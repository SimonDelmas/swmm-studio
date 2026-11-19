// X-Y (scatter) plots: one result variable against another at the same times, for one
// object or across objects. Their data, their drawing on a canvas and their exports.

import { api } from "../api";
import { chartSvg, ticks } from "../chartSvg";
import { formatDateTime, formatNumber, periodMs } from "../format";
import { ensureIds } from "../actions/ids";
import type { ElementKind, ResultsInfo } from "../types";
import type { PlotSeries, XYPair } from "../uiTypes";
import { COLORS, makeSeries } from "./series";

/** Points of a pair at most: longer runs are read one period in `stride`. */
export const MAX_POINTS = 20_000;

/** What an X-Y graph draws. */
export interface XYBuilt {
  /** The pairs the values were fetched for (the view may already have changed). */
  pairs: XYPair[];
  /** Values of each pair at periods `0, stride, 2 stride…` (NaN: no value). */
  xs: Float32Array[];
  ys: Float32Array[];
  stride: number;
}

/** Reads every `stride`-th period of the series (the same periods for all, so they pair up). */
export async function fetchXY(results: ResultsInfo, pairs: XYPair[]): Promise<XYBuilt> {
  const n = results.n_periods;
  const stride = Math.max(1, Math.ceil(n / MAX_POINTS));
  // A series in several pairs (a fixed X) is read once.
  const read = new Map<string, Promise<Float32Array>>();
  const values = (s: PlotSeries) => {
    let p = read.get(s.key);
    if (!p) read.set(s.key, (p = api.seriesValues(s.kind, s.index, s.var, 0, n, stride)));
    return p;
  };
  const xs = await Promise.all(pairs.map((p) => values(p.x)));
  const ys = await Promise.all(pairs.map((p) => values(p.y)));
  return { pairs, xs, ys, stride };
}

/** The name of a series without its object (its variable), and the object's name. */
const varName = (s: PlotSeries) => (s.id && s.label.startsWith(`${s.id} `) ? s.label.slice(s.id.length + 1) : s.label);

/** "J1 Flow vs Depth" for one object, "C2 Flow vs J1 Depth" across objects. */
export function pairLabel(p: XYPair): string {
  if (p.x.kind === p.y.kind && p.x.index === p.y.index) return `${p.y.label} vs ${varName(p.x)}`;
  return `${p.y.label} vs ${p.x.label}`;
}

/** Title of an axis: the variables plotted on it, with their units. */
export function axisTitle(series: PlotSeries[]): string {
  const names = Array.from(new Set(series.map((s) => `${varName(s)} (${s.unit})`)));
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
}

/** Default x and y variables of a kind: the usual pairs (depth-flow, rainfall-runoff). */
export const XY_DEFAULTS: Record<ElementKind, [number, number]> = {
  node: [4, 0],
  link: [1, 0],
  subcatchment: [0, 4],
  system: [1, 4],
};

/** A pair of series of the loaded results (null when a variable is not in them). */
export async function makePair(x: { kind: ElementKind; index: number; var: number } | PlotSeries, kind: ElementKind, index: number, yVar: number): Promise<XYPair | null> {
  await ensureIds([x.kind, kind].filter((k) => k !== "system"));
  const xs = "key" in x ? x : makeSeries(x.kind, x.index, x.var, false);
  const ys = makeSeries(kind, index, yVar, false);
  if (!xs || !ys || xs.key === ys.key) return null;
  return { key: `${xs.key}|${ys.key}`, x: xs, y: ys };
}

/** Lower and upper value of the finite values of arrays, padded by 5% (null: none). */
function extent(arrays: Float32Array[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays)
    for (const v of a)
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  if (!Number.isFinite(lo)) return null;
  if (hi === lo) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

/** Value ranges shown on the axes (x, then y). */
export type XYRange = { x: [number, number]; y: [number, number] };

export function dataRange(b: XYBuilt): XYRange | null {
  const x = extent(b.xs);
  const y = extent(b.ys);
  return x && y ? { x, y } : null;
}

/** Where the plot area is in a canvas of `w` × `h` CSS pixels. */
export function plotBox(w: number, h: number) {
  const m = { l: 64, r: 16, t: 10, b: 40 };
  return { l: m.l, t: m.t, w: Math.max(10, w - m.l - m.r), h: Math.max(10, h - m.t - m.b) };
}

/** Converts values to CSS pixels of the canvas and back. */
export function scales(range: XYRange, box: ReturnType<typeof plotBox>) {
  const [x0, x1] = range.x;
  const [y0, y1] = range.y;
  return {
    px: (x: number) => box.l + ((x - x0) / (x1 - x0)) * box.w,
    py: (y: number) => box.t + box.h - ((y - y0) / (y1 - y0)) * box.h,
    vx: (px: number) => x0 + ((px - box.l) / box.w) * (x1 - x0),
    vy: (py: number) => y0 + ((box.t + box.h - py) / box.h) * (y1 - y0),
  };
}

export interface DrawOptions {
  lines: boolean;
  /** Index of the point at the current time (marked), or -1. */
  current: number;
  /** Pair index and point index under the pointer (marked), or null. */
  hover: [number, number] | null;
  /** Zoom rectangle being dragged, in CSS pixels. */
  select: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Draws the graph on a canvas sized `w` × `h` CSS pixels (at the device pixel ratio). */
export function drawXY(canvas: HTMLCanvasElement, b: XYBuilt, range: XYRange, w: number, h: number, o: DrawOptions, fg: string) {
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const box = plotBox(w, h);
  const { px, py } = scales(range, box);
  // Grid, tick labels and axis titles.
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = fg;
  ctx.strokeStyle = "rgba(128,128,128,0.15)";
  ctx.lineWidth = 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of ticks(range.x[0], range.x[1], Math.max(2, Math.floor(box.w / 90)))) {
    const x = Math.round(px(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, box.t);
    ctx.lineTo(x, box.t + box.h);
    ctx.stroke();
    ctx.fillText(formatNumber(t), x, box.t + box.h + 4);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of ticks(range.y[0], range.y[1], Math.max(2, Math.floor(box.h / 40)))) {
    const y = Math.round(py(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(box.l, y);
    ctx.lineTo(box.l + box.w, y);
    ctx.stroke();
    ctx.fillText(formatNumber(t), box.l - 4, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(axisTitle(b.pairs.map((p) => p.x)), box.l + box.w / 2, h - 2);
  ctx.save();
  ctx.translate(12, box.t + box.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "middle";
  ctx.fillText(axisTitle(b.pairs.map((p) => p.y)), 0, 0);
  ctx.restore();
  ctx.strokeStyle = "rgba(128,128,128,0.6)";
  ctx.strokeRect(box.l + 0.5, box.t + 0.5, box.w, box.h);
  // Series, clipped to the plot area.
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.l, box.t, box.w, box.h);
  ctx.clip();
  b.pairs.forEach((_, i) => {
    const xs = b.xs[i];
    const ys = b.ys[i];
    const color = COLORS[i % COLORS.length];
    const n = Math.min(xs.length, ys.length);
    if (o.lines) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < n; k++) {
        if (!Number.isFinite(xs[k]) || !Number.isFinite(ys[k])) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(px(xs[k]), py(ys[k]));
        else ctx.moveTo(px(xs[k]), py(ys[k]));
        pen = true;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = color;
    for (let k = 0; k < n; k++) {
      if (!Number.isFinite(xs[k]) || !Number.isFinite(ys[k])) continue;
      ctx.fillRect(px(xs[k]) - 1.5, py(ys[k]) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  });
  // The point at the current time, and the one under the pointer.
  const ring = (i: number, k: number, color: string, r: number) => {
    const x = b.xs[i]?.[k];
    const y = b.ys[i]?.[k];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px(x), py(y), r, 0, 2 * Math.PI);
    ctx.stroke();
  };
  if (o.current >= 0) b.pairs.forEach((_, i) => ring(i, o.current, "#e5534b", 5));
  if (o.hover) ring(o.hover[0], o.hover[1], fg, 6);
  ctx.restore();
  if (o.select) {
    const { x0, y0, x1, y1 } = o.select;
    ctx.fillStyle = "rgba(100,150,255,0.15)";
    ctx.strokeStyle = "rgba(100,150,255,0.8)";
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
}

/** The point nearest to (`cx`, `cy`) CSS pixels within `radius` pixels: [pair, point index]. */
export function nearestPoint(b: XYBuilt, range: XYRange, w: number, h: number, cx: number, cy: number, radius = 8): [number, number] | null {
  const { px, py } = scales(range, plotBox(w, h));
  let best: [number, number] | null = null;
  let bd = radius * radius;
  b.pairs.forEach((_, i) => {
    const xs = b.xs[i];
    const ys = b.ys[i];
    for (let k = 0; k < Math.min(xs.length, ys.length); k++) {
      if (!Number.isFinite(xs[k]) || !Number.isFinite(ys[k])) continue;
      const dx = px(xs[k]) - cx;
      const dy = py(ys[k]) - cy;
      const d = dx * dx + dy * dy;
      if (d <= bd) ((bd = d), (best = [i, k]));
    }
  });
  return best;
}

/** Time (ms) of point `k` of a graph. */
export const pointMs = (r: ResultsInfo, b: XYBuilt, k: number) => periodMs(r, k * b.stride);

/** Text of the point `k` of pair `i`: what it is, its values and its time. */
export function pointText(r: ResultsInfo, b: XYBuilt, i: number, k: number): string {
  const p = b.pairs[i];
  return `${pairLabel(p)}\n${varName(p.x)} ${formatNumber(b.xs[i][k])} ${p.x.unit}, ${varName(p.y)} ${formatNumber(b.ys[i][k])} ${p.y.unit}\n${formatDateTime(pointMs(r, b, k))}`;
}

/** The values plotted as a table: the time, then each series once (a fixed X is one column). */
export function xyTable(r: ResultsInfo, b: XYBuilt): { head: string[]; rows: (string | number | null)[][] } {
  const cols: { s: PlotSeries; v: Float32Array }[] = [];
  b.pairs.forEach((p, i) => {
    if (!cols.some((c) => c.s.key === p.x.key)) cols.push({ s: p.x, v: b.xs[i] });
    if (!cols.some((c) => c.s.key === p.y.key)) cols.push({ s: p.y, v: b.ys[i] });
  });
  const n = Math.max(0, ...cols.map((c) => c.v.length));
  const head = ["time", ...cols.map((c) => `${c.s.label} (${c.s.unit})`)];
  const rows = Array.from({ length: n }, (_, k) => [
    formatDateTime(pointMs(r, b, k), true),
    ...cols.map((c) => (Number.isFinite(c.v[k]) ? c.v[k] : null)),
  ]);
  return { head, rows };
}

/** The graph as a standalone SVG document (in the `range` shown). */
export function xySvg(b: XYBuilt, range: XYRange, lines: boolean, size: { w: number; h: number }): string {
  const yTitle = axisTitle(b.pairs.map((p) => p.y));
  const inRange = (x: number, y: number) => x >= range.x[0] && x <= range.x[1] && y >= range.y[0] && y <= range.y[1];
  return chartSvg(
    b.pairs.map((p, i) => {
      const x: number[] = [];
      const y: (number | null)[] = [];
      const n = Math.min(b.xs[i].length, b.ys[i].length);
      for (let k = 0; k < n; k++) {
        const a = b.xs[i][k];
        const c = b.ys[i][k];
        const ok = Number.isFinite(a) && Number.isFinite(c) && inRange(a, c);
        // A point out of the range shown breaks the line.
        if (ok || lines) (x.push(ok ? a : range.x[0]), y.push(ok ? c : null));
      }
      return { label: pairLabel(p), unit: yTitle, color: COLORS[i % COLORS.length], x, y, points: true, joined: lines };
    }),
    { width: Math.max(600, size.w), height: Math.max(320, size.h), xLabel: (t) => formatNumber(t), xTitle: axisTitle(b.pairs.map((p) => p.x)), xRange: range.x, yRange: range.y, legendUnits: false },
  );
}

