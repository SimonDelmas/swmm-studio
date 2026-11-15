import { useEffect, type ReactNode } from "react";

/**
 * Shell of a dialog: backdrop, box and title. Escape closes it, and so does a click on
 * the backdrop unless `modal` (dialogs with unsaved input).
 */
export function Modal(props: {
  title: string;
  /** What the title bar shows, when it is more than the title (an editable name…). */
  heading?: ReactNode;
  onClose: () => void;
  modal?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={props.modal ? undefined : onClose}>
      <div className={props.className ? `modal ${props.className}` : "modal"} role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
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
