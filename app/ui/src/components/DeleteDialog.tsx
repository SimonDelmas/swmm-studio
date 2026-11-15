import { confirmDelete } from "../actions/edit";
import { setState, useStore } from "../store";
import { Modal } from "./Modal";

/** Confirmation of a deletion that takes other things with it (connected links, references). */
export function DeleteDialog() {
  const p = useStore((s) => s.pendingDelete);
  if (!p) return null;
  const { plan } = p;
  const close = () => setState({ pendingDelete: null });
  const list = (items: string[]) => items.slice(0, 15).join(", ") + (items.length > 15 ? ` … (${items.length - 15} more)` : "");
  const count = plan.nodes.length + plan.links.length + plan.subcatchments.length + plan.gages.length;
  return (
    <Modal title={`Delete ${count} object(s)?`} onClose={close}>
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
    </Modal>
  );
}
