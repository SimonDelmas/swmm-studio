// Typed wrappers over the Tauri commands. Big arrays come back as ArrayBuffers.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BlockDto,
  CrsEntry,
  ElementKind,
  Geometry,
  MinMaxSeries,
  ModelInfo,
  ObjectInfo,
  ObjKind,
  ObjRef,
  ResultsInfo,
  Basemap,
  DeletePlan,
  EditOutcome,
  EditRequest,
  EnginesDto,
  OptionsDto,
  RefKind,
  RunFinished,
  RunProgress,
  Table,
  TableKind,
  Aggregated,
  Calendar,
  Climate,
  EventDto,
  EventTable,
  Grid,
  Issue,
  ProfileDto,
  RunDto,
  SectionInfo,
  Stat,
} from "./types";

async function buffer(cmd: string, args?: Record<string, unknown>): Promise<ArrayBuffer> {
  const r = await invoke<ArrayBuffer | number[]>(cmd, args);
  // Tauri returns an ArrayBuffer for `ipc::Response`; be lenient with plain arrays.
  return r instanceof ArrayBuffer ? r : new Uint8Array(r).buffer;
}

export function decodeGeometry(buf: ArrayBuffer): Geometry {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "SWG2") throw new Error("bad geometry buffer");
  const space = dv.getUint32(4, true) === 1 ? "lonlat" : "cartesian";
  const origin: [number, number] = [dv.getFloat64(8, true), dv.getFloat64(16, true)];
  const [nNodes, nLinks, nLinkPts, nSubs, nSubPts, nGages] = [24, 28, 32, 36, 40, 44].map((o) =>
    dv.getUint32(o, true),
  );
  let at = 64;
  const f64 = (n: number) => {
    const a = new Float64Array(buf, at, 2 * n);
    at += 16 * n;
    return a;
  };
  const nodes = f64(nNodes);
  const linkPts = f64(nLinkPts);
  const subPts = f64(nSubPts);
  const gages = f64(nGages);
  const u32 = (n: number) => {
    const a = new Uint32Array(buf.slice(at, at + 4 * n));
    at += 4 * n;
    return a;
  };
  const linkStarts = u32(nLinks + 1);
  const subStarts = u32(nSubs + 1);
  const linkEnds = u32(2 * nLinks);
  const nodeTypes = new Uint8Array(buf, at, nNodes);
  at += nNodes;
  const linkTypes = new Uint8Array(buf, at, nLinks);
  return { space, origin, nodes, nodeTypes, linkStarts, linkPts, linkTypes, linkEnds, subStarts, subPts, gages };
}

export const api = {
  openModel: (path: string) => invoke<ModelInfo>("open_model", { path }),
  modelInfo: () => invoke<ModelInfo>("model_info"),
  geometry: async () => decodeGeometry(await buffer("geometry")),
  ids: (kind: ObjKind) => invoke<string[]>("ids", { kind }),
  searchCrs: (query: string) => invoke<CrsEntry[]>("search_crs", { query }),
  setCrs: (crs: string | null) => invoke<ModelInfo>("set_crs", { crs }),
  updateProject: (basemap?: Basemap, ui?: unknown) => invoke<void>("update_project", { basemap, ui }),
  pick: (x: number, y: number, tol: number) => invoke<ObjRef | null>("pick", { x, y, tol }),
  selectRect: (a: [number, number], b: [number, number]) => invoke<ObjRef[]>("select_rect", { a, b }),
  selectPolygon: (ring: [number, number][]) => invoke<ObjRef[]>("select_polygon", { ring }),
  findObject: (id: string) => invoke<ObjRef | null>("find_object", { id }),
  objectInfo: (o: ObjRef, period: number | null) =>
    invoke<ObjectInfo>("object_info", { kind: o.kind, index: o.index, period }),
  attribute: async (kind: ObjKind, name: string) => new Float32Array(await buffer("attribute", { kind, name })),
  openResults: (path: string) => invoke<ModelInfo>("open_results", { path }),
  openReport: (path: string) => invoke<ModelInfo>("open_report", { path }),
  frame: async (kind: ElementKind, v: number, period: number) =>
    new Float32Array(await buffer("frame", { kind, var: v, period })),
  envelope: async (kind: ElementKind, v: number) => new Float32Array(await buffer("envelope", { kind, var: v })),
  series: async (
    kind: ElementKind,
    index: number,
    v: number,
    p0: number,
    p1: number,
    buckets: number,
    b = false,
  ): Promise<MinMaxSeries> => {
    const buf = await buffer("series", { kind, index, var: v, p0, p1, buckets: Math.max(1, Math.round(buckets)), b });
    const n = new DataView(buf).getUint32(0, true);
    return {
      periods: new Uint32Array(buf.slice(4, 4 + 4 * n)),
      min: new Float32Array(buf.slice(4 + 4 * n, 4 + 8 * n)),
      max: new Float32Array(buf.slice(4 + 8 * n, 4 + 12 * n)),
    };
  },
  timeOfMax: (kind: ElementKind, index: number, v: number) => invoke<number>("time_of_max", { kind, index, var: v }),
  nextEvent: (kind: ElementKind, index: number, v: number, from: number, threshold: number) =>
    invoke<number | null>("next_event", { kind, index, var: v, from, threshold }),
  reportBlock: (index: number) => invoke<BlockDto>("report_block", { index }),
  rebuildCache: () => invoke<ModelInfo>("rebuild_cache"),
  saveFile: (path: string, data: Uint8Array) =>
    invoke<void>("save_file", data, { headers: { path: encodeURIComponent(path) } }),
  edit: (request: EditRequest, selection: ObjRef[]) => invoke<EditOutcome>("edit", { request, selection }),
  undo: (selection: ObjRef[]) => invoke<EditOutcome>("undo", { selection }),
  redo: (selection: ObjRef[]) => invoke<EditOutcome>("redo", { selection }),
  deletePlan: (objects: ObjRef[]) => invoke<DeletePlan>("delete_plan", { objects }),
  names: (kind: RefKind) => invoke<string[]>("names", { kind }),
  table: (kind: TableKind, name: string) => invoke<Table>("table", { kind, name }),
  options: () => invoke<OptionsDto>("options"),
  saveModel: (path: string | null) => invoke<ModelInfo>("save_model", { path }),
  newModel: (path: string, flowUnits: string) => invoke<ModelInfo>("new_model", { path, flowUnits }),
  engines: () => invoke<EnginesDto>("engines"),
  addEngine: (name: string, path: string) => invoke<EnginesDto>("add_engine", { name, path }),
  removeEngine: (name: string) => invoke<EnginesDto>("remove_engine", { name }),
  setDefaultEngine: (name: string) => invoke<EnginesDto>("set_default_engine", { name }),
  setProjectEngine: (name: string | null) => invoke<EnginesDto>("set_project_engine", { name }),
  runStart: (label: string | null) => invoke<void>("run_start", { label }),
  runCancel: () => invoke<void>("run_cancel"),
  statValues: async (kind: ElementKind, v: number, stat: Stat, p0: number, p1: number, b = false) =>
    new Float32Array(await buffer("stat_values", { kind, var: v, stat, p0, p1, b })),
  statUnit: (kind: ElementKind, v: number, stat: Stat, b = false) => invoke<string>("stat_unit", { kind, var: v, stat, b }),
  compareFrame: async (kind: ElementKind, v: number, period: number) =>
    new Float32Array(await buffer("compare_frame", { kind, var: v, period })),
  comparePeriod: (period: number) => invoke<number | null>("compare_period", { period }),
  openComparison: (path: string) => invoke<ModelInfo>("open_comparison", { path }),
  closeComparison: () => invoke<ModelInfo>("close_comparison"),
  aggregate: (kind: ElementKind, index: number, v: number, unit: Calendar, stat: Stat, b = false) =>
    invoke<Aggregated>("aggregate", { kind, index, var: v, unit, stat, b }),
  eventStats: (query: {
    kind: ElementKind;
    var: number;
    threshold: number;
    min_gap_hours: number;
    objects: number[] | null;
    outfalls_only: boolean;
    b: boolean;
  }) => invoke<EventTable>("event_stats", { query }),
  objectEvents: (kind: ElementKind, index: number, v: number, threshold: number, minGapHours: number, b = false) =>
    invoke<EventDto[]>("object_events", { kind, index, var: v, threshold, minGapHours, b }),
  profile: (nodes: number[]) => invoke<ProfileDto>("profile", { nodes }),
  heads: async (nodes: number[], period: number, b = false) => new Float32Array(await buffer("heads", { nodes, period, b })),
  validate: () => invoke<Issue[]>("validate_model"),
  grid: (section: string) => invoke<Grid>("grid", { section }),
  climate: () => invoke<Climate>("climate"),
  sections: () => invoke<SectionInfo[]>("sections"),
  sectionText: (section: string) => invoke<string>("section_text", { section }),
  runs: () => invoke<RunDto[]>("runs"),
  openRun: (dir: string) => invoke<ModelInfo>("open_run", { dir }),
  compareRun: (dir: string) => invoke<ModelInfo>("compare_run", { dir }),
  setRunLabel: (dir: string, label: string | null) => invoke<RunDto[]>("set_run_label", { dir, label }),
  deleteRun: (dir: string) => invoke<ModelInfo>("delete_run", { dir }),
  launchFile: () => invoke<string | null>("launch_file"),
  exportTable: (path: string, title: string, columns: string[], rows: string[][]) =>
    invoke<void>("export_table", { path, title, columns, rows }),
};

export function onRunProgress(f: (p: RunProgress) => void): Promise<UnlistenFn> {
  return listen<RunProgress>("run-progress", (e) => f(e.payload));
}

export function onRunOutput(f: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>("run-output", (e) => f(e.payload));
}

export function onRunFinished(f: (r: RunFinished) => void): Promise<UnlistenFn> {
  return listen<RunFinished>("run-finished", (e) => f(e.payload));
}

export function onCacheProgress(f: (p: { path: string; progress: number }) => void): Promise<UnlistenFn> {
  return listen<{ path: string; progress: number }>("cache-progress", (e) => f(e.payload));
}

export function onResultsChanged(f: (r: ResultsInfo) => void): Promise<UnlistenFn> {
  return listen<ResultsInfo>("results-changed", (e) => f(e.payload));
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export function onOpenFile(f: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("open-file", (e) => f(e.payload));
}
