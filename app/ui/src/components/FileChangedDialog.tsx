import { keepFile, reloadModel, reloadResults } from "../actions/model";
import { useStore } from "../store";
import { Modal } from "./Modal";

/** The model or the loaded results changed on disk by another program: reload them, or keep what the app has. */
export function FileChangedDialog() {
  const change = useStore((s) => s.fileChanges[0]);
  const model = useStore((s) => s.model);
  const busy = useStore((s) => s.busy !== null);
  if (!change || !model) return null;
  const keep = () => keepFile(change.kind);
  if (change.kind === "model") {
    return (
      <Modal title="Model changed on disk" onClose={keep}>
        {change.exists ? (
          <>
            <p>
              <b>{model.name}</b> was changed by another program.
            </p>
            <p className="muted">
              {model.dirty
                ? "Reloading it discards the unsaved changes made here. Kept, saving it here overwrites the other program's changes."
                : "Kept, saving it here overwrites the other program's changes."}
            </p>
          </>
        ) : (
          <p>
            <b>{model.name}</b> was deleted or renamed by another program. Saving it here writes it again.
          </p>
        )}
        <div className="row end">
          {change.exists && (
            <button className={model.dirty ? "danger" : "primary"} disabled={busy} onClick={() => reloadModel()}>
              Reload
            </button>
          )}
          <button disabled={busy} onClick={keep}>
            {change.exists ? "Keep this version" : "Close"}
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Results changed on disk" onClose={keep}>
      <p>
        {change.exists ? "The results file was changed by another program (a new run?):" : "The results file was deleted or renamed:"}
      </p>
      <p className="muted">{change.path}</p>
      {!change.exists && <p className="muted">The results shown stay as they were read.</p>}
      <div className="row end">
        {change.exists && (
          <button className="primary" disabled={busy} onClick={() => reloadResults()}>
            Reload results
          </button>
        )}
        <button disabled={busy} onClick={keep}>
          {change.exists ? "Keep these results" : "Close"}
        </button>
      </div>
    </Modal>
  );
}
