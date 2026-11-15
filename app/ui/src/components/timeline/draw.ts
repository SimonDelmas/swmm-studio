// Drawing of the timeline strip: the overview of a system variable, the time axis and
// the cursor of the current period.

import { formatDateTime, periodMs } from "../../format";
import { cssVar } from "../../hooks/useSize";
import type { MinMaxSeries, ResultsInfo } from "../../types";

/** Height of the strip in pixels. */
const HEIGHT = 64;
/** The overview is drawn between these, the axis under it. */
const OVERVIEW_TOP = 4;
const OVERVIEW_BOTTOM = 42;
const AXIS_Y = 44;

const TICKS_MS = [
  60e3,
  5 * 60e3,
  15 * 60e3,
  3600e3,
  3 * 3600e3,
  6 * 3600e3,
  12 * 3600e3,
  86400e3,
  2 * 86400e3,
  7 * 86400e3,
  30 * 86400e3,
  91 * 86400e3,
  365 * 86400e3,
  5 * 365 * 86400e3,
];

/** Tick positions (ms), aligned on calendar months / years for long steps. */
function timeTicks(t0: number, t1: number, step: number): number[] {
  const out: number[] = [];
  if (step >= 30 * 86400e3) {
    const months = step >= 365 * 86400e3 ? 12 * Math.round(step / (365 * 86400e3)) : Math.round(step / (30 * 86400e3));
    const d = new Date(t0);
    let y = d.getUTCFullYear();
    let m = months >= 12 ? 0 : Math.floor(d.getUTCMonth() / months) * months;
    for (let i = 0; i < 1000; i++) {
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      if (t >= t0) out.push(t);
      m += months;
      y += Math.floor(m / 12);
      m %= 12;
    }
    return out;
  }
  for (let t = Math.ceil(t0 / step) * step; t <= t1 && out.length < 1000; t += step) out.push(t);
  return out;
}

function tickLabel(t: number, step: number): string {
  const s = formatDateTime(t);
  if (step >= 365 * 86400e3) return s.slice(0, 4);
  if (step >= 30 * 86400e3) return s.slice(0, 7);
  if (step >= 86400e3) return s.slice(0, 10);
  return s.slice(11) === "00:00" ? s.slice(0, 10) : s.slice(11);
}

export interface TimelineScene {
  width: number;
  results: ResultsInfo | null;
  /** Periods at the left and right edges. */
  view: [number, number];
  period: number;
  overview: MinMaxSeries | null;
}

/** Bars of the overview, scaled to its highest value. */
function drawOverview(ctx: CanvasRenderingContext2D, s: MinMaxSeries, x: (p: number) => number, end: number) {
  let hi = 0;
  for (let i = 0; i < s.max.length; i++) if (Number.isFinite(s.max[i])) hi = Math.max(hi, s.max[i]);
  ctx.fillStyle = cssVar("--accent", "#1f6feb") + "55";
  for (let i = 0; i < s.periods.length; i++) {
    const a = x(s.periods[i]);
    const b = i + 1 < s.periods.length ? x(s.periods[i + 1]) : x(end);
    const y = hi > 0 ? OVERVIEW_BOTTOM - (s.max[i] / hi) * (OVERVIEW_BOTTOM - OVERVIEW_TOP) : OVERVIEW_BOTTOM;
    ctx.fillRect(a, y, Math.max(1, b - a), OVERVIEW_BOTTOM - y);
  }
}

/** The time axis: ticks about 90 pixels apart, on round times. */
function drawAxis(ctx: CanvasRenderingContext2D, t0: number, t1: number, width: number) {
  const msPerPx = (t1 - t0) / width;
  const step = TICKS_MS.find((s) => s / msPerPx > 90) ?? TICKS_MS[TICKS_MS.length - 1];
  ctx.strokeStyle = cssVar("--muted", "#888");
  ctx.fillStyle = cssVar("--fg", "#222");
  ctx.font = "11px system-ui, sans-serif";
  ctx.beginPath();
  ctx.moveTo(0, AXIS_Y + 0.5);
  ctx.lineTo(width, AXIS_Y + 0.5);
  ctx.stroke();
  for (const t of timeTicks(t0, t1, step)) {
    const px = ((t - t0) / (t1 - t0)) * width;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, AXIS_Y);
    ctx.lineTo(px + 0.5, AXIS_Y + 6);
    ctx.stroke();
    ctx.fillText(tickLabel(t, step), px + 3, AXIS_Y + 16);
  }
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number) {
  ctx.strokeStyle = "#e5534b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, AXIS_Y + 6);
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Sizes the canvas for the screen and draws the strip. */
export function drawTimeline(canvas: HTMLCanvasElement, scene: TimelineScene) {
  const { width, results, view, period, overview } = scene;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = HEIGHT * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${HEIGHT}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, HEIGHT);
  if (!results) return;
  const [v0, v1] = view;
  const x = (p: number) => ((p - v0) / (v1 - v0 || 1)) * width;
  if (overview && overview.periods.length > 0) drawOverview(ctx, overview, x, v1);
  drawAxis(ctx, periodMs(results, v0), periodMs(results, v1), width);
  drawCursor(ctx, x(period));
}
