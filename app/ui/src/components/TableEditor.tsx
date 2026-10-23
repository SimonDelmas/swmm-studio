// Editors of curves, time series, time patterns, unit hydrographs and transects.

import { useEffect, useMemo, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { tryEdit } from "../edit";
import { setState, useStore } from "../store";
import type { Curve, Hydrograph, Pattern, Table, Timeseries, Transect, UhRow } from "../types";
import { useNames } from "./PropertiesPanel";

const CURVE_TYPES = ["STORAGE", "SHAPE", "DIVERSION", "TIDAL", "PUMP1", "PUMP2", "PUMP3", "PUMP4", "PUMP5", "RATING", "CONTROL", "WEIR"];
const CURVE_AXES: Record<string, [string, string]> = {
  STORAGE: ["Depth", "Area"],
  SHAPE: ["Depth / full depth", "Width / full depth"],
  DIVERSION: ["Inflow", "Diverted flow"],
  TIDAL: ["Hour of day", "Stage"],
  PUMP1: ["Volume", "Flow"],
  PUMP2: ["Depth", "Flow"],
  PUMP3: ["Head", "Flow"],
  PUMP4: ["Depth", "Flow"],
  PUMP5: ["Head", "Flow"],
  RATING: ["Head", "Flow"],
  CONTROL: ["Control value", "Setting"],
  WEIR: ["Head", "Coefficient"],
};
const PATTERN_TYPES: Record<string, string[]> = {
  MONTHLY: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  DAILY: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  HOURLY: Array.from({ length: 24 }, (_, h) => `${h}:00`),
  WEEKEND: Array.from({ length: 24 }, (_, h) => `${h}:00`),
};
const MONTHS = ["All", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RESPONSES = ["Short", "Medium", "Long"];

/** Editable grid of text cells; pasting several lines (e.g. from Excel) fills rows. */
function Grid({
  columns,
  rows,
  onChange,
  fixedRows,
  rowLabels,
}: {
  columns: string[];
  rows: string[][];
  onChange: (rows: string[][]) => void;
  fixedRows?: boolean;
  rowLabels?: string[];
}) {
  const set = (r: number, c: number, v: string) => onChange(rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  const paste = (r: number, c: number, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n") && !text.includes("\t")) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
    const next = rows.map((x) => [...x]);
    lines.forEach((line, k) => {
      const cells = line.split(/\t|;/);
      const at = r + k;
      if (at >= next.length) {
        if (fixedRows) return;
        next.push(columns.map(() => ""));
      }
      cells.forEach((v, j) => {
        if (c + j < columns.length) next[at][c + j] = v.trim().replace(",", ".");
      });
    });
    onChange(next);
  };
  return (
    <div className="grid-box">
      <table className="grid edit-grid">
        <thead>
          <tr>
            <th></th>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
            {!fixedRows && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              <td className="muted">{rowLabels?.[r] ?? r + 1}</td>
              {row.map((v, c) => (
                <td key={c}>
                  <input value={v} onChange={(e) => set(r, c, e.target.value)} onPaste={(e) => paste(r, c, e)} />
                </td>
              ))}
              {!fixedRows && (
                <td>
                  <a className="muted" title="Delete row" onClick={() => onChange(rows.filter((_, i) => i !== r))}>
                    ✕
                  </a>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!fixedRows && (
        <div className="row">
          <button onClick={() => onChange([...rows, columns.map(() => "")])}>Add row</button>
          <span className="muted">Paste cells copied from a spreadsheet into a cell to fill several rows.</span>
        </div>
      )}
    </div>
  );
}

/** Small line chart of (x, y) points; `bars` draws a step chart. */
function Preview({ pts, xLabel, yLabel, bars }: { pts: [number, number][]; xLabel: string; yLabel: string; bars?: boolean }) {
  const ok = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (ok.length < 1) return <div className="preview muted">No data to plot</div>;
  const W = 360;
  const H = 180;
  const P = 34;
  const xs = ok.map((p) => p[0]);
  const ys = ok.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) + (bars ? 1 : 0)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(...ys)];
  const sx = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - P - 8);
  const sy = (y: number) => H - P + 10 - ((y - y0) / (y1 - y0 || 1)) * (H - P - 4);
  const d = bars
    ? ok.map((p) => `M${sx(p[0])},${sy(y0)} V${sy(p[1])} H${sx(p[0] + 1)} V${sy(y0)}`).join(" ")
    : ok.map((p, i) => `${i ? "L" : "M"}${sx(p[0])},${sy(p[1])}`).join(" ");
  return (
    <svg className="preview" viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
      <line x1={P} y1={sy(y0)} x2={W - 8} y2={sy(y0)} className="axis" />
      <line x1={P} y1={6} x2={P} y2={H - P + 10} className="axis" />
      <path d={d} className={bars ? "bars" : "curve"} />
      {!bars && ok.length < 60 && ok.map((p, i) => <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={2.5} className="dot" />)}
      <text x={P} y={H - 4} className="lbl">
        {xLabel}: {fmt(x0)} – {fmt(bars ? x1 - 1 : x1)}
      </text>
      <text x={P + 4} y={14} className="lbl">
        {yLabel}: {fmt(y0)} – {fmt(y1)}
      </text>
    </svg>
  );
}

function fmt(v: number) {
  return Math.abs(v) >= 1000 || v === Math.round(v) ? String(Math.round(v * 100) / 100) : v.toPrecision(3);
}

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

/** Hours from a time string `H:MM[:SS]` or decimal hours. */
function hours(t: string): number {
  if (!t.includes(":")) return num(t);
  const [h, m = "0", s = "0"] = t.split(":");
  return Number(h) + Number(m) / 60 + Number(s) / 3600;
}

function CurveForm({ t, set }: { t: Curve; set: (t: Curve) => void }) {
  const axes = CURVE_AXES[t.curve_type] ?? ["X", "Y"];
  return (
    <div className="table-form">
      <div>
        <label>
          Type
          <select value={t.curve_type} onChange={(e) => set({ ...t, curve_type: e.target.value })}>
            {CURVE_TYPES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <Grid columns={axes} rows={t.points} onChange={(rows) => set({ ...t, points: rows as [string, string][] })} />
      </div>
      <Preview pts={t.points.map((p) => [num(p[0]), num(p[1])])} xLabel={axes[0]} yLabel={axes[1]} />
    </div>
  );
}

function TimeseriesForm({ t, set }: { t: Timeseries; set: (t: Timeseries) => void }) {
  const external = t.file !== null;
  const pts = useMemo(() => {
    // Hours since the first row (dates carried over from the rows above).
    let date: number | null = null;
    let first: number | null = null;
    return t.rows.map((r) => {
      if (r.date.trim()) {
        const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(r.date.trim());
        date = m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) / 3600e3 : NaN;
      }
      const h = (date ?? 0) + hours(r.time);
      if (first === null) first = h;
      return [h - first, num(r.value)] as [number, number];
    });
  }, [t.rows]);
  return (
    <div className="table-form">
      <div>
        <div className="row">
          <label>
            <input type="radio" checked={!external} onChange={() => set({ ...t, file: null })} /> Values
          </label>
          <label>
            <input type="radio" checked={external} onChange={() => set({ ...t, file: t.file ?? "", rows: [] })} /> External file
          </label>
        </div>
        {external ? (
          <div className="row">
            <input className="wide" value={t.file ?? ""} placeholder="path to a data file" onChange={(e) => set({ ...t, file: e.target.value })} />
            <button
              onClick={async () => {
                const p = await openFile({ multiple: false });
                if (typeof p === "string") set({ ...t, file: p });
              }}
            >
              Browse…
            </button>
          </div>
        ) : (
          <Grid
            columns={["Date (M/D/Y)", "Time (H:M)", "Value"]}
            rows={t.rows.map((r) => [r.date, r.time, r.value])}
            onChange={(rows) => set({ ...t, rows: rows.map(([date, time, value]) => ({ date, time, value })) })}
          />
        )}
      </div>
      {!external && <Preview pts={pts} xLabel="Hours" yLabel="Value" />}
    </div>
  );
}

function PatternForm({ t, set }: { t: Pattern; set: (t: Pattern) => void }) {
  const labels = PATTERN_TYPES[t.pattern_type] ?? [];
  const setType = (pattern_type: string) => {
    const n = PATTERN_TYPES[pattern_type].length;
    const factors = Array.from({ length: n }, (_, i) => t.factors[i] ?? "1.0");
    set({ ...t, pattern_type, factors });
  };
  return (
    <div className="table-form">
      <div>
        <label>
          Type
          <select value={t.pattern_type} onChange={(e) => setType(e.target.value)}>
            {Object.keys(PATTERN_TYPES).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <Grid
          columns={["Multiplier"]}
          rows={t.factors.map((f) => [f])}
          rowLabels={labels}
          fixedRows
          onChange={(rows) => set({ ...t, factors: rows.map((r) => r[0]) })}
        />
      </div>
      <Preview pts={t.factors.map((f, i) => [i, num(f)])} xLabel={t.pattern_type.toLowerCase()} yLabel="Multiplier" bars />
    </div>
  );
}

function HydrographForm({ t, set }: { t: Hydrograph; set: (t: Hydrograph) => void }) {
  const gages = useNames("gage");
  const [month, setMonth] = useState("All");
  const rowsOf = (m: string) => RESPONSES.map((r) => t.rows.find((x) => x.month.toLowerCase() === m.toLowerCase() && x.response.toLowerCase() === r.toLowerCase()));
  const current = rowsOf(month);
  const defined = current.some(Boolean);
  const blank = (r: string): UhRow => ({ month, response: r, r: "0", t: "1", k: "2", dmax: "", drecov: "", dinit: "" });
  const setRows = (grid: string[][]) => {
    const others = t.rows.filter((x) => x.month.toLowerCase() !== month.toLowerCase());
    const mine = grid.map((g, i) => ({ month, response: RESPONSES[i], r: g[0], t: g[1], k: g[2], dmax: g[3], drecov: g[4], dinit: g[5] }));
    // Keep months in calendar order.
    const all = [...others, ...mine].sort((a, b) => MONTHS.findIndex((m) => m.toLowerCase() === a.month.toLowerCase()) - MONTHS.findIndex((m) => m.toLowerCase() === b.month.toLowerCase()));
    set({ ...t, rows: all });
  };
  return (
    <div className="table-form column">
      <div className="row">
        <label>
          Rain gage
          <select value={t.gage} onChange={(e) => set({ ...t, gage: e.target.value })}>
            {!gages.includes(t.gage) && <option>{t.gage}</option>}
            {gages.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="row month-tabs">
        {MONTHS.map((m) => (
          <button key={m} className={`${m === month ? "active" : ""} ${rowsOf(m).some(Boolean) ? "has" : ""}`} onClick={() => setMonth(m)}>
            {m}
          </button>
        ))}
      </div>
      {defined ? (
        <>
          <Grid
            columns={["R (fraction of rain)", "T (hours to peak)", "K (recession / T)", "Dmax", "Drecov", "Dinit"]}
            rowLabels={RESPONSES}
            fixedRows
            rows={current.map((x, i) => {
              const r = x ?? blank(RESPONSES[i]);
              return [r.r, r.t, r.k, r.dmax, r.drecov, r.dinit];
            })}
            onChange={setRows}
          />
          <div className="row">
            <span className="muted">Dmax, Drecov, Dinit: optional initial abstraction depth, recovery rate and initial depth.</span>
            {month !== "All" && (
              <button onClick={() => set({ ...t, rows: t.rows.filter((x) => x.month.toLowerCase() !== month.toLowerCase()) })}>
                Use the "All" values for {month}
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="row">
          <span className="muted">{month === "All" ? "No parameters for all months." : `${month} uses the "All" parameters.`}</span>
          <button onClick={() => setRows(RESPONSES.map((r) => { const b = rowsOf("All").find((x) => x?.response.toLowerCase() === r.toLowerCase()) ?? blank(r); return [b.r, b.t, b.k, b.dmax, b.drecov, b.dinit]; }))}>
            Set parameters for {month}
          </button>
        </div>
      )}
      <UhPreview rows={current.filter((x): x is UhRow => !!x)} />
    </div>
  );
}

/** Sum of the three triangular unit hydrographs (response to 1 h of unit rain). */
function UhPreview({ rows }: { rows: UhRow[] }) {
  const tri = rows.map((r) => ({ R: num(r.r), T: num(r.t), K: num(r.k) })).filter((x) => x.T > 0 && Number.isFinite(x.R) && x.K >= 0);
  if (tri.length === 0) return null;
  const end = Math.max(...tri.map((x) => x.T * (1 + x.K)));
  const pts: [number, number][] = [];
  for (let i = 0; i <= 100; i++) {
    const h = (end * i) / 100;
    let q = 0;
    for (const x of tri) {
      const peak = (2 * x.R) / (x.T * (1 + x.K));
      q += h <= x.T ? (peak * h) / x.T : h <= x.T * (1 + x.K) ? peak * (1 - (h - x.T) / (x.T * x.K)) : 0;
    }
    pts.push([h, q]);
  }
  return <Preview pts={pts} xLabel="Hours" yLabel="Unit response" />;
}

function TransectForm({ t, set }: { t: Transect; set: (t: Transect) => void }) {
  const f = (k: keyof Transect, label: string) => (
    <label>
      {label}
      <input className="narrow" value={t[k] as string} onChange={(e) => set({ ...t, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="table-form">
      <div>
        <div className="style-grid">
          {f("n_left", "Left bank n")}
          {f("n_channel", "Channel n")}
          {f("n_right", "Right bank n")}
          {f("x_left", "Left bank station")}
          {f("x_right", "Right bank station")}
          {f("lfactor", "Meander modifier")}
          {f("wfactor", "Stations factor")}
          {f("eoffset", "Elevation offset")}
        </div>
        <Grid columns={["Station", "Elevation"]} rows={t.points} onChange={(rows) => set({ ...t, points: rows as [string, string][] })} />
      </div>
      <Preview pts={t.points.map((p) => [num(p[0]), num(p[1])])} xLabel="Station" yLabel="Elevation" />
    </div>
  );
}

const TITLES: Record<Table["kind"], string> = {
  curve: "Curve",
  timeseries: "Time series",
  pattern: "Time pattern",
  hydrograph: "Unit hydrograph",
  transect: "Transect",
};

export function TableEditor() {
  const target = useStore((s) => s.tableEditor);
  const [table, setTable] = useState<Table | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!target) return;
    api.table(target.kind, target.name).then(
      (t) => {
        setTable(t);
        setName(t.name);
        setDirty(false);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [target?.kind, target?.name]);

  if (!target) return null;
  const close = () => setState({ tableEditor: null });
  const set = (t: Table) => {
    setTable(t);
    setDirty(true);
  };
  const apply = async (andClose: boolean) => {
    if (!table) return;
    try {
      const t = { ...table, name: name.trim() } as Table;
      await tryEdit({ op: "set_table", table: t, old_name: target.name });
      setDirty(false);
      setError(null);
      if (andClose) close();
      else setState({ tableEditor: { kind: target.kind, name: t.name } });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="modal-back" onClick={() => !dirty && close()}>
      <div className="modal wide-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {TITLES[target.kind]}{" "}
          <input className="name-input" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
        </h3>
        {!table && !error && <div className="muted">Loading…</div>}
        {table?.kind === "curve" && <CurveForm t={table} set={set} />}
        {table?.kind === "timeseries" && <TimeseriesForm t={table} set={set} />}
        {table?.kind === "pattern" && <PatternForm t={table} set={set} />}
        {table?.kind === "hydrograph" && <HydrographForm t={table} set={set} />}
        {table?.kind === "transect" && <TransectForm t={table} set={set} />}
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button className="primary" onClick={() => apply(true)} disabled={!table}>
            OK
          </button>
          <button onClick={() => apply(false)} disabled={!table || !dirty}>
            Apply
          </button>
          <button onClick={close}>{dirty ? "Discard" : "Close"}</button>
        </div>
      </div>
    </div>
  );
}
