// One form per kind of table: curve, time series, time pattern, unit hydrograph, transect.

// Editors of curves, time series, time patterns, unit hydrographs and transects.

import { useMemo, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import type { Curve, Hydrograph, Pattern, Timeseries, Transect, UhRow } from "../../types";
import { useNames } from "../../hooks/useNames";
import { Grid, Preview, hours, num } from "./Grid";

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

export function CurveForm({ t, set }: { t: Curve; set: (t: Curve) => void }) {
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

export function TimeseriesForm({ t, set }: { t: Timeseries; set: (t: Timeseries) => void }) {
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

export function PatternForm({ t, set }: { t: Pattern; set: (t: Pattern) => void }) {
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

export function HydrographForm({ t, set }: { t: Hydrograph; set: (t: Hydrograph) => void }) {
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

export function TransectForm({ t, set }: { t: Transect; set: (t: Transect) => void }) {
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
