// Building blocks of the table forms: an editable grid that accepts pasted cells, and a preview chart.

import { LinkButton } from "../LinkButton";
// Editors of curves, time series, time patterns, unit hydrographs and transects.


/** Editable grid of text cells; pasting several lines (e.g. from Excel) fills rows. */
export function Grid({
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
                  <LinkButton className="muted" title="Delete row" onClick={() => onChange(rows.filter((_, i) => i !== r))}>
                    ✕
                  </LinkButton>
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
export function Preview({ pts, xLabel, yLabel, bars }: { pts: [number, number][]; xLabel: string; yLabel: string; bars?: boolean }) {
  const ok = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (ok.length < 1) return <div className="preview muted">No data to plot</div>;
  const W = 360;
  const H = 180;
  const P = 34;
  const xs = ok.map((p) => p[0]);
  const ys = ok.map((p) => p[1]);
  // Reduced, not spread: a long rain series has more points than a call takes arguments.
  const lowest = (v: number[], from: number) => v.reduce((a, b) => Math.min(a, b), from);
  const highest = (v: number[]) => v.reduce((a, b) => Math.max(a, b), -Infinity);
  const [x0, x1] = [lowest(xs, Infinity), highest(xs) + (bars ? 1 : 0)];
  const [y0, y1] = [lowest(ys, 0), highest(ys)];
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

export function fmt(v: number) {
  return Math.abs(v) >= 1000 || v === Math.round(v) ? String(Math.round(v * 100) / 100) : v.toPrecision(3);
}

export const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

/** Hours from a time string `H:MM[:SS]` or decimal hours. */
export function hours(t: string): number {
  if (!t.includes(":")) return num(t);
  const [h, m = "0", s = "0"] = t.split(":");
  return Number(h) + Number(m) / 60 + Number(s) / 3600;
}
