import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { formatDateTime, periodMs } from "../format";
import { getState, notify, setState, useStore, type PlotSeries } from "../store";
import type { ElementKind, ResultsInfo } from "../types";
import { cssVar, useSize } from "../useSize";

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

const COLORS = ["#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#17becf"];

/** Adds the selected objects (or the system) to the plot with variable `v` of each kind. */
export async function addToPlot(kind: ElementKind, index: number, v: number) {
  if (kind !== "system" && !getState().ids[kind]) {
    const ids = await api.ids(kind);
    setState({ ids: { ...getState().ids, [kind]: ids } });
  }
  const s = getState();
  const r = s.model?.results;
  if (!r) return;
  const info = r.variables[kind][v];
  const id = kind === "system" ? "System" : (s.ids[kind]?.[index] ?? `${kind} #${index + 1}`);
  const key = `${kind}:${index}:${v}`;
  if (s.plot.some((p) => p.key === key)) return;
  setState({
    plot: [...s.plot, { key, kind, index, id: kind === "system" ? undefined : id, var: v, label: `${id} ${info.name}`, unit: info.unit }],
    bottomTab: "plot",
  });
}

interface Built {
  data: uPlot.AlignedData;
  decimated: boolean;
}

/** x in seconds; decimated buckets become (min at start, max at mid-bucket) pairs. */
function build(r: ResultsInfo, all: { periods: Uint32Array; min: Float32Array; max: Float32Array }[], p1: number): Built {
  const first = all[0];
  const n = first.periods.length;
  const decimated = n > 0 && n < p1 - first.periods[0];
  const t = (p: number) => periodMs(r, p) / 1000;
  if (!decimated) {
    const x = Array.from(first.periods, t);
    return { data: [x, ...all.map((s) => Array.from(s.min, (v) => (Number.isFinite(v) ? v : null)))], decimated };
  }
  const x: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = first.periods[i];
    const b = i + 1 < n ? first.periods[i + 1] : p1;
    x.push(t(a), t(a + (b - a) / 2));
  }
  const ys = all.map((s) => {
    const y: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      y.push(Number.isFinite(s.min[i]) ? s.min[i] : null, Number.isFinite(s.max[i]) ? s.max[i] : null);
    }
    return y.length === x.length ? y : x.map(() => null);
  });
  return { data: [x, ...ys], decimated };
}

export function PlotPanel() {
  const plot = useStore((s) => s.plot);
  const results = useStore((s) => s.model?.results ?? null);
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

  useEffect(() => setRange(null), [results?.path]);

  // Fetch: about one min/max pair per pixel over the visible range.
  const req = useRef(0);
  useEffect(() => {
    if (!results || plot.length === 0) {
      setBuilt(null);
      return;
    }
    const [p0, p1] = range ?? [0, n];
    const id = ++req.current;
    const t = setTimeout(() => {
      Promise.all(plot.map((s) => api.series(s.kind, s.index, s.var, p0, p1, Math.max(100, size.w))))
        .then((all) => {
          if (id !== req.current) return;
          setError(null);
          setBuilt(build(results, all, p1));
        })
        .catch((e) => id === req.current && setError(errorText(e)));
    }, 50);
    return () => clearTimeout(t);
  }, [plot, range, size.w, results?.path, results?.cache.state, n]);

  // (Re)create the chart when the series or the size change.
  const units = Array.from(new Set(plot.map((p) => p.unit)));
  const shape = `${plot.map((p) => p.key).join("|")}#${size.w}x${size.h}`;
  useEffect(() => {
    chart.current?.destroy();
    chart.current = null;
    if (!wrap.current || !built || plot.length === 0 || size.h < 60) return;
    const fg = cssVar("--fg", "#222");
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
          scale: p.unit,
          stroke: COLORS[i % COLORS.length],
          width: 1.25,
          points: { show: false },
          spanGaps: false,
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const r = getState().model?.results;
            if (!r) return;
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
            const toP = (s: number) => (s * 1000 - r.start_ms) / (r.step_secs * 1000);
            const p0 = Math.max(0, Math.floor(toP(a)));
            const p1 = Math.min(r.n_periods, Math.ceil(toP(b)) + 1);
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
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
      const p = Math.round((s * 1000 - r.start_ms) / (r.step_secs * 1000));
      setState({ period: Math.max(0, Math.min(r.n_periods - 1, p)) });
    });
    u.over.addEventListener("dblclick", () => setRange(null));
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

  const addSelected = () => {
    const s = getState();
    const objs = s.selection.filter((o) => o.kind !== "gage").slice(0, 8);
    if (objs.length === 0) return notify("Select objects on the map first.");
    for (const o of objs) addToPlot(o.kind as ElementKind, o.index, varChoice[o.kind] ?? 0);
  };
  const exportCsv = async () => {
    if (!built) return;
    const path = await save({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "series.csv" });
    if (!path) return;
    const [x, ...ys] = built.data;
    const head = ["time", ...plot.map((p) => `${p.label} (${p.unit})${built.decimated ? " [min/max per bucket]" : ""}`)];
    const lines = [head.map((h) => `"${h.replace(/"/g, '""')}"`).join(",")];
    for (let i = 0; i < x.length; i++) {
      lines.push([formatDateTime(Number(x[i]) * 1000, true), ...ys.map((y) => y[i] ?? "")].join(","));
    }
    await api.saveFile(path, new TextEncoder().encode(lines.join("\r\n") + "\r\n")).catch((e) => notify(errorText(e), true));
    notify(`Saved ${path}`);
  };
  const exportPng = async () => {
    const c = chart.current?.ctx.canvas;
    if (!c) return;
    const path = await save({ filters: [{ name: "PNG image", extensions: ["png"] }], defaultPath: "plot.png" });
    if (!path) return;
    // Opaque background for viewers that show transparency as black.
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, 0, 0);
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    if (!blob) return;
    await api.saveFile(path, new Uint8Array(await blob.arrayBuffer())).catch((e) => notify(errorText(e), true));
    notify(`Saved ${path}`);
  };
  const kinds = Array.from(new Set(selection.map((o) => o.kind).filter((k) => k !== "gage"))) as ElementKind[];

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
        <button disabled={kinds.length === 0} onClick={addSelected}>
          + Add selected
        </button>
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
        {plot.map((p: PlotSeries, i) => (
          <span key={p.key} className="chip" style={{ borderColor: COLORS[i % COLORS.length] }}>
            {p.label}
            <button onClick={() => setState({ plot: getState().plot.filter((q) => q.key !== p.key) })}>×</button>
          </span>
        ))}
        <span className="grow" />
        {range && <button onClick={() => setRange(null)}>Whole run</button>}
        <button disabled={!built} onClick={exportCsv}>
          CSV
        </button>
        <button disabled={!built} onClick={exportPng}>
          PNG
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {plot.length === 0 && (
        <div className="panel-empty">Select objects and click “Add selected”, or add a system series. Drag to zoom, double-click to reset.</div>
      )}
      <div ref={setWrap} className="plot-area" />
    </div>
  );
}
