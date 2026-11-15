import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { newModel } from "../edit";
import { setState } from "../store";
import { Modal } from "./Modal";

/** Flow units of a new model, then the file it is written to. */
export function NewModelDialog() {
  const [units, setUnits] = useState("LPS");
  const close = () => setState({ dialog: null });
  const create = async () => {
    const path = await save({ filters: [{ name: "SWMM model", extensions: ["inp"] }] });
    if (path) await newModel(path, units);
  };
  return (
    <Modal title="New model" onClose={close}>
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
    </Modal>
  );
}
