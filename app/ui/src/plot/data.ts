// Data of a graph: fetching the series of a view and shaping them for uPlot.

import uPlot from "uplot";
import { api, errorText } from "../api";
import { observedLink } from "../actions/observed";
import { resultsName } from "../actions/runs";
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
  /**
   * The series from the results of other runs (overlays), after the series in `data` and
   * before the observed values (none for aggregates).
   */
  runs: RunPlot[];
  /** Observed values drawn as points, after the runs in `data` (none for aggregates). */
  obs: ObservedPlot[];
  /** Observed files that could not be read. */
  obsErrors: string[];
  /** Series of other runs that could not be read (the object is not in the run…). */
  runErrors: string[];
}

/** Series `parent` of a graph from the results of another run (same axis and colour, dashed). */
export interface RunPlot {
  parent: number;
  /** Index of the run among the overlays (its dash pattern). */
  run: number;
  label: string;
}

/**
 * Identity of each drawn line, in the order of `data` after x (series, other runs, observed
 * values): what the legend hides, kept when the chart is made again.
 */
export const drawnIds = (b: Built): string[] => [
  ...b.series.map((p) => p.key),
  ...b.runs.map((r) => `run:${b.series[r.parent]?.key}:${r.run}`),
  ...b.obs.map((o) => `obs:${b.series[o.parent]?.key}:${o.label}`),
];

/** Dash patterns of the runs overlaid on the graphs, in order. */
const RUN_DASHES = [[6, 3], [2, 2], [10, 3, 2, 3], [1, 4], [12, 4]];
export const runDash = (run: number) => RUN_DASHES[run % RUN_DASHES.length];

/** Observed values of series `parent` of a graph (same axis and colour). */
export interface ObservedPlot {
  parent: number;
  label: string;
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
    return { series: plot, data: align(tables), decimated: false, units: all.map((a) => a.unit), stepped: true, runs: [], obs: [], obsErrors: [], runErrors: [] };
  }
  const m = getState().model;
  const observed = fetchObserved(results, plot, [p0, p1], width);
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
  const runs = await fetchRuns(results, plot, [p0, p1], width);
  const obs = await observed;
  return {
    series: plot,
    data: align([...all.map((a) => a.t), ...runs.tables, ...obs.tables]),
    decimated: all.some((a) => a.decimated) || runs.decimated,
    units: plot.map((p) => p.unit),
    stepped: false,
    runs: runs.series,
    obs: obs.series,
    obsErrors: obs.errors,
    runErrors: runs.errors,
  };
}

/**
 * The plotted series (not run B's) from the results of the runs overlaid on the graphs,
 * over the times of periods `[p0, p1)` of the loaded results.
 */
async function fetchRuns(
  results: ResultsInfo,
  plot: PlotSeries[],
  [p0, p1]: [number, number],
  width: number,
): Promise<{ series: RunPlot[]; tables: Table[]; decimated: boolean; errors: string[] }> {
  const overlays = (getState().model?.overlays ?? []).filter((o) => o.path !== results.path);
  const wanted = plot.flatMap((s, parent) => {
    if (s.b) return [];
    const name = results.variables[s.kind][s.var]?.name;
    return overlays.flatMap((o, run) => {
      // The variable by name: the runs may not have the same pollutants.
      const v = o.variables[s.kind]?.findIndex((x) => x.name === name) ?? -1;
      return v < 0 ? [] : [{ s, parent, run, o, v, label: `${s.label} [${resultsName(o.path)}]` }];
    });
  });
  const got = await Promise.all(
    wanted.map(async (w) => {
      // Same time range in the other run.
      const [q0, q1] = [periodAt(w.o, periodMs(results, p0)), periodAt(w.o, periodMs(results, p1 - 1)) + 1];
      try {
        const mm = await api.series(w.s.kind, w.s.index, w.v, q0, q1, Math.max(100, width), false, w.o.path);
        return { w, t: table(w.o, mm, q1), e: null };
      } catch (e) {
        return { w, t: null, e: `${w.label}: ${errorText(e)}` };
      }
    }),
  );
  const series: RunPlot[] = [];
  const tables: Table[] = [];
  const errors: string[] = [];
  let decimated = false;
  for (const { w, t, e } of got) {
    if (e) errors.push(e);
    if (!t) continue;
    series.push({ parent: w.parent, run: w.run, label: w.label });
    tables.push(t.t);
    decimated ||= t.decimated;
  }
  return { series, tables, decimated, errors };
}

/**
 * Observed values of the plotted results (not run B's) whose object has a file linked,
 * over the times of periods `[p0, p1)`. A file that cannot be read gives a message, not an error.
 */
async function fetchObserved(
  results: ResultsInfo,
  plot: PlotSeries[],
  [p0, p1]: [number, number],
  width: number,
): Promise<{ series: ObservedPlot[]; tables: Table[]; errors: string[] }> {
  const t0 = periodMs(results, p0);
  const t1 = periodMs(results, Math.max(p0, p1 - 1));
  const wanted = plot.flatMap((s, parent) => {
    if (s.b || s.kind === "system" || !s.id) return [];
    const name = results.variables[s.kind][s.var]?.name;
    const link = name ? observedLink(s.kind, s.id) : undefined;
    return link && name && link.columns[name] ? [{ parent, name, link, label: `${s.label} observed` }] : [];
  });
  const got = await Promise.all(
    wanted.map((w) =>
      api.observedSeries(w.link.kind, w.link.id, w.name, t0, t1, Math.max(100, width)).then(
        (r) => ({ w, r, e: null }),
        (e) => ({ w, r: null, e: `${w.label}: ${errorText(e)}` }),
      ),
    ),
  );
  const series: ObservedPlot[] = [];
  const tables: Table[] = [];
  const errors: string[] = [];
  for (const { w, r, e } of got) {
    if (e) errors.push(e);
    if (!r || r.times.length === 0) continue;
    series.push({ parent: w.parent, label: w.label });
    tables.push([Array.from(r.times, (t) => t / 1000), Array.from(r.values, (v) => (Number.isFinite(v) ? v : null))]);
  }
  return { series, tables, errors };
}
