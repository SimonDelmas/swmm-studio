import { useEffect, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { refreshEngine } from "../actions/engines";
import { api, errorText } from "../api";
import { setState, useStore } from "../store";
import type { EnginesDto } from "../types";

/** Registered engines and the one that runs this model; changes apply at once. */
export function EnginesPane() {
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
  const browse = async () => {
    const p = await openFile({ filters: [{ name: "SWMM engine", extensions: ["exe"] }] });
    if (typeof p === "string") {
      setPath(p);
      if (!name) setName(p.split(/[\\/]/).slice(-2, -1)[0]?.replace(/\s*\(.*\)/, "") || "SWMM");
    }
  };
  return (
    <div className="option-pane">
    <p className="muted">
      No engine is bundled: register a command-line SWMM executable (EPA <span className="mono">runswmm.exe</span>,
      OWA or custom builds). Changes apply at once, even on Cancel. Shared with the command-line tool, stored in{" "}
      <span className="mono">{dto?.settings_path}</span>.
    </p>
    {dto?.error && <div className="panel-error">Settings file unreadable: {dto.error}</div>}
    {model && dto && (
      <label className="option">
        <span>Engine for {model.name}</span>
        <select value={dto.project ?? ""} onChange={(e) => run(api.setProjectEngine(e.target.value || null))}>
          <option value="">Default engine{dto.default ? ` (${dto.default})` : ""}</option>
          {dto.engines.map((e) => (
            <option key={e.name}>{e.name}</option>
          ))}
        </select>
      </label>
    )}
    <h4>Registered engines</h4>
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
              <button className="link" onClick={() => run(api.removeEngine(e.name))}>
                remove
              </button>
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
    {error && <div className="panel-error">{error}</div>}
    </div>
  );
}
