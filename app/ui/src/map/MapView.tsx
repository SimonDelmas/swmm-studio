import { useEffect, useMemo, useRef, useState } from "react";
import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { ensureIds } from "../actions/ids";
import { updateProjectUi } from "../actions/project";
import { api, errorText } from "../api";
import { profileClick } from "../profile/profiles";
import { getState, notify, sameRef, setState, useStore } from "../store";
import type { ObjRef } from "../types";
import { styleObjects } from "./colors";
import { baseLayers, staticGeometry } from "./layers";
import { outletSegments } from "./outlets";
import { labelLayer, profileLayers, selectionLayers } from "./overlayLayers";
import { ToolHint } from "./ToolHint";
import { useEditTools, type EditTools } from "./useEditTools";
import { useLayerValues } from "./useLayerValues";
import { createDeckViewer, createMapViewer, selectionBounds, type Extent, type Pt, type Viewer } from "./viewers";

/** Rendering measurements, read by the UI tests. */
export const mapPerf = { steps: [] as { period: number; ms: number }[] };
/** Editing tools of the map, for keyboard shortcuts (Escape, Enter, Backspace). */
export const mapTools: { current: EditTools | null } = { current: null };
/** Display coordinates → page coordinates on the map (UI tests). */
export const mapProject: { current: ((p: Pt) => Pt) | null } = { current: null };

/** The view saved in the project, when it was saved in this coordinate space. */
function savedView(space: string): Extent | null {
  const view = getState().model?.project.ui.view as { extent?: number[]; space?: string } | undefined;
  return view?.space === space && view.extent?.length === 4 && view.extent.every(Number.isFinite) ? (view.extent as Extent) : null;
}

/** Same extent, up to the rounding of a view that was restored and read back. */
function sameExtent(a: Extent, b: Extent): boolean {
  const tol = 1e-6 * Math.max(a[2] - a[0], a[3] - a[1]);
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

export function MapView() {
  const model = useStore((s) => s.model);
  const g = useStore((s) => s.geometry);
  const styles = useStore((s) => s.styles);
  const period = useStore((s) => s.period);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const labels = useStore((s) => s.labels);
  const ids = useStore((s) => s.ids);
  const fitExtent = useStore((s) => s.fitExtent);
  const fitSelection = useStore((s) => s.fitSelection);
  const panSelection = useStore((s) => s.panSelection);
  const profile = useStore((s) => s.profile);
  const profileStart = useStore((s) => s.profileStart);
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const [cursor, setCursor] = useState<string>("");
  const [drawing, setDrawing] = useState<Pt[] | null>(null);

  const modelSeq = useStore((s) => s.modelSeq);
  const revision = model?.revision ?? 0;
  // Values are reloaded after every edit (the objects or their attributes may differ).
  const resultsKey = model?.results ? `${model.results.path}:${model.results.cache.state}:${revision}` : null;
  const modelKey = model ? `${modelSeq}:${model.crs?.id ?? ""}` : null;
  const valuesKey = modelKey ? `${modelKey}:${revision}` : null;
  const compareKey = model?.compare ? `${model.compare.path}:${model.compare.cache.state}:${revision}` : null;
  const nodeValues = useLayerValues("node", styles.node, period, resultsKey, valuesKey, compareKey);
  const linkValues = useLayerValues("link", styles.link, period, resultsKey, valuesKey, compareKey);
  const subValues = useLayerValues("subcatchment", styles.subcatchment, period, resultsKey, valuesKey, compareKey);
  const tools = useEditTools(viewer, container, g, tool, selection);
  mapTools.current = tools;
  const drawingTool = tool.startsWith("add-");
  // Block body: an effect must return nothing or a cleanup function.
  useEffect(() => {
    viewer.current?.setDoubleClickZoom(!drawingTool);
  }, [drawingTool, modelKey]);
  // Leaving the profile tool forgets a half-picked profile.
  useEffect(() => {
    if (tool !== "profile" && getState().profileStart !== null) setState({ profileStart: null });
  }, [tool]);

  const space = g?.space;
  // (Re)create the viewer when the kind of view changes.
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
  const basemap = model?.project.basemap;
  useEffect(() => {
    if (basemap) viewer.current?.setBasemap(basemap);
  }, [basemap, space, modelKey]);

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

  // Remember the view in the project (debounced), once it differs from the saved one.
  useEffect(() => {
    if (!viewer.current || !space) return;
    const path = getState().model?.path;
    const t = setTimeout(() => {
      if (!viewer.current) return;
      const extent = viewer.current.extent();
      const saved = savedView(space);
      if (!saved || !sameExtent(saved, extent)) updateProjectUi({ view: { space, extent } }, path);
    }, 1500);
    return () => clearTimeout(t);
  }, [viewTick, space]);

  // Labels need the IDs.
  useEffect(() => {
    if (labels && model) void ensureIds(["node", "link"]);
  }, [labels, modelKey]);

  const coordSystem = space === "lonlat" ? COORDINATE_SYSTEM.LNGLAT : COORDINATE_SYSTEM.CARTESIAN;

  const nodeStyled = useMemo(
    () => g && styleObjects("node", styles.node, g.nodeTypes.length, g.nodeTypes, nodeValues),
    [g, styles.node, nodeValues],
  );
  const linkStyled = useMemo(
    () => g && styleObjects("link", styles.link, g.linkTypes.length, g.linkTypes, linkValues),
    [g, styles.link, linkValues],
  );
  const subStyled = useMemo(
    () => g && styleObjects("subcatchment", styles.subcatchment, g.subStarts.length - 1, null, subValues),
    [g, styles.subcatchment, subValues],
  );

  const geo = useMemo(() => g && staticGeometry(g), [g]);
  const outlets = useMemo(() => (g && styles.subcatchment.outletLinks ? outletSegments(g) : null), [g, styles.subcatchment.outletLinks]);

  const visible = useMemo(
    () => ({ node: styles.node.visible, link: styles.link.visible, subcatchment: styles.subcatchment.visible }),
    [styles.node.visible, styles.link.visible, styles.subcatchment.visible],
  );
  const base = useMemo(
    () => (g && geo && nodeStyled && linkStyled && subStyled ? baseLayers(g, geo, outlets, nodeStyled, linkStyled, subStyled, visible, coordSystem) : []),
    [g, geo, outlets, nodeStyled, linkStyled, subStyled, visible, coordSystem],
  );
  const selected = useMemo(
    () => (g ? selectionLayers(g, selection, coordSystem, styles.link.size, styles.node.size) : []),
    [g, selection, coordSystem, styles.link.size, styles.node.size],
  );
  const profiled = useMemo(
    () => (g ? profileLayers(g, profile, profileStart, coordSystem, styles.link.size, styles.node.size) : []),
    [g, profile, profileStart, coordSystem, styles.link.size, styles.node.size],
  );
  // Labels of the objects in view (viewTick: recomputed when the view moves).
  const labelled = useMemo(
    () => (labels && g && viewer.current ? labelLayer(g, ids, viewer.current.extent(), coordSystem, styles) : null),
    [labels, g, ids, viewTick, coordSystem, styles.node.visible, styles.link.visible, styles.node.hiddenTypes, styles.link.hiddenTypes],
  );

  // Time from a period change to the map drawn with it (see `mapPerf`).
  const stepStart = useRef<{ period: number; t0: number } | null>(null);
  useEffect(() => {
    stepStart.current = { period, t0: performance.now() };
  }, [period]);

  useEffect(() => {
    viewer.current?.setLayers([...base, ...profiled, ...selected, ...(labelled ? [labelled] : []), ...tools.layers]);
    const s = stepStart.current;
    if (s) {
      requestAnimationFrame(() => {
        mapPerf.steps.push({ period: s.period, ms: performance.now() - s.t0 });
        if (mapPerf.steps.length > 500) mapPerf.steps.shift();
      });
    }
  }, [base, profiled, selected, labelled, tools.layers]);

  // ---- interaction ----------------------------------------------------------

  const applySelection = (all: ObjRef[], add: boolean) => {
    const { selection: cur, styles: st, geometry: geom } = getState();
    // Objects of a hidden type cannot be selected on the map.
    const typeOf = (h: ObjRef) => (h.kind === "node" ? geom?.nodeTypes[h.index] : h.kind === "link" ? geom?.linkTypes[h.index] : undefined);
    const hits = all.filter((h) => {
      const t = typeOf(h);
      return t === undefined || !st[h.kind as "node" | "link"].hiddenTypes.includes(t);
    });
    if (!add) return setState({ selection: hits });
    const merged = [...cur];
    for (const h of hits) if (!merged.some((m) => sameRef(m, h))) merged.push(h);
    setState({ selection: merged });
  };

  const relative = (e: React.PointerEvent | PointerEvent): Pt => {
    const r = container.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // Click selection (any tool): a press and release without movement.
  const down = useRef<{ p: Pt; shift: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    down.current = { p: relative(e), shift: e.shiftKey };
  };
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (tools.onDownCapture(e, relative(e))) {
      // The drag is ours: the map must not pan.
      e.preventDefault();
      e.stopPropagation();
      down.current = null;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    const v = viewer.current;
    if (!d || !v || tool === "box" || tool === "lasso") return;
    const p = relative(e);
    if (Math.hypot(p[0] - d.p[0], p[1] - d.p[1]) > 4) return;
    if (tools.onClick(p, e)) return;
    if (tool.startsWith("add-")) return;
    const [x, y] = v.unproject(p);
    api
      .pick(x, y, 6 * v.unitsPerPixel())
      .then((hit) => (tool === "profile" ? profileClick(hit, d.shift) : applySelection(hit ? [hit] : [], d.shift)))
      .catch((err) => notify(errorText(err), true));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const v = viewer.current;
    if (!v || !g) return;
    tools.onMove(relative(e));
    const [x, y] = v.unproject(relative(e));
    setCursor(
      g.space === "lonlat"
        ? `${y.toFixed(6)}°, ${x.toFixed(6)}°`
        : `X ${(x + g.origin[0]).toFixed(2)}  Y ${(y + g.origin[1]).toFixed(2)}`,
    );
  };

  // Box and lasso: an overlay captures the pointer so the map does not pan.
  const onDrawDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = relative(e);
    setDrawing([p, p]);
    down.current = { p, shift: e.shiftKey };
  };
  const onDrawMove = (e: React.PointerEvent) => {
    onPointerMove(e);
    if (!drawing) return;
    const p = relative(e);
    if (tool === "box") setDrawing([drawing[0], p]);
    else {
      const last = drawing[drawing.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) setDrawing([...drawing, p]);
    }
  };
  const onDrawUp = () => {
    const v = viewer.current;
    const pts = drawing;
    const shift = down.current?.shift ?? false;
    setDrawing(null);
    down.current = null;
    if (!v || !pts) return;
    const req =
      tool === "box"
        ? api.selectRect(v.unproject(pts[0]), v.unproject(pts[pts.length - 1]))
        : pts.length >= 3
          ? api.selectPolygon(pts.map((p) => v.unproject(p)))
          : Promise.resolve([] as ObjRef[]);
    req.then((hits) => applySelection(hits, shift)).catch((err) => notify(errorText(err), true));
  };

  let shape: React.ReactNode = null;
  if (drawing) {
    if (tool === "box") {
      const [a, b] = [drawing[0], drawing[drawing.length - 1]];
      shape = (
        <rect
          x={Math.min(a[0], b[0])}
          y={Math.min(a[1], b[1])}
          width={Math.abs(b[0] - a[0])}
          height={Math.abs(b[1] - a[1])}
          className="draw-shape"
        />
      );
    } else {
      shape = <polygon points={drawing.map((p) => p.join(",")).join(" ")} className="draw-shape" />;
    }
  }

  const attribution = space === "lonlat" ? null : <div className="map-note">Local coordinates (no coordinate system)</div>;

  return (
    <div className="map-wrap">
      <div
        ref={container}
        className={`map tool-${drawingTool ? "add" : tool}`}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => e.preventDefault()}
      />
      {(tool === "box" || tool === "lasso") && (
        <svg className="draw-overlay" onPointerDown={onDrawDown} onPointerMove={onDrawMove} onPointerUp={onDrawUp}>
          {shape}
        </svg>
      )}
      {attribution}
      {cursor && <div className="map-cursor">{cursor}</div>}
      {model && <ToolHint tool={tool} sketching={tools.busy || (tool === "profile" && profileStart !== null)} />}
      {!model && <div className="map-empty">Open a SWMM model (.inp) to start.</div>}
    </div>
  );
}
