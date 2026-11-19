// What the state of the interface is made of: map styles, time series and profile tabs,
// tools, panels.

import type { Calendar, Stat } from "./analysisTypes";
import type { ElementKind, LinkType, ModelInfo, NodeType, RunFinished } from "./types";

export type StyledKind = "node" | "link" | "subcatchment";
export type ClassMethod = "equal" | "quantile" | "custom";
export type StatName = Stat["stat"];
/** Period range of a statistic: the whole run, or the day / month / year of the current time. */
export type Scope = "run" | Calendar;

/** The statistics of a result variable, with their labels. */
export const STATS: [StatName, string][] = [
  ["max", "Maximum"],
  ["min", "Minimum"],
  ["mean", "Mean"],
  ["time_of_max", "Time of maximum"],
  ["total", "Total (volume, depth)"],
  ["periods_above", "Duration above threshold"],
];

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
  /** Subcatchments: lines from each subcatchment to its outlet. */
  outletLinks: boolean;
  /** Nodes and links: types not drawn (indices into the type names). */
  hiddenTypes: number[];
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
  outletLinks: false,
  hiddenTypes: [],
});

/** A style still applies to the model's results (a result variable needs results). */
export function styleUsable(s: LayerStyle, kind: StyledKind, model: ModelInfo): boolean {
  if (s.source === "type" || s.source === "attribute") return true;
  if (!model.results?.variables[kind]?.[Number(s.field)]) return false;
  return s.source !== "compare" || !!model.compare?.variables[kind]?.[Number(s.field)];
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

/** Identity of a series: the same object and variable is plotted once per graph. */
export const seriesKey = (kind: string, index: number, v: number, b?: boolean) => `${kind}:${index}:${v}${b ? ":b" : ""}`;

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

/** A tab of the bottom panel showing a longitudinal profile. */
export interface ProfileView {
  id: number;
  name: string;
  /** Nodes the profile goes through (in order; empty: not drawn yet). */
  nodes: number[];
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
  /** Folder of the running simulation (known once it started). */
  dir: string | null;
  progress: number | null;
  elapsed: number;
  log: string[];
  last: RunFinished | null;
}

/** "engines" is the options dialog opened on its engine tab. */
export type Dialog = "options" | "engines" | "new" | "climate" | "sections" | null;

/**
 * Tabs of the bottom panel: fixed views, then time series (`plotView`), profile
 * (`profileView`), comparison (`compareView`) and report (`reportView`) tabs.
 */
export type BottomTab = "table" | "issues" | "simulation" | "events" | "compare" | "plot" | "profile" | "report";

/** A tab of the bottom panel showing the report of a run, or of the loaded results. */
export interface ReportTabView {
  id: number;
  name: string;
  /** Folder of the run (null: the report of results loaded from outside the runs). */
  dir: string | null;
}

/** A tab of the bottom panel comparing the loaded results with other results (run B). */
export interface CompareView {
  id: number;
  name: string;
  /** The `.out` compared with the loaded results. */
  path: string;
}

/**
 * What the simulation tab shows: the list of runs (null) or the console of the running one.
 * Reports open in tabs of their own.
 */
export type SimView = null | "running";
