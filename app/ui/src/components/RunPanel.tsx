import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { defaultStyle, getState, notify, setState, useStore, type StyledKind } from "../store";
import type { RunFinished, RunProgress } from "../types";

/** Starts a simulation of the model as it is now (unsaved edits included). */
export async function startRun(label: string | null = null) {
  const s = getState();
  if (!s.model || s.run.running) return;
  if (!s.engine) {
    notify("Configure a SWMM engine first", true);
    setState({ dialog: "engines" });
    return;
  }
  setState({ run: { running: true, progress: null, elapsed: 0, log: [], last: null }, bottomTab: "run" });
  try {
    await api.runStart(label);
  } catch (e) {
    setState({ run: { ...getState().run, running: false } });
    notify(errorText(e), true);
  }
}

export function onProgress(p: RunProgress) {
  const r = getState().run;
  setState({ run: { ...r, progress: p.progress ?? r.progress, elapsed: p.elapsed } });
}

export function onOutput(line: string) {
  const r = getState().run;
  setState({ run: { ...r, log: [...r.log.slice(-1999), line] } });
}

export function onFinished(f: RunFinished) {
  const s = getState();
  const patch: Parameters<typeof setState>[0] = { run: { ...s.run, running: false, progress: null, last: f } };
  if (f.info) {
    Object.assign(patch, { model: f.info, period: 0, playing: false });
    // Without results (failed run), layers coloured by a result go back to their default.
    const styles = { ...s.styles };
    for (const k of Object.keys(styles) as StyledKind[]) {
      if (styles[k].source === "result" && !f.info.results?.variables[k]?.[Number(styles[k].field)]) styles[k] = defaultStyle(k);
    }
    Object.assign(patch, { styles });
  }
  setState(patch);
  const what =
    f.status === "success"
      ? "Simulation completed"
      : f.status === "warnings"
        ? `Simulation completed with ${f.warnings} warning(s)`
        : f.status === "cancelled"
          ? "Simulation cancelled"
          : `Simulation failed${f.errors ? ` with ${f.errors} error(s)` : ""}`;
  notify(`${what} (${f.seconds.toFixed(1)} s)`, f.status === "failed");
  if (f.errors > 0) setState({ bottomTab: "report" });
}

export function RunControls() {
  const run = useStore((s) => s.run);
  const model = useStore((s) => s.model);
  const engine = useStore((s) => s.engine);
  if (run.running)
    return (
      <span className="run-controls">
        <span title="Simulation progress">
          {run.progress === null ? "Starting…" : `${Math.round(run.progress * 100)} %`}
          <span className="progress">
            <span style={{ width: `${(run.progress ?? 0) * 100}%` }} />
          </span>
        </span>
        <span className="muted">{run.elapsed.toFixed(0)} s</span>
        <button onClick={() => api.runCancel()}>Cancel</button>
      </span>
    );
  return (
    <button
      className="primary"
      disabled={!model}
      title={engine ? `Run the model with ${engine}` : "No SWMM engine configured: click to add one"}
      onClick={() => startRun()}
    >
      ▶ Run
    </button>
  );
}

export function RunPanel() {
  const run = useStore((s) => s.run);
  const engine = useStore((s) => s.engine);
  const dirty = useStore((s) => s.model?.dirty ?? false);
  const [label, setLabel] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run.log.length]);
  const f = run.last;
  return (
    <div className="run-panel">
      <div className="panel-toolbar">
        <span>
          Engine: <b>{engine ?? "none"}</b> <a onClick={() => setState({ dialog: "engines" })}>change</a>
        </span>
        <input placeholder="Run label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={run.running} />
        {run.running ? (
          <button onClick={() => api.runCancel()}>Cancel</button>
        ) : (
          <button className="primary" onClick={() => startRun(label.trim() || null)}>
            ▶ Run
          </button>
        )}
        {dirty && !run.running && <span className="muted">The model is run as edited; it does not need to be saved first.</span>}
      </div>
      {f && (
        <div className={`run-result ${f.status}`}>
          <b>{f.status}</b> in {f.seconds.toFixed(1)} s{f.errors > 0 && `, ${f.errors} error(s)`}
          {f.warnings > 0 && `, ${f.warnings} warning(s)`}
          {f.message && ` — ${f.message}`}
          {f.run_dir && <span className="muted mono"> {f.run_dir}</span>}
          {f.errors + f.warnings > 0 && (
            <>
              {" "}
              <a onClick={() => setState({ bottomTab: "report" })}>see the report</a>
            </>
          )}
        </div>
      )}
      <pre className="run-log" ref={logRef}>
        {(run.log.length ? run.log : f?.console ?? []).join("\n")}
      </pre>
    </div>
  );
}
