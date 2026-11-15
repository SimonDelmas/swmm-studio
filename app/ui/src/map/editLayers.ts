// What the map edit tools draw: the object being dragged, the sketch of a new one and
// the vertex handles.

import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Tool } from "../store";
import type { Geometry, LinkType, NodeType, ObjRef, Pt } from "../types";
import { hasEnds, linkPath, nodePt, subRing, nearest } from "./hitTest";

const ACCENT: [number, number, number, number] = [31, 111, 235, 255];
const PREVIEW: [number, number, number, number] = [255, 120, 0, 230];

export type Drag =
  | { kind: "point"; obj: ObjRef; start: Pt; cur: Pt }
  | { kind: "translate"; objs: ObjRef[]; start: Pt; cur: Pt }
  /** `pts`: the link path or subcatchment ring being edited; `index`: dragged point. */
  | { kind: "vertex"; obj: ObjRef; pts: Pt[]; index: number; cur: Pt };

export interface Sketch {
  from: number | null;
  pts: Pt[];
}

/** Vertex handles of the object being reshaped: its points and the midpoints of its segments. */
export interface Handles {
  pts: Pt[];
  mids: { p: Pt; after: number }[];
  closed: boolean;
}

export function isAddLink(t: Tool): t is `add-${LinkType}` {
  return ["add-conduit", "add-pump", "add-orifice", "add-weir", "add-outlet"].includes(t);
}

export function isAddNode(t: Tool): t is `add-${NodeType}` {
  return ["add-junction", "add-outfall", "add-divider", "add-storage"].includes(t);
}

/** Layers of the edit in progress. `tolerance`: snap distance in index units (0: no snapping). */
export function editLayers(
  g: Geometry,
  drag: Drag | null,
  sketch: Sketch | null,
  hover: Pt | null,
  handles: Handles | null,
  tool: Tool,
  tolerance: number,
): Layer[] {
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
  if (isAddLink(tool) && hover && tolerance > 0) {
    const node = nearest(g, g.nodes, hover, tolerance);
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
}
