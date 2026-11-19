import { cancelRun, startRun } from "../actions/run";
import { setState, useStore } from "../store";

export function RunControls() {
  const run = useStore((s) => s.run);
  const model = useStore((s) => s.model);
  const engine = useStore((s) => s.engine);
  if (run.running)
    return (
      <span className="run-controls">
        <span className="link-like" title="Simulation progress – click to show the console" onClick={() => setState({ bottomTab: "simulation", simView: "running" })}>
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
