// The state of the application and a minimal store for it (no dependency): read it with
// `useStore` in components and `getState` elsewhere, change it with `setState`.

import { useSyncExternalStore } from "react";
import type { Issue, ProfileDto } from "./analysisTypes";
import type { DeletePlan, Geometry, ModelInfo, ObjKind, ObjRef, TableKind } from "./types";
import { defaultStyle, styleUsable, type BottomTab, type Dialog, type LayerStyle, type PlotView, type ProfileView, type RunState, type SimTab, type StyledKind, type Tool } from "./uiTypes";

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
  /** Profile tabs of the bottom panel. */
  profileViews: ProfileView[];
  /** Id of the open (or last opened) profile view. */
  profileView: number;
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
  /** Table open in the editor. */
  tableEditor: { kind: TableKind; name: string } | null;
  /** Deletion waiting for confirmation. */
  pendingDelete: { objects: ObjRef[]; plan: DeletePlan } | null;
  run: RunState;
  /** Engine a run would use (null: none configured). */
  engine: string | null;
  sideTab: "props" | "style" | "data" | "simulation";
  simTab: SimTab;
  /** Incremented when a model is opened (the map view is rebuilt). */
  modelSeq: number;
}

/** No time series or profile tab: they are opened as needed. */
function noViews(): Pick<State, "plotViews" | "plotView" | "profileViews" | "profileView"> {
  return { plotViews: [], plotView: 0, profileViews: [], profileView: 0 };
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
  labels: false,
  ...noViews(),
  bottomMax: false,
  timeline: false,
  bottomTab: "table",
  profileNodes: [],
  profile: null,
  profileError: null,
  profileStart: null,
  issues: null,
  issuesError: null,
  fitExtent: 0,
  fitSelection: 0,
  panSelection: 0,
  message: null,
  busy: null,
  crsDialog: false,
  dialog: null,
  tableEditor: null,
  pendingDelete: null,
  run: { running: false, progress: null, elapsed: 0, log: [], last: null },
  engine: null,
  sideTab: "props",
  simTab: "run",
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
    labels: ui.labels ?? false,
    ...noViews(),
    profileNodes: [],
    profile: null,
    profileError: null,
    profileStart: null,
    bottomTab: state.bottomTab === "plot" || state.bottomTab === "profile" ? "table" : state.bottomTab,
    issues: null,
    issuesError: null,
    // The map view is rebuilt (modelSeq) and shows the saved view, or the whole model.
    tool: "select",
    // The console of the previous model does not belong to this one.
    run: state.run.running ? state.run : initial.run,
    modelSeq: state.modelSeq + 1,
    tableEditor: null,
    pendingDelete: null,
  });
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
