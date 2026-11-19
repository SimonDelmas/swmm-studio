import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { cancelRun, startRun } from "../actions/run";
import { deleteRun, loadRun, refreshRuns, runName, runTime, setRunLabel, showLoadedReport, showRunReport, toggleOverlay } from "../actions/runs";
import { exportTable } from "../exporting";
import { setState, useStore, type State } from "../store";
import type { ReportSummary } from "../types";
import type { ReportTabView } from "../uiTypes";
import { CommitInput } from "./CommitInput";
import { LinkButton } from "./LinkButton";
import { Linkified } from "./ObjLink";
import { ReportPanel, reportMemo, ReportView, type ReportMemo } from "./ReportPanel";

/** Number of errors in the report of the loaded results. */
export const reportErrors = (s: State) => (s.model?.report ? s.model.report.errors.length : 0);

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v.toFixed(2)} %`);
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Bottom panel tab: the runs of the model, or the console of the running one. A run's report opens in a tab of its own. */
export function SimulationPanel() {
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.simView);
  if (!model) return <div className="panel-empty">Open a model first.</div>;
  if (view === "running") return <RunConsole back={<button onClick={() => setState({ simView: null })}>← Simulations</button>} />;
  return <RunList />;
}

/** A report tab: the report of a run, or of the results loaded from outside the runs. */
export function ReportTab({ view }: { view: ReportTabView }) {
  const model = useStore((s) => s.model);
  const memo = reportMemo(view.id);
  if (!model) return <div className="panel-empty">Open a model first.</div>;
  if (view.dir === null)
    return (
      <div className="sim-detail">
        <div className="panel-toolbar">
          <b>Loaded results</b>
        </div>
        <ReportPanel memo={memo} />
      </div>
    );
  return <RunDetail dir={view.dir} memo={memo} />;
}

/** The runs of the model, the running one first with its progress. */
function RunList() {
  const model = useStore((s) => s.model)!;
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const engine = useStore((s) => s.engine);
  const [label, setLabel] = useState("");
  const overlaid = new Set(model.overlays.map((o) => o.path));
  // Results loaded from elsewhere than a run (a .out next to the model, a file opened).
  const outside = (model.results || model.report) && !runs?.some((r) => r.loaded);
  const headers = ["Started", "Label", "Status", "Engine", "Duration (s)", "Errors", "Warnings", "Runoff continuity (%)", "Routing continuity (%)", "Folder"];
  const exportRuns = () =>
    runs &&
    exportTable(
      "runs",
      "Runs",
      headers,
      runs.map((r) => [
        runTime(r.record.started),
        r.record.label ?? "",
        r.record.status,
        r.record.engine.name,
        r.record.seconds,
        r.record.errors,
        r.record.warnings,
        r.record.continuity?.runoff_quantity ?? null,
        r.record.continuity?.flow_routing ?? null,
        r.dir,
      ]),
    );
  // Clicks on the controls of a row do not open the run.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div className="runs-panel">
      <div className="panel-toolbar">
        <span>
          Engine: <b>{engine ?? "none"}</b> <LinkButton onClick={() => setState({ dialog: "engines" })}>change</LinkButton>
        </span>
        <input placeholder="Run label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={run.running} />
        {run.running ? (
          <button onClick={cancelRun}>Cancel</button>
        ) : (
          <button
            className="primary"
            onClick={() => {
              void startRun(label.trim() || null);
              setLabel("");
            }}
          >
            ▶ Run
          </button>
        )}
        {model.dirty && !run.running && <span className="muted">The model is run as edited; it does not need to be saved first.</span>}
        <span className="grow" />
        {outside && (
          <LinkButton onClick={showLoadedReport}>
            Loaded: {model.results ? fileName(model.results.path) : fileName(model.report!.path)}
          </LinkButton>
        )}
        <button onClick={() => void refreshRuns()}>Refresh</button>
        <button disabled={!runs?.length} onClick={exportRuns}>
          Export
        </button>
      </div>
      {runs && runs.length === 0 && !run.running && <div className="panel-empty">No run yet: Run (F5) keeps each simulation in {model.name.replace(/\.inp$/i, "")}_runs next to the model.</div>}
      {(run.running || (runs && runs.length > 0)) && (
        <div className="table-box">
          <table className="grid runs">
            <thead>
              <tr>
                <th title="Draw these runs with each series of the time series graphs">Graphs</th>
                <th></th>
                <th>Started</th>
                <th>Label</th>
                <th>Status</th>
                <th>Engine</th>
                <th>Duration</th>
                <th>Errors / warnings</th>
                <th>Continuity runoff / routing</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {run.running && (
                <tr className="link-row running-row" title="Show the console" onClick={() => setState({ simView: "running" })}>
                  <td />
                  <td />
                  <td>now</td>
                  <td className="muted">{run.dir ? fileName(run.dir) : ""}</td>
                  <td colSpan={3}>
                    <span className="run-progress">
                      <span className="progress">
                        <span style={{ width: `${(run.progress ?? 0) * 100}%` }} />
                      </span>
                      {run.progress === null ? "Starting…" : `${Math.round(run.progress * 100)} %`}
                    </span>
                  </td>
                  <td className="num">{run.elapsed.toFixed(0)} s</td>
                  <td />
                  <td className="actions" onClick={stop}>
                    <button onClick={cancelRun}>Cancel</button>
                  </td>
                </tr>
              )}
              {runs?.map((r) => (
                <tr key={r.dir} className={`link-row${r.loaded ? " active-row" : ""}`} title="Show the report (in a tab)" onClick={() => showRunReport(r)}>
                  <td className="check" onClick={stop}>
                    <input
                      type="checkbox"
                      disabled={!r.out || r.loaded || !model.results}
                      checked={!!r.out && overlaid.has(r.out)}
                      title={
                        !r.out
                          ? "This run has no results"
                          : r.loaded
                            ? "The loaded results are always drawn"
                            : !model.results
                              ? "Load results first"
                              : "Draw this run with each series of the time series graphs"
                      }
                      onChange={(e) => toggleOverlay(r, e.target.checked)}
                    />
                  </td>
                  <td className="actions" onClick={stop}>
                    {r.loaded ? (
                      <span className="badge">loaded</span>
                    ) : (
                      <button disabled={!r.out} onClick={() => loadRun(r)}>
                        Load
                      </button>
                    )}
                  </td>
                  <td title={r.dir}>{runTime(r.record.started)}</td>
                  <td onClick={stop}>
                    <CommitInput value={r.record.label ?? ""} placeholder="label" onCommit={(text) => setRunLabel(r, text)} />
                  </td>
                  <td className={r.record.status === "failed" ? "bad" : r.record.status === "warnings" ? "warn" : undefined}>{r.record.status}</td>
                  <td>
                    {r.record.engine.name} {r.record.engine.version ?? ""}
                  </td>
                  <td className="num">{r.record.seconds.toFixed(1)} s</td>
                  <td className="num">
                    {r.record.errors} / {r.record.warnings}
                  </td>
                  <td className="num">
                    {pct(r.record.continuity?.runoff_quantity)} / {pct(r.record.continuity?.flow_routing)}
                  </td>
                  <td className="actions" onClick={stop}>
                    <button className="danger" onClick={() => deleteRun(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Console of the running simulation. */
function RunConsole({ back }: { back: React.ReactNode }) {
  const run = useStore((s) => s.run);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run.log.length]);
  const f = run.last;
  return (
    <div className="run-panel">
      <div className="panel-toolbar">
        {back}
        {run.running ? (
          <>
            <span className="run-progress">
              <span className="progress">
                <span style={{ width: `${(run.progress ?? 0) * 100}%` }} />
              </span>
              {run.progress === null ? "Starting…" : `${Math.round(run.progress * 100)} %`}
            </span>
            <span className="muted">{run.elapsed.toFixed(0)} s</span>
            <button onClick={cancelRun}>Cancel</button>
          </>
        ) : (
          f && (
            <span className={`run-result ${f.status}`}>
              <b>{f.status}</b> in {f.seconds.toFixed(1)} s
              {f.message && (
                <>
                  {" — "}
                  <Linkified text={f.message} />
                </>
              )}
            </span>
          )
        )}
      </div>
      <pre className="run-log" ref={logRef}>
        {run.running ? run.log.join("\n") : <Linkified text={(run.log.length ? run.log : (f?.console ?? [])).join("\n")} />}
      </pre>
    </div>
  );
}

/** Lines of a console that report an error. */
const errorLines = (lines: string[]) => lines.filter((l) => /\berror\b/i.test(l));

/**
 * A finished run: its report, with the errors of its console. What was read is kept in
 * `memo`: coming back to the tab shows it at once.
 */
function RunDetail({ dir, memo }: { dir: string; memo: ReportMemo }) {
  const model = useStore((s) => s.model)!;
  const runs = useStore((s) => s.runs);
  const last = useStore((s) => s.run.last);
  const r = runs?.find((x) => x.dir === dir);
  // The report of the loaded run is the loaded report.
  const loadedReport = r?.loaded && model.report && r.rpt && model.report.path === r.rpt ? model.report : null;
  const key = `${r?.rpt}|${r?.record.started}`;
  const kept = memo.run?.key === key ? memo.run : null;
  const keep = (p: Partial<NonNullable<ReportMemo["run"]>>) => {
    const base = memo.run?.key === key ? memo.run : { key, report: null, error: null, console: null };
    memo.run = { ...base, ...p };
  };
  const [report, setReport] = useState<ReportSummary | null>(kept?.report ?? null);
  const [reportError, setReportError] = useState<string | null>(kept?.error ?? null);
  const [console_, setConsole] = useState<string[] | null>(kept?.console ?? null);
  useEffect(() => {
    if (!r?.rpt || loadedReport) return;
    // Already read (back in the tab).
    if (memo.run?.key === key && (memo.run.report || memo.run.error)) return;
    setReport(null);
    setReportError(null);
    let live = true;
    api.runReport(dir).then(
      (x) => {
        keep({ report: x });
        if (live) setReport(x);
      },
      (e) => {
        keep({ error: errorText(e) });
        if (live) setReportError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [dir, key, !!loadedReport]);
  // The console of a run that failed or reported errors: kept in its folder, or that of the last run.
  const failed = r && (r.record.status === "failed" || r.record.errors > 0);
  useEffect(() => {
    if (!failed) return setConsole(null);
    if (last?.run_dir === dir) {
      const c = [...(last.message ? [last.message] : []), ...last.console];
      keep({ console: c });
      return setConsole(c);
    }
    if (memo.run?.key === key && memo.run.console) return;
    setConsole(null);
    let live = true;
    api.runConsole(dir).then(
      (x) => {
        keep({ console: x });
        if (live) setConsole(x);
      },
      () => live && setConsole([]),
    );
    return () => {
      live = false;
    };
  }, [dir, key, failed, last]);

  if (!runs) return <div className="panel-empty">Listing the runs…</div>;
  if (!r) return <div className="panel-empty">This run no longer exists.</div>;
  const shown = loadedReport ?? report;
  const errs = console_ ? errorLines(console_) : [];
  const consoleBox =
    console_ && (errs.length > 0 || !shown) ? (
      <div className="console-errors">
        <h4>Console {errs.length > 0 ? `errors (${errs.length})` : ""}</h4>
        <pre className="run-log">
          <Linkified text={(errs.length > 0 ? errs : console_).join("\n") || "(no console output kept for this run)"} />
        </pre>
      </div>
    ) : null;
  return (
    <div className="sim-detail">
      <div className="panel-toolbar">
        <b>{runName(r)}</b>
        <span className={r.record.status === "failed" ? "bad" : r.record.status === "warnings" ? "warn" : "muted"}>{r.record.status}</span>
        <span className="muted">
          {runTime(r.record.started)}, {r.record.seconds.toFixed(1)} s
        </span>
        {r.loaded ? (
          <span className="badge">loaded</span>
        ) : (
          <button disabled={!r.out} onClick={() => loadRun(r)}>
            Load
          </button>
        )}
        <span className="grow" />
        <span className="muted mono" title={r.dir}>
          {fileName(r.dir)}
        </span>
      </div>
      {shown ? (
        <ReportView report={shown} source={loadedReport ? null : shown.path} extra={consoleBox} memo={memo} />
      ) : (
        <div className="report-summary">
          {reportError && <div className="panel-error">{reportError}</div>}
          {!r.rpt && <div className="muted">This run wrote no report.</div>}
          {r.rpt && !reportError && <div className="muted">Reading the report…</div>}
          {consoleBox}
        </div>
      )}
    </div>
  );
}
