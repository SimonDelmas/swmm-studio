import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatNumber } from "../format";
import { usePlayback } from "../hooks/usePlayback";
import { useSize } from "../hooks/useSize";
import { latest } from "../latest";
import { setState, useStore } from "../store";
import type { MinMaxSeries, ResultsInfo } from "../types";
import { drawTimeline } from "./timeline/draw";
import { JumpButtons } from "./timeline/JumpButtons";
import { TransportControls } from "./timeline/TransportControls";

/** Periods at the left and right edges of the strip. */
type View = [number, number];

/** A system variable over the visible range, for the overview of the strip. */
function useOverview(results: ResultsInfo | null, sysVar: number, view: View, width: number, shown: boolean): MinMaxSeries | null {
  const [overview, setOverview] = useState<MinMaxSeries | null>(null);
  const n = results?.n_periods ?? 0;
  useEffect(() => {
    if (!results || n === 0 || !shown) return;
    const p0 = Math.max(0, Math.floor(view[0]));
    const p1 = Math.min(n, Math.ceil(view[1]) + 1);
    // A short wait: one request for a wheel or drag gesture, not one per event.
    return latest(() => api.series("system", 0, sysVar, p0, p1, Math.max(50, width / 2)), setOverview, () => setOverview(null), 60);
  }, [results?.path, results?.cache.state, view, width, sysVar, n, shown]);
  return overview;
}

/** The visible range of the strip: the whole run at first, then what the wheel and drags make of it. */
function useView(results: ResultsInfo | null, period: number, canvas: React.RefObject<HTMLCanvasElement | null>) {
  const n = results?.n_periods ?? 0;
  const whole = (): View => [0, Math.max(1, n - 1)];
  const [view, setView] = useState<View>([0, 1]);
  const drag = useRef<{ x: number; v: View; moved: boolean } | null>(null);

  useEffect(() => {
    setView(whole());
  }, [results?.path, n]);

  // Keep the cursor in view.
  useEffect(() => {
    if (period < view[0] || period > view[1]) {
      const span = view[1] - view[0];
      const a = Math.max(0, Math.min(n - 1 - span, period - span * 0.1));
      setView([a, a + span]);
    }
  }, [period]);

  const toPeriod = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return view[0] + ((clientX - r.left) / r.width) * (view[1] - view[0]);
  };
  /** Wheel: zooms around the pointer. Drag: pans. Click: sets the current period. */
  const handlers = {
    onWheel: (e: React.WheelEvent) => {
      const at = toPeriod(e.clientX);
      const f = Math.exp(e.deltaY * 0.0015);
      let span = Math.min(n - 1, Math.max(10, (view[1] - view[0]) * f));
      let a = at - (at - view[0]) * (span / (view[1] - view[0]));
      a = Math.max(0, Math.min(n - 1 - span, a));
      span = Math.max(span, 1);
      setView([a, a + span]);
    },
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, v: view, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (!d.moved) return;
      const span = d.v[1] - d.v[0];
      const r = canvas.current!.getBoundingClientRect();
      const a = Math.max(0, Math.min(n - 1 - span, d.v[0] - (dx / r.width) * span));
      setView([a, a + span]);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      if (d && !d.moved) setState({ period: Math.max(0, Math.min(n - 1, Math.round(toPeriod(e.clientX)))) });
    },
  };
  return { view, showAll: () => setView(whole()), handlers };
}

/** The time controls under the map and, when shown, the strip that gives an overview of the run. */
export function Timeline() {
  const results = useStore((s) => s.model?.results ?? null);
  const period = useStore((s) => s.period);
  const shown = useStore((s) => s.timeline);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [boxRef, box] = useSize<HTMLDivElement>({ w: 800, h: 0 });
  const width = Math.max(100, box.w - 16);
  const [sysVar, setSysVar] = useState(4); // runoff
  const { view, showAll, handlers } = useView(results, period, canvas);
  const overview = useOverview(results, sysVar, view, width, shown);
  usePlayback();

  useEffect(() => {
    if (canvas.current) drawTimeline(canvas.current, { width, results, view, period, overview });
  }, [results, view, width, period, overview, shown]);

  if (!results) return <div className="timeline timeline-empty">No results loaded.</div>;

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <TransportControls results={results} />
        <span className="sep" />
        <JumpButtons />
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
                {results.variables.system.map((v, i) => (
                  <option key={v.name} value={i}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            {overview && overview.max.length > 0 && (
              <span className="muted">max {formatNumber(Math.max(...Array.from(overview.max).filter(Number.isFinite)))}</span>
            )}
            <button title="Show the whole run" onClick={showAll}>
              ⤢
            </button>
          </>
        )}
      </div>
      {shown && (
        <div className="timeline-canvas" ref={boxRef}>
          <canvas ref={canvas} {...handlers} />
        </div>
      )}
    </div>
  );
}
