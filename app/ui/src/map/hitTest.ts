// Geometry helpers of the map edit tools: distances and hit tests in index space, and the
// points of an object as the tools edit them.

import type { Geometry, ObjRef, Pt } from "../types";

export const R = 6378137;
export const NONE = 0xffffffff;

/** Display coordinates → isotropic index space (Web Mercator metres, or as is). */
export function toIndex(g: Geometry, p: Pt): Pt {
  if (g.space !== "lonlat") return p;
  const lat = Math.max(-85, Math.min(85, p[1]));
  return [(R * p[0] * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

export function inRing(p: Pt, ring: Pt[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i], ring[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Nearest finite point of an xy array within `tol` (index units); -1 if none. */
export function nearest(g: Geometry, xy: Float64Array, p: Pt, tol: number, skip = -1): number {
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
export function subRing(g: Geometry, i: number): Pt[] {
  const out: Pt[] = [];
  for (let v = g.subStarts[i]; v < g.subStarts[i + 1]; v++) out.push([g.subPts[2 * v], g.subPts[2 * v + 1]]);
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

export function nodePt(g: Geometry, i: number): Pt {
  return [g.nodes[2 * i], g.nodes[2 * i + 1]];
}

/** Whether a link path starts and ends at its nodes (both drawn). */
export function hasEnds(g: Geometry, i: number) {
  const [a, b] = [g.linkEnds[2 * i], g.linkEnds[2 * i + 1]];
  return a !== NONE && b !== NONE && Number.isFinite(g.nodes[2 * a]) && Number.isFinite(g.nodes[2 * b]);
}

/** Whether `p` is on one of the objects (index units tolerance). */
export function onObject(g: Geometry, o: ObjRef, p: Pt, tol: number): boolean {
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
export function editablePoints(g: Geometry, o: ObjRef): Pt[] | null {
  if (o.kind === "link") return linkPath(g, o.index);
  if (o.kind === "subcatchment") return subRing(g, o.index);
  return null;
}
