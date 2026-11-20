// Mirrors of the Rust DTOs of the analysis side (app/src-tauri/src: analysis, runs, model_views).

import type { EngineConfig, FieldType, LinkType, ObjKind, ObjRef } from "./types";


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
  kind: LinkType;
  /** Cross-section shape (e.g. "CIRCULAR"; empty without one). */
  shape: string;
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
  /** Line in the section (1 = the first after the header), for sections edited as text. */
  line: number | null;
}

/** A problem on a line of control rules being edited. */
export interface RuleIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** Index of the line in the text (0 = the first). */
  line: number;
  rule: string | null;
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
