import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { exportTable } from "../exporting";
import { formatDateTime, periodMs } from "../format";
import { getState, makeStat, notify, setState, useStore, type StatName } from "../store";
import { addToPlot } from "./PlotPanel";
import { setResultsInfo } from "./RunsPanel";
import { applyStyle, STATS } from "./StylePanel";
import { VirtualTable, type CellValue } from "./VirtualTable";

type Kind = "node" | "link" | "subcatchment";

const num = (v: CellValue) => (typeof v === "number" ? formatNumber(v) : (v ?? ""));

export async function chooseComparison() {
  const path = await open({ filters: [{ name: "SWMM results", extensions: ["out"] }] });
  if (typeof path !== "string") return;
  setState({ busy: "Opening results…" });
  try {
    setResultsInfo(await api.openComparison(path), false);
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    setState({ busy: null });
  }
}

/** Loaded results (A) against compared results (B): per-object statistics and their differences. */
export function ComparePanel() {
  const model = useStore((s) => s.model);
  const a = model?.results ?? null;
  const b = model?.compare ?? null;
  const [kind, setKind] = useState<Kind>("node");
  const [v, setV] = useState(0);
  const [stat, setStat] = useState<StatName>("max");
  const [threshold, setThreshold] = useState("0");
  const [values, setValues] = useState<[Float32Array, Float32Array] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const vars = a?.variables[kind] ?? [];
  const shared = vars.map((x, i) => [x, i] as const).filter(([x]) => b?.variables[kind]?.some((y) => y.name === x.name));
  const vi = shared.some(([, i]) => i === v) ? v : (shared[0]?.[1] ?? 0);
  const revision = model?.revision ?? 0;

  useEffect(() => {
    setValues(null);
    if (!a || !b || shared.length === 0) return;
    const th = Number(threshold);
    if (!Number.isFinite(th)) return;
    let live = true;
    const st = makeStat(stat, th);
    Promise.all([api.statValues(kind, vi, st, 0, a.n_periods), api.statValues(kind, vi, st, 0, b.n_periods, true), api.ids(kind)])
      .then(([x, y, names]) => {
        if (!live) return;
        setValues([x, y]);
        setIds(names);
        setError(null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [a?.path, a?.cache.state, b?.path, b?.cache.state, kind, vi, stat, threshold, revision]);

  const rows: CellValue[][] = useMemo(() => {
    if (!values) return [];
    const [x, y] = values;
    const out: CellValue[][] = [];
    for (let i = 0; i < x.length; i++) {
      if (!Number.isFinite(x[i]) && !Number.isFinite(y[i])) continue;
      const d = x[i] - y[i];
      out.push([ids[i] ?? String(i), x[i], y[i], Number.isFinite(d) ? d : null, Number.isFinite(d) && y[i] !== 0 ? (100 * d) / Math.abs(y[i]) : null, i]);
    }
    return out;
  }, [values, ids]);

  if (!model) return <div className="panel-empty">Open a model first.</div>;
  if (!a) return <div className="panel-empty">Load results first (run A), then compare them with another run.</div>;
  if (!b)
    return (
      <div className="panel-empty">
        No run to compare with. <button onClick={chooseComparison}>Open results B…</button> or use Compare in the Runs tab.
      </div>
    );
  const unit = vars[vi]?.unit ?? "";
  const statLabel = STATS.find(([s]) => s === stat)?.[1] ?? stat;
  const headers = ["Object", `A ${statLabel}`, `B ${statLabel}`, "A − B", "A − B (%)"];
  const offset = (b.start_ms - a.start_ms) / 1000;
  const differenceMap = () => applyStyle(kind, { source: "compare", field: String(vi), stat, threshold: Number(threshold), scope: "run", ramp: "diverging" });
  const animatedMap = () => applyStyle(kind, { source: "compare", field: String(vi), stat: "value", ramp: "diverging" });
  const pick = (i: number) => {
    const index = rows[i][5] as number;
    setState({ selection: [{ kind, index }], fitSelection: getState().fitSelection + 1 });
  };
  // One graph per object, runs A and B on it.
  const overlay = async () => {
    const sel = getState().selection.filter((o) => o.kind === kind);
    if (sel.length === 0) return notify(`Select ${kind}s first.`);
    for (const o of sel.slice(0, 4)) {
      const g = await addToPlot(kind, o.index, vi, false, "new");
      if (g !== null) await addToPlot(kind, o.index, vi, true, g);
    }
  };
  return (
    <div className="events-panel">
      <div className="panel-toolbar">
        <span title={a.path}>
          <b>A</b> {a.path.split(/[\\/]/).slice(-2).join("/")}
        </span>
        <span title={b.path}>
          <b>B</b> {b.path.split(/[\\/]/).slice(-2).join("/")}
        </span>
        <span className="muted">
          B starts {formatDateTime(periodMs(b, 0))}
          {offset !== 0 ? ` (${offset > 0 ? "+" : ""}${formatNumber(offset / 3600)} h)` : ""}, step {b.step_secs} s
        </span>
        <button onClick={chooseComparison}>Other B…</button>
        <button onClick={() => api.closeComparison().then((m) => setResultsInfo(m, false))}>Close B</button>
      </div>
      <div className="panel-toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="node">Nodes</option>
          <option value="link">Links</option>
          <option value="subcatchment">Subcatchments</option>
        </select>
        <select value={vi} onChange={(e) => setV(Number(e.target.value))}>
          {shared.map(([x, i]) => (
            <option key={x.name} value={i}>
              {x.name}
            </option>
          ))}
        </select>
        <select value={stat} onChange={(e) => setStat(e.target.value as StatName)}>
          {STATS.filter(([s]) => s !== "time_of_max").map(([s, label]) => (
            <option key={s} value={s}>
              {label}
            </option>
          ))}
        </select>
        {stat === "periods_above" && (
          <label>
            above <input className="narrow" value={threshold} onChange={(e) => setThreshold(e.target.value)} /> {unit}
          </label>
        )}
        <button onClick={differenceMap} title="Colour the map by A − B of this statistic">
          Difference map
        </button>
        <button onClick={animatedMap} title="Colour the map by A − B at the current time">
          Animated difference
        </button>
        <button onClick={overlay} title="Plot the selected objects from both runs">
          Overlay plot
        </button>
        <span className="grow" />
        <button disabled={rows.length === 0} onClick={() => exportTable(`compare_${kind}`, "Comparison", headers, rows.map((r) => r.slice(0, 5)))}>
          Export
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      <VirtualTable
        columns={[{ title: headers[0] }, ...headers.slice(1).map((t) => ({ title: t, numeric: true, format: num }))]}
        rows={rows}
        onRow={pick}
        resetKey={values}
      />
    </div>
  );
}
