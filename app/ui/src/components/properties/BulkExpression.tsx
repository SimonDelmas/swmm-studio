import { useState } from "react";
import { errorText } from "../../api";
import { tryEdit } from "../../actions/edit";
import { getState } from "../../store";
import type { ObjKind, ObjRef } from "../../types";
import { KIND_LABEL } from "./BulkEditor";

const EXAMPLES: Partial<Record<ObjKind, string>> = {
  node: "max_depth = max_depth + 0.5 where type = junction",
  link: "diameter = diameter * 1.2 where slope < 0.005",
  subcatchment: "width = width * 2 where imperviousness > 50",
  gage: "scf = 1.1",
};

/** The last expression, found again when the panel shows again. */
let last = "";

/**
 * Sets a field of the selected objects of one kind from an expression, as one edit (undone
 * at once): `diameter = diameter * 1.2 where slope < 0.005`.
 */
export function BulkExpression({ selection }: { selection: ObjRef[] }) {
  const [statement, setStatement] = useState(last);
  const [kind, setKind] = useState<ObjKind | null>(null);
  const [outcome, setOutcome] = useState<{ text: string; error: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const kinds: ObjKind[] = Array.from(new Set(selection.map((o) => o.kind)));
  const k = kind && kinds.includes(kind) ? kind : (kinds[0] ?? null);
  if (!k) return null;
  const objects = selection.filter((o) => o.kind === k);

  const apply = async () => {
    if (!statement.trim() || running) return;
    last = statement;
    setRunning(true);
    try {
      const s = getState();
      const o = await tryEdit({ op: "bulk_expression", objects, statement, period: s.model?.results ? s.period : null });
      setOutcome({ text: o.message ?? "Done", error: false });
    } catch (e) {
      setOutcome({ text: errorText(e), error: true });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bulk">
      <h4>Edit with an expression</h4>
      {kinds.length > 1 && (
        <div className="row">
          <select value={k} onChange={(e) => (setKind(e.target.value as ObjKind), setOutcome(null))}>
            {kinds.map((x) => (
              <option key={x} value={x}>
                {KIND_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
      )}
      <input
        className="mono bulk-expression"
        aria-label="Bulk edit expression"
        placeholder={`e.g. ${EXAMPLES[k] ?? "field = value"}`}
        value={statement}
        onChange={(e) => (setStatement(e.target.value), setOutcome(null))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void apply();
        }}
      />
      <p className="muted">
        <span className="mono">field = value where condition</span>. Fields by name (diameter, roughness, length,
        invert_elevation, max_depth, area, width…) or by key (n, off1, geom2, shape…); the value and the condition use the
        same names, results and operators as Select by query. One edit: undo reverts it all.
      </p>
      <div className="row">
        <button className="primary" disabled={!statement.trim() || running} onClick={() => void apply()}>
          Apply to {objects.length} {KIND_LABEL[k].toLowerCase()}
        </button>
      </div>
      {outcome && <div className={outcome.error ? "field-error" : "muted"}>{outcome.text}</div>}
    </div>
  );
}
