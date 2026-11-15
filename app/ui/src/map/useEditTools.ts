// Graphical editing on the map: add objects, drag nodes and gages, move the selection,
// edit vertices (insert, move, delete) and reconnect link ends.
//
// Hit tests run in JS on the geometry the map already has, so that a drag can start on
// pointer-down before the map begins to pan. Edits are committed on release; the
// backend writes them in model coordinates and the map reloads its geometry.
import { useEffect, useMemo, useRef, useState } from "react";
import { type Layer } from "@deck.gl/core";
import { edit } from "../edit";
import { notify, setState, type Tool } from "../store";
import type { Geometry, LinkType, NodeType, ObjRef, Pt } from "../types";
import type { Viewer as MapViewer } from "./viewers";
import { editLayers, isAddLink, isAddNode, type Drag, type Sketch } from "./editLayers";
import { dist, editablePoints, hasEnds, nearest, onObject, toIndex } from "./hitTest";

/** Pick tolerance in pixels. */
const TOL = 8;
/** Pixels the pointer moves before a press becomes a drag. */
const DRAG_START = 3;

/** What the tools need from the map viewer. */
type Viewer = Pick<MapViewer, "unproject" | "unitsPerPixel">;

export interface EditTools {
  layers: Layer[];
  /** Pointer-down before the map sees it; true when a drag started. */
  onDownCapture(e: React.PointerEvent, rel: Pt): boolean;
  /** A click (press and release without moving); true when handled. */
  onClick(rel: Pt, e: React.PointerEvent): boolean;
  onMove(rel: Pt): void;
  /** Escape: drops the current sketch or drag; true if there was one. */
  cancel(): boolean;
  /** Enter: finishes a subcatchment outline. */
  finish(): void;
  /** Backspace: removes the last sketch point. */
  back(): boolean;
  busy: boolean;
}

export function useEditTools(
  viewer: React.RefObject<Viewer | null>,
  container: React.RefObject<HTMLDivElement | null>,
  g: Geometry | null,
  tool: Tool,
  selection: ObjRef[],
): EditTools {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // A new tool or new geometry ends any sketch.
  useEffect(() => {
    setSketch(null);
  }, [tool, g]);

  const tol = () => TOL * (viewer.current?.unitsPerPixel() ?? 1);
  const relOf = (e: PointerEvent | React.PointerEvent): Pt => {
    const r = container.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toMap = (rel: Pt): Pt => viewer.current!.unproject(rel);

  const commit = (d: Drag) => {
    if (!g) return;
    if (d.kind !== "vertex" && dist(toIndex(g, d.start), toIndex(g, d.cur)) === 0) return;
    if (d.kind === "point") {
      edit({ op: "set_geometry", object: d.obj, points: [d.cur] });
    } else if (d.kind === "translate") {
      edit({ op: "translate", objects: d.objs, dx: d.cur[0] - d.start[0], dy: d.cur[1] - d.start[1] });
    } else {
      const pts = d.pts.map((p, i) => (i === d.index ? d.cur : p));
      if (d.obj.kind === "link") {
        const last = pts.length - 1;
        if (hasEnds(g, d.obj.index) && (d.index === 0 || d.index === last)) {
          // A link end dropped on another node reconnects it.
          const own = g.linkEnds[2 * d.obj.index + (d.index === 0 ? 0 : 1)];
          const node = nearest(g, g.nodes, d.cur, tol(), own);
          if (node < 0) return notify("Drop the link end on a node to reconnect it");
          edit({ op: "reconnect", link: d.obj.index, end: d.index === 0 ? "from" : "to", node });
        } else {
          const interior = hasEnds(g, d.obj.index) ? pts.slice(1, -1) : pts;
          edit({ op: "set_geometry", object: d.obj, points: interior });
        }
      } else {
        edit({ op: "set_geometry", object: d.obj, points: pts });
      }
    }
  };

  /** Ends the drag in progress without applying it (Escape, or the pointer was taken away). */
  const abortDrag = useRef<(() => void) | null>(null);

  const startDrag = (d: Drag, e: React.PointerEvent) => {
    setDrag(d);
    const [x0, y0] = [e.clientX, e.clientY];
    // A press and release in place is a click, not a move.
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START) return;
      moved = true;
      const cur = toMap(relOf(ev));
      const prev = dragRef.current;
      if (prev) setDrag({ ...prev, cur } as Drag);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      abortDrag.current = null;
      setDrag(null);
    };
    const up = () => {
      const last = dragRef.current;
      end();
      if (last && moved) commit(last);
    };
    abortDrag.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
  };
  // Nothing is left listening when the map goes away during a drag.
  useEffect(() => () => abortDrag.current?.(), []);

  const single = selection.length === 1 ? selection[0] : null;
  const vertexTarget = tool === "vertex" && single && (single.kind === "link" || single.kind === "subcatchment") ? single : null;

  /** Vertex handles of the target: points (with their index) and segment midpoints. */
  const handles = useMemo(() => {
    if (!g || !vertexTarget) return null;
    const pts = editablePoints(g, vertexTarget);
    if (!pts) return null;
    const closed = vertexTarget.kind === "subcatchment";
    const mids: { p: Pt; after: number }[] = [];
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const [a, b] = [pts[i], pts[(i + 1) % n]];
      mids.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], after: i });
    }
    return { pts, mids, closed };
  }, [g, vertexTarget?.kind, vertexTarget?.index]);

  const onDownCapture = (e: React.PointerEvent, rel: Pt): boolean => {
    if (e.button !== 0 || !g || !viewer.current) return false;
    const p = toMap(rel);
    const t = tol();
    const q = toIndex(g, p);
    if (tool === "vertex" && handles && vertexTarget) {
      const { pts, mids } = handles;
      const hit = pts.findIndex((v) => dist(q, toIndex(g, v)) <= t);
      const ends = vertexTarget.kind === "link" && hasEnds(g, vertexTarget.index);
      const interior = (i: number) => !ends || (i > 0 && i < pts.length - 1);
      if (hit >= 0 && e.altKey) {
        // Alt+click removes a vertex.
        if (!interior(hit)) return true;
        const rest = pts.filter((_, i) => i !== hit);
        if (vertexTarget.kind === "subcatchment" && rest.length < 3) {
          notify("A subcatchment outline needs at least 3 points");
          return true;
        }
        edit({ op: "set_geometry", object: vertexTarget, points: ends ? rest.slice(1, -1) : rest });
        return true;
      }
      if (hit >= 0) {
        startDrag({ kind: "vertex", obj: vertexTarget, pts, index: hit, cur: pts[hit] }, e);
        return true;
      }
      const mid = mids.findIndex((m) => dist(q, toIndex(g, m.p)) <= t);
      if (mid >= 0) {
        const at = mids[mid].after + 1;
        const withNew = [...pts.slice(0, at), mids[mid].p, ...pts.slice(at)];
        startDrag({ kind: "vertex", obj: vertexTarget, pts: withNew, index: at, cur: mids[mid].p }, e);
        return true;
      }
      return false;
    }
    if (tool === "move") {
      // A selected object under the pointer moves the whole selection.
      const sel = selection.filter((o) => onObject(g, o, p, t));
      if (sel.length > 0 && selection.length > 1) {
        startDrag({ kind: "translate", objs: selection, start: p, cur: p }, e);
        return true;
      }
      const node = nearest(g, g.nodes, p, t);
      if (node >= 0) {
        startDrag({ kind: "point", obj: { kind: "node", index: node }, start: p, cur: p }, e);
        setState({ selection: [{ kind: "node", index: node }] });
        return true;
      }
      const gage = nearest(g, g.gages, p, t);
      if (gage >= 0) {
        startDrag({ kind: "point", obj: { kind: "gage", index: gage }, start: p, cur: p }, e);
        setState({ selection: [{ kind: "gage", index: gage }] });
        return true;
      }
      if (sel.length > 0) {
        startDrag({ kind: "translate", objs: sel, start: p, cur: p }, e);
        return true;
      }
    }
    return false;
  };

  const onClick = (rel: Pt, _e: React.PointerEvent): boolean => {
    if (!g || !viewer.current) return false;
    const p = toMap(rel);
    const t = tol();
    if (isAddNode(tool)) {
      edit({ op: "add_node", node_type: tool.slice(4) as NodeType, xy: p });
      return true;
    }
    if (tool === "add-gage") {
      edit({ op: "add_gage", xy: p });
      return true;
    }
    if (isAddLink(tool)) {
      const node = nearest(g, g.nodes, p, t);
      if (!sketch) {
        if (node < 0) notify("Click the node where the link starts");
        else setSketch({ from: node, pts: [] });
        return true;
      }
      if (node >= 0 && node !== sketch.from) {
        edit({ op: "add_link", link_type: tool.slice(4) as LinkType, from: sketch.from!, to: node, vertices: sketch.pts });
        setSketch(null);
      } else if (node < 0) {
        setSketch({ ...sketch, pts: [...sketch.pts, p] });
      }
      return true;
    }
    if (tool === "add-subcatchment") {
      const pts = sketch?.pts ?? [];
      if (pts.length >= 3 && dist(toIndex(g, p), toIndex(g, pts[0])) <= t) {
        edit({ op: "add_subcatchment", polygon: pts });
        setSketch(null);
      } else {
        setSketch({ from: null, pts: [...pts, p] });
      }
      return true;
    }
    return false;
  };

  const onMove = (rel: Pt) => {
    if (!viewer.current) return;
    if (sketch || isAddLink(tool)) setHover(toMap(rel));
  };

  const cancel = () => {
    if (abortDrag.current) {
      abortDrag.current();
      return true;
    }
    if (sketch) {
      setSketch(null);
      return true;
    }
    return false;
  };

  const finish = () => {
    if (tool === "add-subcatchment" && sketch && sketch.pts.length >= 3) {
      edit({ op: "add_subcatchment", polygon: sketch.pts });
      setSketch(null);
    }
  };

  const back = () => {
    if (!sketch) return false;
    if (sketch.pts.length === 0) setSketch(null);
    else setSketch({ ...sketch, pts: sketch.pts.slice(0, -1) });
    return true;
  };
  const layers = useMemo(() => (g ? editLayers(g, drag, sketch, hover, handles, tool, viewer.current ? tol() : 0) : []), [g, drag, sketch, hover, handles, tool]);

  return { layers, onDownCapture, onClick, onMove, cancel, finish, back, busy: drag !== null || sketch !== null };
}
