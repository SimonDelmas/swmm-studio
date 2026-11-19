import { useEffect, useMemo, useRef, useState } from "react";
import { findCommands, runCommand, type Command } from "../actions/commands";
import { getState, setState } from "../store";
import { Modal } from "./Modal";

/**
 * The command palette (Ctrl+P): type to filter the commands usable now, ↑ / ↓ to choose,
 * Enter or a click to run, Escape to close.
 */
export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The commands usable as the palette opens (it is modal: the state does not change meanwhile).
  const found = useMemo(() => findCommands(query, getState()), [query]);
  const list = useRef<HTMLUListElement>(null);
  const at = Math.min(active, found.length - 1);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const close = () => setState({ dialog: null });
  const run = (c: Command | undefined) => {
    if (!c) return;
    // Closed first: the command may open a dialog of its own.
    close();
    runCommand(c);
  };
  const move = (step: number) => {
    if (found.length > 0) setActive((at + step + found.length) % found.length);
  };

  return (
    <Modal title="Command palette" onClose={close} className="palette-modal">
      <input
        autoFocus
        className="palette-input"
        placeholder="Type a command…"
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={at >= 0 ? `palette-${at}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          const ctrl = e.ctrlKey || e.metaKey;
          if (e.key === "ArrowDown" || (ctrl && e.key.toLowerCase() === "p" && !e.shiftKey)) move(1);
          else if (e.key === "ArrowUp" || (ctrl && e.key.toLowerCase() === "p")) move(-1);
          else if (e.key === "PageDown") setActive(Math.max(0, Math.min(found.length - 1, at + 8)));
          else if (e.key === "PageUp") setActive(Math.max(0, at - 8));
          else if (e.key === "Enter") run(found[at]);
          else return;
          e.preventDefault();
        }}
      />
      <ul id="palette-list" ref={list} className="palette-list" role="listbox" aria-label="Commands">
        {found.map((c, i) => (
          <li
            key={c.id}
            id={`palette-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === at}
            className={i === at ? "active" : ""}
            onMouseMove={() => i !== at && setActive(i)}
            onClick={() => run(c)}
          >
            <span className="palette-group">{c.group}</span>
            <span className="palette-label">{c.label}</span>
            {c.keys && <kbd>{c.keys}</kbd>}
          </li>
        ))}
        {found.length === 0 && <li className="muted palette-none">No command matches</li>}
      </ul>
    </Modal>
  );
}
