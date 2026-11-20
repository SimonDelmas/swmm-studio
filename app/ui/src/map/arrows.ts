// Flow direction arrows on the links: along the link as drawn, turned round where the
// flow at the current time is negative, not drawn where there is none.

import type { CoordinateSystem, Layer } from "@deck.gl/core";
import type { Geometry, Pt, VarInfo } from "../types";
import type { Styled } from "./colors";
import { toIndex } from "./hitTest";
import { shapeLayers } from "./layers";
import { LINK_TYPE_SHAPES } from "./shapes";

/** Flows smaller than this (in absolute value) have no direction. */
const NO_FLOW = 1e-6;

/** Index of the flow among the result variables of links (-1: none). */
export function flowVariable(vars: VarInfo[] | undefined): number {
  return vars ? vars.findIndex((v) => /flow/i.test(v.name)) : -1;
}

/**
 * Where the arrow of each link is drawn, and its angle (degrees, counter-clockwise, pointing
 * from the first point of the link to the last): half-way along the link, or further down
 * for links with a symbol in their middle. NaN for links that are not drawn.
 */
export function arrowGeometry(g: Geometry) {
  const n = g.linkStarts.length - 1;
  const pos = new Float64Array(2 * n).fill(NaN);
  const angle = new Float32Array(n);
  const p = g.linkPts;
  for (let i = 0; i < n; i++) {
    const [a, b] = [g.linkStarts[i], g.linkStarts[i + 1]];
    if (b - a < 2) continue;
    // Lengths in index space (isotropic: Web Mercator metres, or model units).
    const pts: Pt[] = [];
    for (let v = a; v < b; v++) pts.push(toIndex(g, [p[2 * v], p[2 * v + 1]]));
    if (!pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) continue;
    const seg = pts.slice(1).map((q, k) => Math.hypot(q[0] - pts[k][0], q[1] - pts[k][1]));
    const total = seg.reduce((s, l) => s + l, 0);
    if (total === 0) continue;
    let at = total * (LINK_TYPE_SHAPES[g.linkTypes[i]] ? 0.75 : 0.5);
    let k = 0;
    while (k < seg.length - 1 && at > seg[k]) at -= seg[k++];
    const t = seg[k] > 0 ? at / seg[k] : 0;
    const [x0, y0, x1, y1] = [p[2 * (a + k)], p[2 * (a + k) + 1], p[2 * (a + k) + 2], p[2 * (a + k) + 3]];
    pos[2 * i] = x0 + t * (x1 - x0);
    pos[2 * i + 1] = y0 + t * (y1 - y0);
    const [q0, q1] = [pts[k], pts[k + 1]];
    angle[i] = (Math.atan2(q1[1] - q0[1], q1[0] - q0[0]) * 180) / Math.PI;
  }
  return { pos, angle };
}
export type ArrowGeometry = ReturnType<typeof arrowGeometry>;

/**
 * Arrows of the drawn links. `flows`: flow of each link at the current time (null: the
 * direction the links are drawn in, without results).
 */
export function flowArrowLayers(
  g: Geometry,
  arrows: ArrowGeometry,
  linkStyled: Styled,
  flows: Float32Array | null,
  coordSystem: CoordinateSystem,
): Layer[] {
  const n = g.linkStarts.length - 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(arrows.pos[2 * i]) || linkStyled.sizes[i] <= 0 || linkStyled.colors[4 * i + 3] === 0) continue;
    if (flows && !(Math.abs(flows[i]) >= NO_FLOW)) continue;
    idx.push(i);
  }
  const m = idx.length;
  if (m === 0) return [];
  const pos = new Float64Array(2 * m);
  const angle = new Float32Array(m);
  const colors = new Uint8Array(4 * m);
  const sizes = new Float32Array(m);
  idx.forEach((i, k) => {
    pos[2 * k] = arrows.pos[2 * i];
    pos[2 * k + 1] = arrows.pos[2 * i + 1];
    angle[k] = arrows.angle[i] + (flows && flows[i] < 0 ? 180 : 0);
    colors.set([30, 30, 30, 230], 4 * k);
    sizes[k] = 2 * linkStyled.sizes[i] + 8;
  });
  const common = { coordinateSystem: coordSystem, pickable: false };
  return shapeLayers("flow-arrows", common, m, { value: pos, size: 2 }, { value: angle, size: 1 }, () => "flow", colors, sizes);
}
