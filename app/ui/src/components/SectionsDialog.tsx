import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { tryEdit } from "../edit";
import { setState } from "../store";
import type { SectionInfo } from "../types";

/** Sections whose lines define the network: editing them as text rebuilds it. */
const NETWORK = new Set(["JUNCTIONS", "OUTFALLS", "DIVIDERS", "STORAGE", "CONDUITS", "PUMPS", "ORIFICES", "WEIRS", "OUTLETS", "SUBCATCHMENTS", "RAINGAGES", "COORDINATES", "VERTICES", "POLYGONS", "SYMBOLS"]);

/** Raw text of any section, editable (water quality, LID, groundwater… have no other editor). */
export function SectionsDialog() {
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [name, setName] = useState<string>("POLLUTANTS");
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api.sections().then((s) => {
      setSections(s);
      const firstQuality = s.find((x) => x.present && ["POLLUTANTS", "LANDUSES", "LID_CONTROLS", "AQUIFERS"].includes(x.name));
      setName(firstQuality?.name ?? s.find((x) => x.present)?.name ?? "TITLE");
    });
  }, []);
  useEffect(() => {
    setText(null);
    api.sectionText(name).then((t) => (setText(t), setOrig(t), setError(null)), (e) => setError(errorText(e)));
  }, [name]);
  const close = () => setState({ dialog: null });
  const changed = text !== null && text !== orig;
  const discard = async () => !changed || (await ask("Discard the changes to this section?", { title: "SWMM Studio", kind: "warning" }));
  const choose = async (n: string) => {
    if (await discard()) setName(n);
  };
  const apply = async () => {
    if (text === null) return;
    try {
      await tryEdit({ op: "set_section_text", section: name, text });
      setOrig(text);
      setSections(await api.sections());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const list = sections.filter((s) => all || s.present);
  return (
    <div className="modal-back">
      <div className="modal wide-modal sections-modal">
        <h3>Sections as text</h3>
        <div className="sections-body">
          <div className="sections-list">
            <label className="muted">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all sections
            </label>
            {list.map((s) => (
              <div key={s.name} className={`summary-item ${s.name === name ? "active" : ""}`} onClick={() => choose(s.name)}>
                [{s.name}] {s.present && <span className="muted">{s.lines}</span>}
              </div>
            ))}
          </div>
          <div className="sections-text">
            {NETWORK.has(name) && <div className="warn">This section defines the network: invalid lines are ignored by the map. Prefer the editors.</div>}
            <textarea spellCheck={false} value={text ?? ""} disabled={text === null} onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <span className="muted">Applied edits can be undone (Ctrl+Z).</span>
          <button className="primary" disabled={!changed} onClick={apply}>
            Apply
          </button>
          <button onClick={async () => (await discard()) && close()}>Close</button>
        </div>
      </div>
    </div>
  );
}
