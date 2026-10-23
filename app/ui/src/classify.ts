// Class breaks and colour ramps for thematic maps.

import type { ClassMethod } from "./store";

export type RGB = [number, number, number];

export const RAMPS: Record<string, RGB[]> = {
  "blue-red": [
    [49, 54, 149],
    [69, 117, 180],
    [116, 173, 209],
    [254, 224, 144],
    [244, 109, 67],
    [215, 48, 39],
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  blues: [
    [198, 219, 239],
    [107, 174, 214],
    [33, 113, 181],
    [8, 48, 107],
  ],
  greens: [
    [229, 245, 224],
    [161, 217, 155],
    [65, 171, 93],
    [0, 90, 50],
  ],
  magma: [
    [252, 253, 191],
    [254, 159, 109],
    [222, 73, 104],
    [140, 41, 129],
    [59, 15, 112],
  ],
};

/** `n` colours sampled along a ramp. */
export function rampColors(name: string, n: number): RGB[] {
  const stops = RAMPS[name] ?? RAMPS["blue-red"];
  if (n <= 1) return [stops[stops.length - 1]];
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    const f = t - k;
    return [0, 1, 2].map((c) => Math.round(stops[k][c] + f * (stops[k + 1][c] - stops[k][c]))) as RGB;
  });
}

/** Inner limits (n - 1 values) of `n` classes over the finite values. */
export function computeBreaks(values: ArrayLike<number>, method: ClassMethod, n: number): number[] {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0 || n < 2) return [];
  if (method === "quantile") {
    finite.sort((a, b) => a - b);
    const out: number[] = [];
    for (let k = 1; k < n; k++) out.push(finite[Math.min(finite.length - 1, Math.floor((k * finite.length) / n))]);
    return dedupe(out);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of finite) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi === lo) return [lo];
  return Array.from({ length: n - 1 }, (_, k) => nice(lo + ((k + 1) * (hi - lo)) / n, (hi - lo) / n));
}

function dedupe(a: number[]): number[] {
  return a.filter((v, i) => i === 0 || v > a[i - 1]);
}

/** Rounds to 2 significant digits of the class width. */
function nice(v: number, width: number): number {
  if (width <= 0) return v;
  const step = Math.pow(10, Math.floor(Math.log10(width)) - 1);
  return Math.round(v / step) * step;
}

/** Class of a value: 0 .. breaks.length; -1 for NaN. */
export function classOf(v: number, breaks: number[]): number {
  if (!Number.isFinite(v)) return -1;
  let k = 0;
  while (k < breaks.length && v > breaks[k]) k++;
  return k;
}

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  if (a >= 100) return v.toFixed(1).replace(/\.0$/, "");
  return Number(v.toPrecision(4)).toString();
}
