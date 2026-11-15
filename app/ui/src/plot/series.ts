// Series of the time series tabs: what a plotted series is and how one is added to a view.

import { ensureIds } from "../actions/ids";
import { setSeriesDropHandler } from "../dragSeries";
import { currentPlotView, getState, newPlotId, newPlotView, setState, type PlotSeries } from "../store";
import type { ElementKind } from "../types";

/** Colours of the series of a graph, in order. */
export const COLORS = ["#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#17becf"];

export const seriesKey = (kind: string, index: number, v: number, b?: boolean) => `${kind}:${index}:${v}${b ? ":b" : ""}`;

/** A series of the loaded (or compared) results, labelled with the object's name. */
export function makeSeries(kind: ElementKind, index: number, v: number, b: boolean): PlotSeries | null {
  const s = getState();
  const r = b ? s.model?.compare : s.model?.results;
  const info = r?.variables[kind][v];
  if (!info) return null;
  const id = kind === "system" ? "System" : (s.ids[kind]?.[index] ?? `${kind} #${index + 1}`);
  const label = `${id} ${info.name}${b ? " [B]" : ""}`;
  return { key: seriesKey(kind, index, v, b), kind, index, id: kind === "system" ? undefined : id, var: v, label, unit: info.unit, b };
}

/**
 * Adds an object (or the system) with variable `v`, from the loaded or the compared results,
 * to plot view `viewId` (default: the time series tab shown, else a new tab; `new`: a new
 * tab), to graph `target` (default: the view's target; `new`: a new graph). Returns the
 * graph it went to.
 */
export async function addToPlot(
  kind: ElementKind,
  index: number,
  v: number,
  b = false,
  target?: number | "new",
  viewId?: number | "new",
): Promise<number | null> {
  await ensureIds([kind]);
  const series = makeSeries(kind, index, v, b);
  if (!series) return null;
  const s = getState();
  const existing =
    viewId === "new" ? undefined : viewId !== undefined ? s.plotViews.find((x) => x.id === viewId) : s.bottomTab === "plot" ? currentPlotView(s) : undefined;
  const view = existing ?? newPlotView(series.label);
  const t = target ?? view.target;
  let graphs = view.graphs;
  const last = graphs[graphs.length - 1];
  let gid: number;
  if (t === "new") {
    gid = last.series.length === 0 ? last.id : newPlotId();
    if (gid !== last.id) graphs = [...graphs, { id: gid, series: [] }];
  } else gid = graphs.some((g) => g.id === t) ? t : last.id;
  graphs = graphs.map((g) => (g.id === gid && !g.series.some((p) => p.key === series.key) ? { ...g, series: [...g.series, series] } : g));
  const plotViews = existing ? s.plotViews.map((x) => (x.id === view.id ? { ...x, graphs } : x)) : [...s.plotViews, { ...view, graphs }];
  setState({ plotViews, plotView: view.id, bottomTab: "plot" });
  return gid;
}

// A result dragged from the properties panel: to the graph dropped on, or the view's target.
setSeriesDropHandler((d, t) => void addToPlot(d.kind, d.index, d.var, false, t.graph, t.view));
