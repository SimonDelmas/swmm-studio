import { useCallback, useRef, useState } from "react";

/** Size of an element, tracked with a ResizeObserver attached through a callback ref
 * (so it works for elements that mount after the component). */
export function useSize<T extends HTMLElement>(initial = { w: 0, h: 0 }) {
  const [size, setSize] = useState(initial);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const update = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    ro.current = new ResizeObserver(update);
    ro.current.observe(el);
    update();
  }, []);
  return [ref, size] as const;
}

/** Value of a CSS custom property of the document (theme colours for canvases). */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
