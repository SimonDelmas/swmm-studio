// Minimal global store (no dependency): state + subscribe, read with `useStore`.

import { useSyncExternalStore } from "react";
import type { ElementKind, Geometry, ModelInfo, ObjKind, ObjRef } from "./types";

export type StyledKind = "node" | "link" | "subcatchment";
export type ClassMethod = "equal" | "quantile" | "custom";

export interface LayerStyle {
  visible: boolean;
  /** `type`: colour by object type; `attribute`: an input attribute; `result`: a result variable. */
  source: "type" | "attribute" | "result";
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
}

export interface PlotSeries {
  key: string;
  kind: ElementKind;
  index: number;
  var: number;
  label: string;
  unit: string;
}

export type Tool = "select" | "box" | "lasso";

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
  plot: PlotSeries[];
  bottomTab: "plot" | "report";
  /** Incremented to ask the map to zoom to the model extent / to the selection. */
  fitExtent: number;
  fitSelection: number;
  message: { text: string; error: boolean } | null;
  busy: string | null;
  crsDialog: boolean;
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
});

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
  plot: [],
  bottomTab: "plot",
  fitExtent: 0,
  fitSelection: 0,
  message: null,
  busy: null,
  crsDialog: false,
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
  // A saved result style needs results with that variable.
  for (const k of Object.keys(styles) as StyledKind[]) {
    const s = styles[k];
    if (s.source === "result" && !model.results?.variables[k]?.[Number(s.field)]) styles[k] = defaultStyle(k);
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
    plot: [],
    fitExtent: state.fitExtent + 1,
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

export function setStyle(kind: StyledKind, patch: Partial<LayerStyle>) {
  setState((s) => ({ styles: { ...s.styles, [kind]: { ...s.styles[kind], ...patch } } }));
}

export function sameRef(a: ObjRef, b: ObjRef) {
  return a.kind === b.kind && a.index === b.index;
}
