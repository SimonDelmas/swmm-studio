import { ObjLink } from "./ObjLink";
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { errorText } from "../api";
import { exportTable, savePng, saveSvg } from "../exporting";
import { useSize } from "../hooks/useSize";
import { formatDateTime, periodAt, periodMs } from "../format";
import { cacheReason, fetchGraph, zoomPeriods, type Built } from "../plot/data";
import { chartOptions } from "../plot/chart";
import { graphSvg, graphTable } from "../plot/exportGraph";
import { COLORS } from "../plot/series";
import { updatePlotView } from "../actions/views";
import { getState, setState, useStore } from "../store";
import type { PlotGraph as GraphDef, PlotSeries, PlotView } from "../uiTypes";

/** One chart of a view; the charts of a view share their cursor and their zoom. */
export function PlotGraph({ view, graph, number, removable }: { view: PlotView; graph: GraphDef; number: number; removable: boolean }) {
  const plot = graph.series;
  const agg = view.agg;
  const zoom = view.zoom;
  const results = useStore((s) => s.model?.results ?? null);
  const compare = useStore((s) => s.model?.compare ?? null);
  const observed = useStore((s) => s.model?.project.observed);
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

  // Without the cache a long run cannot be read whole: unzoomed, show the longest readable
  // window, around the current time (moved when the current time leaves it).
  const cap = results && !agg && !zoom && results.cache.state !== "ready" && n > results.direct_periods ? Math.max(2, results.direct_periods) : null;
  const [win, setWin] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (cap === null) {
      if (win) setWin(null);
      return;
    }
    if (win && win[1] - win[0] === cap && period >= win[0] && period < win[1]) return;
    const p0 = Math.max(0, Math.min(n - cap, period - Math.floor(cap / 2)));
    setWin([p0, p0 + cap]);
  }, [cap, period, n]);

  // Fetch: about one min/max pair per pixel over the visible range, or the aggregates.
  const req = useRef(0);
  useEffect(() => {
    // Every change supersedes the fetch in flight, also when there is nothing to fetch.
    const id = ++req.current;
    if (!results || plot.length === 0) {
      setBuilt(null);
      setError(null);
      return;
    }
    if (cap !== null && !win) return;
    const range: [number, number] = agg ? [0, n] : zoom ? zoomPeriods(results, zoom) : cap !== null && win ? win : [0, n];
    const t = setTimeout(() => {
      fetchGraph(results, plot, agg, range, size.w)
        .then((b) => {
          if (id !== req.current) return;
          setError(null);
          setBuilt(b);
        })
        .catch((e) => id === req.current && setError(errorText(e)));
    }, 50);
    return () => clearTimeout(t);
  }, [plot, agg ? null : zoom, size.w, results?.path, results?.cache.state, compare?.path, compare?.cache.state, n, agg, cap !== null ? win : null, observed]);

  // (Re)create the chart when the series, their units or the size change.
  const units = built ? Array.from(new Set(built.units)) : [];
  const shape = `${(built?.series ?? []).map((p) => p.key).join("|")}#${(built?.obs ?? []).map((o) => o.parent).join("|")}#${size.w}x${size.h}#${units.join(",")}#${built?.stepped}`;
  useEffect(() => {
    chart.current?.destroy();
    chart.current = null;
    if (!wrap.current || !built || built.series.length === 0 || size.h < 50) return;
    const live = { view: () => viewRef.current, period: () => periodRef.current };
    const opts = chartOptions(built, units, size, `plot-view-${view.id}`, live);
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

  const exportData = () => {
    if (!built) return;
    const { head, rows } = graphTable(built, agg);
    exportTable(agg ? `series_${agg.unit}` : "series", name, head, rows);
  };
  const setSeries = (series: PlotSeries[]) =>
    updatePlotView(view.id, (v) => ({ graphs: v.graphs.map((g) => (g.id === graph.id ? { ...g, series } : g)) }));
  const remove = () =>
    updatePlotView(view.id, (v) => {
      const graphs = v.graphs.filter((g) => g.id !== graph.id);
      return { graphs, target: v.target === graph.id ? graphs[graphs.length - 1].id : v.target };
    });

  return (
    <div className={`plot-graph${active ? " active" : ""}`} data-drop-view={view.id} data-drop-graph={graph.id}>
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
            {p.kind !== "system" && p.id && p.label.startsWith(p.id) ? (
              <>
                <ObjLink obj={{ kind: p.kind, index: p.index }}>{p.id}</ObjLink>
                {p.label.slice(p.id.length)}
              </>
            ) : (
              p.label
            )}
            <button onClick={() => setSeries(plot.filter((q) => q.key !== p.key))}>×</button>
          </span>
        ))}
        {plot.length === 0 && <span className="muted">Empty graph: add selected objects, or drag a result from the properties here.</span>}
        <span className="grow" />
        <button disabled={!built} onClick={exportData} title="Export the plotted values (CSV or Excel)">
          Data
        </button>
        <button disabled={!built} onClick={() => built && saveSvg("plot", graphSvg(built, agg, size))}>
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
      {built && built.obsErrors.length > 0 && <div className="muted plot-window-note">Observed data not shown: {built.obsErrors.join("; ")}</div>}
      {cap !== null && win && results && plot.length > 0 && (
        <div className="muted plot-window-note">
          {formatDateTime(periodMs(results, win[0]))} – {formatDateTime(periodMs(results, win[1] - 1))} only: the whole run needs the results
          cache ({cacheReason(results)}). Move the current time to show another part of the run.
        </div>
      )}
      <div ref={setWrap} className="plot-area" />
    </div>
  );
}
