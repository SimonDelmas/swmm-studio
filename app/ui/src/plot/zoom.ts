// The time zoom of a time series view: zooming in and out around a time, panning, and the
// zoom history (back / forward), shared by the graphs of the view.

import { updatePlotView } from "../actions/views";
import { periodMs } from "../format";
import { getState } from "../store";
import type { ResultsInfo } from "../types";
import type { PlotView } from "../uiTypes";

export type Zoom = [number, number] | null;

/** Zooms kept to go back to (and forward again). */
const HISTORY = 50;
/** Changes closer in time than this are one step of the history (a wheel turn, a pan drag). */
const GESTURE_MS = 600;

/** The whole run in seconds. */
export function runRange(r: ResultsInfo): [number, number] {
  return [r.start_ms / 1000, periodMs(r, Math.max(1, r.n_periods - 1)) / 1000];
}

/** The time range a view shows, in seconds. */
export function shownRange(r: ResultsInfo, v: PlotView): [number, number] {
  return v.zoom ?? runRange(r);
}

/**
 * The zoom `z` kept within the run, at least 2 time steps wide; null when it covers the
 * whole run. A zoom wider than the run is shifted back into it before being cut.
 */
export function clampZoom(r: ResultsInfo, z: Zoom): Zoom {
  if (!z) return null;
  const [r0, r1] = runRange(r);
  let [a, b] = z[0] <= z[1] ? z : [z[1], z[0]];
  const min = Math.min(r1 - r0, 2 * r.step_secs);
  if (b - a < min) {
    const c = (a + b) / 2;
    [a, b] = [c - min / 2, c + min / 2];
  }
  const w = b - a;
  if (a < r0) [a, b] = [r0, r0 + w];
  if (b > r1) [a, b] = [r1 - w, r1];
  a = Math.max(r0, a);
  b = Math.min(r1, b);
  // A few seconds short of the whole run is the whole run.
  if (a <= r0 + 1e-6 && b >= r1 - 1e-6) return null;
  return [a, b];
}

const same = (a: Zoom, b: Zoom) => (a === null ? b === null : b !== null && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6);

let lastGesture = { view: 0, t: 0 };

/**
 * Zooms a view to `z` (seconds; null: the whole run). The zoom left goes to the history,
 * once per gesture when `gesture` (the steps of a wheel turn or of a pan are one step back).
 */
export function setZoom(viewId: number, z: Zoom, gesture = false) {
  const r = getState().model?.results;
  if (!r) return;
  const next = clampZoom(r, z);
  const now = performance.now();
  const continues = gesture && lastGesture.view === viewId && now - lastGesture.t < GESTURE_MS;
  lastGesture = gesture ? { view: viewId, t: now } : { view: 0, t: 0 };
  updatePlotView(viewId, (v) => {
    if (same(v.zoom, next)) return {};
    const back = continues ? (v.zoomBack ?? []) : [...(v.zoomBack ?? []), v.zoom].slice(-HISTORY);
    return { zoom: next, zoomBack: back, zoomForward: [] };
  });
}

/** Goes back to the previous zoom of a view. */
export function zoomBack(viewId: number) {
  lastGesture = { view: 0, t: 0 };
  updatePlotView(viewId, (v) => {
    const back = v.zoomBack ?? [];
    if (back.length === 0) return {};
    return { zoom: back[back.length - 1], zoomBack: back.slice(0, -1), zoomForward: [v.zoom, ...(v.zoomForward ?? [])] };
  });
}

/** Goes forward again to the zoom left by `zoomBack`. */
export function zoomForward(viewId: number) {
  lastGesture = { view: 0, t: 0 };
  updatePlotView(viewId, (v) => {
    const fwd = v.zoomForward ?? [];
    if (fwd.length === 0) return {};
    return { zoom: fwd[0], zoomBack: [...(v.zoomBack ?? []), v.zoom].slice(-HISTORY), zoomForward: fwd.slice(1) };
  });
}

/**
 * Scales the range a view shows by `factor` (< 1 zooms in), keeping the time `at` (seconds;
 * default the middle) at the same place.
 */
export function zoomBy(viewId: number, factor: number, at?: number, gesture = false) {
  const s = getState();
  const r = s.model?.results;
  const v = s.plotViews.find((x) => x.id === viewId);
  if (!r || !v) return;
  const [a, b] = shownRange(r, v);
  const c = at ?? (a + b) / 2;
  setZoom(viewId, [c - (c - a) * factor, c + (b - c) * factor], gesture);
}

/** Moves the range a view shows by `fraction` of its width (> 0: later). */
export function panBy(viewId: number, fraction: number, gesture = false) {
  const s = getState();
  const r = s.model?.results;
  const v = s.plotViews.find((x) => x.id === viewId);
  if (!r || !v || !v.zoom) return;
  const d = (v.zoom[1] - v.zoom[0]) * fraction;
  setZoom(viewId, [v.zoom[0] + d, v.zoom[1] + d], gesture);
}
