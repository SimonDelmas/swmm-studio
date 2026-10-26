import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, errorText } from "../api";
import { chartSvg, exportTable, savePng, saveSvg } from "../exporting";
import { bucketLabel, formatDateTime, periodAt, periodMs } from "../format";
import {
  currentPlotView,
  getState,
  makeStat,
  newPlotId,
  newPlotView,
  notify,
  setState,
  updatePlotView,
  useStore,
  type PlotAgg,
  type PlotGraph,
  type PlotSeries,
  type PlotView,
  type StatName,
} from "../store";
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

async function loadIds(kinds: ElementKind[]) {
  const missing = Array.from(new Set(kinds.filter((k): k is Exclude<ElementKind, "system"> => k !== "system" && !getState().ids[k])));
  if (missing.length === 0) return;
  const lists = await Promise.all(missing.map((k) => api.ids(k)));
  const ids = { ...getState().ids };
  missing.forEach((k, i) => (ids[k] = lists[i]));
  setState({ ids });
}

function makeSeries(kind: ElementKind, index: number, v: number, b: boolean): PlotSeries | null {
  const s = getState();
  const r = b ? s.model?.compare : s.model?.results;
  const info = r?.variables[kind][v];
  if (!info) return null;
  const id = kind === "system" ? "System" : (s.ids[kind]?.[index] ?? `${kind} #${index + 1}`);
  const label = `${id} ${info.name}${b ? " [B]" : ""}`;
  return { key: seriesKey(kind, index, v, b), kind, index, id: kind === "system" ? undefined : id, var: v, label, unit: info.unit, b };
}

/**
 * Adds an object (or the system) to the open plot view with variable `v`, from the loaded
 * or the compared results: to graph `target` (default: the view's target; `new`: a new
 * graph). Returns the graph it went to.
 */
export async function addToPlot(kind: ElementKind, index: number, v: number, b = false, target?: number | "new"): Promise<number | null> {
  await loadIds([kind]);
  const series = makeSeries(kind, index, v, b);
  if (!series) return null;
  const s = getState();
  const view = currentPlotView(s);
  const t = target ?? view.target;
  let graphs = view.graphs;
  const last = graphs[graphs.length - 1];
  let gid: number;
  if (t === "new") {
    gid = last.series.length === 0 ? last.id : newPlotId();
    if (gid !== last.id) graphs = [...graphs, { id: gid, series: [] }];
  } else gid = graphs.some((g) => g.id === t) ? t : last.id;
  graphs = graphs.map((g) => (g.id === gid && !g.series.some((p) => p.key === series.key) ? { ...g, series: [...g.series, series] } : g));
  setState({ plotViews: s.plotViews.map((x) => (x.id === view.id ? { ...x, graphs } : x)), bottomTab: "plot" });
  return gid;
}

// ---- Views saved in the project ----

/** A plot view saved in the project: objects by ID and variables by name (indices change). */
export interface SavedPlotView {
  name: string;
  agg: PlotAgg | null;
  graphs: { kind: ElementKind; id?: string; var: string; b?: boolean }[][];
}

const NONE: SavedPlotView[] = [];

export function savedPlotViews(s = getState()): SavedPlotView[] {
  const list = s.model?.project.ui.plotViews;
  return Array.isArray(list) ? (list as SavedPlotView[]) : NONE;
}

function storePlotViews(list: SavedPlotView[]) {
  const m = getState().model;
  if (!m) return;
  const ui = { ...m.project.ui, plotViews: list };
  setState({ model: { ...m, project: { ...m.project, ui } } });
  api.updateProject(undefined, ui).catch((e) => notify(errorText(e), true));
}

/** Saves the open view under `name` (replaces a view of the same name) and names its tab so. */
export function savePlotView(name: string) {
  const s = getState();
  const view = currentPlotView(s);
  const varName = (p: PlotSeries) => (p.b ? s.model?.compare : s.model?.results)?.variables[p.kind][p.var]?.name ?? "";
  const graphs = view.graphs
    .filter((g) => g.series.length > 0)
    .map((g) => g.series.map((p) => ({ kind: p.kind, id: p.id, var: varName(p), ...(p.b ? { b: true } : {}) })));
  storePlotViews([...savedPlotViews().filter((v) => v.name !== name), { name, agg: view.agg, graphs }]);
  updatePlotView(view.id, { name });
}

export function deletePlotView(name: string) {
  storePlotViews(savedPlotViews().filter((v) => v.name !== name));
}

/** Rebuilds a saved view from the current results, in the open tab if it is empty or has that name, else in a new tab. */
export async function loadPlotView(name: string) {
  const saved = savedPlotViews().find((v) => v.name === name);
  const m = getState().model;
  if (!saved || !m?.results) return;
  await loadIds(saved.graphs.flat().map((p) => p.kind));
  const ids = getState().ids;
  const missing: string[] = [];
  const graphs: PlotGraph[] = [];
  for (const list of saved.graphs) {
    const series: PlotSeries[] = [];
    for (const p of list) {
      const r = p.b ? m.compare : m.results;
      const v = r?.variables[p.kind]?.findIndex((x) => x.name === p.var) ?? -1;
      const index = p.kind === "system" ? 0 : (ids[p.kind]?.findIndex((x) => x.toUpperCase() === p.id?.toUpperCase()) ?? -1);
      const made = v >= 0 && index >= 0 ? makeSeries(p.kind, index, v, !!p.b) : null;
      if (made) series.push(made);
      else missing.push(`${p.id ?? "System"} ${p.var}${p.b ? " [B]" : ""}`);
    }
    if (series.length > 0) graphs.push({ id: newPlotId(), series });
  }
  const view = newPlotView(name, graphs, saved.agg);
  const s = getState();
  const cur = currentPlotView(s);
  const replace = cur.name === name || cur.graphs.every((g) => g.series.length === 0);
  const plotViews = replace ? s.plotViews.map((v) => (v.id === cur.id ? view : v)) : [...s.plotViews, view];
  setState({ plotViews, plotView: view.id, bottomTab: "plot" });
  if (missing.length > 0) notify(`View “${name}”: not in these results: ${missing.join(", ")}.`, true);
}

// ---- Charts ----

interface Built {
  /** The series `data` was fetched for (the graph may already have changed). */
  series: PlotSeries[];
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

/** Period range [p0, p1) of a zoom in seconds. */
function zoomPeriods(r: ResultsInfo, zoom: [number, number] | null): [number, number] {
  if (!zoom) return [0, r.n_periods];
  const toP = (s: number) => (s * 1000 - r.start_ms) / (r.step_secs * 1000);
  return [Math.max(0, Math.floor(toP(zoom[0]))), Math.min(r.n_periods, Math.ceil(toP(zoom[1])) + 1)];
}

/** One chart of a view; the charts of a view share their cursor and their zoom. */
function Graph({ view, graph, number, removable }: { view: PlotView; graph: PlotGraph; number: number; removable: boolean }) {
  const plot = graph.series;
  const agg = view.agg;
  const zoom = view.zoom;
  const results = useStore((s) => s.model?.results ?? null);
  const compare = useStore((s) => s.model?.compare ?? null);
  const period = useStore((s) => s.period);
  const wrap = useRef<HTMLDivElement | null>(null);
  const chart = useRef<uPlot | null>(null);
  const [sizeRef, size] = useSize<HTMLDivElement>({ w: 600, h: 200 });
  const setWrap = (el: HTMLDivElement | null) => {
    wrap.current = el;
    sizeRef(el);
  };
  const [built, setBuilt] = useState<Built | null>(null);
  const [error, setError] = useState<string | null>(null);
  const periodRef = useRef(period);
  periodRef.current = period;
  const viewRef = useRef(view);
  viewRef.current = view;
  const n = results?.n_periods ?? 0;
  const active = view.target === graph.id;
  const name = `${view.name} – graph ${number}`;

  // Aggregates are all fetched: their zoom only sets the x scale.
  const applyAggZoom = (u: uPlot) => {
    const v = viewRef.current;
    if (v.agg && v.zoom) u.setScale("x", { min: v.zoom[0], max: v.zoom[1] });
  };

  // Fetch: about one min/max pair per pixel over the visible range, or the aggregates.
  const req = useRef(0);
  useEffect(() => {
    if (!results || plot.length === 0) {
      setBuilt(null);
      return;
    }
    const [p0, p1] = agg ? [0, n] : zoomPeriods(results, zoom);
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
        setBuilt({ series: plot, data: align(tables), decimated, units, stepped: !!agg });
      } catch (e) {
        if (id === req.current) setError(errorText(e));
      }
    }, 50);
    return () => clearTimeout(t);
  }, [plot, agg ? null : zoom, size.w, results?.path, results?.cache.state, compare?.path, compare?.cache.state, n, agg]);

  // (Re)create the chart when the series, their units or the size change.
  const units = built ? Array.from(new Set(built.units)) : [];
  const shape = `${(built?.series ?? []).map((p) => p.key).join("|")}#${size.w}x${size.h}#${units.join(",")}#${built?.stepped}`;
  useEffect(() => {
    chart.current?.destroy();
    chart.current = null;
    if (!wrap.current || !built || built.series.length === 0 || size.h < 50) return;
    const fg = cssVar("--fg", "#222");
    const stepped = built.stepped ? uPlot.paths.stepped!({ align: 1 }) : undefined;
    const opts: uPlot.Options = {
      width: size.w,
      height: size.h - 34,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), "Etc/UTC"),
      cursor: {
        drag: { x: true, y: false },
        // Share the cursor with the other graphs of the view, not the drag selection.
        sync: { key: `plot-view-${view.id}`, setSeries: false, filters: { pub: (type) => type !== "mousedown" && type !== "mouseup" } },
      },
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
        ...built.series.map((p, i) => ({
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
            if (!r || viewRef.current.agg) return;
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
            const v = viewRef.current;
            if (!v.agg) {
              const [p0, p1] = zoomPeriods(r, [a, b]);
              if (p1 - p0 < 2) return;
            }
            updatePlotView(v.id, { zoom: [a, b] });
          },
        ],
      },
    };
    const u = new uPlot(opts, built.data, wrap.current);
    chart.current = u;
    applyAggZoom(u);
    // Click (without drag) sets the current time.
    let downX = 0;
    u.over.addEventListener("mousedown", (e) => (downX = e.clientX));
    u.over.addEventListener("click", (e) => {
      const r = getState().model?.results;
      if (!r || Math.abs(e.clientX - downX) > 3) return;
      const s = u.posToVal(e.offsetX, "x");
      setState({ period: periodAt(r, s * 1000) });
    });
    u.over.addEventListener("dblclick", () => updatePlotView(viewRef.current.id, { zoom: null }));
    return () => {
      u.destroy();
      chart.current = null;
    };
  }, [shape, built === null]);

  useEffect(() => {
    const u = chart.current;
    if (!u || !built) return;
    u.setData(built.data, true);
    applyAggZoom(u);
  }, [built]);

  useEffect(() => {
    const u = chart.current;
    if (!u || !agg) return;
    if (zoom) applyAggZoom(u);
    else u.setData(u.data, true);
  }, [zoom]);

  useEffect(() => {
    chart.current?.redraw(false, false);
  }, [period]);

  const timeText = (x: number) => (agg ? bucketLabel(agg.unit, x * 1000) : formatDateTime(x * 1000, true));
  const exportData = () => {
    if (!built) return;
    const [x, ...ys] = built.data;
    const head = [
      agg ? agg.unit : "time",
      ...built.series.map((p, i) => `${p.label} (${built.units[i]})${built.decimated ? " [min/max per bucket]" : ""}`),
    ];
    const rows = Array.from(x, (t, i) => [timeText(Number(t)), ...ys.map((y) => y[i] ?? null)]);
    exportTable(agg ? `series_${agg.unit}` : "series", name, head, rows);
  };
  const svg = () => {
    if (!built) return null;
    const [x, ...ys] = built.data;
    return chartSvg(
      built.series.map((p, i) => ({
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
  const setSeries = (series: PlotSeries[]) =>
    updatePlotView(view.id, (v) => ({ graphs: v.graphs.map((g) => (g.id === graph.id ? { ...g, series } : g)) }));
  const remove = () =>
    updatePlotView(view.id, (v) => {
      const graphs = v.graphs.filter((g) => g.id !== graph.id);
      return { graphs, target: v.target === graph.id ? graphs[graphs.length - 1].id : v.target };
    });

  return (
    <div className={`plot-graph${active ? " active" : ""}`}>
      <div className="plot-graph-head">
        <button
          className="plot-graph-name"
          title={active ? "New series go to this graph" : "Add the next series to this graph"}
          onClick={() => updatePlotView(view.id, { target: graph.id })}
        >
          {number}
        </button>
        {plot.map((p, i) => (
          <span key={p.key} className="chip" style={{ borderColor: COLORS[i % COLORS.length], borderStyle: p.b ? "dashed" : undefined }}>
            {p.label}
            <button onClick={() => setSeries(plot.filter((q) => q.key !== p.key))}>×</button>
          </span>
        ))}
        {plot.length === 0 && <span className="muted">Empty graph: select objects and add them.</span>}
        <span className="grow" />
        <button disabled={!built} onClick={exportData} title="Export the plotted values (CSV or Excel)">
          Data
        </button>
        <button disabled={!built} onClick={() => saveSvg("plot", svg()!)}>
          SVG
        </button>
        <button disabled={!built} onClick={() => chart.current && savePng("plot", chart.current.ctx.canvas)}>
          PNG
        </button>
        <button disabled={!removable} title="Remove this graph" onClick={remove}>
          ×
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      <div ref={setWrap} className="plot-area" />
    </div>
  );
}

// ---- Panel ----

function uniqueName(views: PlotView[]): string {
  for (let i = views.length + 1; ; i++) if (!views.some((v) => v.name === `View ${i}`)) return `View ${i}`;
}

/** Tabs of the plot views, and the views saved in the project. */
function ViewTabs({ view }: { view: PlotView }) {
  const views = useStore((s) => s.plotViews);
  const saved = useStore((s) => savedPlotViews(s));
  const [editing, setEditing] = useState<number | null>(null);
  const [savedName, setSavedName] = useState("");
  const [newName, setNewName] = useState("");
  const open = () => {
    const v = newPlotView(uniqueName(views));
    setState({ plotViews: [...views, v], plotView: v.id });
  };
  const close = (id: number) => {
    const rest = views.filter((v) => v.id !== id);
    if (rest.length === 0) rest.push(newPlotView("View 1"));
    const i = views.findIndex((v) => v.id === id);
    setState({ plotViews: rest, plotView: id === view.id ? rest[Math.min(i, rest.length - 1)].id : view.id });
  };
  const rename = (id: number, name: string) => {
    setEditing(null);
    if (name.trim()) updatePlotView(id, { name: name.trim() });
  };
  const save = () => {
    const name = newName.trim() || view.name;
    savePlotView(name);
    setSavedName(name);
    setNewName("");
  };
  const empty = view.graphs.every((g) => g.series.length === 0);
  return (
    <div className="plot-views">
      {views.map((v) =>
        editing === v.id ? (
          <input
            key={v.id}
            className="narrow-name"
            autoFocus
            defaultValue={v.name}
            onBlur={(e) => rename(v.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <span key={v.id} className={`plot-view-tab${v.id === view.id ? " active" : ""}`}>
            <button title="Double-click to rename" onClick={() => setState({ plotView: v.id })} onDoubleClick={() => setEditing(v.id)}>
              {v.name}
            </button>
            <button title="Close this view" onClick={() => close(v.id)}>
              ×
            </button>
          </span>
        ),
      )}
      <button title="New view (the other views are kept)" onClick={open}>
        +
      </button>
      <span className="grow" />
      <select
        value={saved.some((v) => v.name === savedName) ? savedName : ""}
        title="Views saved in the project"
        onChange={(e) => {
          setSavedName(e.target.value);
          if (e.target.value) loadPlotView(e.target.value);
        }}
      >
        <option value="">{saved.length ? "Saved views…" : "No saved views"}</option>
        {saved.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </select>
      <input
        className="narrow-name"
        disabled={empty}
        placeholder={view.name}
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      <button disabled={empty} onClick={save} title="Save this view in the project, to rebuild it later">
        Save
      </button>
      <button
        disabled={!saved.some((v) => v.name === savedName)}
        onClick={() => {
          deletePlotView(savedName);
          setSavedName("");
        }}
      >
        Delete
      </button>
    </div>
  );
}

export function PlotPanel() {
  const view = useStore((s) => currentPlotView(s));
  const results = useStore((s) => s.model?.results ?? null);
  const compare = useStore((s) => s.model?.compare ?? null);
  const selection = useStore((s) => s.selection);
  const [varChoice, setVarChoice] = useState<Record<string, number>>({ node: 0, link: 0, subcatchment: 4, system: 4 });

  if (!results) return <div className="panel-empty">Load results to plot time series.</div>;

  const agg = view.agg;
  // All the selected objects go to one graph (a new one if the target is `new`).
  const addSelected = async (b: boolean) => {
    const objs = getState().selection.filter((o) => o.kind !== "gage").slice(0, 8);
    if (objs.length === 0) return notify("Select objects on the map first.");
    let g: number | "new" | undefined;
    for (const o of objs) g = (await addToPlot(o.kind as ElementKind, o.index, varChoice[o.kind] ?? 0, b, g)) ?? g;
  };
  const kinds = Array.from(new Set(selection.map((o) => o.kind).filter((k) => k !== "gage"))) as ElementKind[];
  const setAgg = (unit: string) =>
    updatePlotView(view.id, { agg: unit ? { unit: unit as Calendar, stat: agg?.stat ?? "max", threshold: agg?.threshold ?? 0 } : null });
  const empty = view.graphs.every((g) => g.series.length === 0);

  return (
    <div className="plot-panel">
      <ViewTabs view={view} />
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
        <label title="Graph the added series go to">
          to
          <select
            value={String(view.target)}
            onChange={(e) => updatePlotView(view.id, { target: e.target.value === "new" ? "new" : Number(e.target.value) })}
          >
            {view.graphs.map((g, i) => (
              <option key={g.id} value={g.id}>
                graph {i + 1}
              </option>
            ))}
            <option value="new">a new graph</option>
          </select>
        </label>
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
          <select value={agg.stat} onChange={(e) => updatePlotView(view.id, { agg: { ...agg, stat: e.target.value as StatName } })}>
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
            onBlur={(e) => Number.isFinite(Number(e.target.value)) && updatePlotView(view.id, { agg: { ...agg, threshold: Number(e.target.value) } })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        )}
        <span className="grow" />
        {view.zoom && <button onClick={() => updatePlotView(view.id, { zoom: null })}>Whole run</button>}
      </div>
      {empty && (
        <div className="panel-empty">
          Select objects and click “Add selected”, or add a system series; “to a new graph” stacks a new graph in the view. Drag to zoom
          (all the graphs of the view), double-click to reset. “+” opens another view; “Save” keeps the view in the project. “per day /
          month / year” plots daily, monthly or yearly statistics.
        </div>
      )}
      <div className="plot-graphs">
        {view.graphs.map((g, i) => (
          <Graph key={g.id} view={view} graph={g} number={i + 1} removable={view.graphs.length > 1} />
        ))}
      </div>
    </div>
  );
}
