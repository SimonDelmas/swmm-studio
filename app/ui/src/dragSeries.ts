// Drag a result variable (from the properties panel) onto a graph or a time series tab.
// Pointer events rather than HTML5 drag and drop, which the desktop webview reserves for files.

import type { ElementKind } from "./types";

export interface DraggedSeries {
  kind: ElementKind;
  index: number;
  var: number;
  label: string;
}

/** Where a dragged series can go: `data-drop-view` (a time series tab) and, inside it, `data-drop-graph`. */
export interface DropTarget {
  view: number;
  graph?: number;
}

type DropHandler = (s: DraggedSeries, t: DropTarget) => void;

let onDrop: DropHandler | null = null;

/** Set by the time series panel (avoids an import cycle). */
export function setSeriesDropHandler(h: DropHandler) {
  onDrop = h;
}

function targetAt(x: number, y: number): { el: HTMLElement; t: DropTarget } | null {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-drop-view]");
  if (!el) return null;
  const view = Number(el.dataset.dropView);
  const g = el.dataset.dropGraph;
  return { el, t: { view, graph: g !== undefined ? Number(g) : undefined } };
}

/**
 * Pointer down on a draggable result: a click (no move) calls `click`; a drag shows the
 * series under the pointer and drops it on the graph or the tab released over.
 */
export function startSeriesDrag(e: React.PointerEvent, item: DraggedSeries, click: () => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let over: HTMLElement | null = null;
  const setOver = (el: HTMLElement | null) => {
    if (el === over) return;
    over?.classList.remove("drop-over");
    el?.classList.add("drop-over");
    over = el;
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = item.label;
      document.body.appendChild(ghost);
      document.body.classList.add("dragging-series");
    }
    ghost.style.left = `${ev.clientX + 12}px`;
    ghost.style.top = `${ev.clientY + 8}px`;
    setOver(targetAt(ev.clientX, ev.clientY)?.el ?? null);
  };
  const end = (ev: PointerEvent, drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    setOver(null);
    if (!ghost) {
      if (drop) click();
      return;
    }
    ghost.remove();
    document.body.classList.remove("dragging-series");
    if (!drop) return;
    const hit = targetAt(ev.clientX, ev.clientY);
    if (hit) onDrop?.(item, hit.t);
  };
  const up = (ev: PointerEvent) => end(ev, true);
  const cancel = (ev: PointerEvent) => end(ev, false);
  const key = (ev: KeyboardEvent) => ev.key === "Escape" && end(new PointerEvent("pointercancel"), false);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
}
