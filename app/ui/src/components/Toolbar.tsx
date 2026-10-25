import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { confirmDiscard, redo, saveModel, undo } from "../edit";
import { getState, notify, resetForModel, setState, useStore, type Tool } from "../store";
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

const EDIT_TOOLS: [Tool, string, string][] = [
  ["move", "✥ Move", "Move: drag nodes and gages, or the selected objects"],
  ["vertex", "⌖ Vertices", "Edit vertices of the selected link or subcatchment, reconnect link ends"],
];

const SELECT_TOOLS: [Tool, string, string][] = [
  ["select", "↖", "Select: click an object (Shift adds)"],
  ["box", "▭", "Box selection (Shift adds)"],
  ["lasso", "✎", "Lasso selection (Shift adds)"],
];

/** The "Project" drop-down: closes on an item click, an outside click or Escape. */
function ProjectMenu() {
  const model = useStore((s) => s.model);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = (label: string, action: () => unknown, opts: { title?: string; disabled?: boolean; className?: string } = {}) => (
    <button
      className={opts.className}
      title={opts.title}
      disabled={opts.disabled}
      onClick={() => {
        setOpen(false);
        action();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="menu" ref={ref}>
      <button className={open ? "active" : model?.dirty ? "dirty" : ""} onClick={() => setOpen(!open)} title="Project: new, open, save, projection">
        Project ▾
      </button>
      {open && (
        <div className="menu-items">
          {item("New", newModel, { title: "New model" })}
          {item("Open…", chooseModel, { title: "Open a model (Ctrl+O)" })}
          {item("Save", () => saveModel(), { title: "Save (Ctrl+S)", disabled: !model, className: model?.dirty ? "dirty" : "" })}
          {item("Save as…", () => saveModel(true), { title: "Save as (Ctrl+Shift+S)", disabled: !model })}
          <hr />
          {item("Open results…", chooseResults, { disabled: !model })}
          <hr />
          {item(`Projection: ${model?.crs ? model.crs.id : "none"}…`, () => setState({ crsDialog: true }), {
            title: "Coordinate system of the model",
            disabled: !model,
          })}
        </div>
      )}
    </div>
  );
}

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
  const adding = tool.startsWith("add-");
  return (
    <div className="toolbar">
      <span className="brand">SWMM Studio</span>
      <ProjectMenu />
      <span className="sep" />
      {/* Edition */}
      <div className="tb-group" aria-label="Edition">
        <button disabled={!model?.undo} onClick={undo} title={model?.undo ? `Undo ${model.undo} (Ctrl+Z)` : "Undo (Ctrl+Z)"}>
          ↶
        </button>
        <button disabled={!model?.redo} onClick={redo} title={model?.redo ? `Redo ${model.redo} (Ctrl+Y)` : "Redo (Ctrl+Y)"}>
          ↷
        </button>
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
        {EDIT_TOOLS.map(([t, label, title]) => (
          <button key={t} className={tool === t ? "active" : ""} title={title} disabled={!model} onClick={() => setState({ tool: t })}>
            {label}
          </button>
        ))}
        <button disabled={!model} title="Zoom to the whole model" onClick={() => setState({ fitExtent: getState().fitExtent + 1 })}>
          ⤢ Extent
        </button>
      </div>
      <span className="sep" />
      {/* Selection */}
      <div className="tb-group" aria-label="Selection">
        {SELECT_TOOLS.map(([t, icon, title]) => (
          <button key={t} className={tool === t ? "active" : ""} title={title} disabled={!model} onClick={() => setState({ tool: t })}>
            {icon}
          </button>
        ))}
        <button
          disabled={!model}
          className={tool === "profile" ? "active" : ""}
          onClick={() => setState({ tool: tool === "profile" ? "select" : "profile" })}
          title="Longitudinal profile: click a start node, then an end node"
        >
          ⟋ Profile
        </button>
      </div>
      <span className="sep" />
      {/* Simulation: run and its settings (more to come) */}
      <div className="tb-group run-group" aria-label="Simulation">
        <button disabled={!model} onClick={() => setState({ dialog: "options" })} title="Simulation options">
          Options
        </button>
        <RunControls />
      </div>
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
