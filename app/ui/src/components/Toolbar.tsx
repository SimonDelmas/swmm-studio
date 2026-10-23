import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { getState, notify, resetForModel, setState, useStore, type Tool } from "../store";
import type { Basemap } from "../types";

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
  const path = await open({ filters: [{ name: "SWMM model", extensions: ["inp"] }] });
  if (typeof path === "string") await openModel(path);
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
  return (
    <div className="toolbar">
      <span className="brand">SWMM Studio</span>
      <button onClick={chooseModel}>Open model…</button>
      <button disabled={!model} onClick={chooseResults}>
        Open results…
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
      <button disabled={!model} title="Zoom to the whole model" onClick={() => setState({ fitExtent: getState().fitExtent + 1 })}>
        ⤢
      </button>
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
