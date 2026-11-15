import { useEffect, useRef, useState } from "react";

/** A drop-down menu: closes on an item (`run`), an outside click or Escape. */
export function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  /** A click handler that closes the menu, then runs `f`. */
  const run = (f: () => unknown) => () => {
    setOpen(false);
    f();
  };
  return { open, setOpen, ref, run };
}
