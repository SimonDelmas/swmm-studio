// The viewer of the map (a basemap or a plain plane) and its view: restored from the
// project, moved on request, and saved back when the user changes it.

import { useEffect, useRef, useState } from "react";
import { updateProjectUi } from "../actions/project";
import { getState, useStore } from "../store";
import { createDeckViewer, createMapViewer, selectionBounds, type Extent, type Pt, type Viewer } from "./viewers";

/** Display coordinates → page coordinates on the map (UI tests). */
export const mapProject: { current: ((p: Pt) => Pt) | null } = { current: null };

/** The view saved in the project, when it was saved in this coordinate space. */
function savedView(space: string): Extent | null {
  const view = getState().model?.project.ui.view as { extent?: number[]; space?: string } | undefined;
  return view?.space === space && view.extent?.length === 4 && view.extent.every(Number.isFinite) ? (view.extent as Extent) : null;
}

/** Latitude in degrees → Web Mercator ordinate, in degrees of longitude at the equator. */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  return (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) * 180) / Math.PI;
}

/**
 * The view is the saved one as the map restores it: the saved extent, centred, filling
 * the map in one direction. In a window of another shape the map shows more in the other
 * direction, which is not a change of view to save.
 */
function isSavedView(space: string, savedView: Extent, view: Extent): boolean {
  // On the basemap the view is centred in map (Mercator) units, not in degrees.
  const flat = (e: Extent): Extent => (space === "lonlat" ? [e[0], mercatorY(e[1]), e[2], mercatorY(e[3])] : e);
  const [saved, now] = [flat(savedView), flat(view)];
  const [w, h] = [saved[2] - saved[0], saved[3] - saved[1]];
  const [nw, nh] = [now[2] - now[0], now[3] - now[1]];
  const tol = 1e-3 * Math.max(w, h);
  const centred = Math.abs(saved[0] + saved[2] - now[0] - now[2]) <= 2 * tol && Math.abs(saved[1] + saved[3] - now[1] - now[3]) <= 2 * tol;
  const fills = (Math.abs(nw - w) <= tol && nh >= h - tol) || (Math.abs(nh - h) <= tol && nw >= w - tol);
  return centred && fills;
}

/** Zooms to the model or to the selection, or pans to the selection, when the store asks. */
function useViewRequests(viewer: React.RefObject<Viewer | null>) {
  const fitExtent = useStore((s) => s.fitExtent);
  const fitSelection = useStore((s) => s.fitSelection);
  const panSelection = useStore((s) => s.panSelection);

  useEffect(() => {
    const b = getState().model?.bounds;
    if (fitExtent && b && viewer.current) viewer.current.fit(b);
  }, [fitExtent]);

  useEffect(() => {
    const st = getState();
    if (!fitSelection || !st.geometry || !viewer.current) return;
    const b = selectionBounds(st.geometry, st.selection);
    if (b) viewer.current.fit(b);
  }, [fitSelection]);

  // Pans to the selection when it is not entirely in view (zooms out only if it does not fit).
  useEffect(() => {
    const st = getState();
    const v = viewer.current;
    if (!panSelection || !st.geometry || !v) return;
    const b = selectionBounds(st.geometry, st.selection);
    if (!b) return;
    const e = v.extent();
    if (b[0] >= e[0] && b[1] >= e[1] && b[2] <= e[2] && b[3] <= e[3]) return;
    if (b[2] - b[0] > e[2] - e[0] || b[3] - b[1] > e[3] - e[1]) return v.fit(b);
    v.center([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
  }, [panSelection]);
}

/**
 * The viewer drawn in `container`, made again when the coordinate space or the model
 * (`modelKey`) changes. `viewTick` changes whenever the view moves.
 */
export function useViewer(container: React.RefObject<HTMLDivElement | null>, space: string | undefined, modelKey: string | null) {
  const viewer = useRef<Viewer | null>(null);
  const [viewTick, setViewTick] = useState(0);

  useEffect(() => {
    if (!container.current || !space) return;
    const el = container.current;
    let raf = 0;
    const onView = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setViewTick((t) => t + 1));
    };
    const v = space === "lonlat" ? createMapViewer(el, getState().model!.project.basemap, onView) : createDeckViewer(el, onView);
    viewer.current = v;
    mapProject.current = (p) => {
      const r = el.getBoundingClientRect();
      const q = v.project(p);
      return [r.left + q[0], r.top + q[1]];
    };
    // The view saved in the project, else the whole model.
    const saved = savedView(space);
    const bounds = getState().model?.bounds;
    if (saved) v.fit(saved, true);
    else if (bounds) v.fit(bounds);
    return () => {
      cancelAnimationFrame(raf);
      v.destroy();
      viewer.current = null;
    };
  }, [space, modelKey]);

  // Basemap settings.
  const basemap = useStore((s) => s.model?.project.basemap);
  useEffect(() => {
    if (basemap) viewer.current?.setBasemap(basemap);
  }, [basemap, space, modelKey]);

  useViewRequests(viewer);

  // Remember the view in the project (debounced), once it differs from the saved one.
  useEffect(() => {
    if (!viewer.current || !space) return;
    const path = getState().model?.path;
    const t = setTimeout(() => {
      if (!viewer.current) return;
      const extent = viewer.current.extent();
      const saved = savedView(space);
      if (!saved || !isSavedView(space, saved, extent)) updateProjectUi({ view: { space, extent } }, path);
    }, 1500);
    return () => clearTimeout(t);
  }, [viewTick, space]);

  return { viewer, viewTick };
}
