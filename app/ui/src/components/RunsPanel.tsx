import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { exportTable } from "../exporting";
import { getState, notify, setState, styleUsable, defaultStyle, useStore, type StyledKind } from "../store";
import type { ModelInfo, RunDto } from "../types";

/** Applies new model info after results were loaded or unloaded (styles that no longer apply are reset). */
export function setResultsInfo(model: ModelInfo, resetTime: boolean) {
  const s = getState();
  const styles = { ...s.styles };
  for (const k of Object.keys(styles) as StyledKind[]) if (!styleUsable(styles[k], k, model)) styles[k] = defaultStyle(k);
  const plot = s.plot.filter((p) => !p.b || model.compare);
  setState({ model, styles, plot, ...(resetTime ? { period: 0, playing: false } : {}) });
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v.toFixed(2)} %`);

function local(rfc: string) {
  const d = new Date(rfc);
  if (Number.isNaN(d.getTime())) return rfc;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Previous runs of the model: load, compare, label, delete. */
export function RunsPanel() {
  const model = useStore((s) => s.model);
  const lastRun = useStore((s) => s.run.last);
  const [runs, setRuns] = useState<RunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api
      .runs()
      .then((r) => (setRuns(r), setError(null)))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    if (model) reload();
  }, [model?.path, model?.results?.path, model?.compare?.path, lastRun]);

  if (!model) return <div className="panel-empty">Open a model first.</div>;
  const act = async (f: () => Promise<ModelInfo>, resetTime: boolean, done: string) => {
    setState({ busy: "Loading results…" });
    try {
      setResultsInfo(await f(), resetTime);
      notify(done);
      reload();
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setState({ busy: null });
    }
  };
  const remove = async (r: RunDto) => {
    const ok = await ask(`Delete the run ${r.record.label ?? local(r.record.started)} and its files?\n${r.dir}`, {
      title: "SWMM Studio",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (ok) await act(() => api.deleteRun(r.dir), r.loaded, "Run deleted");
  };
  const label = async (r: RunDto, text: string) => {
    if ((r.record.label ?? "") === text.trim()) return;
    try {
      setRuns(await api.setRunLabel(r.dir, text.trim() || null));
    } catch (e) {
      notify(errorText(e), true);
    }
  };
  const headers = ["Started", "Label", "Status", "Engine", "Duration (s)", "Errors", "Warnings", "Runoff continuity (%)", "Routing continuity (%)", "Folder"];
  const exportRuns = () =>
    runs &&
    exportTable(
      "runs",
      "Runs",
      headers,
      runs.map((r) => [
        local(r.record.started),
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
  return (
    <div className="runs-panel">
      <div className="panel-toolbar">
        <span className="muted">Runs are kept in {model.name.replace(/\.inp$/i, "")}_runs next to the model.</span>
        <span className="grow" />
        <button onClick={reload}>Refresh</button>
        <button disabled={!runs?.length} onClick={exportRuns}>
          Export
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {runs && runs.length === 0 && <div className="panel-empty">No run yet: Run (F5) keeps each simulation here.</div>}
      {runs && runs.length > 0 && (
        <div className="table-box">
          <table className="grid runs">
            <thead>
              <tr>
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
              {runs.map((r) => (
                <tr key={r.dir} className={r.loaded ? "active-row" : r.compared ? "compared-row" : undefined}>
                  <td title={r.dir}>{local(r.record.started)}</td>
                  <td>
                    <input
                      key={r.record.label ?? ""}
                      defaultValue={r.record.label ?? ""}
                      placeholder="label"
                      onBlur={(e) => label(r, e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
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
                  <td className="actions">
                    {r.loaded ? (
                      <span className="badge">loaded</span>
                    ) : (
                      <button disabled={!r.out} onClick={() => act(() => api.openRun(r.dir), true, "Run loaded")}>
                        Load
                      </button>
                    )}
                    {r.compared ? (
                      <button onClick={() => act(() => api.closeComparison(), false, "Comparison closed")}>Uncompare</button>
                    ) : (
                      <button
                        disabled={!r.out || r.loaded || !model.results}
                        title="Compare the loaded results with this run (run B)"
                        onClick={() => act(() => api.compareRun(r.dir), false, "Comparing with this run")}
                      >
                        Compare
                      </button>
                    )}
                    <button className="danger" onClick={() => remove(r)}>
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
