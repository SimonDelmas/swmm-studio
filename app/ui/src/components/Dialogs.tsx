import { useEffect, useState } from "react";
import { open as openFile, save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { confirmDelete, newModel, tryEdit } from "../edit";
import { setState, useStore } from "../store";
import type { EnginesDto } from "../types";

type Opt = { key: string; label: string; choices?: string[]; kind?: "date" | "time" | "number" | "day" };

const YN = ["YES", "NO"];
const OPTION_GROUPS: [string, Opt[]][] = [
  [
    "General",
    [
      { key: "FLOW_UNITS", label: "Flow units", choices: ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"] },
      {
        key: "INFILTRATION",
        label: "Infiltration model",
        choices: ["HORTON", "MODIFIED_HORTON", "GREEN_AMPT", "MODIFIED_GREEN_AMPT", "CURVE_NUMBER"],
      },
      { key: "FLOW_ROUTING", label: "Routing model", choices: ["STEADY", "KINWAVE", "DYNWAVE"] },
      { key: "LINK_OFFSETS", label: "Link offsets", choices: ["DEPTH", "ELEVATION"] },
      { key: "FORCE_MAIN_EQUATION", label: "Force main equation", choices: ["H-W", "D-W"] },
      { key: "MIN_SLOPE", label: "Minimum conduit slope (%)", kind: "number" },
      { key: "ALLOW_PONDING", label: "Allow ponding", choices: YN },
      { key: "SKIP_STEADY_STATE", label: "Skip steady flow periods", choices: YN },
      { key: "IGNORE_RAINFALL", label: "Ignore rainfall/runoff", choices: YN },
      { key: "IGNORE_RDII", label: "Ignore RDII", choices: YN },
      { key: "IGNORE_SNOWMELT", label: "Ignore snowmelt", choices: YN },
      { key: "IGNORE_GROUNDWATER", label: "Ignore groundwater", choices: YN },
      { key: "IGNORE_ROUTING", label: "Ignore flow routing", choices: YN },
      { key: "IGNORE_QUALITY", label: "Ignore water quality", choices: YN },
    ],
  ],
  [
    "Dates",
    [
      { key: "START_DATE", label: "Start date (MM/DD/YYYY)", kind: "date" },
      { key: "START_TIME", label: "Start time", kind: "time" },
      { key: "REPORT_START_DATE", label: "Report start date", kind: "date" },
      { key: "REPORT_START_TIME", label: "Report start time", kind: "time" },
      { key: "END_DATE", label: "End date", kind: "date" },
      { key: "END_TIME", label: "End time", kind: "time" },
      { key: "SWEEP_START", label: "Street sweeping start (MM/DD)", kind: "day" },
      { key: "SWEEP_END", label: "Street sweeping end (MM/DD)", kind: "day" },
      { key: "DRY_DAYS", label: "Antecedent dry days", kind: "number" },
    ],
  ],
  [
    "Time steps",
    [
      { key: "REPORT_STEP", label: "Reporting", kind: "time" },
      { key: "WET_STEP", label: "Runoff, wet weather", kind: "time" },
      { key: "DRY_STEP", label: "Runoff, dry weather", kind: "time" },
      { key: "ROUTING_STEP", label: "Routing (H:MM:SS or seconds)", kind: "time" },
      { key: "RULE_STEP", label: "Control rule step", kind: "time" },
    ],
  ],
  [
    "Dynamic wave",
    [
      { key: "INERTIAL_DAMPING", label: "Inertial terms", choices: ["NONE", "PARTIAL", "FULL"] },
      { key: "NORMAL_FLOW_LIMITED", label: "Normal flow criterion", choices: ["SLOPE", "FROUDE", "BOTH"] },
      { key: "SURCHARGE_METHOD", label: "Surcharge method", choices: ["EXTRAN", "SLOT"] },
      { key: "VARIABLE_STEP", label: "Variable time step factor", kind: "number" },
      { key: "LENGTHENING_STEP", label: "Conduit lengthening step (s)", kind: "number" },
      { key: "MIN_SURFAREA", label: "Minimum nodal surface area", kind: "number" },
      { key: "MAX_TRIALS", label: "Maximum trials", kind: "number" },
      { key: "HEAD_TOLERANCE", label: "Head convergence tolerance", kind: "number" },
      { key: "SYS_FLOW_TOL", label: "System flow tolerance (%)", kind: "number" },
      { key: "LAT_FLOW_TOL", label: "Lateral flow tolerance (%)", kind: "number" },
      { key: "MINIMUM_STEP", label: "Minimum variable step (s)", kind: "number" },
      { key: "THREADS", label: "Threads", kind: "number" },
    ],
  ],
];

function check(o: Opt, v: string): string | null {
  if (!v.trim()) return null;
  const t = v.trim();
  if (o.kind === "number" && !Number.isFinite(Number(t))) return `${o.label}: not a number`;
  if (o.kind === "date" && !/^(\d{1,2}|[A-Za-z]{3})[/-]\d{1,2}[/-]\d{4}$/.test(t)) return `${o.label}: use MM/DD/YYYY`;
  if (o.kind === "day" && !/^\d{1,2}\/\d{1,2}$/.test(t)) return `${o.label}: use MM/DD`;
  if (o.kind === "time" && !/^\d+(:\d{1,2}){0,2}$|^\d*\.?\d+$/.test(t)) return `${o.label}: use H:MM:SS`;
  return null;
}

export function OptionsDialog() {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [orig, setOrig] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [origTitle, setOrigTitle] = useState("");
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.options().then((o) => {
      const v: Record<string, string> = {};
      o.values.forEach(([k, x]) => (v[k] = x));
      setValues(v);
      setOrig(v);
      setTitle(o.title);
      setOrigTitle(o.title);
    });
  }, []);
  const close = () => setState({ dialog: null });
  if (!values) return null;
  const known = new Set(OPTION_GROUPS.flatMap(([, g]) => g.map((o) => o.key)));
  const others = Object.keys(values).filter((k) => !known.has(k));
  const groups: [string, Opt[]][] = [...OPTION_GROUPS, ["Title & other", others.map((k) => ({ key: k, label: k }))]];
  const ok = async () => {
    const all = groups.flatMap(([, g]) => g);
    for (const o of all) {
      const e = check(o, values[o.key] ?? "");
      if (e) return setError(e);
    }
    const changed: [string, string][] = Object.keys({ ...values, ...orig })
      .filter((k) => (values[k] ?? "").trim() !== (orig[k] ?? ""))
      .map((k) => [k, (values[k] ?? "").trim()]);
    try {
      if (changed.length) await tryEdit({ op: "set_options", values: changed });
      if (title.trim() !== origTitle.trim()) await tryEdit({ op: "set_title", text: title });
      close();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const flowChanged = (values.FLOW_UNITS ?? "") !== (orig.FLOW_UNITS ?? "");
  const infilChanged = (values.INFILTRATION ?? "") !== (orig.INFILTRATION ?? "");
  return (
    <div className="modal-back">
      <div className="modal wide-modal">
        <h3>Simulation options</h3>
        <div className="tabs">
          {groups.map(([g], i) => (
            <button key={g} className={i === tab ? "active" : ""} onClick={() => setTab(i)}>
              {g}
            </button>
          ))}
        </div>
        <div className="options-grid">
          {groups[tab][1].map((o) => (
            <label key={o.key} className="option">
              <span>{o.label}</span>
              {o.choices ? (
                <select value={values[o.key] ?? ""} onChange={(e) => setValues({ ...values, [o.key]: e.target.value })}>
                  <option value="">(default)</option>
                  {o.choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                  {values[o.key] && !o.choices.includes(values[o.key]) && <option>{values[o.key]}</option>}
                </select>
              ) : (
                <input
                  value={values[o.key] ?? ""}
                  placeholder="(default)"
                  onChange={(e) => setValues({ ...values, [o.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          {tab === groups.length - 1 && (
            <label className="option title-option">
              <span>Title / notes</span>
              <textarea rows={4} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          )}
        </div>
        {flowChanged && <div className="warn">Changing the flow units does not convert any value of the model.</div>}
        {infilChanged && (
          <div className="warn">The [INFILTRATION] parameters are not converted: check them for the new model.</div>
        )}
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button className="primary" onClick={ok}>
            OK
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export async function refreshEngine(): Promise<EnginesDto | null> {
  try {
    const e = await api.engines();
    setState({ engine: e.effective });
    return e;
  } catch {
    return null;
  }
}

export function EnginesDialog() {
  const model = useStore((s) => s.model);
  const [dto, setDto] = useState<EnginesDto | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    refreshEngine().then(setDto);
  }, []);
  const run = async (p: Promise<EnginesDto>) => {
    setBusy(true);
    try {
      const d = await p;
      setDto(d);
      setState({ engine: d.effective });
      setError(null);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const close = () => setState({ dialog: null });
  const browse = async () => {
    const p = await openFile({ filters: [{ name: "SWMM engine", extensions: ["exe"] }] });
    if (typeof p === "string") {
      setPath(p);
      if (!name) setName(p.split(/[\\/]/).slice(-2, -1)[0]?.replace(/\s*\(.*\)/, "") || "SWMM");
    }
  };
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal wide-modal" onClick={(e) => e.stopPropagation()}>
        <h3>SWMM engines</h3>
        <p className="muted">
          No engine is bundled: register a command-line SWMM executable (EPA <span className="mono">runswmm.exe</span>,
          OWA or custom builds). Shared with the command-line tool, stored in{" "}
          <span className="mono">{dto?.settings_path}</span>.
        </p>
        {dto?.error && <div className="panel-error">Settings file unreadable: {dto.error}</div>}
        <table className="kv">
          <thead>
            <tr>
              <th>Default</th>
              <th>Name</th>
              <th>Version</th>
              <th>Executable</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dto?.engines.map((e) => (
              <tr key={e.name}>
                <td>
                  <input type="radio" checked={dto.default === e.name} onChange={() => run(api.setDefaultEngine(e.name))} />
                </td>
                <td>{e.name}</td>
                <td>{e.version ?? "?"}</td>
                <td className="mono path">{e.path}</td>
                <td>
                  <a onClick={() => run(api.removeEngine(e.name))}>remove</a>
                </td>
              </tr>
            ))}
            {dto && dto.engines.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No engine yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <h4>Add an engine</h4>
        <div className="row">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="grow" placeholder="Path to runswmm.exe" value={path} onChange={(e) => setPath(e.target.value)} />
          <button onClick={browse}>Browse…</button>
          <button
            className="primary"
            disabled={busy || !name.trim() || !path.trim()}
            onClick={async () => {
              if (await run(api.addEngine(name, path))) {
                setName("");
                setPath("");
              }
            }}
          >
            {busy ? "Checking…" : "Add"}
          </button>
        </div>
        {model && dto && (
          <div className="row">
            <label>
              Engine for {model.name}
              <select value={dto.project ?? ""} onChange={(e) => run(api.setProjectEngine(e.target.value || null))}>
                <option value="">Default engine{dto.default ? ` (${dto.default})` : ""}</option>
                {dto.engines.map((e) => (
                  <option key={e.name}>{e.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function NewModelDialog() {
  const [units, setUnits] = useState("LPS");
  const close = () => setState({ dialog: null });
  const create = async () => {
    const path = await save({ filters: [{ name: "SWMM model", extensions: ["inp"] }] });
    if (path) await newModel(path, units);
  };
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New model</h3>
        <p className="muted">An empty model with default options is written to the file you choose, then opened.</p>
        <label>
          Flow units
          <select value={units} onChange={(e) => setUnits(e.target.value)}>
            {["CMS", "LPS", "MLD", "CFS", "GPM", "MGD"].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <div className="row end">
          <button className="primary" onClick={create}>
            Choose file…
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function DeleteDialog() {
  const p = useStore((s) => s.pendingDelete);
  if (!p) return null;
  const { plan } = p;
  const close = () => setState({ pendingDelete: null });
  const list = (items: string[]) => items.slice(0, 15).join(", ") + (items.length > 15 ? ` … (${items.length - 15} more)` : "");
  const count = plan.nodes.length + plan.links.length + plan.subcatchments.length + plan.gages.length;
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Delete {count} object(s)?</h3>
        {plan.nodes.length > 0 && <div>Nodes: {list(plan.nodes)}</div>}
        {plan.links.length > 0 && <div>Links: {list(plan.links)}</div>}
        {plan.subcatchments.length > 0 && <div>Subcatchments: {list(plan.subcatchments)}</div>}
        {plan.gages.length > 0 && <div>Rain gages: {list(plan.gages)}</div>}
        {plan.cascade_links.length > 0 && (
          <div className="warn">
            {plan.cascade_links.length} connected link(s) are deleted too: {list(plan.cascade_links)}
          </div>
        )}
        {plan.cleared.length > 0 && (
          <div className="warn">References cleared (set to *): {list(plan.cleared)}</div>
        )}
        {plan.rules > 0 && <div className="warn">{plan.rules} control rule line(s) name these objects and are left unchanged.</div>}
        <div className="muted">Undo (Ctrl+Z) restores everything.</div>
        <div className="row end">
          <button className="primary danger" autoFocus onClick={confirmDelete}>
            Delete
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
