// Distances and areas of the measure tool: on the sphere for longitude / latitude, in the
// plane (model units) otherwise.

import type { Pt } from "../types";

/** Mean radius of the Earth (m). */
const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

/** Great-circle distance between two longitude / latitude points (m). */
function haversine(a: Pt, b: Pt): number {
  const [l1, p1, l2, p2] = [a[0] * RAD, a[1] * RAD, b[0] * RAD, b[1] * RAD];
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of a polyline. `lonlat`: points in degrees, length in metres. */
export function pathLength(pts: Pt[], lonlat: boolean): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += lonlat ? haversine(pts[i - 1], pts[i]) : Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/** Area enclosed by a ring (not closed: the last point joins the first). `lonlat`: m² on the sphere. */
export function ringArea(pts: Pt[], lonlat: boolean): number {
  const n = pts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % n]];
    if (lonlat) s += (b[0] - a[0]) * RAD * (2 + Math.sin(a[1] * RAD) + Math.sin(b[1] * RAD));
    else s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(lonlat ? (s * EARTH_R * EARTH_R) / 2 : s / 2);
}

const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 });

/** A length for display: metres or kilometres, or model units. */
export function formatLength(v: number, lonlat: boolean): string {
  if (!lonlat) return `${fmt(v)} units`;
  return v >= 1000 ? `${fmt(v / 1000)} km` : `${fmt(v)} m`;
}

/** An area for display: m², ha or km², or square model units. */
export function formatArea(v: number, lonlat: boolean): string {
  if (!lonlat) return `${fmt(v)} units²`;
  if (v >= 1e6) return `${fmt(v / 1e6)} km²`;
  if (v >= 1e4) return `${fmt(v / 1e4)} ha`;
  return `${fmt(v)} m²`;
}
