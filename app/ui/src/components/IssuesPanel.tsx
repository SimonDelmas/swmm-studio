import { selectObject } from "../actions/selection";
import { Linkified } from "./ObjLink";
import { useMemo, useState } from "react";
import { validateModel } from "../actions/validate";
import { exportTable } from "../exporting";
import { useStore } from "../store";
import { VirtualTable, type CellValue } from "./VirtualTable";

/** Model validation: errors SWMM would stop on and suspicious data, linked to the objects. */
export function IssuesPanel() {
  const model = useStore((s) => s.model);
  const issues = useStore((s) => s.issues);
  const error = useStore((s) => s.issuesError);
  const [show, setShow] = useState<"all" | "error" | "warning">("all");
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (issues ?? []).filter((i) => (show === "all" || i.severity === show) && (!f || `${i.code} ${i.message} ${i.section ?? ""}`.toLowerCase().includes(f)));
  }, [issues, show, filter]);
  const rows: CellValue[][] = shown.map((i) => [i.severity, i.code.replace(/_/g, " "), i.message, i.section ?? ""]);

  if (!model) return <div className="panel-empty">Open a model first.</div>;
  const errors = issues?.filter((i) => i.severity === "error").length ?? 0;
  const warnings = (issues?.length ?? 0) - errors;
  const pick = (k: number) => {
    const o = shown[k].object;
    if (o) selectObject(o);
  };
  return (
    <div className="events-panel">
      <div className="panel-toolbar">
        <span className={errors ? "bad" : "ok"}>{errors} error(s)</span>
        <span className={warnings ? "warn" : "muted"}>{warnings} warning(s)</span>
        <select value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="all">all</option>
          <option value="error">errors</option>
          <option value="warning">warnings</option>
        </select>
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => void validateModel().catch(() => {})}>Check again</button>
        <span className="grow" />
        <button disabled={rows.length === 0} onClick={() => exportTable("issues", "Issues", ["Severity", "Check", "Message", "Section"], rows)}>
          Export
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {issues && issues.length === 0 && <div className="panel-empty">No problem found.</div>}
      {issues && issues.length > 0 && (
        <VirtualTable
          columns={[
            { title: "", format: (v) => <span className={v === "error" ? "bad" : "warn"}>{v === "error" ? "●" : "▲"}</span> },
            { title: "Check" },
            { title: "Message", format: (v, k) => <Linkified text={String(v ?? "")} hint={shown[k].object} /> },
            { title: "Section" },
          ]}
          rows={rows}
          onRow={pick}
          resetKey={model.path}
          rowClass={(k) => (shown[k].object ? undefined : "no-object")}
        />
      )}
    </div>
  );
}
