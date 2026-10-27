// Minimal global store (no dependency): state + subscribe, read with `useStore`.

import { useSyncExternalStore } from "react";
import type { Calendar, DeletePlan, ElementKind, Geometry, Issue, LinkType, ModelInfo, NodeType, ObjKind, ObjRef, ProfileDto, RunFinished, Stat, TableKind } from "./types";

export type StyledKind = "node" | "link" | "subcatchment";
export type ClassMethod = "equal" | "quantile" | "custom";
export type StatName = Stat["stat"];
/** Period range of a statistic: the whole run, or the day / month / year of the current time. */
export type Scope = "run" | Calendar;

export function makeStat(name: StatName, threshold: number): Stat {
  return name === "periods_above" ? { stat: name, threshold } : ({ stat: name } as Stat);
}

export interface LayerStyle {
  visible: boolean;
  /**
   * `type`: colour by object type; `attribute`: an input attribute; `result`: a result
   * variable at the current time; `stat`: a statistic of a result variable over a period
   * range (envelope map); `compare`: loaded minus compared results.
   */
  source: "type" | "attribute" | "result" | "stat" | "compare";
  /** Attribute name, or result variable index (as a string). */
  field: string;
  method: ClassMethod;
  classes: number;
  /** Inner class limits (classes - 1 values, ascending). */
  breaks: number[];
  ramp: string;
  /** Size of points / width of lines in pixels. */
  size: number;
  /** Wider lines / bigger points for higher classes. */
  sizeByClass: boolean;
  /** Statistic (`stat` and `compare` sources; `value` = at the current time, compare only). */
  stat: StatName | "value";
  threshold: number;
  scope: Scope;
}

export interface PlotSeries {
  key: string;
  kind: ElementKind;
  index: number;
  /** Object name, to find it again after objects are added or removed. */
  id?: string;
  var: number;
  label: string;
  unit: string;
  /** From the compared results (run B). */
  b?: boolean;
}

/** Time aggregation of a plot view (null: the series themselves). */
export type PlotAgg = { unit: Calendar; stat: StatName; threshold: number };

/** One chart of a plot view. */
export interface PlotGraph {
  id: number;
  series: PlotSeries[];
}

/** A tab of the time series panel: a group of graphs stacked on one time axis. */
export interface PlotView {
  id: number;
  name: string;
  /** Never empty. */
  graphs: PlotGraph[];
  /** Graph new series go to (`new`: each addition opens a new graph). */
  target: number | "new";
  agg: PlotAgg | null;
  /** Zoomed time range in seconds (null: the whole run). */
  zoom: [number, number] | null;
}

let plotIds = 0;
export const newPlotId = () => ++plotIds;

export function newPlotView(name: string, graphs: PlotGraph[] = [], agg: PlotAgg | null = null): PlotView {
  if (graphs.length === 0) graphs = [{ id: newPlotId(), series: [] }];
  return { id: newPlotId(), name, graphs, target: graphs[graphs.length - 1].id, agg, zoom: null };
}

/** The open plot view (there is always one). */
export function currentPlotView(s: State = state): PlotView {
  return s.plotViews.find((v) => v.id === s.plotView) ?? s.plotViews[0];
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

export type Tool =
  | "select"
  | "box"
  | "lasso"
  /** Drag objects. */
  | "move"
  /** Drag, add and remove the vertices of the selected link or subcatchment. */
  | "vertex"
  /** Click a start and an end node to draw their longitudinal profile. */
  | "profile"
  | `add-${NodeType}`
  | `add-${LinkType}`
  | "add-subcatchment"
  | "add-gage";

export interface RunState {
  running: boolean;
  progress: number | null;
  elapsed: number;
  log: string[];
  last: RunFinished | null;
}

/** "engines" is the options dialog opened on its engine tab. */
export type Dialog = "options" | "engines" | "new" | "climate" | "sections" | null;

export type BottomTab = "plot" | "profile" | "events" | "compare" | "runs" | "table" | "issues" | "report" | "run";

export interface State {
  model: ModelInfo | null;
  geometry: Geometry | null;
  ids: Partial<Record<ObjKind, string[]>>;
  selection: ObjRef[];
  period: number;
  playing: boolean;
  /** Frames per second and periods per frame of the animation. */
  fps: number;
  stride: number;
  tool: Tool;
  styles: Record<StyledKind, LayerStyle>;
  labels: boolean;
  /** Tabs of the time series panel. */
  plotViews: PlotView[];
  /** Id of the open plot view. */
  plotView: number;
  /** The bottom panel fills the centre (the map is hidden). */
  bottomMax: boolean;
  /** The timeline strip (overview of a system variable) is shown under the map. */
  timeline: boolean;
  bottomTab: BottomTab;
  /** Nodes the profile goes through (in order). */
  profileNodes: number[];
  /** The profile path computed from `profileNodes` (highlighted on the map). */
  profile: ProfileDto | null;
  profileError: string | null;
  /** Profile tool: start node clicked, waiting for the end node. */
  profileStart: number | null;
  /** Last model check (null: not run yet). */
  issues: Issue[] | null;
  /** Incremented to ask the map to zoom to the model extent / to the selection. */
  fitExtent: number;
  fitSelection: number;
  message: { text: string; error: boolean } | null;
  busy: string | null;
  crsDialog: boolean;
  dialog: Dialog;
  /** Table open in the editor. */
  tableEditor: { kind: TableKind; name: string } | null;
  /** Deletion waiting for confirmation. */
  pendingDelete: { objects: ObjRef[]; plan: DeletePlan } | null;
  run: RunState;
  /** Engine a run would use (null: none configured). */
  engine: string | null;
  sideTab: "props" | "style" | "data";
  /** Incremented when a model is opened (the map view is rebuilt). */
  modelSeq: number;
}

export const defaultStyle = (kind: StyledKind): LayerStyle => ({
  visible: true,
  source: "type",
  field: "",
  method: "equal",
  classes: 5,
  breaks: [],
  ramp: kind === "subcatchment" ? "greens" : "blue-red",
  size: kind === "node" ? 4 : kind === "link" ? 2 : 1,
  sizeByClass: kind === "link",
  stat: "max",
  threshold: 0,
  scope: "run",
});

function firstView(): Pick<State, "plotViews" | "plotView"> {
  const v = newPlotView("View 1");
  return { plotViews: [v], plotView: v.id };
}

const initial: State = {
  model: null,
  geometry: null,
  ids: {},
  selection: [],
  period: 0,
  playing: false,
  fps: 10,
  stride: 1,
  tool: "select",
  styles: { node: defaultStyle("node"), link: defaultStyle("link"), subcatchment: defaultStyle("subcatchment") },
  labels: true,
  ...firstView(),
  bottomMax: false,
  timeline: false,
  bottomTab: "plot",
  profileNodes: [],
  profile: null,
  profileError: null,
  profileStart: null,
  issues: null,
  fitExtent: 0,
  fitSelection: 0,
  message: null,
  busy: null,
  crsDialog: false,
  dialog: null,
  tableEditor: null,
  pendingDelete: null,
  run: { running: false, progress: null, elapsed: 0, log: [], last: null },
  engine: null,
  sideTab: "props",
  modelSeq: 0,
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function resetForModel(model: ModelInfo, geometry: Geometry) {
  const ui = (model.project.ui ?? {}) as { styles?: Partial<Record<StyledKind, LayerStyle>>; labels?: boolean };
  const styles = { ...initial.styles };
  for (const k of ["node", "link", "subcatchment"] as StyledKind[]) {
    const saved = ui.styles?.[k];
    if (saved) styles[k] = { ...defaultStyle(k), ...saved };
  }
  // A saved result style needs results with that variable (and compared results).
  for (const k of Object.keys(styles) as StyledKind[]) {
    if (!styleUsable(styles[k], k, model)) styles[k] = defaultStyle(k);
  }
  setState({
    model,
    geometry,
    ids: {},
    selection: [],
    period: 0,
    playing: false,
    styles,
    labels: ui.labels ?? true,
    ...firstView(),
    profileNodes: [],
    profile: null,
    profileError: null,
    profileStart: null,
    issues: null,
    fitExtent: state.fitExtent + 1,
    tool: "select",
    modelSeq: state.modelSeq + 1,
    tableEditor: null,
    pendingDelete: null,
  });
}

/** A style still applies to the model's results (a result variable needs results). */
export function styleUsable(s: LayerStyle, kind: StyledKind, model: ModelInfo): boolean {
  if (s.source === "type" || s.source === "attribute") return true;
  if (!model.results?.variables[kind]?.[Number(s.field)]) return false;
  return s.source !== "compare" || !!model.compare?.variables[kind]?.[Number(s.field)];
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export function notify(text: string, error = false) {
  setState({ message: { text, error } });
}

export function setStyle(kind: StyledKind, patch: Partial<LayerStyle>) {
  setState((s) => ({ styles: { ...s.styles, [kind]: { ...s.styles[kind], ...patch } } }));
}

export function sameRef(a: ObjRef, b: ObjRef) {
  return a.kind === b.kind && a.index === b.index;
}
