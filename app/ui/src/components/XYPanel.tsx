import { useEffect, useRef, useState } from "react";
import { errorText } from "../api";
import { exportTable, savePng, saveSvg } from "../exporting";
import { cssVar, useSize } from "../hooks/useSize";
import { updateXYView } from "../actions/views";
import { ensureIds } from "../actions/ids";
import { COLORS, makeSeries } from "../plot/series";
import {
  dataRange,
  drawXY,
  fetchXY,
  makePair,
  nearestPoint,
  pairLabel,
  plotBox,
  pointText,
  scales,
  xySvg,
  xyTable,
  XY_DEFAULTS,
  type XYBuilt,
  type XYRange,
} from "../plot/xy";
import { getState, notify, setState, useStore } from "../store";
import type { ElementKind, ResultsInfo } from "../types";
import type { XYPair, XYView } from "../uiTypes";
import { ObjLink } from "./ObjLink";

/** Adds pairs to a view (those it has already are left out). */
function addPairs(view: XYView, pairs: (XYPair | null)[]) {
  updateXYView(view.id, (v) => {
    const added = pairs.filter((p): p is XYPair => !!p && !v.pairs.some((q) => q.key === p.key));
    return { pairs: [...v.pairs, ...added] };
  });
}

/** Variable choices of a kind: [x, y], within the variables of the results. */
const defaults = (r: ResultsInfo, k: ElementKind): [number, number] => {
  const n = r.variables[k].length;
  return XY_DEFAULTS[k].map((v) => (v < n ? v : 0)) as [number, number];
};

function VarSelect({ r, kind, value, onChange, title }: { r: ResultsInfo; kind: ElementKind; value: number; onChange: (v: number) => void; title: string }) {
  return (
    <select title={title} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {r.variables[kind].map((v, i) => (
        <option key={v.name} value={i}>
          {v.name}
        </option>
      ))}
    </select>
  );
}

/** An X-Y tab: result variables plotted against each other, for an object or across objects. */
export function XYPanel({ view }: { view: XYView }) {
  const results = useStore((s) => s.model?.results ?? null);
  const selection = useStore((s) => s.selection);
  const [choice, setChoice] = useState<Partial<Record<ElementKind, [number, number]>>>({});
  if (!results) return <div className="panel-empty">Load results to plot one variable against another.</div>;

  const vars = (k: ElementKind) => choice[k] ?? defaults(results, k);
  const setVar = (k: ElementKind, axis: 0 | 1, v: number) => {
    const c = [...vars(k)] as [number, number];
    c[axis] = v;
    setChoice({ ...choice, [k]: c });
  };
  const kinds = Array.from(new Set(selection.map((o) => o.kind).filter((k) => k !== "gage"))) as ElementKind[];
  const fixed = view.fixedX;

  const addSelected = async () => {
    const objs = getState().selection.filter((o) => o.kind !== "gage").slice(0, 8);
    if (objs.length === 0) return notify("Select objects on the map first.");
    const pairs = await Promise.all(
      objs.map((o) => {
        const k = o.kind as ElementKind;
        const [x, y] = vars(k);
        return makePair(fixed ?? { kind: k, index: o.index, var: x }, k, o.index, y);
      }),
    );
    if (pairs.every((p) => !p)) return notify("The x and y variables are the same series: nothing to plot.");
    addPairs(view, pairs);
  };
  const addSystem = async () => {
    const [x, y] = vars("system");
    const p = await makePair(fixed ?? { kind: "system", index: 0, var: x }, "system", 0, y);
    if (!p) return notify("The x and y variables are the same series: nothing to plot.");
    addPairs(view, [p]);
  };
  // X of the pairs added next: the first selected object's x variable, else the system's.
  const fixX = async () => {
    const o = getState().selection.find((x) => x.kind !== "gage");
    const k = (o?.kind ?? "system") as ElementKind;
    if (k !== "system") await ensureIds([k]);
    const s = makeSeries(k, o?.index ?? 0, vars(k)[0], false);
    if (s) updateXYView(view.id, { fixedX: s });
  };

  return (
    <div className="plot-panel">
      <div className="panel-toolbar">
        {kinds.map((k) => (
          <label key={k}>
            {k}
            {!fixed && (
              <>
                {" "}x
                <VarSelect r={results} kind={k} value={vars(k)[0]} onChange={(v) => setVar(k, 0, v)} title={`Variable of the ${k}s on the x axis`} />
              </>
            )}{" "}
            y
            <VarSelect r={results} kind={k} value={vars(k)[1]} onChange={(v) => setVar(k, 1, v)} title={`Variable of the ${k}s on the y axis`} />
          </label>
        ))}
        <button disabled={kinds.length === 0} title="Plot y against x for each selected object" onClick={addSelected}>
          + Add selected
        </button>
        <label>
          system
          {!fixed && (
            <>
              {" "}x
              <VarSelect r={results} kind="system" value={vars("system")[0]} onChange={(v) => setVar("system", 0, v)} title="System variable on the x axis" />
            </>
          )}{" "}
          y
          <VarSelect r={results} kind="system" value={vars("system")[1]} onChange={(v) => setVar("system", 1, v)} title="System variable on the y axis" />
        </label>
        <button onClick={addSystem}>+ System</button>
        <span className="sep" />
        {fixed ? (
          <span className="chip" title="The x axis of the series added next (across objects)">
            x: {fixed.label}
            <button title="Each object added gets its own x variable again" onClick={() => updateXYView(view.id, { fixedX: null })}>
              ×
            </button>
          </span>
        ) : (
          <button
            title="Use the x variable of the first selected object (or of the system, when nothing is selected) as the x of the series added next: one variable against those of other objects"
            onClick={fixX}
          >
            Fix x
          </button>
        )}
        <label title="Join the points of each series in time order (loops show hysteresis)">
          <input type="checkbox" checked={view.lines} onChange={(e) => updateXYView(view.id, { lines: e.target.checked })} />
          Join points
        </label>
      </div>
      {view.pairs.length === 0 && (
        <div className="panel-empty">
          Select objects, choose their x and y variables and click “Add selected” to plot y against x at each time of the run (depth vs flow of a
          conduit, rainfall vs runoff of a subcatchment…). “Fix x” keeps one object’s variable on the x axis to plot other objects against it.
          Drag a box to zoom, double-click to show everything; click a point to go to its time.
        </div>
      )}
      {view.pairs.length > 0 && <XYGraph view={view} results={results} />}
    </div>
  );
}

function XYGraph({ view, results }: { view: XYView; results: ResultsInfo }) {
  const period = useStore((s) => s.period);
  const [sizeRef, size] = useSize<HTMLDivElement>({ w: 600, h: 200 });
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [built, setBuilt] = useState<XYBuilt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<XYRange | null>(null);
  const [hover, setHover] = useState<{ at: [number, number]; x: number; y: number } | null>(null);
  const [select, setSelect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // Fetch the values of the pairs (every period, or one in `stride` for long runs).
  const req = useRef(0);
  useEffect(() => {
    const id = ++req.current;
    const t = setTimeout(() => {
      fetchXY(results, view.pairs)
        .then((b) => {
          if (id !== req.current) return;
          setError(null);
          setBuilt(b);
        })
        .catch((e) => id === req.current && setError(errorText(e)));
    }, 30);
    return () => clearTimeout(t);
  }, [view.pairs, results.path, results.cache.state, results.n_periods]);

  const range = zoom ?? (built ? dataRange(built) : null);
  const current = built && period % built.stride === 0 ? period / built.stride : built ? Math.round(period / built.stride) : -1;
  const h = Math.max(0, size.h);
  useEffect(() => {
    if (!canvas.current || !built || !range || h < 60) return;
    drawXY(canvas.current, built, range, size.w, h, { lines: view.lines, current, hover: hover?.at ?? null, select }, cssVar("--fg", "#222"));
  }, [built, range?.x[0], range?.x[1], range?.y[0], range?.y[1], size.w, h, view.lines, current, hover, select]);

  const pos = (e: React.MouseEvent) => {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    down.current = pos(e);
  };
  const onMove = (e: React.MouseEvent) => {
    if (!built || !range) return;
    const p = pos(e);
    if (down.current && Math.hypot(p.x - down.current.x, p.y - down.current.y) > 4) {
      setHover(null);
      setSelect({ x0: down.current.x, y0: down.current.y, x1: p.x, y1: p.y });
      return;
    }
    const at = nearestPoint(built, range, size.w, h, p.x, p.y);
    setHover(at ? { at, x: p.x, y: p.y } : null);
  };
  const onUp = (e: React.MouseEvent) => {
    const start = down.current;
    down.current = null;
    if (!start || !built || !range) return;
    const p = pos(e);
    setSelect(null);
    if (Math.hypot(p.x - start.x, p.y - start.y) > 4) {
      // Zoom to the box dragged.
      const s = scales(range, plotBox(size.w, h));
      const [x0, x1] = [s.vx(start.x), s.vx(p.x)].sort((a, b) => a - b);
      const [y0, y1] = [s.vy(start.y), s.vy(p.y)].sort((a, b) => a - b);
      if (x1 > x0 && y1 > y0) setZoom({ x: [x0, x1], y: [y0, y1] });
      return;
    }
    // A click on a point goes to its time.
    const at = nearestPoint(built, range, size.w, h, p.x, p.y);
    if (at) setState({ period: Math.min(results.n_periods - 1, at[1] * built.stride), playing: false });
  };

  const name = view.name;
  const exportData = () => {
    if (!built) return;
    const { head, rows } = xyTable(results, built);
    exportTable("xy", name, head, rows);
  };
  const remove = (key: string) => updateXYView(view.id, (v) => ({ pairs: v.pairs.filter((p) => p.key !== key) }));

  return (
    <div className="plot-graph">
      <div className="plot-graph-head">
        {view.pairs.map((p, i) => (
          <span key={p.key} className="chip" style={{ borderColor: COLORS[i % COLORS.length] }}>
            {p.y.kind !== "system" && p.y.id ? <ObjLink obj={{ kind: p.y.kind, index: p.y.index }}>{pairLabel(p)}</ObjLink> : pairLabel(p)}
            <button title="Remove this series" onClick={() => remove(p.key)}>
              ×
            </button>
          </span>
        ))}
        <span className="grow" />
        {built && built.stride > 1 && (
          <span className="muted" title="Long run: the values of one time step in this many are plotted">
            1 time step in {built.stride}
          </span>
        )}
        {zoom && <button onClick={() => setZoom(null)}>Show all</button>}
        <button disabled={!built} onClick={exportData} title="Export the plotted values (CSV or Excel)">
          Data
        </button>
        <button disabled={!built || !range} onClick={() => built && range && saveSvg("xy", xySvg(built, range, view.lines, { w: size.w, h }))}>
          SVG
        </button>
        <button disabled={!built} onClick={() => canvas.current && savePng("xy", canvas.current)}>
          PNG
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      <div ref={sizeRef} className="plot-area xy-area">
        {built && range && (
          <canvas
            ref={canvas}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={() => {
              setHover(null);
              setSelect(null);
              down.current = null;
            }}
            onDoubleClick={() => setZoom(null)}
          />
        )}
        {built && !range && <div className="panel-empty">No values to plot.</div>}
        {hover && built && (
          // On the other side of the pointer near the right and bottom edges, so it is not cut.
          <div
            className="xy-tip"
            style={{
              ...(hover.x > size.w - 240 ? { right: size.w - hover.x + 12 } : { left: hover.x + 12 }),
              ...(hover.y > h - 70 ? { bottom: h - hover.y + 12 } : { top: hover.y + 12 }),
            }}
          >
            {pointText(results, built, hover.at[0], hover.at[1])}
          </div>
        )}
      </div>
    </div>
  );
}
