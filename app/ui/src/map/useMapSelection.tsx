// Selecting on the map: a click picks the object under the pointer, the box and lasso
// tools select what they enclose. Shift adds to the selection.

import { useRef, useState } from "react";
import { api, errorText } from "../api";
import { profileClick } from "../profile/profiles";
import { getState, notify, setState } from "../store";
import { sameRef, type ObjRef } from "../types";
import type { Tool } from "../uiTypes";
import type { EditTools } from "./useEditTools";
import type { Pt, Viewer } from "./viewers";

/** Whether the map draws an object: its layer is shown and, for nodes and links, its type too. */
function shown(h: ObjRef): boolean {
  const { styles: st, geometry: geom } = getState();
  if (h.kind === "subcatchment") return st.subcatchment.visible;
  if (h.kind !== "node" && h.kind !== "link") return true;
  const style = st[h.kind];
  if (!style.visible) return false;
  const t = h.kind === "node" ? geom?.nodeTypes[h.index] : geom?.linkTypes[h.index];
  return t === undefined || !style.hiddenTypes.includes(t);
}

/** Replaces the selection, or adds to it. Objects the map does not draw cannot be selected on it. */
function applySelection(all: ObjRef[], add: boolean) {
  const cur = getState().selection;
  const hits = all.filter(shown);
  if (!add) return setState({ selection: hits });
  const merged = [...cur];
  for (const h of hits) if (!merged.some((m) => sameRef(m, h))) merged.push(h);
  setState({ selection: merged });
}

/**
 * Pointer handlers of the map (`map`) and of the overlay the box and lasso tools draw on
 * (`overlay`), and the shape being drawn. The drawing tools see the pointer first.
 */
export function useMapSelection(viewer: React.RefObject<Viewer | null>, container: React.RefObject<HTMLDivElement | null>, tool: Tool, tools: EditTools) {
  const [drawing, setDrawing] = useState<Pt[] | null>(null);
  // Where the button went down: a click is a press and a release without movement.
  const down = useRef<{ p: Pt; shift: boolean } | null>(null);

  const relative = (e: React.PointerEvent | PointerEvent): Pt => {
    const r = container.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const map = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      down.current = { p: relative(e), shift: e.shiftKey };
    },
    onPointerDownCapture: (e: React.PointerEvent) => {
      if (tools.onDownCapture(e, relative(e))) {
        // The drag is ours: the map must not pan.
        e.preventDefault();
        e.stopPropagation();
        down.current = null;
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = down.current;
      down.current = null;
      const v = viewer.current;
      if (!d || !v || tool === "box" || tool === "lasso") return;
      const p = relative(e);
      if (Math.hypot(p[0] - d.p[0], p[1] - d.p[1]) > 4) return;
      if (tools.onClick(p, e)) return;
      if (tool.startsWith("add-")) return;
      const [x, y] = v.unproject(p);
      // The closest object the map draws: a hidden one must not shadow a shown one under it.
      api
        .pickAll(x, y, 6 * v.unitsPerPixel())
        .then((all) => all.find(shown) ?? null)
        .then((hit) => (tool === "profile" ? profileClick(hit, d.shift) : applySelection(hit ? [hit] : [], d.shift)))
        .catch((err) => notify(errorText(err), true));
    },
  };

  // Box and lasso: an overlay captures the pointer so the map does not pan.
  const overlay = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const p = relative(e);
      setDrawing([p, p]);
      down.current = { p, shift: e.shiftKey };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drawing) return;
      const p = relative(e);
      if (tool === "box") setDrawing([drawing[0], p]);
      else {
        const last = drawing[drawing.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) setDrawing([...drawing, p]);
      }
    },
    onPointerUp: () => {
      const v = viewer.current;
      const pts = drawing;
      const shift = down.current?.shift ?? false;
      setDrawing(null);
      down.current = null;
      if (!v || !pts) return;
      const req =
        tool === "box"
          ? api.selectRect(v.unproject(pts[0]), v.unproject(pts[pts.length - 1]))
          : pts.length >= 3
            ? api.selectPolygon(pts.map((p) => v.unproject(p)))
            : Promise.resolve([] as ObjRef[]);
      req.then((hits) => applySelection(hits, shift)).catch((err) => notify(errorText(err), true));
    },
  };

  let shape: React.ReactNode = null;
  if (drawing && tool === "box") {
    const [a, b] = [drawing[0], drawing[drawing.length - 1]];
    shape = <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} className="draw-shape" />;
  } else if (drawing) {
    shape = <polygon points={drawing.map((p) => p.join(",")).join(" ")} className="draw-shape" />;
  }

  return { map, overlay, shape, relative };
}
