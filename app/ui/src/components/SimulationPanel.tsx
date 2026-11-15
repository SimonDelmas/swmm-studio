import { setState, useStore, type State } from "../store";
import type { SimTab } from "../uiTypes";
import { ReportPanel } from "./ReportPanel";
import { RunPanel } from "./RunPanel";
import { RunsPanel } from "./RunsPanel";

const SIM_TABS: [SimTab, string, string][] = [
  ["run", "Console", "Run the model and follow its output"],
  ["runs", "Runs", "Previous runs: load or compare their results"],
  ["report", "Report", "Report of the loaded results"],
];

/** Number of errors in the report of the loaded results. */
export const reportErrors = (s: State) => (s.model?.report ? s.model.report.errors.length : 0);

/** Side panel tab: run the model, previous runs and their reports. */
export function SimulationPanel() {
  const simTab = useStore((s) => s.simTab);
  const running = useStore((s) => s.run.running);
  const errors = useStore(reportErrors);
  return (
    <div className="sim-panel">
      <div className="sub-tabs">
        {SIM_TABS.map(([t, label, title]) => (
          <button key={t} className={simTab === t ? "active" : ""} title={title} onClick={() => setState({ simTab: t })}>
            {label}
            {t === "run" && running && <span className="badge warn">…</span>}
            {t === "report" && errors > 0 && <span className="badge bad">{errors}</span>}
          </button>
        ))}
      </div>
      <div className="sim-body">{simTab === "run" ? <RunPanel /> : simTab === "runs" ? <RunsPanel /> : <ReportPanel />}</div>
    </div>
  );
}
