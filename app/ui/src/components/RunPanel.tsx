import { LinkButton } from "./LinkButton";
import { useEffect, useRef, useState } from "react";
import { cancelRun, startRun } from "../actions/run";
import { setState, useStore } from "../store";
import { Linkified } from "../objects";

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
        <button onClick={cancelRun}>Cancel</button>
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
          Engine: <b>{engine ?? "none"}</b> <LinkButton onClick={() => setState({ dialog: "engines" })}>change</LinkButton>
        </span>
        <input placeholder="Run label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={run.running} />
        {run.running ? (
          <button onClick={cancelRun}>Cancel</button>
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
          {f.message && (
            <>
              {" — "}
              <Linkified text={f.message} />
            </>
          )}
          {f.run_dir && <span className="muted mono"> {f.run_dir}</span>}
          {f.errors + f.warnings > 0 && (
            <>
              {" "}
              <LinkButton onClick={() => setState({ sideTab: "simulation", simTab: "report" })}>see the report</LinkButton>
            </>
          )}
        </div>
      )}
      <pre className="run-log" ref={logRef}>
        {run.running ? run.log.join("\n") : <Linkified text={(run.log.length ? run.log : (f?.console ?? [])).join("\n")} />}
      </pre>
    </div>
  );
}
