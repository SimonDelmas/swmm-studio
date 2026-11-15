import { useState } from "react";
import { addToPlot } from "../plot/series";
import { savePlotView } from "../plot/savedViews";
import { getState, notify, updatePlotView, useStore, type PlotView, type StatName } from "../store";
import type { Calendar, ElementKind } from "../types";
import { NumberInput } from "./CommitInput";
import { PlotGraph } from "./PlotGraph";
import { STATS } from "./StylePanel";

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
        {view.zoom && <button onClick={() => updatePlotView(view.id, { zoom: null })}>Whole run</button>}
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
          graph” stacks a new graph in the view. Drag to zoom (all the graphs of the view), double-click to reset. “Save” keeps the view in the
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
