import { discardRecovery, restoreRecovery } from "../actions/model";
import { useStore } from "../store";
import { Modal } from "./Modal";

/** Unsaved changes of the model just opened, autosaved by a session that ended without saving. */
export function RecoveryDialog() {
  const model = useStore((s) => s.model);
  const busy = useStore((s) => s.busy !== null);
  const rec = model?.recovery;
  if (!model || !rec) return null;
  return (
    <Modal title="Unsaved changes found">
      <p>
        SWMM Studio closed without saving <b>{model.name}</b>. Its changes were autosaved at {rec.saved_at}.
      </p>
      <p className="muted">
        Restored, they are unsaved changes of the model: save to keep them. Discarded, the model stays as it was last
        saved.
      </p>
      <div className="row end">
        <button className="primary" disabled={busy} onClick={() => restoreRecovery()}>
          Restore changes
        </button>
        <button className="danger" disabled={busy} onClick={() => discardRecovery()}>
          Discard
        </button>
      </div>
    </Modal>
  );
}
