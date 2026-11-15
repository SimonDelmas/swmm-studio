import { zoomToSelection } from "../../actions/selection";
import { ObjLink } from "../ObjLink";
import { useEffect } from "react";
import { ensureIds } from "../../actions/ids";
import { deleteObjects } from "../../edit";
import { setState, useStore } from "../../store";
import type { ObjKind, ObjRef } from "../../types";
import { BulkEditor, KIND_LABEL } from "./BulkEditor";
import { RdiiAssign } from "./RdiiAssign";


export function MultiSelection({ selection }: { selection: ObjRef[] }) {
  const ids = useStore((s) => s.ids);
  useEffect(() => {
    void ensureIds(selection.map((o) => o.kind));
  }, [selection]);
  const counts = new Map<ObjKind, number>();
  selection.forEach((o) => counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1));
  const nodes = selection.filter((o) => o.kind === "node").map((o) => o.index);
  return (
    <div className="props">
      <h3>{selection.length} objects selected</h3>
      <div>
        {Array.from(counts).map(([k, n]) => (
          <div key={k}>
            {KIND_LABEL[k]}: {n}
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={zoomToSelection}>Zoom to selection</button>
        <button onClick={() => setState({ selection: [] })}>Clear</button>
        <button className="danger" onClick={() => deleteObjects(selection)}>
          Delete…
        </button>
      </div>
      <BulkEditor selection={selection} />
      {nodes.length > 0 && <RdiiAssign nodes={nodes} />}
      <h4>Objects</h4>
      <div className="id-list">
        {selection.slice(0, 300).map((o) => (
          <ObjLink key={`${o.kind}${o.index}`} obj={o} zoom={false}>
            {ids[o.kind]?.[o.index] ?? `${o.kind} #${o.index + 1}`}
          </ObjLink>
        ))}
        {selection.length > 300 && <span className="muted">… {selection.length - 300} more</span>}
      </div>
    </div>
  );
}
