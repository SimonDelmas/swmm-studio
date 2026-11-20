import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { tryEdit } from "../actions/edit";
import { getState, setState } from "../store";
import type { RuleIssue, SectionInfo } from "../analysisTypes";
import { Modal } from "./Modal";
import { RulesEditor, type RulesEditorHandle } from "./RulesEditor";
import { latest } from "../latest";

/** Sections whose lines define the network: editing them as text rebuilds it. */
const NETWORK = new Set(["JUNCTIONS", "OUTFALLS", "DIVIDERS", "STORAGE", "CONDUITS", "PUMPS", "ORIFICES", "WEIRS", "OUTLETS", "SUBCATCHMENTS", "RAINGAGES", "COORDINATES", "VERTICES", "POLYGONS", "SYMBOLS"]);

/** Raw text of any section, editable (water quality, LID, groundwater… have no other editor). */
export function SectionsDialog() {
  // Opened from the Issues tab: at a section and line.
  const [at] = useState(() => getState().sectionsAt);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [name, setName] = useState<string>(at?.section ?? "POLLUTANTS");
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [problems, setProblems] = useState<RuleIssue[]>([]);
  const editor = useRef<RulesEditorHandle>(null);
  const pendingLine = useRef<number | null>(at ? at.line - 1 : null);
  const rules = name === "CONTROLS";
  useEffect(() => {
    setState({ sectionsAt: null });
    api.sections().then(
      (s) => {
        setSections(s);
        if (at) return;
        const firstQuality = s.find((x) => x.present && ["POLLUTANTS", "LANDUSES", "LID_CONTROLS", "AQUIFERS"].includes(x.name));
        setName(firstQuality?.name ?? s.find((x) => x.present)?.name ?? "TITLE");
      },
      (e) => setError(errorText(e)),
    );
  }, [at]);
  useEffect(() => {
    setText(null);
    // The text of another section, answered late, must not be shown (and saved) under this name.
    return latest(
      () => api.sectionText(name),
      (t) => (setText(t), setOrig(t), setError(null)),
      (e) => setError(errorText(e)),
    );
  }, [name]);
  // Control rules are checked as they are typed (against the names of the model).
  useEffect(() => {
    if (!rules || text === null) {
      setProblems([]);
      return;
    }
    return latest(
      () => api.checkSectionText(name, text),
      setProblems,
      () => setProblems([]),
      250,
    );
  }, [rules, name, text]);
  // Once the text is shown, go to the line asked for.
  useEffect(() => {
    if (text !== null && pendingLine.current !== null) {
      editor.current?.goTo(pendingLine.current);
      pendingLine.current = null;
    }
  }, [text]);
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
  // Closing asks before unapplied changes are lost.
  const leave = async () => {
    if (await discard()) close();
  };
  const list = sections.filter((s) => all || s.present || s.name === name);
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <Modal title="Sections as text" className="wide-modal sections-modal">
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
            {rules ? (
              <>
                <RulesEditor ref={editor} text={text ?? ""} issues={problems} disabled={text === null} onChange={setText} />
                <div className="rules-problems">
                  {problems.length === 0 ? (
                    <span className="muted">{text?.trim() ? "No problem found in the rules." : "RULE name / IF condition / THEN action / ELSE action / PRIORITY value"}</span>
                  ) : (
                    <>
                      <div className="muted">
                        {errors} error(s), {problems.length - errors} warning(s)
                      </div>
                      {problems.map((p, k) => (
                        <div key={k} className="summary-item" onClick={() => editor.current?.goTo(p.line)}>
                          <span className={p.severity === "error" ? "bad" : "warn"}>{p.severity === "error" ? "●" : "▲"}</span> line {p.line + 1}: {p.message}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </>
            ) : (
              <textarea spellCheck={false} value={text ?? ""} disabled={text === null} onChange={(e) => setText(e.target.value)} />
            )}
          </div>
        </div>
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <span className="muted">Applied edits can be undone (Ctrl+Z).</span>
          <button className="primary" disabled={!changed} onClick={apply}>
            Apply
          </button>
          <button onClick={leave}>Close</button>
        </div>
    </Modal>
  );
}
