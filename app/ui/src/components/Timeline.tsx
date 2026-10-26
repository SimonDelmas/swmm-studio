import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { focusVar, formatDateTime, fromInputValue, periodAt, periodMs, toInputValue } from "../format";
import { getState, notify, setState, useStore } from "../store";
import type { MinMaxSeries } from "../types";
import { cssVar, useSize } from "../useSize";

const TICKS_MS = [
  60e3,
  5 * 60e3,
  15 * 60e3,
  3600e3,
  3 * 3600e3,
  6 * 3600e3,
  12 * 3600e3,
  86400e3,
  2 * 86400e3,
  7 * 86400e3,
  30 * 86400e3,
  91 * 86400e3,
  365 * 86400e3,
  5 * 365 * 86400e3,
];

/** Tick positions (ms), aligned on calendar months / years for long steps. */
function ticks(t0: number, t1: number, step: number): number[] {
  const out: number[] = [];
  if (step >= 30 * 86400e3) {
    const months = step >= 365 * 86400e3 ? 12 * Math.round(step / (365 * 86400e3)) : Math.round(step / (30 * 86400e3));
    const d = new Date(t0);
    let y = d.getUTCFullYear();
    let m = months >= 12 ? 0 : Math.floor(d.getUTCMonth() / months) * months;
    for (let i = 0; i < 1000; i++) {
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      if (t >= t0) out.push(t);
      m += months;
      y += Math.floor(m / 12);
      m %= 12;
    }
    return out;
  }
  for (let t = Math.ceil(t0 / step) * step; t <= t1 && out.length < 1000; t += step) out.push(t);
  return out;
}

function tickLabel(t: number, step: number): string {
  const s = formatDateTime(t);
  if (step >= 365 * 86400e3) return s.slice(0, 4);
  if (step >= 30 * 86400e3) return s.slice(0, 7);
  if (step >= 86400e3) return s.slice(0, 10);
  return s.slice(11) === "00:00" ? s.slice(0, 10) : s.slice(11);
}

export function Timeline() {
  const results = useStore((s) => s.model?.results ?? null);
  const period = useStore((s) => s.period);
  const playing = useStore((s) => s.playing);
  const fps = useStore((s) => s.fps);
  const stride = useStore((s) => s.stride);
  const selection = useStore((s) => s.selection);
  const shown = useStore((s) => s.timeline);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [boxRef, box] = useSize<HTMLDivElement>({ w: 800, h: 0 });
  const width = Math.max(100, box.w - 16);
  const [view, setView] = useState<[number, number]>([0, 1]);
  const [sysVar, setSysVar] = useState(4); // runoff
  const [spark, setSpark] = useState<MinMaxSeries | null>(null);
  const [threshold, setThreshold] = useState("0");
  const drag = useRef<{ x: number; v: [number, number]; moved: boolean } | null>(null);
  const n = results?.n_periods ?? 0;

  useEffect(() => {
    setView([0, Math.max(1, n - 1)]);
  }, [results?.path, n]);

  // Overview series of a system variable over the visible range (coalesced).
  const sparkReq = useRef(0);
  useEffect(() => {
    if (!results || n === 0 || !shown) return;
    const id = ++sparkReq.current;
    const t = setTimeout(() => {
      const p0 = Math.max(0, Math.floor(view[0]));
      const p1 = Math.min(n, Math.ceil(view[1]) + 1);
      api
        .series("system", 0, sysVar, p0, p1, Math.max(50, width / 2))
        .then((s) => id === sparkReq.current && setSpark(s))
        .catch(() => id === sparkReq.current && setSpark(null));
    }, 60);
    return () => clearTimeout(t);
  }, [results?.path, results?.cache.state, view, width, sysVar, n, shown]);

  // Playback.
  useEffect(() => {
    if (!playing || n === 0) return;
    const timer = setInterval(() => {
      const s = getState();
      const next = s.period + s.stride;
      if (next >= n) setState({ playing: false, period: n - 1 });
      else setState({ period: next });
    }, 1000 / fps);
    return () => clearInterval(timer);
  }, [playing, fps, n]);

  // Keep the cursor in view.
  useEffect(() => {
    if (period < view[0] || period > view[1]) {
      const span = view[1] - view[0];
      const a = Math.max(0, Math.min(n - 1 - span, period - span * 0.1));
      setView([a, a + span]);
    }
  }, [period]);

  // Drawing.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 64;
    c.width = width * dpr;
    c.height = h * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fg = cssVar("--fg", "#222");
    const muted = cssVar("--muted", "#888");
    const accent = cssVar("--accent", "#1f6feb");
    ctx.clearRect(0, 0, width, h);
    if (!results) return;
    const [v0, v1] = view;
    const x = (p: number) => ((p - v0) / (v1 - v0 || 1)) * width;
    // Overview.
    if (spark && spark.periods.length > 0) {
      let hi = 0;
      for (let i = 0; i < spark.max.length; i++) if (Number.isFinite(spark.max[i])) hi = Math.max(hi, spark.max[i]);
      ctx.fillStyle = accent + "55";
      const top = 4;
      const bottom = 42;
      for (let i = 0; i < spark.periods.length; i++) {
        const a = x(spark.periods[i]);
        const b = i + 1 < spark.periods.length ? x(spark.periods[i + 1]) : x(v1);
        const yv = hi > 0 ? bottom - ((spark.max[i] / hi) * (bottom - top)) : bottom;
        ctx.fillRect(a, yv, Math.max(1, b - a), bottom - yv);
      }
    }
    // Axis.
    const t0 = periodMs(results, v0);
    const t1 = periodMs(results, v1);
    const msPerPx = (t1 - t0) / width;
    const step = TICKS_MS.find((s) => s / msPerPx > 90) ?? TICKS_MS[TICKS_MS.length - 1];
    ctx.strokeStyle = muted;
    ctx.fillStyle = fg;
    ctx.font = "11px system-ui, sans-serif";
    ctx.beginPath();
    ctx.moveTo(0, 44.5);
    ctx.lineTo(width, 44.5);
    ctx.stroke();
    for (const t of ticks(t0, t1, step)) {
      const px = ((t - t0) / (t1 - t0)) * width;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, 44);
      ctx.lineTo(px + 0.5, 50);
      ctx.stroke();
      ctx.fillText(tickLabel(t, step), px + 3, 60);
    }
    // Cursor.
    const cx = x(period);
    ctx.strokeStyle = "#e5534b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, 50);
    ctx.stroke();
    ctx.lineWidth = 1;
  }, [results, view, width, period, spark, shown]);

  if (!results) return <div className="timeline timeline-empty">No results loaded.</div>;

  const toPeriod = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return view[0] + ((clientX - r.left) / r.width) * (view[1] - view[0]);
  };
  const onWheel = (e: React.WheelEvent) => {
    const at = toPeriod(e.clientX);
    const f = Math.exp(e.deltaY * 0.0015);
    let span = Math.min(n - 1, Math.max(10, (view[1] - view[0]) * f));
    let a = at - (at - view[0]) * (span / (view[1] - view[0]));
    a = Math.max(0, Math.min(n - 1 - span, a));
    span = Math.max(span, 1);
    setView([a, a + span]);
  };
  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, v: view, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    if (!d.moved) return;
    const span = d.v[1] - d.v[0];
    const r = canvas.current!.getBoundingClientRect();
    const a = Math.max(0, Math.min(n - 1 - span, d.v[0] - (dx / r.width) * span));
    setView([a, a + span]);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) setState({ period: Math.max(0, Math.min(n - 1, Math.round(toPeriod(e.clientX)))) });
  };

  const step = (k: number) => setState({ period: Math.max(0, Math.min(n - 1, period + k * stride)) });
  const target = selection[0] ? focusVar(getState(), selection[0]) : null;
  const jumpMax = () => {
    const o = getState().selection[0];
    if (!target || !o) return;
    api
      .timeOfMax(target.kind, o.index, target.var)
      .then((p) => setState({ period: p }))
      .catch((e) => notify(errorText(e), true));
  };
  const nextEvent = () => {
    const o = getState().selection[0];
    if (!target || !o) return;
    const thr = Number(threshold);
    api
      .nextEvent(target.kind, o.index, target.var, period, Number.isFinite(thr) ? thr : 0)
      .then((p) => (p === null ? notify("No later event above the threshold.") : setState({ period: p })))
      .catch((e) => notify(errorText(e), true));
  };
  const sysVars = results.variables.system;
  const varLabel = target ? results.variables[target.kind][target.var] : null;

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button title="Previous step" onClick={() => step(-1)}>
          ◀
        </button>
        <button className="primary" title="Play / pause (Space)" onClick={() => setState({ playing: !playing })}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button title="Next step" onClick={() => step(1)}>
          ▶|
        </button>
        <input
          type="datetime-local"
          value={toInputValue(periodMs(results, period))}
          onChange={(e) => {
            const ms = fromInputValue(e.target.value);
            if (ms !== null) setState({ period: periodAt(results, ms) });
          }}
        />
        <span className="muted">
          {period + 1} / {n}
        </span>
        <label>
          Speed
          <select value={fps} onChange={(e) => setState({ fps: Number(e.target.value) })}>
            {[1, 2, 5, 10, 20, 30, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
        <label>
          Every
          <select value={stride} onChange={(e) => setState({ stride: Number(e.target.value) })}>
            {[1, 2, 3, 6, 12, 24, 48, 96, 288, 2016].map((s) => (
              <option key={s} value={s}>
                {s} step{s > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
        <span className="sep" />
        <button disabled={!target} onClick={jumpMax} title="Jump to the time of maximum of the selected object">
          Max{varLabel ? ` ${varLabel.name}` : ""}
        </button>
        <button disabled={!target} onClick={nextEvent} title="Jump to the next time the value rises above the threshold">
          Next event &gt;
        </button>
        <input className="narrow" value={threshold} onChange={(e) => setThreshold(e.target.value)} title="Event threshold" />
        <span className="sep" />
        <button
          className={shown ? "active" : ""}
          title={shown ? "Hide the timeline" : "Show the timeline: overview of a system variable, click to set the time"}
          onClick={() => setState({ timeline: !shown })}
        >
          Timeline {shown ? "▴" : "▾"}
        </button>
        {shown && (
          <>
            <label title="System variable drawn in the timeline">
              Overview
              <select value={sysVar} onChange={(e) => setSysVar(Number(e.target.value))}>
                {sysVars.map((v, i) => (
                  <option key={v.name} value={i}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            {spark && spark.max.length > 0 && (
              <span className="muted">max {formatNumber(Math.max(...Array.from(spark.max).filter(Number.isFinite)))}</span>
            )}
            <button title="Show the whole run" onClick={() => setView([0, Math.max(1, n - 1)])}>
              ⤢
            </button>
          </>
        )}
      </div>
      {shown && (
        <div className="timeline-canvas" ref={boxRef}>
          <canvas ref={canvas} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
        </div>
      )}
    </div>
  );
}
