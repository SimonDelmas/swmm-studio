import { useCallback, useEffect, useRef, useState } from "react";

/** Height of a table row, in pixels (fixed: only the rows in view are rendered). */
export const ROW_HEIGHT = 22;
/** Rows rendered before and after those in view, so that scrolling shows no gap. */
const MARGIN = 10;

/**
 * Windowing of a long table in a scrolling box: which rows to render, and the height of
 * the spacers that stand for the others. `mounted` tells when the box appears (a table
 * shown only once its data is loaded).
 */
export function useVirtualRows(mounted: unknown = true) {
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted]);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => setScroll(e.currentTarget.scrollTop), []);
  /** Scrolls back to the first row. */
  const toTop = useCallback(() => {
    setScroll(0);
    if (box.current) box.current.scrollTop = 0;
  }, []);
  /** Rows `[first, last)` to render out of `count`, and the spacer heights around them. */
  const rowsInView = (count: number) => {
    const first = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - MARGIN);
    const last = Math.min(count, first + Math.ceil(height / ROW_HEIGHT) + 2 * MARGIN);
    return { first, last, before: first * ROW_HEIGHT, after: (count - last) * ROW_HEIGHT };
  };
  return { box, onScroll, toTop, rowsInView, height };
}
