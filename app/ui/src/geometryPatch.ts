// The geometry of the map after an edit moved or reshaped some objects.

import type { Geometry, GeometryPatch } from "./types";

const num = (v: number | null) => (v === null ? NaN : v);

/** Replaces the paths of some objects in flat (starts, points) arrays. */
function splice(starts: Uint32Array, pts: Float64Array, changed: Map<number, (number | null)[][]>) {
  const n = starts.length - 1;
  let sameSize = true;
  let total = pts.length / 2;
  for (const [i, p] of changed) {
    const old = starts[i + 1] - starts[i];
    if (p.length !== old) sameSize = false;
    total += p.length - old;
  }
  if (sameSize) {
    const out = pts.slice();
    for (const [i, p] of changed) p.forEach((xy, k) => ((out[2 * (starts[i] + k)] = num(xy[0])), (out[2 * (starts[i] + k) + 1] = num(xy[1]))));
    return { starts, pts: out };
  }
  const s2 = new Uint32Array(n + 1);
  const p2 = new Float64Array(2 * total);
  let k = 0;
  for (let i = 0; i < n; i++) {
    s2[i] = k;
    const c = changed.get(i);
    if (c) {
      for (const xy of c) ((p2[2 * k] = num(xy[0])), (p2[2 * k + 1] = num(xy[1])), k++);
    } else {
      p2.set(pts.subarray(2 * starts[i], 2 * starts[i + 1]), 2 * k);
      k += starts[i + 1] - starts[i];
    }
  }
  s2[n] = k;
  return { starts: s2, pts: p2 };
}

/** Geometry with the objects of a patch replaced (the arrays are copied, not changed). */
export function applyPatch(g: Geometry, p: GeometryPatch): Geometry {
  const out = { ...g };
  if (p.nodes.length) {
    out.nodes = g.nodes.slice();
    for (const [i, xy] of p.nodes) ((out.nodes[2 * i] = num(xy[0])), (out.nodes[2 * i + 1] = num(xy[1])));
  }
  if (p.gages.length) {
    out.gages = g.gages.slice();
    for (const [i, xy] of p.gages) ((out.gages[2 * i] = num(xy[0])), (out.gages[2 * i + 1] = num(xy[1])));
  }
  if (p.links.length) {
    out.linkEnds = g.linkEnds.slice();
    for (const [i, ends] of p.links) ((out.linkEnds[2 * i] = ends[0]), (out.linkEnds[2 * i + 1] = ends[1]));
    const r = splice(g.linkStarts, g.linkPts, new Map(p.links.map(([i, , pts]) => [i, pts])));
    out.linkStarts = r.starts;
    out.linkPts = r.pts;
  }
  if (p.subcatchments.length) {
    out.subOutlets = g.subOutlets.slice();
    for (const [i, o] of p.subcatchments) ((out.subOutlets[2 * i] = o[0]), (out.subOutlets[2 * i + 1] = o[1]));
    const r = splice(g.subStarts, g.subPts, new Map(p.subcatchments.map(([i, , pts]) => [i, pts])));
    out.subStarts = r.starts;
    out.subPts = r.pts;
  }
  return out;
}
