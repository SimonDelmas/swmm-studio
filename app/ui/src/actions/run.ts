// Running the model: start, and the events the backend sends while it runs.

import { api, errorText } from "../api";
import { getState, notify, setState } from "../store";
import type { RunFinished, RunProgress } from "../types";
import { setResultsInfo } from "./model";
import { refreshRuns } from "./runs";

/** Starts a simulation of the model as it is now (unsaved edits included). */
export async function startRun(label: string | null = null) {
  const s = getState();
  if (!s.model || s.run.running) return;
  if (!s.engine) {
    notify("Configure a SWMM engine first", true);
    setState({ dialog: "engines" });
    return;
  }
  // The simulation tab shows the list of runs, the new one first with its progress.
  setState({ run: { running: true, dir: null, progress: null, elapsed: 0, log: [], last: null }, bottomTab: "simulation", simView: null });
  try {
    await api.runStart(label);
  } catch (e) {
    setState({ run: { ...getState().run, running: false } });
    notify(errorText(e), true);
  }
}

export function cancelRun() {
  api.runCancel().catch((e) => notify(errorText(e), true));
}

export function onProgress(p: RunProgress) {
  const r = getState().run;
  setState({ run: { ...r, dir: p.run_dir ?? r.dir, progress: p.progress ?? r.progress, elapsed: p.elapsed } });
}

export function onOutput(line: string) {
  const r = getState().run;
  setState({ run: { ...r, log: [...r.log.slice(-1999), line] } });
}

export function onFinished(f: RunFinished) {
  const watching = getState().simView === "running";
  setState({ run: { ...getState().run, running: false, progress: null, last: f } });
  void refreshRuns();
  // The console of the run shown becomes its report.
  if (watching) setState({ simView: f.run_dir });
  // Without results (failed run), layers coloured by a result go back to their default.
  if (f.info) setResultsInfo(f.info, true);
  const what =
    f.status === "success"
      ? "Simulation completed"
      : f.status === "warnings"
        ? `Simulation completed with ${f.warnings} warning(s)`
        : f.status === "cancelled"
          ? "Simulation cancelled"
          : `Simulation failed${f.errors ? ` with ${f.errors} error(s)` : ""}${f.info?.results ? "; partial results loaded" : ""}`;
  notify(`${what} (${f.seconds.toFixed(1)} s)`, f.status === "failed");
  if ((f.errors > 0 || f.status === "failed") && f.run_dir) setState({ bottomTab: "simulation", simView: f.run_dir });
}
