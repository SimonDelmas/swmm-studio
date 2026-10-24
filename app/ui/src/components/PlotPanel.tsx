import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, errorText } from "../api";
import { chartSvg, exportTable, savePng, saveSvg } from "../exporting";
import { bucketLabel, formatDateTime, periodAt, periodMs } from "../format";
import { getState, makeStat, notify, setState, useStore, type PlotSeries, type StatName } from "../store";
import type { Calendar, ElementKind, ResultsInfo } from "../types";
import { cssVar, useSize } from "../useSize";
import { STATS } from "./StylePanel";

/** Time axis labels in the model clock (UTC), 24 h. */
function timeLabels(_u: uPlot, splits: number[], _ax: number, _space: number, incr: number): string[] {
  return splits.map((s, i) => {
    const t = formatDateTime(s * 1000);
    const date = t.slice(0, 10);
    const prevDate = i > 0 ? formatDateTime(splits[i - 1] * 1000).slice(0, 10) : "";
    if (incr >= 28 * 86400) return t.slice(0, 7);
    if (incr >= 86400) return date;
    return date !== prevDate ? `${t.slice(11)}
${date}` : t.slice(11);
  });
}

export const COLORS = ["#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#17becf"];

export const seriesKey = (kind: string, index: number, v: number, b?: boolean) => `${kind}:${index}:${v}${b ? ":b" : ""}`;

/** Adds an object (or the system) to the plot with variable `v`, from the loaded or the compared results. */
export async function addToPlot(kind: ElementKind, index: number, v: number, b = false) {
  if (kind !== "system" && !getState().ids[kind]) {
    const ids = await api.ids(kind);
    setState({ ids: { ...getState().ids, [kind]: ids } });
  }
  const s = getState();
  const r = b ? s.model?.compare : s.model?.results;
  if (!r) return;
  const info = r.variables[kind][v];
  if (!info) return;
  const id = kind === "system" ? "System" : (s.ids[kind]?.[index] ?? `${kind} #${index + 1}`);
  const key = seriesKey(kind, index, v, b);
  if (s.plot.some((p) => p.key === key)) return;
  const label = `${id} ${info.name}${b ? " [B]" : ""}`;
  setState({
    plot: [...s.plot, { key, kind, index, id: kind === "system" ? undefined : id, var: v, label, unit: info.unit, b }],
    bottomTab: "plot",
  });
}

interface Built {
  data: uPlot.AlignedData;
  decimated: boolean;
  units: string[];
  stepped: boolean;
}

type Table = [number[], (number | null)[]];

/** x in seconds; decimated buckets become (min at start, max at mid-bucket) pairs. */
function table(r: ResultsInfo, s: { periods: Uint32Array; min: Float32Array; max: Float32Array }, p1: number): { t: Table; decimated: boolean } {
  const n = s.periods.length;
  const decimated = n > 0 && n < p1 - s.periods[0];
  const t = (p: number) => periodMs(r, p) / 1000;
  const fin = (v: number) => (Number.isFinite(v) ? v : null);
  if (!decimated) return { t: [Array.from(s.periods, t), Array.from(s.min, fin)], decimated };
  const x: number[] = [];
  const y: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = s.periods[i];
    const b = i + 1 < n ? s.periods[i + 1] : p1;
    x.push(t(a), t(a + (b - a) / 2));
    y.push(fin(s.min[i]), fin(s.max[i]));
  }
  return { t: [x, y], decimated };
}

/** Aligns series on one x axis (they differ when runs A and B have other periods). */
function align(tables: Table[]): uPlot.AlignedData {
  const x0 = tables[0][0];
  const same = tables.every((t) => t[0].length === x0.length && t[0].every((v, i) => v === x0[i]));
  if (same) return [x0, ...tables.map((t) => t[1])] as uPlot.AlignedData;
  return uPlot.join(tables as unknown as uPlot.AlignedData[]);
}

export function PlotPanel() {
  const plot = useStore((s) => s.plot);
  const agg = useStore((s) => s.plotAgg);
  const results = useStore((s) => s.model?.results ?? null);
  const compare = useStore((s) => s.model?.compare ?? null);
  const selection = useStore((s) => s.selection);
  const period = useStore((s) => s.period);
  const wrap = useRef<HTMLDivElement | null>(null);
  const chart = useRef<uPlot | null>(null);
  const [sizeRef, size] = useSize<HTMLDivElement>({ w: 600, h: 200 });
  const setWrap = (el: HTMLDivElement | null) => {
    wrap.current = el;
    sizeRef(el);
  };
  const [range, setRange] = useState<[number, number] | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [varChoice, setVarChoice] = useState<Record<string, number>>({ node: 0, link: 0, subcatchment: 4, system: 4 });
  const periodRef = useRef(period);
  periodRef.current = period;
  const n = results?.n_periods ?? 0;
  const aggRef = useRef(agg);
  aggRef.current = agg;

  useEffect(() => setRange(null), [results?.path]);

  // Fetch: about one min/max pair per pixel over the visible range, or the aggregates.
  const req = useRef(0);
  useEffect(() => {
    if (!results || plot.length === 0) {
      setBuilt(null);
      return;
    }
    const [p0, p1] = range ?? [0, n];
    const id = ++req.current;
    const t = setTimeout(async () => {
      try {
        let tables: Table[];
        let units: string[];
        let decimated = false;
        if (agg) {
          const stat = makeStat(agg.stat, agg.threshold);
          const all = await Promise.all(plot.map((s) => api.aggregate(s.kind, s.index, s.var, agg.unit, stat, !!s.b)));
          // The last step ends with its interval.
          tables = all.map((a) => {
            const x = a.starts_ms.map((ms) => ms / 1000);
            const y: (number | null)[] = a.values.map((v) => (Number.isFinite(v) ? v : null));
            if (a.end_ms !== null && y.length) (x.push(a.end_ms / 1000), y.push(y[y.length - 1]));
            return [x, y] as Table;
          });
          units = all.map((a) => a.unit);
        } else {
          const m = getState().model;
          const all = await Promise.all(
            plot.map(async (s) => {
              const r = s.b ? m?.compare : m?.results;
              if (!r) throw new Error("the compared results are no longer loaded");
              // Same time range in the other run.
              const [q0, q1] = s.b ? [periodAt(r, periodMs(results, p0)), periodAt(r, periodMs(results, p1 - 1)) + 1] : [p0, p1];
              const mm = await api.series(s.kind, s.index, s.var, q0, q1, Math.max(100, size.w), !!s.b);
              return table(r, mm, q1);
            }),
          );
          tables = all.map((a) => a.t);
          decimated = all.some((a) => a.decimated);
          units = plot.map((p) => p.unit);
        }
        if (id !== req.current) return;
        setError(null);
        setBuilt({ data: align(tables), decimated, units, stepped: !!agg });
      } catch (e) {
        if (id === req.current) setError(errorText(e));
      }
    }, 50);
    return () => clearTimeout(t);
  }, [plot, range, size.w, results?.path, results?.cache.state, compare?.path, compare?.cache.state, n, agg]);

  // (Re)create the chart when the series, their units or the size change.
  const units = built ? Array.from(new Set(built.units)) : [];
  const shape = `${plot.map((p) => p.key).join("|")}#${size.w}x${size.h}#${units.join(",")}#${built?.stepped}`;
  useEffect(() => {
    chart.current?.destroy();
    chart.current = null;
    if (!wrap.current || !built || plot.length === 0 || size.h < 60) return;
    const fg = cssVar("--fg", "#222");
    const stepped = built.stepped ? uPlot.paths.stepped!({ align: 1 }) : undefined;
    const opts: uPlot.Options = {
      width: size.w,
      height: size.h - 34,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), "Etc/UTC"),
      cursor: { drag: { x: true, y: false }, sync: undefined },
      scales: { x: { time: true }, ...Object.fromEntries(units.map((u) => [u, { auto: true }])) },
      axes: [
        { stroke: fg, grid: { stroke: "rgba(128,128,128,0.15)" }, values: timeLabels, size: 44 },
        ...units.map((u, i) => ({
          scale: u,
          label: u,
          side: i % 2 === 0 ? 3 : 1,
          stroke: fg,
          grid: { show: i === 0, stroke: "rgba(128,128,128,0.15)" },
          size: 60,
        })),
      ] as uPlot.Axis[],
      series: [
        { value: (_u, v) => (v == null ? "" : formatDateTime(v * 1000)) },
        ...plot.map((p, i) => ({
          label: p.label,
          scale: built.units[i],
          stroke: COLORS[i % COLORS.length],
          width: 1.25,
          dash: p.b ? [6, 3] : undefined,
          points: { show: false },
          spanGaps: false,
          paths: stepped,
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const r = getState().model?.results;
            if (!r || aggRef.current) return;
            const x = u.valToPos(periodMs(r, periodRef.current) / 1000, "x", true);
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
            u.ctx.save();
            u.ctx.strokeStyle = "#e5534b";
            u.ctx.lineWidth = 1.5 * devicePixelRatio;
            u.ctx.beginPath();
            u.ctx.moveTo(x, u.bbox.top);
            u.ctx.lineTo(x, u.bbox.top + u.bbox.height);
            u.ctx.stroke();
            u.ctx.restore();
          },
        ],
        setSelect: [
          (u) => {
            if (u.select.width < 5) return;
            const r = getState().model?.results;
            if (!r) return;
            const a = u.posToVal(u.select.left, "x");
            const b = u.posToVal(u.select.left + u.select.width, "x");
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            if (aggRef.current) {
              u.setScale("x", { min: a, max: b });
              return;
            }
            const toP = (s: number) => (s * 1000 - r.start_ms) / (r.step_secs * 1000);
            const p0 = Math.max(0, Math.floor(toP(a)));
            const p1 = Math.min(r.n_periods, Math.ceil(toP(b)) + 1);
            if (p1 - p0 >= 2) setRange([p0, p1]);
          },
        ],
      },
    };
    const u = new uPlot(opts, built.data, wrap.current);
    chart.current = u;
    // Click (without drag) sets the current time.
    let downX = 0;
    u.over.addEventListener("mousedown", (e) => (downX = e.clientX));
    u.over.addEventListener("click", (e) => {
      const r = getState().model?.results;
      if (!r || Math.abs(e.clientX - downX) > 3) return;
      const s = u.posToVal(e.offsetX, "x");
      setState({ period: periodAt(r, s * 1000) });
    });
    u.over.addEventListener("dblclick", () => {
      setRange(null);
      if (aggRef.current) u.setData(u.data, true);
    });
    return () => {
      u.destroy();
      chart.current = null;
    };
  }, [shape, built === null]);

  useEffect(() => {
    if (chart.current && built) chart.current.setData(built.data, true);
  }, [built]);

  useEffect(() => {
    chart.current?.redraw(false, false);
  }, [period]);

  if (!results) return <div className="panel-empty">Load results to plot time series.</div>;

  const addSelected = (b: boolean) => {
    const s = getState();
    const objs = s.selection.filter((o) => o.kind !== "gage").slice(0, 8);
    if (objs.length === 0) return notify("Select objects on the map first.");
    for (const o of objs) addToPlot(o.kind as ElementKind, o.index, varChoice[o.kind] ?? 0, b);
  };
  const timeText = (x: number) => (agg ? bucketLabel(agg.unit, x * 1000) : formatDateTime(x * 1000, true));
  const exportData = () => {
    if (!built) return;
    const [x, ...ys] = built.data;
    const head = [
      agg ? agg.unit : "time",
      ...plot.map((p, i) => `${p.label} (${built.units[i]})${built.decimated ? " [min/max per bucket]" : ""}`),
    ];
    const rows = Array.from(x, (t, i) => [timeText(Number(t)), ...ys.map((y) => y[i] ?? null)]);
    exportTable(agg ? `series_${agg.unit}` : "series", "Time series", head, rows);
  };
  const svg = () => {
    if (!built) return null;
    const [x, ...ys] = built.data;
    return chartSvg(
      plot.map((p, i) => ({
        label: p.label,
        unit: built.units[i],
        color: COLORS[i % COLORS.length],
        x: Array.from(x),
        y: Array.from(ys[i] as (number | null)[]),
        stepped: built.stepped,
      })),
      { width: Math.max(600, size.w), height: Math.max(320, size.h), xLabel: (t) => timeText(t).slice(0, 16) },
    );
  };
  const kinds = Array.from(new Set(selection.map((o) => o.kind).filter((k) => k !== "gage"))) as ElementKind[];
  const setAgg = (unit: string) =>
    setState({ plotAgg: unit ? { unit: unit as Calendar, stat: agg?.stat ?? "max", threshold: agg?.threshold ?? 0 } : null });

  return (
    <div className="plot-panel">
      <div className="panel-toolbar">
        {kinds.map((k) => (
          <label key={k}>
            {k}
            <select value={varChoice[k] ?? 0} onChange={(e) => setVarChoice({ ...varChoice, [k]: Number(e.target.value) })}>
              {results.variables[k].map((v, i) => (
                <option key={v.name} value={i}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button disabled={kinds.length === 0} onClick={() => addSelected(false)}>
          + Add selected
        </button>
        {compare && (
          <button disabled={kinds.length === 0} title="Add the selected objects from the compared run (dashed)" onClick={() => addSelected(true)}>
            + From run B
          </button>
        )}
        <label>
          system
          <select value={varChoice.system} onChange={(e) => setVarChoice({ ...varChoice, system: Number(e.target.value) })}>
            {results.variables.system.map((v, i) => (
              <option key={v.name} value={i}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => addToPlot("system", 0, varChoice.system)}>+ System</button>
        <span className="sep" />
        <label title="Time aggregation">
          per
          <select value={agg?.unit ?? ""} onChange={(e) => setAgg(e.target.value)}>
            <option value="">— (series)</option>
            <option value="day">day</option>
            <option value="month">month</option>
            <option value="year">year</option>
          </select>
        </label>
        {agg && (
          <select value={agg.stat} onChange={(e) => setState({ plotAgg: { ...agg, stat: e.target.value as StatName } })}>
            {STATS.filter(([s]) => s !== "time_of_max").map(([s, label]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
        )}
        {agg?.stat === "periods_above" && (
          <input
            className="narrow"
            title="Threshold"
            key={agg.threshold}
            defaultValue={agg.threshold}
            onBlur={(e) => Number.isFinite(Number(e.target.value)) && setState({ plotAgg: { ...agg, threshold: Number(e.target.value) } })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        )}
        <span className="sep" />
        {plot.map((p: PlotSeries, i) => (
          <span key={p.key} className="chip" style={{ borderColor: COLORS[i % COLORS.length], borderStyle: p.b ? "dashed" : undefined }}>
            {p.label}
            <button onClick={() => setState({ plot: getState().plot.filter((q) => q.key !== p.key) })}>×</button>
          </span>
        ))}
        <span className="grow" />
        {range && !agg && <button onClick={() => setRange(null)}>Whole run</button>}
        <button disabled={!built} onClick={exportData} title="Export the plotted values (CSV or Excel)">
          Data
        </button>
        <button disabled={!built} onClick={() => saveSvg("plot", svg()!)}>
          SVG
        </button>
        <button disabled={!built} onClick={() => chart.current && savePng("plot", chart.current.ctx.canvas)}>
          PNG
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {plot.length === 0 && (
        <div className="panel-empty">
          Select objects and click “Add selected”, or add a system series. Drag to zoom, double-click to reset. “per day / month / year”
          plots daily, monthly or yearly statistics.
        </div>
      )}
      <div ref={setWrap} className="plot-area" />
    </div>
  );
}
