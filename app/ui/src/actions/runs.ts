// The runs of the model: listing, loading, overlaying on the graphs, comparing, deleting.

import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import type { RunDto } from "../analysisTypes";
import type { ModelInfo } from "../types";
import { getState, notify, setState, startBusy } from "../store";
import { setResultsInfo } from "./model";
import { closeReportViews, openCompareView, openReportView, renameReportView } from "./views";

/** Start time of a run, in local time. */
export function runTime(rfc: string) {
  const d = new Date(rfc);
  if (Number.isNaN(d.getTime())) return rfc;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Name of a run: its label, else when it started. */
export const runName = (r: RunDto) => r.record.label ?? runTime(r.record.started);

/** Name of the run whose results are in `path` (else the file name). */
export function resultsName(path: string): string {
  const r = getState().runs?.find((x) => x.out === path);
  return r ? runName(r) : (path.split(/[\\/]/).pop() ?? path);
}

/** Opens the report of a run in a tab (or shows the tab that has it). */
export const showRunReport = (r: RunDto) => openReportView(r.dir, runName(r));

/** Opens the report of the run in `dir` once the runs are listed again (a run just finished). */
export async function showRunReportOf(dir: string) {
  await refreshRuns();
  const r = getState().runs?.find((x) => x.dir === dir);
  openReportView(dir, r ? runName(r) : (dir.split(/[\\/]/).pop() ?? dir));
}

/** Opens the report of the results loaded from outside the runs in a tab. */
export const showLoadedReport = () => openReportView(null, "Loaded results");

let listing = 0;
/** Lists the runs of the model again. */
export async function refreshRuns(): Promise<void> {
  const id = ++listing;
  if (!getState().model) return;
  try {
    const runs = await api.runs();
    if (id === listing) setState({ runs });
  } catch (e) {
    if (id === listing) notify(errorText(e), true);
  }
}

async function withResults(text: string, f: () => Promise<ModelInfo>, resetTime: boolean, done?: string) {
  const finish = startBusy(text);
  try {
    setResultsInfo(await f(), resetTime);
    if (done) notify(done);
    await refreshRuns();
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    finish();
  }
}

/** Loads the results and report of a run. */
export const loadRun = (r: RunDto) => withResults("Loading results…", () => api.openRun(r.dir), true, "Run loaded");

/** The results of the run are drawn (or no longer) with each series of the time series graphs. */
export function toggleOverlay(r: RunDto, on: boolean) {
  const m = getState().model;
  if (!m || !r.out) return;
  const paths = m.overlays.map((o) => o.path).filter((p) => p !== r.out);
  if (on) paths.push(r.out);
  return withResults("Opening results…", () => api.setOverlays(paths), false);
}

export async function deleteRun(r: RunDto) {
  const ok = await ask(`Delete the run ${runName(r)} and its files?\n${r.dir}`, {
    title: "SWMM Studio",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  const s = getState();
  // Its comparison tabs go with it.
  if (r.out) setState({ compareViews: s.compareViews.filter((v) => v.path !== r.out), bottomTab: s.bottomTab === "compare" && s.compareViews.find((v) => v.id === s.compareView)?.path === r.out ? "simulation" : s.bottomTab });
  closeReportViews(r.dir);
  await withResults("Deleting run…", () => api.deleteRun(r.dir), r.loaded, "Run deleted");
}

export async function setRunLabel(r: RunDto, text: string) {
  if ((r.record.label ?? "") === text.trim()) return;
  try {
    const runs = await api.setRunLabel(r.dir, text.trim() || null);
    setState({ runs });
    const now = runs.find((x) => x.dir === r.dir);
    if (now) renameReportView(r.dir, runName(now));
  } catch (e) {
    notify(errorText(e), true);
  }
}

/** Opens a comparison tab of the loaded results with a run. */
export function compareWithRun(r: RunDto) {
  if (r.out) openCompareView(r.out, `Compare ${runName(r)}`);
}

/** Asks for a results file and opens a comparison tab with it. */
export async function compareWithFile() {
  const path = await open({ filters: [{ name: "SWMM results", extensions: ["out"] }] });
  if (typeof path === "string") openCompareView(path, `Compare ${resultsName(path)}`);
}
