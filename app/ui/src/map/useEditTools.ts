// Graphical editing on the map: add objects, drag nodes and gages, move the selection,
// edit vertices (insert, move, delete) and reconnect link ends.
//
// Hit tests run in JS on the geometry the map already has, so that a drag can start on
// pointer-down before the map begins to pan. Edits are committed on release; the
// backend writes them in model coordinates and the map reloads its geometry.

import { useEffect, useMemo, useRef, useState } from "react";
import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { edit } from "../edit";
import { notify, setState, type Tool } from "../store";
import type { Geometry, LinkType, NodeType, ObjRef, Pt } from "../types";

const R = 6378137;
const NONE = 0xffffffff;
const ACCENT: [number, number, number, number] = [31, 111, 235, 255];
const PREVIEW: [number, number, number, number] = [255, 120, 0, 230];
/** Pick tolerance in pixels. */
const TOL = 8;

/** Display coordinates → isotropic index space (Web Mercator metres, or as is). */
function toIndex(g: Geometry, p: Pt): Pt {
  if (g.space !== "lonlat") return p;
  const lat = Math.max(-85, Math.min(85, p[1]));
  return [(R * p[0] * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

function inRing(p: Pt, ring: Pt[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i], ring[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Nearest finite point of an xy array within `tol` (index units); -1 if none. */
function nearest(g: Geometry, xy: Float64Array, p: Pt, tol: number, skip = -1): number {
  const q = toIndex(g, p);
  let best = -1;
  let bd = tol;
  for (let i = 0; i < xy.length / 2; i++) {
    const x = xy[2 * i];
    if (!Number.isFinite(x) || i === skip) continue;
    const d = dist(q, toIndex(g, [x, xy[2 * i + 1]]));
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function linkPath(g: Geometry, i: number): Pt[] {
  const out: Pt[] = [];
  for (let v = g.linkStarts[i]; v < g.linkStarts[i + 1]; v++) out.push([g.linkPts[2 * v], g.linkPts[2 * v + 1]]);
  return out;
}

/** Outline without the closing point. */
function subRing(g: Geometry, i: number): Pt[] {
  const out: Pt[] = [];
  for (let v = g.subStarts[i]; v < g.subStarts[i + 1]; v++) out.push([g.subPts[2 * v], g.subPts[2 * v + 1]]);
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

function nodePt(g: Geometry, i: number): Pt {
  return [g.nodes[2 * i], g.nodes[2 * i + 1]];
}

/** Whether a link path starts and ends at its nodes (both drawn). */
function hasEnds(g: Geometry, i: number) {
  const [a, b] = [g.linkEnds[2 * i], g.linkEnds[2 * i + 1]];
  return a !== NONE && b !== NONE && Number.isFinite(g.nodes[2 * a]) && Number.isFinite(g.nodes[2 * b]);
}

/** Whether `p` is on one of the objects (index units tolerance). */
function onObject(g: Geometry, o: ObjRef, p: Pt, tol: number): boolean {
  const q = toIndex(g, p);
  if (o.kind === "node") return Number.isFinite(g.nodes[2 * o.index]) && dist(q, toIndex(g, nodePt(g, o.index))) <= tol;
  if (o.kind === "gage") return dist(q, toIndex(g, [g.gages[2 * o.index], g.gages[2 * o.index + 1]])) <= tol;
  if (o.kind === "link") {
    const path = linkPath(g, o.index).map((x) => toIndex(g, x));
    return path.some((a, i) => i + 1 < path.length && segDist(q, a, path[i + 1]) <= tol);
  }
  const ring = subRing(g, o.index).map((x) => toIndex(g, x));
  return ring.length >= 3 && inRing(q, ring);
}

/** Editable points of the object in vertex mode: a link's whole path, a subcatchment's ring. */
function editablePoints(g: Geometry, o: ObjRef): Pt[] | null {
  if (o.kind === "link") return linkPath(g, o.index);
  if (o.kind === "subcatchment") return subRing(g, o.index);
  return null;
}

type Drag =
  | { kind: "point"; obj: ObjRef; start: Pt; cur: Pt }
  | { kind: "translate"; objs: ObjRef[]; start: Pt; cur: Pt }
  /** `pts`: the link path or subcatchment ring being edited; `index`: dragged point. */
  | { kind: "vertex"; obj: ObjRef; pts: Pt[]; index: number; cur: Pt };

interface Sketch {
  from: number | null;
  pts: Pt[];
}

interface Viewer {
  unproject(p: Pt): Pt;
  unitsPerPixel(): number;
}

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

function isAddLink(t: Tool): t is `add-${LinkType}` {
  return ["add-conduit", "add-pump", "add-orifice", "add-weir", "add-outlet"].includes(t);
}

function isAddNode(t: Tool): t is `add-${NodeType}` {
  return ["add-junction", "add-outfall", "add-divider", "add-storage"].includes(t);
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
  useEffect(() => setSketch(null), [tool, g]);

  const tol = () => TOL * (viewer.current?.unitsPerPixel() ?? 1);
  const relOf = (e: PointerEvent | React.PointerEvent): Pt => {
    const r = container.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toMap = (rel: Pt): Pt => viewer.current!.unproject(rel);

  const commit = (d: Drag) => {
    if (!g) return;
    const moved = d.kind === "vertex" ? true : dist(toIndex(g, d.start), toIndex(g, d.cur)) > 0;
    if (!moved) return;
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

  const startDrag = (d: Drag) => {
    setDrag(d);
    const move = (e: PointerEvent) => {
      const cur = toMap(relOf(e));
      const prev = dragRef.current;
      if (prev) setDrag({ ...prev, cur } as Drag);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const last = dragRef.current;
      setDrag(null);
      if (last) commit(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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
        startDrag({ kind: "vertex", obj: vertexTarget, pts, index: hit, cur: pts[hit] });
        return true;
      }
      const mid = mids.findIndex((m) => dist(q, toIndex(g, m.p)) <= t);
      if (mid >= 0) {
        const at = mids[mid].after + 1;
        const withNew = [...pts.slice(0, at), mids[mid].p, ...pts.slice(at)];
        startDrag({ kind: "vertex", obj: vertexTarget, pts: withNew, index: at, cur: mids[mid].p });
        return true;
      }
      return false;
    }
    if (tool === "move") {
      // A selected object under the pointer moves the whole selection.
      const sel = selection.filter((o) => onObject(g, o, p, t));
      if (sel.length > 0 && selection.length > 1) {
        startDrag({ kind: "translate", objs: selection, start: p, cur: p });
        return true;
      }
      const node = nearest(g, g.nodes, p, t);
      if (node >= 0) {
        startDrag({ kind: "point", obj: { kind: "node", index: node }, start: p, cur: p });
        setState({ selection: [{ kind: "node", index: node }] });
        return true;
      }
      const gage = nearest(g, g.gages, p, t);
      if (gage >= 0) {
        startDrag({ kind: "point", obj: { kind: "gage", index: gage }, start: p, cur: p });
        setState({ selection: [{ kind: "gage", index: gage }] });
        return true;
      }
      if (sel.length > 0) {
        startDrag({ kind: "translate", objs: sel, start: p, cur: p });
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

  const layers = useMemo(() => {
    if (!g) return [];
    const coordinateSystem = g.space === "lonlat" ? COORDINATE_SYSTEM.LNGLAT : COORDINATE_SYSTEM.CARTESIAN;
    const common = { coordinateSystem, pickable: false };
    const out: Layer[] = [];
    const paths: Pt[][] = [];
    const points: Pt[] = [];
    if (drag?.kind === "point") {
      points.push(drag.cur);
      if (drag.obj.kind === "node") {
        // Links attached to the dragged node follow it.
        const n = drag.obj.index;
        for (let i = 0; i < g.linkTypes.length; i++) {
          const [a, b] = [g.linkEnds[2 * i], g.linkEnds[2 * i + 1]];
          if (a !== n && b !== n) continue;
          const path = linkPath(g, i);
          if (path.length < 2) continue;
          if (a === n) path[0] = drag.cur;
          if (b === n) path[path.length - 1] = drag.cur;
          paths.push(path);
        }
      }
    } else if (drag?.kind === "translate") {
      const [dx, dy] = [drag.cur[0] - drag.start[0], drag.cur[1] - drag.start[1]];
      const shift = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
      for (const o of drag.objs) {
        if (o.kind === "node") points.push(shift(nodePt(g, o.index)));
        else if (o.kind === "gage") points.push(shift([g.gages[2 * o.index], g.gages[2 * o.index + 1]]));
        else if (o.kind === "link") {
          const path = linkPath(g, o.index);
          const ends = hasEnds(g, o.index);
          paths.push(path.map((p, i) => (ends && (i === 0 || i === path.length - 1) ? p : shift(p))));
        } else {
          const ring = subRing(g, o.index).map(shift);
          if (ring.length) paths.push([...ring, ring[0]]);
        }
      }
    } else if (drag?.kind === "vertex") {
      const pts = drag.pts.map((p, i) => (i === drag.index ? drag.cur : p));
      paths.push(drag.obj.kind === "subcatchment" ? [...pts, pts[0]] : pts);
      points.push(drag.cur);
    }
    if (sketch) {
      const start = sketch.from !== null ? [nodePt(g, sketch.from)] : [];
      const line = [...start, ...sketch.pts, ...(hover ? [hover] : [])];
      if (tool === "add-subcatchment" && line.length >= 2) line.push(line[0]);
      if (line.length >= 2) paths.push(line);
      points.push(...start, ...sketch.pts);
    }
    if (handles && !drag) {
      out.push(
        new ScatterplotLayer<Pt>({
          ...common,
          id: "edit-mids",
          data: handles.mids.map((m) => m.p),
          getPosition: (p) => p,
          getRadius: 3.5,
          radiusUnits: "pixels",
          getFillColor: [255, 255, 255, 170],
          stroked: true,
          getLineColor: ACCENT,
          lineWidthUnits: "pixels",
          getLineWidth: 1,
        }),
        new ScatterplotLayer<Pt>({
          ...common,
          id: "edit-handles",
          data: handles.pts,
          getPosition: (p) => p,
          getRadius: 5.5,
          radiusUnits: "pixels",
          getFillColor: [255, 255, 255, 255],
          stroked: true,
          getLineColor: ACCENT,
          lineWidthUnits: "pixels",
          getLineWidth: 2,
        }),
      );
    }
    // Snap target of a link being drawn.
    if (isAddLink(tool) && hover && viewer.current) {
      const node = nearest(g, g.nodes, hover, tol());
      if (node >= 0) {
        out.push(
          new ScatterplotLayer<Pt>({
            ...common,
            id: "edit-snap",
            data: [nodePt(g, node)],
            getPosition: (p) => p,
            getRadius: 9,
            radiusUnits: "pixels",
            filled: false,
            stroked: true,
            getLineColor: PREVIEW,
            lineWidthUnits: "pixels",
            getLineWidth: 2.5,
          }),
        );
      }
    }
    if (paths.length) {
      out.push(
        new PathLayer<Pt[]>({
          ...common,
          id: "edit-paths",
          data: paths,
          getPath: (p) => p,
          getColor: PREVIEW,
          getWidth: 2.5,
          widthUnits: "pixels",
          jointRounded: true,
          capRounded: true,
        }),
      );
    }
    if (points.length) {
      out.push(
        new ScatterplotLayer<Pt>({
          ...common,
          id: "edit-points",
          data: points,
          getPosition: (p) => p,
          getRadius: 5,
          radiusUnits: "pixels",
          getFillColor: PREVIEW,
          stroked: true,
          getLineColor: [255, 255, 255, 255],
          lineWidthUnits: "pixels",
          getLineWidth: 1.5,
        }),
      );
    }
    return out;
  }, [g, drag, sketch, hover, handles, tool]);

  return { layers, onDownCapture, onClick, onMove, cancel, finish, back, busy: drag !== null || sketch !== null };
}
