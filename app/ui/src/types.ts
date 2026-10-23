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
  report: ReportSummary | null;
  notes: string[];
}

export interface PropertyGroup {
  title: string;
  fields: [string, string][];
  comment: string | null;
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
  subStarts: Uint32Array;
  subPts: Float64Array;
  gages: Float64Array;
}

export interface MinMaxSeries {
  periods: Uint32Array;
  min: Float32Array;
  max: Float32Array;
}
