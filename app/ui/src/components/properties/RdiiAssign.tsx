import { useState } from "react";
import { errorText } from "../../api";
import { tryEdit } from "../../edit";
import { setState, useStore } from "../../store";
import { useNames } from "../../hooks/useNames";

/** Assigns a unit hydrograph and sewershed area to the selected nodes. */
export function RdiiAssign({ nodes }: { nodes: number[] }) {
  const uhs = useNames("hydrograph");
  const [uh, setUh] = useState("");
  const [area, setArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hydrograph = uh || uhs[0] || "";
  const areaUnit = useStore((s) => (s.model && ["CMS", "LPS", "MLD"].includes(s.model.flow_units) ? "ha" : "ac"));
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e) => setError(errorText(e)));
  return (
    <div className="bulk">
      <h4>RDII of the {nodes.length} selected node(s)</h4>
      <div className="row">
        <label>
          Unit hydrograph
          <select value={hydrograph} onChange={(e) => setUh(e.target.value)}>
            {uhs.length === 0 && <option value="">(none defined)</option>}
            {uhs.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label title="Leave empty to keep each node's sewershed area (0 for new assignments)">
          Area <input className="narrow" value={area} placeholder="keep" onChange={(e) => setArea(e.target.value)} />
          <span className="muted">{areaUnit}</span>
        </label>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={!hydrograph}
          onClick={() => run(tryEdit({ op: "assign_rdii", nodes, hydrograph, area: area.trim() || null }))}
        >
          Assign
        </button>
        <button onClick={() => run(tryEdit({ op: "remove_rdii", nodes }))}>Remove RDII</button>
        <button onClick={() => setState({ sideTab: "data" })}>Unit hydrographs…</button>
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
