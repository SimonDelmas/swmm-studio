// Layers drawn over the network: the selection, the current profile and the labels.

import type { CoordinateSystem, Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import type { LayerStyle } from "../uiTypes";
import type { ProfileDto } from "../analysisTypes";
import type { Geometry, ObjKind, ObjRef } from "../types";
import type { Upstream } from "./upstream";
import type { Extent, Pt } from "./viewers";

type Rgba = [number, number, number, number];
const HIGHLIGHT: Rgba = [255, 200, 0, 255];
/** The network upstream of the selection. */
const UPSTREAM: Rgba = [0, 170, 230, 220];
const UPSTREAM_FILL: Rgba = [0, 170, 230, 60];
/** Path of the current longitudinal profile. */
const PROFILE: Rgba = [230, 40, 150, 210];
const MAX_LABELS = 400;

/** Highlight of the selected objects. */
export function selectionLayers(g: Geometry, selection: ObjRef[], coordSystem: CoordinateSystem, linkSize: number, nodeSize: number): Layer[] {
  if (selection.length === 0) return [];
  const common = { coordinateSystem: coordSystem, pickable: false };
  const pts: Pt[] = [];
  const paths: Pt[][] = [];
  const rings: Pt[][] = [];
  const slice = (a: Float64Array, s: number, e: number) => {
    const out: Pt[] = [];
    for (let i = s; i < e; i++) out.push([a[2 * i], a[2 * i + 1]]);
    return out;
  };
  for (const o of selection) {
    if (o.kind === "node") pts.push([g.nodes[2 * o.index], g.nodes[2 * o.index + 1]]);
    else if (o.kind === "gage") pts.push([g.gages[2 * o.index], g.gages[2 * o.index + 1]]);
    else if (o.kind === "link") paths.push(slice(g.linkPts, g.linkStarts[o.index], g.linkStarts[o.index + 1]));
    else rings.push(slice(g.subPts, g.subStarts[o.index], g.subStarts[o.index + 1]));
  }
  return [
    new PathLayer<Pt[]>({
      ...common,
      id: "sel-subcatchments",
      data: rings,
      getPath: (r) => r,
      getColor: HIGHLIGHT,
      getWidth: 3,
      widthUnits: "pixels",
    }),
    new PathLayer<Pt[]>({
      ...common,
      id: "sel-links",
      data: paths,
      getPath: (p) => p,
      getColor: HIGHLIGHT,
      getWidth: Math.max(5, linkSize + 4),
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
    }),
    new ScatterplotLayer<Pt>({
      ...common,
      id: "sel-nodes",
      data: pts,
      getPosition: (p) => p,
      getRadius: Math.max(7, nodeSize + 4),
      radiusUnits: "pixels",
      filled: false,
      stroked: true,
      getLineColor: HIGHLIGHT,
      getLineWidth: 3,
      lineWidthUnits: "pixels",
    }),
  ];
}

/** The network upstream of the selection: its subcatchments, links and nodes. */
export function upstreamLayers(g: Geometry, up: Upstream, coordSystem: CoordinateSystem, linkSize: number, nodeSize: number): Layer[] {
  if (up.nodes.length + up.links.length + up.subcatchments.length === 0) return [];
  const common = { coordinateSystem: coordSystem, pickable: false };
  const slice = (a: Float64Array, s: number, e: number) => {
    const out: Pt[] = [];
    for (let i = s; i < e; i++) out.push([a[2 * i], a[2 * i + 1]]);
    return out;
  };
  const rings = up.subcatchments.map((i) => slice(g.subPts, g.subStarts[i], g.subStarts[i + 1])).filter((r) => r.length >= 3);
  const paths = up.links.map((i) => slice(g.linkPts, g.linkStarts[i], g.linkStarts[i + 1])).filter((p) => p.length >= 2);
  const pts = up.nodes.map((i): Pt => [g.nodes[2 * i], g.nodes[2 * i + 1]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  return [
    new SolidPolygonLayer<Pt[]>({
      ...common,
      id: "upstream-subcatchment-fill",
      data: rings,
      getPolygon: (r) => r,
      getFillColor: UPSTREAM_FILL,
    }),
    new PathLayer<Pt[]>({
      ...common,
      id: "upstream-subcatchments",
      data: rings,
      getPath: (r) => r,
      getColor: UPSTREAM,
      getWidth: 2,
      widthUnits: "pixels",
    }),
    new PathLayer<Pt[]>({
      ...common,
      id: "upstream-links",
      data: paths,
      getPath: (p) => p,
      getColor: UPSTREAM,
      getWidth: Math.max(5, linkSize + 4),
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
    }),
    new ScatterplotLayer<Pt>({
      ...common,
      id: "upstream-nodes",
      data: pts,
      getPosition: (p) => p,
      getRadius: Math.max(4, nodeSize + 1),
      radiusUnits: "pixels",
      getFillColor: UPSTREAM,
    }),
  ];
}

/** The current profile: its links and nodes, and the start node being picked. */
export function profileLayers(
  g: Geometry,
  profile: ProfileDto | null,
  profileStart: number | null,
  coordSystem: CoordinateSystem,
  linkSize: number,
  nodeSize: number,
): Layer[] {
  const common = { coordinateSystem: coordSystem, pickable: false };
  const nodePt = (i: number): Pt => [g.nodes[2 * i], g.nodes[2 * i + 1]];
  const paths: Pt[][] = [];
  const pts: Pt[] = [];
  if (profile) {
    for (const l of profile.links) {
      const path: Pt[] = [];
      for (let i = g.linkStarts[l.index]; i < g.linkStarts[l.index + 1]; i++) path.push([g.linkPts[2 * i], g.linkPts[2 * i + 1]]);
      paths.push(path);
    }
    for (const n of profile.nodes) pts.push(nodePt(n.index));
  }
  const start = profileStart !== null && profileStart < g.nodeTypes.length ? [nodePt(profileStart)] : [];
  if (paths.length === 0 && pts.length === 0 && start.length === 0) return [];
  return [
    new PathLayer<Pt[]>({
      ...common,
      id: "profile-links",
      data: paths,
      getPath: (p) => p,
      getColor: PROFILE,
      getWidth: Math.max(7, linkSize + 6),
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
    }),
    new ScatterplotLayer<Pt>({
      ...common,
      id: "profile-nodes",
      data: pts,
      getPosition: (p) => p,
      getRadius: Math.max(5, nodeSize + 2),
      radiusUnits: "pixels",
      getFillColor: PROFILE,
    }),
    new ScatterplotLayer<Pt>({
      ...common,
      id: "profile-start",
      data: start,
      getPosition: (p) => p,
      getRadius: Math.max(9, nodeSize + 6),
      radiusUnits: "pixels",
      filled: false,
      stroked: true,
      getLineColor: PROFILE,
      getLineWidth: 3,
      lineWidthUnits: "pixels",
    }),
  ];
}

/** Labels of the nodes and links in view, when few enough (null: too many, or names not loaded). */
export function labelLayer(
  g: Geometry,
  ids: Partial<Record<ObjKind, string[]>>,
  [x0, y0, x1, y1]: Extent,
  coordSystem: CoordinateSystem,
  styles: Record<"node" | "link", LayerStyle>,
): Layer | null {
  if (!ids.node) return null;
  const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const items: { p: Pt; t: string }[] = [];
  const push = (x: number, y: number, t: string | undefined) => {
    if (t !== undefined && Number.isFinite(x) && inView(x, y)) items.push({ p: [x, y], t });
  };
  const nNodes = g.nodeTypes.length;
  const nodeHidden = styles.node.hiddenTypes;
  const linkHidden = styles.link.hiddenTypes;
  for (let i = 0; styles.node.visible && i < nNodes && items.length <= MAX_LABELS; i++) {
    if (!nodeHidden.includes(g.nodeTypes[i])) push(g.nodes[2 * i], g.nodes[2 * i + 1], ids.node[i]);
  }
  if (ids.link && styles.link.visible) {
    for (let i = 0; i + 1 < g.linkStarts.length && items.length <= MAX_LABELS; i++) {
      if (linkHidden.includes(g.linkTypes[i])) continue;
      const a = g.linkStarts[i];
      const b = g.linkStarts[i + 1];
      if (b - a < 2) continue;
      const m = a + Math.floor((b - a - 1) / 2);
      const x = (g.linkPts[2 * m] + g.linkPts[2 * m + 2]) / 2;
      const y = (g.linkPts[2 * m + 1] + g.linkPts[2 * m + 3]) / 2;
      push(x, y, ids.link[i]);
    }
  }
  if (items.length > MAX_LABELS) return null;
  return new TextLayer<{ p: Pt; t: string }>({
    id: "labels",
    coordinateSystem: coordSystem,
    data: items,
    getPosition: (d) => d.p,
    getText: (d) => d.t,
    getSize: 12,
    getColor: [20, 20, 20, 255],
    getPixelOffset: [0, -13],
    fontFamily: "Segoe UI, system-ui, sans-serif",
    background: true,
    getBackgroundColor: [255, 255, 255, 190],
    backgroundPadding: [3, 1],
    characterSet: "auto",
  });
}
