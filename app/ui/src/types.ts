// Mirrors of the Rust DTOs (app/src-tauri/src: session, editing, commands); the analysis ones are in analysisTypes.ts.


export type ObjKind = "node" | "link" | "subcatchment" | "gage";
export type ElementKind = "node" | "link" | "subcatchment" | "system";

export function sameRef(a: ObjRef, b: ObjRef) {
  return a.kind === b.kind && a.index === b.index;
}

export interface ObjRef {
  kind: ObjKind;
  index: number;
}

export type Space = { kind: "cartesian"; origin: [number, number] } | { kind: "lonlat" };

export interface CrsDto {
  id: string;
  name: string;
}

export interface Basemap {
  url: string;
  attribution: string;
  opacity: number;
  visible: boolean;
  /** Tiles in shades of grey. */
  greyscale: boolean;
}

export interface Project {
  version: number;
  crs: string | null;
  basemap: Basemap;
  results: { out: string | null; rpt: string | null };
  /** Files of observed series linked to objects (absent: none). */
  observed?: ObservedLink[];
  ui: Record<string, unknown>;
}

export type CacheState =
  | { state: "ready" }
  | { state: "building"; progress: number }
  | { state: "failed"; message: string };

export interface VarInfo {
  name: string;
  unit: string;
}

export interface ResultsInfo {
  path: string;
  n_periods: number;
  start_ms: number;
  step_secs: number;
  complete: boolean;
  flow_units: string;
  version: number;
  variables: Record<ElementKind, VarInfo[]>;
  matched: Record<string, number>;
  in_file: Record<string, number>;
  cache: CacheState;
  /** Most periods a series can span when read without the cache. */
  direct_periods: number;
}

export interface MessageDto {
  code: string;
  text: string;
  line: number | null;
  section: string | null;
  context: string | null;
  object: ObjRef | null;
}

export interface BlockInfo {
  title: string;
  kind: "table" | "values" | "text";
  rows: number;
}

export interface ReportSummary {
  path: string;
  version: string | null;
  errors: MessageDto[];
  warnings: MessageDto[];
  continuity: [string, number][];
  blocks: BlockInfo[];
  analysis_begun: string | null;
  analysis_ended: string | null;
  elapsed: string | null;
}

export interface BlockDto {
  title: string;
  value_headers: string[];
  kind: "table" | "values" | "text";
  columns: string[];
  header: string[];
  rows: string[][];
  footer: string[][];
  notes: string[];
  id_kind: ObjKind | null;
}

export interface ModelInfo {
  path: string;
  name: string;
  title: string | null;
  flow_units: string;
  counts: { nodes: number; links: number; subcatchments: number; gages: number };
  crs: CrsDto | null;
  crs_hint: CrsDto | null;
  space: Space;
  bounds: [number, number, number, number] | null;
  unprojected: number;
  missing_coordinates: number;
  project: Project;
  project_error: string | null;
  attributes: Record<string, string[]>;
  results: ResultsInfo | null;
  /** Results compared with the loaded ones (run B). */
  compare: ResultsInfo | null;
  /** Results of other runs drawn with each series of the time series graphs. */
  overlays: ResultsInfo[];
  report: ReportSummary | null;
  notes: string[];
  dirty: boolean;
  undo: string | null;
  redo: string | null;
  revision: number;
  /** Unsaved changes left by a session that ended without saving, to restore or discard. */
  recovery: RecoveryInfo | null;
}

/** Unsaved changes of a model, autosaved by a session that ended without saving. */
/** The model or the loaded results changed on disk by another program. */
export interface FileChange {
  kind: "model" | "results";
  path: string;
  /** False: the file was deleted or renamed. */
  exists: boolean;
}

export interface RecoveryInfo {
  model: string;
  /** Local time, `YYYY-MM-DD HH:MM:SS`. */
  saved_at: string;
}

/** A model opened or saved lately. */
export interface RecentFile {
  path: string;
  name: string;
  exists: boolean;
}

export type RefKind =
  | "node"
  | "link"
  | "subcatchment"
  | "gage"
  | "outlet"
  | "curve"
  | "timeseries"
  | "pattern"
  | "hydrograph"
  | "transect"
  | "street"
  | "snowpack"
  | "aquifer";

export type FieldType =
  | { type: "id" }
  | { type: "real" }
  | { type: "text" }
  | { type: "time" }
  | { type: "choice"; options: string[] }
  | { type: "ref"; to: RefKind };

export type Field = FieldType & {
  name: string;
  value: string;
  key: string | null;
  unit: string;
  default: string;
  required: boolean;
  present: boolean;
};

export interface PropertyGroup {
  title: string;
  section: string;
  key: string[];
  fields: Field[];
  comment: string | null;
  editable: boolean;
  removable: boolean;
}

export interface Addable {
  title: string;
  section: string;
  key: string[];
}

export interface VarValue {
  name: string;
  unit: string;
  value: number;
  max: number | null;
  max_period: number | null;
}

export interface ObjectInfo {
  object: ObjRef;
  id: string;
  type: string;
  groups: PropertyGroup[];
  addable: Addable[];
  connections: { role: string; object: ObjRef; id: string }[];
  results: VarValue[] | null;
}

export interface CrsEntry {
  id: string;
  name: string;
  geographic: boolean;
}

/** Network geometry decoded from the binary buffer of the `geometry` command. */
export interface Geometry {
  space: "cartesian" | "lonlat";
  origin: [number, number];
  nodes: Float64Array; // xy per node (NaN if not drawn)
  nodeTypes: Uint8Array;
  linkStarts: Uint32Array; // vertex index, links + 1
  linkPts: Float64Array;
  linkTypes: Uint8Array;
  /** From and to node index per link (0xffffffff when unknown). */
  linkEnds: Uint32Array;
  subStarts: Uint32Array;
  subPts: Float64Array;
  /** Outlet per subcatchment: kind (0 node, 1 subcatchment) and index (0xffffffff for both when none). */
  subOutlets: Uint32Array;
  gages: Float64Array;
}

export interface MinMaxSeries {
  periods: Uint32Array;
  min: Float32Array;
  max: Float32Array;
}

export type NodeType = "junction" | "outfall" | "divider" | "storage";
export type LinkType = "conduit" | "pump" | "orifice" | "weir" | "outlet";
export type Pt = [number, number];

export interface GridCell {
  key: string[];
  field: string;
  value: string;
}

export interface Climate {
  evap_source: string;
  evap_values: string[];
  evap_recovery: string;
  evap_dry_only: boolean;
  temp_source: string;
  temp_series: string;
  temp_file: string;
  temp_file_start: string;
  wind_source: string;
  wind_monthly: string[];
  snowmelt: string[];
  adc_impervious: string[];
  adc_pervious: string[];
  adj_temperature: string[];
  adj_evaporation: string[];
  adj_rainfall: string[];
  adj_conductivity: string[];
}

/** Edits understood by the backend (app/src-tauri/src/editing/request.rs). */
export type EditRequest =
  | { op: "set_field"; section: string; key: string[]; field: number; value: string }
  | { op: "set_field_bulk"; objects: ObjRef[]; section: string; field: string; value: string }
  | { op: "add_line"; section: string; key: string[] }
  | { op: "remove_line"; section: string; key: string[] }
  | { op: "rename"; kind: RefKind; old: string; new: string }
  | { op: "add_node"; node_type: NodeType; xy: Pt }
  | { op: "add_link"; link_type: LinkType; from: number; to: number; vertices: Pt[] }
  | { op: "add_subcatchment"; polygon: Pt[] }
  | { op: "add_gage"; xy: Pt }
  | { op: "delete"; objects: ObjRef[] }
  | { op: "set_geometry"; object: ObjRef; points: Pt[] }
  | { op: "translate"; objects: ObjRef[]; dx: number; dy: number }
  | { op: "reconnect"; link: number; end: "from" | "to"; node: number }
  | { op: "set_options"; values: [string, string][] }
  | { op: "set_title"; text: string }
  | { op: "set_table"; table: Table; old_name: string | null }
  | { op: "add_table"; kind: TableKind }
  | { op: "delete_table"; kind: TableKind; name: string }
  | { op: "assign_rdii"; nodes: number[]; hydrograph: string; area: string | null }
  | { op: "remove_rdii"; nodes: number[] }
  | { op: "set_cells"; section: string; cells: GridCell[] }
  | { op: "set_climate"; climate: Climate }
  | { op: "set_section_text"; section: string; text: string };

/** Coordinates are null where they cannot be drawn. */
type PPt = [number | null, number | null];

export interface GeometryPatch {
  nodes: [number, PPt][];
  gages: [number, PPt][];
  links: [number, [number, number], PPt[]][];
  subcatchments: [number, [number, number], PPt[]][];
}

export interface EditOutcome {
  label: string;
  info: ModelInfo;
  geometry: boolean;
  patch: GeometryPatch | null;
  rebuilt: boolean;
  selection: ObjRef[];
  message: string | null;
  created: string | null;
}

export interface DeletePlan {
  nodes: string[];
  links: string[];
  subcatchments: string[];
  gages: string[];
  cascade_links: string[];
  cleared: string[];
  rules: number;
}

export type TableKind = "curve" | "timeseries" | "pattern" | "hydrograph" | "transect" | "aquifer" | "snowpack";

export interface Curve {
  kind: "curve";
  name: string;
  curve_type: string;
  points: [string, string][];
}
export interface TsRow {
  date: string;
  time: string;
  value: string;
}
export interface Timeseries {
  kind: "timeseries";
  name: string;
  file: string | null;
  rows: TsRow[];
}
export interface Pattern {
  kind: "pattern";
  name: string;
  pattern_type: string;
  factors: string[];
}
export interface UhRow {
  month: string;
  response: string;
  r: string;
  t: string;
  k: string;
  dmax: string;
  drecov: string;
  dinit: string;
}
export interface Hydrograph {
  kind: "hydrograph";
  name: string;
  gage: string;
  rows: UhRow[];
}
export interface Transect {
  kind: "transect";
  name: string;
  n_left: string;
  n_right: string;
  n_channel: string;
  x_left: string;
  x_right: string;
  lfactor: string;
  wfactor: string;
  eoffset: string;
  points: [string, string][];
}
/** Twelve parameters in file order, and an optional evaporation pattern. */
export interface Aquifer {
  kind: "aquifer";
  name: string;
  values: string[];
  pattern: string;
}
/** Seven parameters per surface, six snow removal values and a receiving subcatchment. */
export interface Snowpack {
  kind: "snowpack";
  name: string;
  plowable: string[];
  impervious: string[];
  pervious: string[];
  removal: string[];
  subcatchment: string;
}
export type Table = Curve | Timeseries | Pattern | Hydrograph | Transect | Aquifer | Snowpack;

export interface OptionsDto {
  values: [string, string][];
  title: string;
}

export interface EngineConfig {
  name: string;
  path: string;
  version?: string | null;
}

export interface EnginesDto {
  engines: EngineConfig[];
  default: string | null;
  project: string | null;
  effective: string | null;
  settings_path: string;
  error: string | null;
}

export interface RunProgress {
  progress: number | null;
  elapsed: number;
  run_dir: string | null;
}

export interface RunFinished {
  status: "success" | "warnings" | "failed" | "cancelled";
  message: string | null;
  seconds: number;
  run_dir: string | null;
  errors: number;
  warnings: number;
  console: string[];
  info: ModelInfo | null;
}

/** Order of day and month in dates that do not start with the year. */
export type DateOrder = "auto" | "dmy" | "mdy";

/** A file of observed series linked to an object, with the column of each variable. */
export interface ObservedLink {
  kind: "node" | "link" | "subcatchment";
  id: string;
  file: string;
  sheet?: string | null;
  time_column: string;
  date_order: DateOrder;
  /** Variable name → column. */
  columns: Record<string, string>;
  /** Variable name → unit of its series, when not the results' unit (values are converted). */
  units?: Record<string, string>;
}

export interface ObservedColumn {
  name: string;
  kind: "time" | "number" | "text" | "empty";
  values: number;
}

/** A file read to link it to an object: its columns and the default mapping. */
export interface ObservedFile {
  path: string;
  format: "text" | "workbook" | "parquet";
  sheets: string[];
  sheet: string | null;
  columns: ObservedColumn[];
  time_column: string | null;
  date_order: DateOrder;
  date_order_ambiguous: boolean;
  rows: number;
  preview: string[][];
  /** Columns of numbers. */
  series: string[];
  variables: VarInfo[];
  mapping: Record<string, string>;
  /** Units each variable's series can be in, the results' unit first (empty: no conversion). */
  unit_options: Record<string, string[]>;
  /** Unit written in a column's title. */
  column_units: Record<string, string>;
  /** Default unit of each mapped variable (absent: the results' unit). */
  units: Record<string, string>;
  start_ms: number | null;
  end_ms: number | null;
  skipped: number;
  time_error: string | null;
}

/** Observed values: times in ms (model clock) and values. */
export interface ObservedSeries {
  times: Float64Array;
  values: Float32Array;
}
