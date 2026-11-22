// The state of the application and a minimal store for it (no dependency): read it with
// `useStore` in components and `getState` elsewhere, change it with `setState`.

import { useSyncExternalStore } from "react";
import type { Issue, ProfileDto, RunDto } from "./analysisTypes";
import type { DeletePlan, FileChange, Geometry, ModelInfo, ObjKind, ObjRef, TableKind } from "./types";
import { defaultStyle, styleUsable, type BottomTab, type CompareView, type Dialog, type LayerStyle, type PlotView, type ProfileView, type ReportTabView, type RunState, type SimView, type StyledKind, type Tool, type XYView } from "./uiTypes";

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
  /** Time series tabs of the bottom panel. */
  plotViews: PlotView[];
  /** Id of the open (or last opened) plot view. */
  plotView: number;
  /** X-Y (scatter) tabs of the bottom panel. */
  xyViews: XYView[];
  xyView: number;
  /** Profile tabs of the bottom panel. */
  profileViews: ProfileView[];
  /** Id of the open (or last opened) profile view. */
  profileView: number;
  /** Comparison tabs of the bottom panel. */
  compareViews: CompareView[];
  compareView: number;
  /** Report tabs of the bottom panel. */
  reportViews: ReportTabView[];
  reportView: number;
  /**
   * Order of the tabs created as needed, dragged by the user (keys `type:id`); tabs not
   * in it come after, in creation order.
   */
  viewOrder: string[];
  /** The bottom panel fills the centre (the map is hidden). */
  bottomMax: boolean;
  /** The timeline strip (overview of a system variable) is shown under the map. */
  timeline: boolean;
  bottomTab: BottomTab;
  /** Nodes the profile of the open profile tab goes through (in order). */
  profileNodes: number[];
  /** The profile path computed from `profileNodes` (highlighted on the map). */
  profile: ProfileDto | null;
  profileError: string | null;
  /** Profile tool: start node clicked, waiting for the end node. */
  profileStart: number | null;
  /** The network upstream of the selected objects is highlighted on the map. */
  upstream: boolean;
  /** Last model check (null: not run yet), and why it could not run. */
  issues: Issue[] | null;
  issuesError: string | null;
  /** Incremented to ask the map to zoom to the model extent / to the selection. */
  fitExtent: number;
  fitSelection: number;
  /** Incremented to ask the map to pan (without zooming) to the selection when it is out of view. */
  panSelection: number;
  message: { text: string; error: boolean } | null;
  busy: string | null;
  crsDialog: boolean;
  dialog: Dialog;
  /** Section and line (1 = the first after the header) the sections dialog opens at. */
  sectionsAt: { section: string; line: number } | null;
  /** Table open in the editor. */
  tableEditor: { kind: TableKind; name: string } | null;
  /** Deletion waiting for confirmation. */
  pendingDelete: { objects: ObjRef[]; plan: DeletePlan } | null;
  /** Files of the model changed by other programs, to reload or keep (one per kind). */
  fileChanges: FileChange[];
  run: RunState;
  /** Engine a run would use (null: none configured). */
  engine: string | null;
  sideTab: "props" | "style" | "data";
  /** Runs of the model, newest first (null: not listed yet). */
  runs: RunDto[] | null;
  simView: SimView;
  /** Incremented when a model is opened (the map view is rebuilt). */
  modelSeq: number;
}

/** No time series, X-Y, profile, comparison or report tab: they are opened as needed. */
function noViews(): Pick<
  State,
  "plotViews" | "plotView" | "xyViews" | "xyView" | "profileViews" | "profileView" | "compareViews" | "compareView" | "reportViews" | "reportView" | "viewOrder"
> {
  return { plotViews: [], plotView: 0, xyViews: [], xyView: 0, profileViews: [], profileView: 0, compareViews: [], compareView: 0, reportViews: [], reportView: 0, viewOrder: [] };
}

/** Tabs of the bottom panel opened as needed (they go when another model is opened). */
export const isViewTabType = (t: BottomTab) => t === "plot" || t === "xy" || t === "profile" || t === "compare" || t === "report";

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
  labels: false,
  ...noViews(),
  bottomMax: false,
  timeline: false,
  bottomTab: "table",
  profileNodes: [],
  profile: null,
  profileError: null,
  profileStart: null,
  upstream: false,
  issues: null,
  issuesError: null,
  fitExtent: 0,
  fitSelection: 0,
  panSelection: 0,
  message: null,
  busy: null,
  crsDialog: false,
  dialog: null,
  sectionsAt: null,
  tableEditor: null,
  pendingDelete: null,
  fileChanges: [],
  run: { running: false, dir: null, progress: null, elapsed: 0, log: [], last: null },
  engine: null,
  sideTab: "props",
  runs: null,
  simView: null,
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

/** Shows a model just opened or created; `geometry` is null when its map could not be read. */
export function resetForModel(model: ModelInfo, geometry: Geometry | null) {
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
    labels: ui.labels ?? false,
    ...noViews(),
    profileNodes: [],
    profile: null,
    profileError: null,
    profileStart: null,
    bottomTab: isViewTabType(state.bottomTab) ? "table" : state.bottomTab,
    runs: null,
    simView: state.run.running ? state.simView : null,
    issues: null,
    issuesError: null,
    // The map view is rebuilt (modelSeq) and shows the saved view, or the whole model.
    tool: "select",
    // The console of the previous model does not belong to this one.
    run: state.run.running ? state.run : initial.run,
    modelSeq: state.modelSeq + 1,
    // Dialogs show and edit the previous model: their values must not reach this one.
    dialog: null,
    tableEditor: null,
    pendingDelete: null,
    // Read from disk just now.
    fileChanges: [],
  });
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

/** Long tasks running, in the order they started: `busy` shows the last one. */
const busyTasks: { text: string }[] = [];

/**
 * Marks the app busy with `text` until the returned function is called. Tasks can overlap
 * (results loaded while a model waits to open): the app stays busy until all have ended.
 */
export function startBusy(text: string): () => void {
  const task = { text };
  busyTasks.push(task);
  setState({ busy: text });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    busyTasks.splice(busyTasks.indexOf(task), 1);
    setState({ busy: busyTasks.at(-1)?.text ?? null });
  };
}

export function notify(text: string, error = false) {
  setState({ message: { text, error } });
}
