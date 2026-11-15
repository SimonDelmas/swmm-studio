// Plot views saved in the project: objects by ID and variables by name, since indices
// change from one run or one edit to the next.

import { ensureIds } from "../actions/ids";
import { updateProjectUi } from "../actions/project";
import {
  currentPlotView,
  getState,
  newPlotId,
  newPlotView,
  notify,
  openPlotView,
  setState,
  updatePlotView,
  type PlotAgg,
  type PlotGraph,
  type PlotSeries,
} from "../store";
import type { ElementKind } from "../types";
import { makeSeries } from "./series";

/** A plot view saved in the project: objects by ID and variables by name (indices change). */
export interface SavedPlotView {
  name: string;
  agg: PlotAgg | null;
  graphs: { kind: ElementKind; id?: string; var: string; b?: boolean }[][];
}

const NONE: SavedPlotView[] = [];

export function savedPlotViews(s = getState()): SavedPlotView[] {
  const list = s.model?.project.ui.plotViews;
  return Array.isArray(list) ? (list as SavedPlotView[]) : NONE;
}

function storePlotViews(list: SavedPlotView[]) {
  updateProjectUi({ plotViews: list });
}

/** Saves a view (default: the open one) under `name` (replaces a view of the same name) and names its tab so. */
export function savePlotView(name: string, viewId?: number) {
  const s = getState();
  const view = viewId !== undefined ? s.plotViews.find((v) => v.id === viewId) : currentPlotView(s);
  if (!view) return;
  const varName = (p: PlotSeries) => (p.b ? s.model?.compare : s.model?.results)?.variables[p.kind][p.var]?.name ?? "";
  const graphs = view.graphs
    .filter((g) => g.series.length > 0)
    .map((g) => g.series.map((p) => ({ kind: p.kind, id: p.id, var: varName(p), ...(p.b ? { b: true } : {}) })));
  storePlotViews([...savedPlotViews().filter((v) => v.name !== name), { name, agg: view.agg, graphs }]);
  updatePlotView(view.id, { name });
}

export function deletePlotView(name: string) {
  storePlotViews(savedPlotViews().filter((v) => v.name !== name));
}

/** Rebuilds a saved view from the current results, in the time series tab shown if it is empty, else in a new tab. */
export async function loadPlotView(name: string) {
  const saved = savedPlotViews().find((v) => v.name === name);
  const m = getState().model;
  if (!saved || !m?.results) return;
  await ensureIds(saved.graphs.flat().map((p) => p.kind));
  const ids = getState().ids;
  const missing: string[] = [];
  const graphs: PlotGraph[] = [];
  for (const list of saved.graphs) {
    const series: PlotSeries[] = [];
    for (const p of list) {
      const r = p.b ? m.compare : m.results;
      const v = r?.variables[p.kind]?.findIndex((x) => x.name === p.var) ?? -1;
      const index = p.kind === "system" ? 0 : (ids[p.kind]?.findIndex((x) => x.toUpperCase() === p.id?.toUpperCase()) ?? -1);
      const made = v >= 0 && index >= 0 ? makeSeries(p.kind, index, v, !!p.b) : null;
      if (made) series.push(made);
      else missing.push(`${p.id ?? "System"} ${p.var}${p.b ? " [B]" : ""}`);
    }
    if (series.length > 0) graphs.push({ id: newPlotId(), series });
  }
  const view = newPlotView(name, graphs, saved.agg);
  const s = getState();
  const cur = s.bottomTab === "plot" ? currentPlotView(s) : undefined;
  if (cur && cur.graphs.every((g) => g.series.length === 0))
    setState({ plotViews: s.plotViews.map((v) => (v.id === cur.id ? view : v)), plotView: view.id, bottomTab: "plot" });
  else openPlotView(view);
  if (missing.length > 0) notify(`View “${name}”: not in these results: ${missing.join(", ")}.`, true);
}
