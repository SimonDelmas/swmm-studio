// The time series, profile, comparison and report tabs of the bottom panel: opening, updating,
// ordering and closing them.

import { api, errorText } from "../api";
import { getState, isViewTabType, notify, setState, type State } from "../store";
import type { CompareView, PlotAgg, PlotGraph, PlotSeries, PlotView, ProfileView, ReportTabView } from "../uiTypes";
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

/**
 * Opens the report of a run (`dir`) or of the loaded results (null) in a tab, or shows
 * the tab that already has it.
 */
export function openReportView(dir: string | null, name: string) {
  setState((s) => {
    const open = s.reportViews.find((v) => v.dir === dir);
    if (open) return { reportView: open.id, bottomTab: "report" };
    const v: ReportTabView = { id: newPlotId(), name, dir };
    return { reportViews: [...s.reportViews, v], reportView: v.id, bottomTab: "report" };
  });
}

/** Renames the report tab of a run (its label changed). */
export function renameReportView(dir: string, name: string) {
  setState((s) => ({ reportViews: s.reportViews.map((v) => (v.dir === dir ? { ...v, name } : v)) }));
}

/** A time series, profile, comparison or report tab. */
export interface ViewTab {
  type: "plot" | "profile" | "compare" | "report";
  id: number;
  name: string;
}

export const viewTabKey = (t: Pick<ViewTab, "type" | "id">) => `${t.type}:${t.id}`;

/** The tabs created as needed: in the order they were dragged to, then in creation order. */
export function viewTabs(s: Pick<State, "plotViews" | "profileViews" | "compareViews" | "reportViews" | "viewOrder">): ViewTab[] {
  const rank = new Map(s.viewOrder.map((k, i) => [k, i]));
  const at = (t: ViewTab) => rank.get(viewTabKey(t)) ?? Infinity;
  return [
    ...s.plotViews.map((v) => ({ type: "plot" as const, id: v.id, name: v.name })),
    ...s.profileViews.map((v) => ({ type: "profile" as const, id: v.id, name: v.name })),
    ...s.compareViews.map((v) => ({ type: "compare" as const, id: v.id, name: v.name })),
    ...s.reportViews.map((v) => ({ type: "report" as const, id: v.id, name: v.name })),
  ].sort((a, b) => at(a) - at(b) || a.id - b.id);
}

/** Puts the tabs in this order (keys `type:id`, as dragged). */
export function orderViewTabs(keys: string[]) {
  setState({ viewOrder: keys });
}

type OpenTabs = Pick<State, "bottomTab" | "plotView" | "profileView" | "compareView" | "reportView">;

const openId = (s: OpenTabs, type: ViewTab["type"]) =>
  type === "plot" ? s.plotView : type === "profile" ? s.profileView : type === "compare" ? s.compareView : s.reportView;

export const isViewTabOpen = (s: OpenTabs, t: ViewTab) => s.bottomTab === t.type && openId(s, t.type) === t.id;

export function openViewTab(t: ViewTab) {
  if (t.type === "plot") setState({ plotView: t.id, bottomTab: "plot" });
  else if (t.type === "compare") setState({ compareView: t.id, bottomTab: "compare" });
  else if (t.type === "report") setState({ reportView: t.id, bottomTab: "report" });
  else selectProfileView(t.id);
}

export function renameViewTab(t: ViewTab, name: string) {
  if (t.type === "plot") updatePlotView(t.id, { name });
  else if (t.type === "compare") updateCompareView(t.id, { name });
  else if (t.type === "report") setState((s) => ({ reportViews: s.reportViews.map((v) => (v.id === t.id ? { ...v, name } : v)) }));
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
  } else if (t.type === "report") setState({ reportViews: s.reportViews.filter((v) => v.id !== t.id) });
  else setState({ profileViews: s.profileViews.filter((v) => v.id !== t.id), ...(wasOpen ? { profileNodes: [], profileStart: null } : {}) });
  setState((x) => ({ viewOrder: x.viewOrder.filter((k) => k !== viewTabKey(t)) }));
  if (!wasOpen) return;
  const next = tabs[i + 1] ?? tabs[i - 1];
  if (next) openViewTab(next);
  else setState({ bottomTab: "table" });
}

/** Closes the report tabs of a run (deleted). */
export function closeReportViews(dir: string) {
  for (const v of getState().reportViews.filter((x) => x.dir === dir)) closeViewTab({ type: "report", id: v.id, name: v.name });
}

/** Closes all the time series, profile, comparison and report tabs. */
export function closeAllViewTabs() {
  const s = getState();
  setState({
    plotViews: [],
    profileViews: [],
    compareViews: [],
    reportViews: [],
    viewOrder: [],
    profileNodes: [],
    profileStart: null,
    ...(isViewTabType(s.bottomTab) ? { bottomTab: "table" as const } : {}),
  });
  releaseComparison();
}
