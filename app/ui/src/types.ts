// Mirrors of the Rust DTOs (app/src-tauri/src/session.rs).

export type ObjKind = "node" | "link" | "subcatchment" | "gage";
export type ElementKind = "node" | "link" | "subcatchment" | "system";

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
}

export interface Project {
  version: number;
  crs: string | null;
  basemap: Basemap;
  results: { out: string | null; rpt: string | null };
  ui: Record<string, unknown>;
}

export type CacheState =
  | { state: "ready" }
  | { state: "building"; progress: number }
  | { state: "failed"; message: string }
  | { state: "unavailable"; message: string };

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
  report: ReportSummary | null;
  notes: string[];
  dirty: boolean;
  undo: string | null;
  redo: string | null;
  revision: number;
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
  | "snowpack";

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

/** Edits understood by the backend (app/src-tauri/src/editing.rs). */
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
  subcatchments: [number, PPt[]][];
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

export type TableKind = "curve" | "timeseries" | "pattern" | "hydrograph" | "transect";

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
export type Table = Curve | Timeseries | Pattern | Hydrograph | Transect;

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

// ---- analysis (app/src-tauri/src/analysis.rs) ----------------------------------

export type Stat =
  | { stat: "max" }
  | { stat: "min" }
  | { stat: "mean" }
  | { stat: "time_of_max" }
  | { stat: "total" }
  | { stat: "periods_above"; threshold: number };

export type Calendar = "day" | "month" | "year";

export interface Aggregated {
  starts_ms: number[];
  end_ms: number | null;
  periods: [number, number][];
  values: number[];
  unit: string;
}

export interface YearStats {
  year: number;
  count: number;
  total: number;
  hours: number;
  peak: number | null;
}

export interface EventRow {
  index: number;
  id: string;
  count: number;
  per_year: number;
  total: number;
  hours: number;
  peak: number | null;
  years: YearStats[];
}

export interface EventTable {
  rows: EventRow[];
  years: number;
  unit: string;
  total_unit: string;
  seconds: number;
}

export interface EventDto {
  start: number;
  end: number;
  peak: number;
  peak_period: number;
  total: number;
  hours: number;
}

export interface ProfileNode {
  index: number;
  id: string;
  station: number;
  invert: number | null;
  rim: number | null;
}

export interface ProfileLink {
  index: number;
  id: string;
  start: number;
  end: number;
  invert_start: number | null;
  invert_end: number | null;
  height: number | null;
}

export interface ProfileDto {
  nodes: ProfileNode[];
  links: ProfileLink[];
  max_head: (number | null)[];
}

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  object: ObjRef | null;
  section: string | null;
  id: string | null;
}

export type GridColumn = FieldType & { key: string; name: string; unit: string };

export interface GridRow {
  key: string[];
  cells: (string | null)[];
  object: number | null;
}

export interface Grid {
  section: string;
  object_kind: ObjKind;
  columns: GridColumn[];
  rows: GridRow[];
}

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

export interface RunRecord {
  label: string | null;
  model: string;
  engine: EngineConfig;
  started: string;
  seconds: number;
  status: "success" | "warnings" | "failed" | "cancelled";
  exit_code: number | null;
  errors: number;
  warnings: number;
  continuity: { runoff_quantity: number | null; groundwater: number | null; flow_routing: number | null } | null;
  inp: string;
  rpt: string;
  out: string;
}

export interface RunDto {
  dir: string;
  record: RunRecord;
  out: string | null;
  rpt: string | null;
  loaded: boolean;
  compared: boolean;
}

export interface SectionInfo {
  name: string;
  lines: number;
  present: boolean;
}
