// The time series, profile and comparison tabs of the bottom panel: opening, updating and closing them.

import { api, errorText } from "../api";
import { getState, notify, setState, type State } from "../store";
import type { CompareView, PlotAgg, PlotGraph, PlotSeries, PlotView, ProfileView } from "../uiTypes";
import { setResultsInfo } from "./model";

let plotIds = 0;
export const newPlotId = () => ++plotIds;

export function newPlotView(name: string, graphs: PlotGraph[] = [], agg: PlotAgg | null = null): PlotView {
  if (graphs.length === 0) graphs = [{ id: newPlotId(), series: [] }];
  return { id: newPlotId(), name, graphs, target: graphs[graphs.length - 1].id, agg, zoom: null };
}

/** The last opened plot view (none before a time series tab is created). */
export function currentPlotView(s: State = getState()): PlotView | undefined {
  return s.plotViews.find((v) => v.id === s.plotView);
}

/** Opens a plot view in a new tab of the bottom panel. */
export function openPlotView(view: PlotView) {
  setState((s) => ({ plotViews: [...s.plotViews, view], plotView: view.id, bottomTab: "plot" }));
}

/** The open profile tab, if the bottom panel shows one. */
export function currentProfileView(s: State = getState()): ProfileView | undefined {
  return s.bottomTab === "profile" ? s.profileViews.find((v) => v.id === s.profileView) : undefined;
}

function uniqueName(prefix: string, names: string[]): string {
  for (let i = names.length + 1; ; i++) if (!names.includes(`${prefix} ${i}`)) return `${prefix} ${i}`;
}

export const newPlotName = (s: State = getState()) => uniqueName("Time series", s.plotViews.map((v) => v.name));

/** Opens a profile through `nodes` in a new tab. */
export function openProfileView(nodes: number[], name?: string) {
  setState((s) => {
    const v: ProfileView = { id: newPlotId(), name: name ?? uniqueName("Profile", s.profileViews.map((p) => p.name)), nodes };
    return { profileViews: [...s.profileViews, v], profileView: v.id, profileNodes: nodes, profileStart: null, bottomTab: "profile" };
  });
}

/** Shows a profile tab (its path is computed and highlighted on the map). */
export function selectProfileView(id: number) {
  const v = getState().profileViews.find((p) => p.id === id);
  if (v) setState({ profileView: id, profileNodes: v.nodes, bottomTab: "profile" });
}

export function updateProfileView(id: number, patch: Partial<ProfileView>) {
  setState((s) => ({
    profileViews: s.profileViews.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    ...(patch.nodes && s.profileView === id ? { profileNodes: patch.nodes, profileStart: null } : {}),
  }));
}

/**
 * Draws a profile through `nodes`: in the open profile tab when it is still empty (or
 * `here`), else in a new tab.
 */
export function showProfile(nodes: number[], here = false) {
  const cur = currentProfileView();
  if (cur && (here || cur.nodes.length < 2)) updateProfileView(cur.id, { nodes });
  else openProfileView(nodes);
}

export function updatePlotView(id: number, patch: Partial<PlotView> | ((v: PlotView) => Partial<PlotView>)) {
  setState((s) => ({
    plotViews: s.plotViews.map((v) => (v.id === id ? { ...v, ...(typeof patch === "function" ? patch(v) : patch) } : v)),
  }));
}

/** Maps every plotted series of every view (null drops it; graphs it leaves empty are removed). */
export function mapPlotSeries(views: PlotView[], f: (p: PlotSeries) => PlotSeries | null): PlotView[] {
  return views.map((v) => {
    const graphs = v.graphs
      .map((g) => ({ ...g, series: g.series.flatMap((p) => f(p) ?? []) }))
      .filter((g, i) => g.series.length > 0 || v.graphs[i].series.length === 0);
    if (graphs.length === 0) graphs.push({ id: newPlotId(), series: [] });
    const target = v.target === "new" || graphs.some((g) => g.id === v.target) ? v.target : graphs[graphs.length - 1].id;
    return { ...v, graphs, target };
  });
}

/** Opens a tab comparing the loaded results with the results `path` (run B). */
export function openCompareView(path: string, name: string) {
  setState((s) => {
    const names = s.compareViews.map((c) => c.name);
    const v: CompareView = { id: newPlotId(), name: names.includes(name) ? uniqueName(name, names) : name, path };
    return { compareViews: [...s.compareViews, v], compareView: v.id, bottomTab: "compare" };
  });
}

export function updateCompareView(id: number, patch: Partial<CompareView>) {
  setState((s) => ({ compareViews: s.compareViews.map((v) => (v.id === id ? { ...v, ...patch } : v)) }));
}

/** Unloads the compared results when no comparison tab shows them any more. */
function releaseComparison() {
  const s = getState();
  const b = s.model?.compare?.path;
  if (!b || s.compareViews.some((v) => v.path === b)) return;
  api
    .closeComparison()
    .then((m) => setResultsInfo(m, false))
    .catch((e) => notify(errorText(e), true));
}

/** A time series, profile or comparison tab. */
export interface ViewTab {
  type: "plot" | "profile" | "compare";
  id: number;
  name: string;
}

/** The tabs created as needed, in creation order. */
export function viewTabs(s: Pick<State, "plotViews" | "profileViews" | "compareViews">): ViewTab[] {
  return [
    ...s.plotViews.map((v) => ({ type: "plot" as const, id: v.id, name: v.name })),
    ...s.profileViews.map((v) => ({ type: "profile" as const, id: v.id, name: v.name })),
    ...s.compareViews.map((v) => ({ type: "compare" as const, id: v.id, name: v.name })),
  ].sort((a, b) => a.id - b.id);
}

export const isViewTabOpen = (s: Pick<State, "bottomTab" | "plotView" | "profileView" | "compareView">, t: ViewTab) =>
  s.bottomTab === t.type && (t.type === "plot" ? s.plotView : t.type === "profile" ? s.profileView : s.compareView) === t.id;

export function openViewTab(t: ViewTab) {
  if (t.type === "plot") setState({ plotView: t.id, bottomTab: "plot" });
  else if (t.type === "compare") setState({ compareView: t.id, bottomTab: "compare" });
  else selectProfileView(t.id);
}

export function renameViewTab(t: ViewTab, name: string) {
  if (t.type === "plot") updatePlotView(t.id, { name });
  else if (t.type === "compare") updateCompareView(t.id, { name });
  else updateProfileView(t.id, { name });
}

/** Closes a tab; when it was open, the next one (or the previous, or the table) opens. */
export function closeViewTab(t: ViewTab) {
  const s = getState();
  const tabs = viewTabs(s);
  const i = tabs.findIndex((x) => x.type === t.type && x.id === t.id);
  const wasOpen = isViewTabOpen(s, t);
  if (t.type === "plot") setState({ plotViews: s.plotViews.filter((v) => v.id !== t.id) });
  else if (t.type === "compare") {
    setState({ compareViews: s.compareViews.filter((v) => v.id !== t.id) });
    releaseComparison();
  } else setState({ profileViews: s.profileViews.filter((v) => v.id !== t.id), ...(wasOpen ? { profileNodes: [], profileStart: null } : {}) });
  if (!wasOpen) return;
  const next = tabs[i + 1] ?? tabs[i - 1];
  if (next) openViewTab(next);
  else setState({ bottomTab: "table" });
}

/** Closes all the time series, profile and comparison tabs. */
export function closeAllViewTabs() {
  const s = getState();
  setState({
    plotViews: [],
    profileViews: [],
    compareViews: [],
    profileNodes: [],
    profileStart: null,
    ...(s.bottomTab === "plot" || s.bottomTab === "profile" || s.bottomTab === "compare" ? { bottomTab: "table" as const } : {}),
  });
  releaseComparison();
}
