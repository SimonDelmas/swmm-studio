import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { confirmDiscard, redo, saveModel, undo } from "../edit";
import { getState, notify, resetForModel, setState, useStore, type Tool } from "../store";
import type { Basemap } from "../types";
import { RunControls } from "./RunPanel";

export async function openModel(path: string) {
  setState({ busy: "Opening model…", playing: false });
  try {
    const model = await api.openModel(path);
    const geometry = await api.geometry();
    resetForModel(model, geometry);
    for (const n of model.notes) notify(n, true);
    if (model.project_error) notify(`Project file ignored: ${model.project_error}`, true);
    if (!model.crs && model.bounds) setState({ crsDialog: !model.project.crs && model.crs_hint !== null });
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    setState({ busy: null });
  }
}

async function chooseModel() {
  if (!(await confirmDiscard())) return;
  const path = await open({ filters: [{ name: "SWMM model", extensions: ["inp"] }] });
  if (typeof path === "string") await openModel(path);
}

async function newModel() {
  if (await confirmDiscard()) setState({ dialog: "new" });
}

async function chooseResults() {
  const path = await open({ filters: [{ name: "SWMM results", extensions: ["out"] }] });
  if (typeof path !== "string") return;
  setState({ busy: "Opening results…", playing: false });
  try {
    const model = await api.openResults(path);
    setState({ model, period: 0 });
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    setState({ busy: null });
  }
}

function setBasemap(patch: Partial<Basemap>) {
  const m = getState().model;
  if (!m) return;
  const basemap = { ...m.project.basemap, ...patch };
  setState({ model: { ...m, project: { ...m.project, basemap } } });
  api.updateProject(basemap).catch(() => {});
}

const TOOLS: [Tool, string, string][] = [
  ["select", "↖", "Select: click an object (Shift adds)"],
  ["box", "▭", "Box selection (Shift adds)"],
  ["lasso", "✎", "Lasso selection (Shift adds)"],
  ["move", "✥", "Move: drag nodes and gages, or the selected objects"],
  ["vertex", "⌖", "Edit vertices of the selected link or subcatchment, reconnect link ends"],
];

const ADD: [Tool, string][] = [
  ["add-junction", "Junction"],
  ["add-outfall", "Outfall"],
  ["add-storage", "Storage unit"],
  ["add-divider", "Flow divider"],
  ["add-conduit", "Conduit"],
  ["add-pump", "Pump"],
  ["add-orifice", "Orifice"],
  ["add-weir", "Weir"],
  ["add-outlet", "Outlet"],
  ["add-subcatchment", "Subcatchment"],
  ["add-gage", "Rain gage"],
];

export function Toolbar() {
  const model = useStore((s) => s.model);
  const tool = useStore((s) => s.tool);
  const [search, setSearch] = useState("");
  const find = () => {
    const id = search.trim();
    if (!id) return;
    api.findObject(id).then((o) => {
      if (!o) return notify(`No object named ${id}`);
      setState({ selection: [o], fitSelection: getState().fitSelection + 1 });
    });
  };
  const bm = model?.project.basemap;
  const adding = tool.startsWith("add-");
  return (
    <div className="toolbar">
      <span className="brand">SWMM Studio</span>
      <button onClick={newModel} title="New model">
        New
      </button>
      <button onClick={chooseModel} title="Open a model (Ctrl+O)">
        Open…
      </button>
      <button disabled={!model} onClick={() => saveModel()} title="Save (Ctrl+S)" className={model?.dirty ? "dirty" : ""}>
        Save
      </button>
      <button disabled={!model} onClick={() => saveModel(true)} title="Save as (Ctrl+Shift+S)">
        Save as…
      </button>
      <button disabled={!model} onClick={chooseResults}>
        Open results…
      </button>
      <span className="sep" />
      <button disabled={!model?.undo} onClick={undo} title={model?.undo ? `Undo ${model.undo} (Ctrl+Z)` : "Undo (Ctrl+Z)"}>
        ↶
      </button>
      <button disabled={!model?.redo} onClick={redo} title={model?.redo ? `Redo ${model.redo} (Ctrl+Y)` : "Redo (Ctrl+Y)"}>
        ↷
      </button>
      <span className="sep" />
      <button disabled={!model} onClick={() => setState({ crsDialog: true })} title="Coordinate system of the model">
        {model?.crs ? model.crs.id : "No CRS"}
      </button>
      {model?.space.kind === "lonlat" && bm && (
        <>
          <label title="Basemap (OpenStreetMap)">
            <input type="checkbox" checked={bm.visible} onChange={(e) => setBasemap({ visible: e.target.checked })} />
            Basemap
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={bm.opacity}
            title="Basemap opacity"
            onChange={(e) => setBasemap({ opacity: Number(e.target.value) })}
          />
        </>
      )}
      <span className="sep" />
      {TOOLS.map(([t, icon, title]) => (
        <button key={t} className={tool === t ? "active" : ""} title={title} disabled={!model} onClick={() => setState({ tool: t })}>
          {icon}
        </button>
      ))}
      <select
        disabled={!model}
        className={adding ? "active" : ""}
        value={adding ? tool : ""}
        title="Add objects on the map"
        onChange={(e) => setState({ tool: (e.target.value || "select") as Tool, selection: [] })}
      >
        <option value="">+ Add…</option>
        {ADD.map(([t, label]) => (
          <option key={t} value={t}>
            {label}
          </option>
        ))}
      </select>
      <button disabled={!model} title="Zoom to the whole model" onClick={() => setState({ fitExtent: getState().fitExtent + 1 })}>
        ⤢
      </button>
      <span className="sep" />
      <button disabled={!model} onClick={() => setState({ dialog: "options" })} title="Simulation options">
        Options
      </button>
      <RunControls />
      <span className="grow" />
      <input
        disabled={!model}
        placeholder="Find object ID"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && find()}
      />
    </div>
  );
}
