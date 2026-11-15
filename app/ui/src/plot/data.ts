// Data of a graph: fetching the series of a view and shaping them for uPlot.

import uPlot from "uplot";
import { api } from "../api";
import { periodAt, periodMs } from "../format";
import { getState } from "../store";
import { makeStat, type PlotAgg, type PlotSeries } from "../uiTypes";
import type { ResultsInfo } from "../types";

/** What a graph draws. */
export interface Built {
  /** The series `data` was fetched for (the graph may already have changed). */
  series: PlotSeries[];
  data: uPlot.AlignedData;
  decimated: boolean;
  units: string[];
  stepped: boolean;
}

type Table = [number[], (number | null)[]];

/** x in seconds; decimated buckets become (min at start, max at mid-bucket) pairs. */
function table(r: ResultsInfo, s: { periods: Uint32Array; min: Float32Array; max: Float32Array }, p1: number): { t: Table; decimated: boolean } {
  const n = s.periods.length;
  const decimated = n > 0 && n < p1 - s.periods[0];
  const t = (p: number) => periodMs(r, p) / 1000;
  const fin = (v: number) => (Number.isFinite(v) ? v : null);
  if (!decimated) return { t: [Array.from(s.periods, t), Array.from(s.min, fin)], decimated };
  const x: number[] = [];
  const y: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = s.periods[i];
    const b = i + 1 < n ? s.periods[i + 1] : p1;
    x.push(t(a), t(a + (b - a) / 2));
    y.push(fin(s.min[i]), fin(s.max[i]));
  }
  return { t: [x, y], decimated };
}

/** Aligns series on one x axis (they differ when runs A and B have other periods). */
function align(tables: Table[]): uPlot.AlignedData {
  const x0 = tables[0][0];
  const same = tables.every((t) => t[0].length === x0.length && t[0].every((v, i) => v === x0[i]));
  if (same) return [x0, ...tables.map((t) => t[1])] as uPlot.AlignedData;
  return uPlot.join(tables as unknown as uPlot.AlignedData[]);
}

/** Period range [p0, p1) of a zoom in seconds. */
export function zoomPeriods(r: ResultsInfo, zoom: [number, number] | null): [number, number] {
  if (!zoom) return [0, r.n_periods];
  const toP = (s: number) => (s * 1000 - r.start_ms) / (r.step_secs * 1000);
  return [Math.max(0, Math.floor(toP(zoom[0]))), Math.min(r.n_periods, Math.ceil(toP(zoom[1])) + 1)];
}

/** Why the results cache is not ready, for a message. */
export function cacheReason(r: ResultsInfo): string {
  const c = r.cache;
  if (c.state === "building") return `being built, ${Math.round(c.progress * 100)}%`;
  if (c.state === "ready") return "ready";
  return c.message;
}

/**
 * Fetches the series of a graph over the periods `[p0, p1)` of the loaded results (the
 * same time range in run B), about one min/max pair per pixel of `width`; with `agg`,
 * their daily, monthly or yearly statistics over the whole run.
 */
export async function fetchGraph(
  results: ResultsInfo,
  plot: PlotSeries[],
  agg: PlotAgg | null,
  [p0, p1]: [number, number],
  width: number,
): Promise<Built> {
  if (agg) {
    const stat = makeStat(agg.stat, agg.threshold);
    const all = await Promise.all(plot.map((s) => api.aggregate(s.kind, s.index, s.var, agg.unit, stat, !!s.b)));
    // The last step ends with its interval.
    const tables = all.map((a) => {
      const x = a.starts_ms.map((ms) => ms / 1000);
      const y: (number | null)[] = a.values.map((v) => (Number.isFinite(v) ? v : null));
      if (a.end_ms !== null && y.length) (x.push(a.end_ms / 1000), y.push(y[y.length - 1]));
      return [x, y] as Table;
    });
    return { series: plot, data: align(tables), decimated: false, units: all.map((a) => a.unit), stepped: true };
  }
  const m = getState().model;
  const all = await Promise.all(
    plot.map(async (s) => {
      const r = s.b ? m?.compare : m?.results;
      if (!r) throw new Error("the compared results are no longer loaded");
      // Same time range in the other run.
      const [q0, q1] = s.b ? [periodAt(r, periodMs(results, p0)), periodAt(r, periodMs(results, p1 - 1)) + 1] : [p0, p1];
      const mm = await api.series(s.kind, s.index, s.var, q0, q1, Math.max(100, width), !!s.b);
      return table(r, mm, q1);
    }),
  );
  return {
    series: plot,
    data: align(all.map((a) => a.t)),
    decimated: all.some((a) => a.decimated),
    units: plot.map((p) => p.unit),
    stepped: false,
  };
}
