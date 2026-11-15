import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[tabindex="0"]';

/**
 * Shell of a dialog: backdrop, box and title. The keyboard stays in the dialog (Tab goes
 * round its controls). With `onClose`, Escape and a click on the backdrop close it;
 * a dialog that edits something gives none and is closed by its own buttons only.
 */
export function Modal(props: {
  title: string;
  /** What the title bar shows, when it is more than the title (an editable name…). */
  heading?: ReactNode;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  // The latest handler, without listening again on every render.
  const close = useRef(onClose);
  close.current = onClose;

  // Focus moves into the dialog when it opens (unless one of its fields took it).
  useEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      // When dialogs are stacked, the keyboard belongs to the one on top.
      const open = document.querySelectorAll(".modal");
      if (open[open.length - 1] !== el) return;
      if (e.key === "Escape") {
        // Handled here only: the shortcuts of the app (clear the selection, leave the
        // tool) must not also react to the key that closes a dialog.
        e.stopPropagation();
        close.current?.();
      } else if (e.key === "Tab") {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return e.preventDefault();
        const [first, last] = [items[0], items[items.length - 1]];
        const at = document.activeElement;
        // From outside the dialog, from its box (where the focus is when it opens) or
        // from its last control in that direction: go round.
        const outside = at === el || !el.contains(at);
        if (outside || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        ref={box}
        tabIndex={-1}
        className={props.className ? `modal ${props.className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{props.heading ?? props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

/** A dialog that is loading its content, or failed to: it can always be closed. */
export function LoadingModal({ title, error, onClose }: { title: string; error: string | null; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      {error ? <div className="panel-error">{error}</div> : <p className="muted">Loading…</p>}
      <div className="row end">
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
