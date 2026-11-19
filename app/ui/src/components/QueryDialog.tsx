import { useRef, useState } from "react";
import { selectByQuery, type QueryMode } from "../actions/selection";
import { errorText } from "../api";
import { setState, useStore } from "../store";
import type { ObjKind } from "../types";
import { Modal } from "./Modal";

const LAYERS: [ObjKind, string, string][] = [
  ["node", "Nodes", "nodes"],
  ["link", "Links", "links"],
  ["subcatchment", "Subcatchments", "subcatchments"],
];

const TYPES: Partial<Record<ObjKind, string[]>> = {
  node: ["junction", "outfall", "divider", "storage"],
  link: ["conduit", "pump", "orifice", "weir", "outlet"],
};

const EXAMPLES: Record<string, string> = {
  node: "type = outfall",
  link: "diameter < 0.3",
  subcatchment: "area > 1 and imperviousness >= 50",
};

const MODES: [QueryMode, string, string][] = [
  ["replace", "New selection", "The objects found become the selection"],
  ["add", "Add", "Add the objects found to the selection"],
  ["intersect", "Intersect", "Keep only the selected objects the query finds"],
  ["remove", "Remove", "Remove the objects found from the selection"],
];

const STATS = ["max", "min", "mean", "total"];

/** The last query, found again when the dialog opens again. */
let last: { kind: ObjKind; query: string; mode: QueryMode } = { kind: "link", query: "", mode: "replace" };

/** Select the objects of a layer by an attribute query: `diameter < 0.3`, `max(flow) > 2`. */
export function QueryDialog() {
  const model = useStore((s) => s.model);
  const [kind, setKind] = useState<ObjKind>(last.kind);
  const [query, setQuery] = useState(last.query);
  const [mode, setMode] = useState<QueryMode>(last.mode);
  const [outcome, setOutcome] = useState<{ text: string; error: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = () => setState({ dialog: null });
  const layer = LAYERS.find(([k]) => k === kind)!;

  const attributes = [...(model?.attributes[kind] ?? []), ...(kind === "link" ? ["diameter"] : [])];
  const variables = model?.results?.variables[kind as "node" | "link" | "subcatchment"]?.map((v) => v.name) ?? [];

  const run = async () => {
    if (!query.trim() || running) return;
    last = { kind, query, mode };
    setRunning(true);
    try {
      const { found, selected } = await selectByQuery(kind, query, mode);
      setOutcome({ text: `${found.toLocaleString()} ${layer[2]} match the query; ${selected.toLocaleString()} objects selected.`, error: false });
    } catch (e) {
      setOutcome({ text: errorText(e), error: true });
    } finally {
      setRunning(false);
    }
  };

  /** Puts `text` at the cursor of the query field. */
  const insert = (text: string) => {
    const el = input.current;
    const [a, b] = el ? [el.selectionStart ?? query.length, el.selectionEnd ?? query.length] : [query.length, query.length];
    const before = query.slice(0, a);
    const pad = before && !before.endsWith(" ") && !before.endsWith("(") ? " " : "";
    const next = before + pad + text + query.slice(b);
    setQuery(next);
    requestAnimationFrame(() => {
      const at = (before + pad + text).length;
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };

  const names = (label: string, items: string[], title: string) =>
    items.length > 0 && (
      <div className="query-names">
        <span className="muted">{label}</span>
        {items.map((n) => (
          <button key={n} className="query-name mono" title={title} onClick={() => insert(n)}>
            {n}
          </button>
        ))}
      </div>
    );

  return (
    <Modal title="Select by query" onClose={close}>
      <div className="row">
        <label>
          Layer{" "}
          <select value={kind} onChange={(e) => (setKind(e.target.value as ObjKind), setOutcome(null))}>
            {LAYERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        ref={input}
        autoFocus
        className="mono"
        aria-label="Query"
        placeholder={`e.g. ${EXAMPLES[kind]}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") run();
        }}
      />
      {names("Names", ["id", "type", ...attributes], "Insert this name")}
      {names("Types", TYPES[kind] ?? [], "Insert this type (type = …)")}
      {names(
        "Results",
        variables,
        "Insert this result variable: its value at the current time step, or a statistic over the run with max( ), min( ), mean( ), total( )",
      )}
      {variables.length > 0 && names("Over the run", STATS.map((f) => `${f}(`), "Statistic of a result variable over the whole run, like max(flow)")}
      <p className="muted">
        Compare with = != &lt; &lt;= &gt; &gt;=, combine with and, or, not and parentheses, compute with + - * /. Texts ignore
        case, and * ? are wildcards in quotes: <span className="mono">id = "C1*"</span>. An object without the value never
        matches.
      </p>
      <div className="row" role="radiogroup" aria-label="Combine with the selection">
        {MODES.map(([m, label, title]) => (
          <label key={m} title={title}>
            <input type="radio" name="query-mode" checked={mode === m} onChange={() => setMode(m)} /> {label}
          </label>
        ))}
      </div>
      {outcome && <div className={outcome.error ? "panel-error" : "muted"}>{outcome.text}</div>}
      <div className="row end">
        <button className="primary" disabled={!query.trim() || running} onClick={run}>
          Select
        </button>
        <button onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
