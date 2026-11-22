import { useEffect, useState } from "react";
import { addToPlot } from "../plot/series";
import { savePlotView } from "../plot/savedViews";
import { updatePlotView } from "../actions/views";
import { getState, notify, useStore } from "../store";
import { STATS, type PlotView, type StatName } from "../uiTypes";
import type { Calendar } from "../analysisTypes";
import type { ElementKind } from "../types";
import { NumberInput } from "./CommitInput";
import { PlotGraph } from "./PlotGraph";
import { fromInputValue, toInputValue } from "../format";
import { setZoom, shownRange, zoomBack, zoomBy, zoomForward } from "../plot/zoom";

/** A time series tab: graphs stacked on one time axis. */
export function PlotPanel({ view }: { view: PlotView }) {
  const results = useStore((s) => s.model?.results ?? null);
  const compare = useStore((s) => s.model?.compare ?? null);
  const selection = useStore((s) => s.selection);
  const [newName, setNewName] = useState("");
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
  const save = () => {
    savePlotView(newName.trim() || view.name, view.id);
    setNewName("");
  };

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
          <NumberInput
            className="narrow"
            title="Threshold"
            value={agg.threshold}
            onCommit={(threshold) => updatePlotView(view.id, { agg: { ...agg, threshold } })}
          />
        )}
        <span className="grow" />
        <ZoomControls view={view} />
        <input
          className="narrow-name"
          disabled={empty}
          placeholder={view.name}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button disabled={empty} onClick={save} title="Save this view in the project (under the name typed, or the tab's), to rebuild it later from the + menu">
          Save
        </button>
      </div>
      {empty && (
        <div className="panel-empty">
          Select objects and click “Add selected”, add a system series, or drag a result from the properties panel onto a graph; “to a new
          graph” stacks a new graph in the view. Drag to zoom (all the graphs of the view), turn the wheel to zoom
          around the pointer, Shift+drag or right-drag to pan, double-click for the whole run; ◀ ▶ (or the mouse back / forward buttons) go
          through the previous zooms, and the dates set the range shown exactly. “Save” keeps the view in the
          project. “per day / month / year” plots daily, monthly or yearly statistics.
        </div>
      )}
      <div className="plot-graphs">
        {view.graphs.map((g, i) => (
          <PlotGraph key={g.id} view={view} graph={g} number={i + 1} removable={view.graphs.length > 1} />
        ))}
        {/* Shown while a result is dragged (an empty last graph takes it already). */}
        {view.graphs[view.graphs.length - 1].series.length > 0 && (
          <div className="plot-new-graph" data-drop-view={view.id} data-drop-graph="new">
            + Drop here for a new graph
          </div>
        )}
      </div>
    </div>
  );
}

/** Zoom of a view: previous / next zoom, in / out, the whole run, and the range shown typed exactly. */
function ZoomControls({ view }: { view: PlotView }) {
  const results = useStore((s) => s.model?.results ?? null);
  if (!results) return null;
  const [a, b] = shownRange(results, view);
  const back = view.zoomBack?.length ?? 0;
  const fwd = view.zoomForward?.length ?? 0;
  const setEnd = (i: 0 | 1, ms: number) => {
    const z: [number, number] = [a, b];
    z[i] = ms / 1000;
    if (z[1] > z[0]) setZoom(view.id, z);
  };
  return (
    <span className="plot-zoom">
      <button disabled={back === 0} title="Previous zoom (mouse back button)" onClick={() => zoomBack(view.id)}>
        ◀
      </button>
      <button disabled={fwd === 0} title="Next zoom (mouse forward button)" onClick={() => zoomForward(view.id)}>
        ▶
      </button>
      <button title="Zoom in (or turn the wheel on a graph)" onClick={() => zoomBy(view.id, 0.5)}>
        +
      </button>
      <button disabled={!view.zoom} title="Zoom out" onClick={() => zoomBy(view.id, 2)}>
        −
      </button>
      <button disabled={!view.zoom} title="Show the whole run (or double-click a graph)" onClick={() => setZoom(view.id, null)}>
        Whole run
      </button>
      <TimeInput title="Start of the range shown" ms={a * 1000} onCommit={(ms) => setEnd(0, ms)} />
      –
      <TimeInput title="End of the range shown" ms={b * 1000} onCommit={(ms) => setEnd(1, ms)} />
    </span>
  );
}

/** A date and time, applied when it is left or on Enter (not at each digit typed). */
function TimeInput({ ms, title, onCommit }: { ms: number; title: string; onCommit: (ms: number) => void }) {
  const shown = toInputValue(ms);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const t = fromInputValue(text);
    if (t !== null && text !== shown) onCommit(t);
    else setText(shown);
  };
  return (
    <input
      type="datetime-local"
      title={title}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(shown);
        e.stopPropagation();
      }}
    />
  );
}
