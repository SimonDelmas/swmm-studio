import { setState } from "../store";
import { Modal } from "./Modal";

/** The keyboard shortcuts, by theme (keep in step with `useShortcuts`). */
const GROUPS: [string, [string, string][]][] = [
  [
    "Project",
    [
      ["Ctrl+N", "New model"],
      ["Ctrl+O", "Open a model"],
      ["Ctrl+S / Ctrl+Shift+S", "Save / save as"],
      ["Ctrl+,", "Simulation options"],
      ["F5", "Run the model"],
      ["Ctrl+P", "Command palette: find and run any command"],
      ["?", "This list"],
    ],
  ],
  [
    "Edition",
    [
      ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
      ["Delete", "Delete the selected objects"],
      ["Enter / Backspace", "Finish the shape being drawn / remove its last point"],
      ["Escape", "Cancel the shape, the profile start, the tool, then the selection"],
    ],
  ],
  [
    "Map tools",
    [
      ["S", "Select"],
      ["B", "Box selection"],
      ["L", "Lasso selection"],
      ["Q", "Select by query"],
      ["M", "Move"],
      ["V", "Edit vertices"],
      ["P", "Longitudinal profile (on / off)"],
      ["U", "Upstream highlight (on / off)"],
    ],
  ],
  [
    "View",
    [
      ["F", "Zoom to the whole model"],
      ["Shift+F", "Zoom to the selection"],
      ["T", "Labels (show / hide)"],
      ["Ctrl+F", "Find an object by its ID"],
      ["Alt+← / Alt+→", "Previous / next tab of the bottom panel"],
      ["Ctrl+ù", "Maximize / restore the bottom panel"],
    ],
  ],
  [
    "Results",
    [
      ["Space", "Play / pause"],
      ["← / →", "Previous / next time step"],
      ["Home / End", "First / last time step"],
    ],
  ],
];

export function ShortcutsDialog() {
  const close = () => setState({ dialog: null });
  return (
    <Modal title="Keyboard shortcuts" onClose={close} className="shortcuts-modal">
      <div className="shortcuts">
        {GROUPS.map(([group, keys]) => (
          <section key={group}>
            <h4>{group}</h4>
            <dl>
              {keys.map(([k, what]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted">The single keys work when the cursor is not in a field.</p>
      <div className="row end">
        <button onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
