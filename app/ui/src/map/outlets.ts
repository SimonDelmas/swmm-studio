// Lines from the subcatchments to their outlets.

import type { Geometry } from "../types";

/** Centroid of each subcatchment outline (NaN without one). */
function subCentroids(g: Geometry): Float64Array {
  const n = g.subStarts.length - 1;
  const out = new Float64Array(2 * n).fill(NaN);
  const p = g.subPts;
  for (let i = 0; i < n; i++) {
    const s = g.subStarts[i];
    const e = g.subStarts[i + 1];
    if (e - s < 3) continue;
    // Relative to the first vertex, for precision; the ring is closed.
    const [x0, y0] = [p[2 * s], p[2 * s + 1]];
    let a = 0;
    let cx = 0;
    let cy = 0;
    let mx = 0;
    let my = 0;
    for (let v = s; v + 1 < e; v++) {
      const [xa, ya, xb, yb] = [p[2 * v] - x0, p[2 * v + 1] - y0, p[2 * v + 2] - x0, p[2 * v + 3] - y0];
      const c = xa * yb - xb * ya;
      a += c;
      cx += (xa + xb) * c;
      cy += (ya + yb) * c;
      mx += xa;
      my += ya;
    }
    // Degenerate outlines: the mean of the vertices.
    const [x, y] = Math.abs(a) > 1e-12 ? [cx / (3 * a), cy / (3 * a)] : [mx / (e - s - 1), my / (e - s - 1)];
    out[2 * i] = x0 + x;
    out[2 * i + 1] = y0 + y;
  }
  return out;
}

/** Segments from each drawn subcatchment's centroid to its outlet (node or subcatchment centroid). */
export function outletSegments(g: Geometry) {
  const c = subCentroids(g);
  const n = g.subStarts.length - 1;
  const src: number[] = [];
  const tgt: number[] = [];
  for (let i = 0; i < n; i++) {
    const [kind, j] = [g.subOutlets[2 * i], g.subOutlets[2 * i + 1]];
    const to = kind === 0 ? g.nodes : kind === 1 ? c : null;
    if (!to || j >= to.length / 2) continue;
    const [x0, y0, x1, y1] = [c[2 * i], c[2 * i + 1], to[2 * j], to[2 * j + 1]];
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    src.push(x0, y0);
    tgt.push(x1, y1);
  }
  return { length: src.length / 2, src: new Float64Array(src), tgt: new Float64Array(tgt) };
}
export type OutletSegments = ReturnType<typeof outletSegments>;
