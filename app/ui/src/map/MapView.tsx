import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { COORDINATE_SYSTEM, Deck, OrthographicView, type Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { LineLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { api, errorText } from "../api";
import { profileClick } from "../components/ProfilePanel";
import { getState, notify, sameRef, setState, useStore } from "../store";
import type { Geometry, ObjKind, ObjRef } from "../types";
import { styleObjects } from "./colors";
import { useEditTools, type EditTools } from "./useEditTools";
import { useLayerValues } from "./useLayerValues";

const EARTH = 40075016.686;

/** Rendering measurements, read by the UI tests. */
export const mapPerf = { steps: [] as { period: number; ms: number }[] };
/** Editing tools of the map, for keyboard shortcuts (Escape, Enter, Backspace). */
export const mapTools: { current: EditTools | null } = { current: null };
/** Display coordinates → page coordinates on the map (UI tests). */
export const mapProject: { current: ((p: Pt) => Pt) | null } = { current: null };
const HIGHLIGHT: [number, number, number, number] = [255, 200, 0, 255];
/** Path of the current longitudinal profile. */
const PROFILE: [number, number, number, number] = [230, 40, 150, 210];
const MAX_LABELS = 400;

type Pt = [number, number];

/** What the map needs from either back-end (MapLibre + overlay, or a plain Deck). */
interface Viewer {
  setLayers(layers: Layer[]): void;
  unproject(p: Pt): Pt;
  /** Display coordinates → pixels in the map element. */
  project(p: Pt): Pt;
  /** Size of a screen pixel in spatial-index units (Web Mercator metres or model units). */
  unitsPerPixel(): number;
  fit(b: [number, number, number, number]): void;
  /** Visible extent in display coordinates. */
  extent(): [number, number, number, number];
  /** Double-click zoom gets in the way while drawing. */
  setDoubleClickZoom(on: boolean): void;
  destroy(): void;
}

function bboxOf(pts: ArrayLike<number>, from = 0, to = pts.length / 2, b = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (let i = from; i < to; i++) {
    const x = pts[2 * i];
    const y = pts[2 * i + 1];
    if (!Number.isFinite(x)) continue;
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return b;
}

function createMapViewer(container: HTMLDivElement, onView: () => void): Viewer {
  const project = getState().model!.project;
  const bm = project.basemap;
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        basemap: { type: "raster", tiles: [bm.url], tileSize: 256, attribution: bm.attribution, maxzoom: 19 },
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#eef0f2" } },
        {
          id: "basemap",
          type: "raster",
          source: "basemap",
          paint: { "raster-opacity": bm.opacity },
          layout: { visibility: bm.visible ? "visible" : "none" },
        },
      ],
    },
    center: [0, 0],
    zoom: 1,
    maxZoom: 24,
    boxZoom: false,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: { compact: true },
    fadeDuration: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);
  map.on("moveend", onView);
  // The panels around the map resize it, not only the window.
  const ro = new ResizeObserver(() => map.resize());
  ro.observe(container);
  (container as unknown as { __map: maplibregl.Map }).__map = map;
  return {
    setLayers: (layers) => overlay.setProps({ layers }),
    unproject: (p) => {
      const ll = map.unproject(p);
      return [ll.lng, ll.lat];
    },
    project: (p) => {
      const q = map.project(p as [number, number]);
      return [q.x, q.y];
    },
    unitsPerPixel: () => EARTH / (512 * Math.pow(2, map.getZoom())),
    fit: (b) =>
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: 40, duration: 0, maxZoom: 19 },
      ),
    extent: () => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
    setDoubleClickZoom: (on) => (on ? map.doubleClickZoom.enable() : map.doubleClickZoom.disable()),
    destroy: () => {
      ro.disconnect();
      map.remove();
      delete (container as unknown as { __map?: maplibregl.Map }).__map;
    },
  };
}

function createDeckViewer(container: HTMLDivElement, onView: () => void): Viewer {
  let viewState = { target: [0, 0, 0] as [number, number, number], zoom: 0, minZoom: -30, maxZoom: 30 };
  const deck = new Deck({
    parent: container,
    views: new OrthographicView({ id: "ortho", flipY: false }),
    initialViewState: viewState,
    controller: { doubleClickZoom: true, inertia: false },
    layers: [],
    onViewStateChange: ({ viewState: v }) => {
      viewState = v as typeof viewState;
      onView();
      return v;
    },
  });
  const viewport = () => deck.getViewports()[0];
  return {
    setLayers: (layers) => deck.setProps({ layers }),
    unproject: (p) => {
      const v = viewport();
      return v ? (v.unproject(p) as Pt) : p;
    },
    project: (p) => {
      const v = viewport();
      return v ? (v.project(p) as Pt) : p;
    },
    unitsPerPixel: () => 1 / Math.pow(2, viewState.zoom),
    fit: (b) => {
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      const sx = Math.max(b[2] - b[0], 1e-6);
      const sy = Math.max(b[3] - b[1], 1e-6);
      const zoom = Math.log2(Math.min((w - 80) / sx, (h - 80) / sy));
      viewState = { ...viewState, target: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], zoom };
      deck.setProps({ initialViewState: { ...viewState } });
      onView();
    },
    extent: () => {
      const v = viewport();
      if (!v) return [-Infinity, -Infinity, Infinity, Infinity];
      const [x0, y0] = v.unproject([0, v.height]);
      const [x1, y1] = v.unproject([v.width, 0]);
      return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    },
    setDoubleClickZoom: (on) => deck.setProps({ controller: { doubleClickZoom: on, inertia: false } }),
    destroy: () => deck.finalize(),
  };
}

/** Display-coordinate bounds of a set of objects. */
function selectionBounds(g: Geometry, sel: ObjRef[]): [number, number, number, number] | null {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const o of sel) {
    if (o.kind === "node") b = bboxOf(g.nodes, o.index, o.index + 1, b);
    else if (o.kind === "gage") b = bboxOf(g.gages, o.index, o.index + 1, b);
    else if (o.kind === "link") b = bboxOf(g.linkPts, g.linkStarts[o.index], g.linkStarts[o.index + 1], b);
    else b = bboxOf(g.subPts, g.subStarts[o.index], g.subStarts[o.index + 1], b);
  }
  if (!Number.isFinite(b[0])) return null;
  // Single points: give the box some size.
  const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.2 || (g.space === "lonlat" ? 0.002 : 100);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
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
  useEffect(() => viewer.current?.setDoubleClickZoom(!drawingTool), [drawingTool, modelKey]);
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
    const v = space === "lonlat" ? createMapViewer(el, onView) : createDeckViewer(el, onView);
    viewer.current = v;
    mapProject.current = (p) => {
      const r = el.getBoundingClientRect();
      const q = v.project(p);
      return [r.left + q[0], r.top + q[1]];
    };
    const saved = (getState().model?.project.ui as { view?: { extent?: number[]; space?: string } })?.view;
    const b = saved?.space === space && saved.extent?.length === 4 ? saved.extent : getState().model?.bounds;
    if (b) v.fit(b as [number, number, number, number]);
    return () => {
      cancelAnimationFrame(raf);
      v.destroy();
      viewer.current = null;
    };
  }, [space, modelKey]);

  // Basemap settings.
  useEffect(() => {
    const map = (container.current as unknown as { __map?: maplibregl.Map })?.__map;
    const bm = model?.project.basemap;
    if (!map || !bm || space !== "lonlat") return;
    const apply = () => {
      if (!map.getLayer("basemap")) return;
      map.setLayoutProperty("basemap", "visibility", bm.visible ? "visible" : "none");
      map.setPaintProperty("basemap", "raster-opacity", bm.opacity);
      const src = map.getSource("basemap") as maplibregl.RasterTileSource | undefined;
      if (src && src.tiles?.[0] !== bm.url) src.setTiles([bm.url]);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [model?.project.basemap, space]);

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

  // Remember the view in the project (debounced).
  useEffect(() => {
    if (!viewer.current || !space) return;
    const t = setTimeout(() => {
      const st = getState();
      if (!st.model || !viewer.current) return;
      const ui = { ...st.model.project.ui, view: { space, extent: viewer.current.extent() } };
      st.model.project.ui = ui;
      api.updateProject(undefined, ui).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [viewTick, space]);

  // Labels need the IDs.
  useEffect(() => {
    if (!labels || !model) return;
    const need = (["node", "link", "subcatchment"] as ObjKind[]).filter((k) => !getState().ids[k]);
    if (need.length === 0) return;
    Promise.all(need.map((k) => api.ids(k))).then((all) => {
      const next = { ...getState().ids };
      need.forEach((k, i) => (next[k] = all[i]));
      setState({ ids: next });
    });
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

  // Static geometry. Links are drawn as one instance per segment so that colours and
  // widths are plain per-instance arrays: deck.gl uploads them directly, without running
  // accessors or re-tessellating paths (a time step only replaces the colour arrays).
  const geo = useMemo(() => {
    if (!g) return null;
    const nLinks = g.linkStarts.length - 1;
    let nSeg = 0;
    for (let i = 0; i < nLinks; i++) nSeg += Math.max(0, g.linkStarts[i + 1] - g.linkStarts[i] - 1);
    const src = new Float64Array(2 * nSeg);
    const tgt = new Float64Array(2 * nSeg);
    const segLink = new Uint32Array(nSeg);
    let k = 0;
    for (let i = 0; i < nLinks; i++) {
      for (let v = g.linkStarts[i]; v + 1 < g.linkStarts[i + 1]; v++, k++) {
        src[2 * k] = g.linkPts[2 * v];
        src[2 * k + 1] = g.linkPts[2 * v + 1];
        tgt[2 * k] = g.linkPts[2 * v + 2];
        tgt[2 * k + 1] = g.linkPts[2 * v + 3];
        segLink[k] = i;
      }
    }
    return {
      nSeg,
      segLink,
      src: { value: src, size: 2 },
      tgt: { value: tgt, size: 2 },
      nodePos: { value: g.nodes, size: 2 },
      gagePos: { value: g.gages, size: 2 },
      subs: { length: g.subStarts.length - 1, startIndices: g.subStarts, attributes: { getPolygon: { value: g.subPts, size: 2 } } },
      outlines: { length: g.subStarts.length - 1, startIndices: g.subStarts, attributes: { getPath: { value: g.subPts, size: 2 } } },
    };
  }, [g]);

  const baseLayers = useMemo(() => {
    if (!g || !geo || !nodeStyled || !linkStyled || !subStyled) return [];
    const common = { coordinateSystem: coordSystem, pickable: false };
    const layers: Layer[] = [];
    if (styles.subcatchment.visible && geo.subs.length > 0 && g.subPts.length > 0) {
      const c = subStyled.colors;
      layers.push(
        new SolidPolygonLayer({
          ...common,
          id: "subcatchments",
          data: geo.subs,
          _normalize: false,
          getFillColor: (_: unknown, { index, target }: { index: number; target: number[] }) => {
            target[0] = c[4 * index];
            target[1] = c[4 * index + 1];
            target[2] = c[4 * index + 2];
            target[3] = c[4 * index + 3];
            return target;
          },
          updateTriggers: { getFillColor: subStyled },
        } as never),
        new PathLayer({
          ...common,
          id: "subcatchment-outlines",
          data: geo.outlines,
          _pathType: "open",
          getColor: [70, 120, 60, 200],
          getWidth: 1,
          widthUnits: "pixels",
        } as never),
      );
    }
    if (styles.link.visible && geo.nSeg > 0) {
      const objColors = new Uint32Array(linkStyled.colors.buffer);
      const colors = new Uint32Array(geo.nSeg);
      const widths = new Float32Array(geo.nSeg);
      for (let k = 0; k < geo.nSeg; k++) {
        const i = geo.segLink[k];
        colors[k] = objColors[i];
        widths[k] = linkStyled.sizes[i];
      }
      layers.push(
        new LineLayer({
          ...common,
          id: "links",
          data: {
            length: geo.nSeg,
            attributes: {
              getSourcePosition: geo.src,
              getTargetPosition: geo.tgt,
              getColor: { value: new Uint8Array(colors.buffer), size: 4, normalized: true },
              getWidth: { value: widths, size: 1 },
            },
          },
          widthUnits: "pixels",
          widthMinPixels: 1,
        } as never),
      );
    }
    if (styles.node.visible && g.nodeTypes.length > 0) {
      layers.push(
        new ScatterplotLayer({
          ...common,
          id: "nodes",
          data: {
            length: g.nodeTypes.length,
            attributes: {
              getPosition: geo.nodePos,
              getFillColor: { value: nodeStyled.colors, size: 4, normalized: true },
              getRadius: { value: nodeStyled.sizes, size: 1 },
            },
          },
          radiusUnits: "pixels",
          stroked: true,
          getLineColor: [255, 255, 255, 220],
          lineWidthUnits: "pixels",
          getLineWidth: 0.75,
        } as never),
      );
    }
    if (g.gages.length > 0) {
      layers.push(
        new ScatterplotLayer({
          ...common,
          id: "gages",
          data: { length: g.gages.length / 2, attributes: { getPosition: geo.gagePos } },
          radiusUnits: "pixels",
          getRadius: 6,
          getFillColor: [30, 30, 30, 230],
          stroked: true,
          getLineColor: [255, 255, 255, 255],
          lineWidthUnits: "pixels",
          getLineWidth: 1.5,
        } as never),
      );
    }
    return layers;
  }, [g, geo, nodeStyled, linkStyled, subStyled, styles.node.visible, styles.link.visible, styles.subcatchment.visible, coordSystem]);

  const selectionLayers = useMemo(() => {
    if (!g || selection.length === 0) return [];
    const common = { coordinateSystem: coordSystem, pickable: false };
    const pts: Pt[] = [];
    const paths: Pt[][] = [];
    const rings: Pt[][] = [];
    const slice = (a: Float64Array, s: number, e: number) => {
      const out: Pt[] = [];
      for (let i = s; i < e; i++) out.push([a[2 * i], a[2 * i + 1]]);
      return out;
    };
    for (const o of selection) {
      if (o.kind === "node") pts.push([g.nodes[2 * o.index], g.nodes[2 * o.index + 1]]);
      else if (o.kind === "gage") pts.push([g.gages[2 * o.index], g.gages[2 * o.index + 1]]);
      else if (o.kind === "link") paths.push(slice(g.linkPts, g.linkStarts[o.index], g.linkStarts[o.index + 1]));
      else rings.push(slice(g.subPts, g.subStarts[o.index], g.subStarts[o.index + 1]));
    }
    return [
      new PathLayer<Pt[]>({
        ...common,
        id: "sel-subcatchments",
        data: rings,
        getPath: (r) => r,
        getColor: HIGHLIGHT,
        getWidth: 3,
        widthUnits: "pixels",
      }),
      new PathLayer<Pt[]>({
        ...common,
        id: "sel-links",
        data: paths,
        getPath: (p) => p,
        getColor: HIGHLIGHT,
        getWidth: Math.max(5, styles.link.size + 4),
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
      }),
      new ScatterplotLayer<Pt>({
        ...common,
        id: "sel-nodes",
        data: pts,
        getPosition: (p) => p,
        getRadius: Math.max(7, styles.node.size + 4),
        radiusUnits: "pixels",
        filled: false,
        stroked: true,
        getLineColor: HIGHLIGHT,
        getLineWidth: 3,
        lineWidthUnits: "pixels",
      }),
    ];
  }, [g, selection, coordSystem, styles.link.size, styles.node.size]);

  // The current profile: its links and nodes, and the start node being picked.
  const profileLayers = useMemo(() => {
    if (!g) return [];
    const common = { coordinateSystem: coordSystem, pickable: false };
    const nodePt = (i: number): Pt => [g.nodes[2 * i], g.nodes[2 * i + 1]];
    const paths: Pt[][] = [];
    const pts: Pt[] = [];
    if (profile) {
      for (const l of profile.links) {
        const path: Pt[] = [];
        for (let i = g.linkStarts[l.index]; i < g.linkStarts[l.index + 1]; i++) path.push([g.linkPts[2 * i], g.linkPts[2 * i + 1]]);
        paths.push(path);
      }
      for (const n of profile.nodes) pts.push(nodePt(n.index));
    }
    const start = profileStart !== null && profileStart < g.nodeTypes.length ? [nodePt(profileStart)] : [];
    if (paths.length === 0 && pts.length === 0 && start.length === 0) return [];
    return [
      new PathLayer<Pt[]>({
        ...common,
        id: "profile-links",
        data: paths,
        getPath: (p) => p,
        getColor: PROFILE,
        getWidth: Math.max(7, styles.link.size + 6),
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
      }),
      new ScatterplotLayer<Pt>({
        ...common,
        id: "profile-nodes",
        data: pts,
        getPosition: (p) => p,
        getRadius: Math.max(5, styles.node.size + 2),
        radiusUnits: "pixels",
        getFillColor: PROFILE,
      }),
      new ScatterplotLayer<Pt>({
        ...common,
        id: "profile-start",
        data: start,
        getPosition: (p) => p,
        getRadius: Math.max(9, styles.node.size + 6),
        radiusUnits: "pixels",
        filled: false,
        stroked: true,
        getLineColor: PROFILE,
        getLineWidth: 3,
        lineWidthUnits: "pixels",
      }),
    ];
  }, [g, profile, profileStart, coordSystem, styles.link.size, styles.node.size]);

  // Labels of the objects in view, when few enough.
  const labelLayer = useMemo(() => {
    const v = viewer.current;
    if (!labels || !g || !v || !ids.node) return null;
    const [x0, y0, x1, y1] = v.extent();
    const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const items: { p: Pt; t: string }[] = [];
    const push = (x: number, y: number, t: string | undefined) => {
      if (t !== undefined && Number.isFinite(x) && inView(x, y)) items.push({ p: [x, y], t });
    };
    const nNodes = g.nodeTypes.length;
    for (let i = 0; i < nNodes && items.length <= MAX_LABELS; i++) push(g.nodes[2 * i], g.nodes[2 * i + 1], ids.node[i]);
    if (ids.link && styles.link.visible) {
      for (let i = 0; i + 1 < g.linkStarts.length && items.length <= MAX_LABELS; i++) {
        const a = g.linkStarts[i];
        const b = g.linkStarts[i + 1];
        if (b - a < 2) continue;
        const m = a + Math.floor((b - a - 1) / 2);
        const x = (g.linkPts[2 * m] + g.linkPts[2 * m + 2]) / 2;
        const y = (g.linkPts[2 * m + 1] + g.linkPts[2 * m + 3]) / 2;
        push(x, y, ids.link[i]);
      }
    }
    if (items.length > MAX_LABELS) return null;
    return new TextLayer<{ p: Pt; t: string }>({
      id: "labels",
      coordinateSystem: coordSystem,
      data: items,
      getPosition: (d) => d.p,
      getText: (d) => d.t,
      getSize: 12,
      getColor: [20, 20, 20, 255],
      getPixelOffset: [0, -13],
      fontFamily: "Segoe UI, system-ui, sans-serif",
      background: true,
      getBackgroundColor: [255, 255, 255, 190],
      backgroundPadding: [3, 1],
      characterSet: "auto",
    });
    // viewTick: recompute when the view moves.
  }, [labels, g, ids, viewTick, coordSystem, styles.link.visible]);

  // Time from a period change to the map drawn with it (see `mapPerf`).
  const stepStart = useRef<{ period: number; t0: number } | null>(null);
  useEffect(() => {
    stepStart.current = { period, t0: performance.now() };
  }, [period]);

  useEffect(() => {
    viewer.current?.setLayers([...baseLayers, ...profileLayers, ...selectionLayers, ...(labelLayer ? [labelLayer] : []), ...tools.layers]);
    const s = stepStart.current;
    if (s) {
      requestAnimationFrame(() => {
        mapPerf.steps.push({ period: s.period, ms: performance.now() - s.t0 });
        if (mapPerf.steps.length > 500) mapPerf.steps.shift();
      });
    }
  }, [baseLayers, profileLayers, selectionLayers, labelLayer, tools.layers]);

  // ---- interaction ----------------------------------------------------------

  const applySelection = (hits: ObjRef[], add: boolean) => {
    const cur = getState().selection;
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


const HINTS: Partial<Record<string, string>> = {
  move: "Drag a node or gage; drag a selected object to move the selection.",
  vertex: "Select a link or subcatchment: drag a vertex, drag a midpoint to add one, Alt+click to delete one. Drag a link end onto a node to reconnect it.",
  "add-subcatchment": "Click the outline points; click the first point or press Enter to finish. Backspace removes the last point.",
  "add-gage": "Click to place a rain gage.",
};

/** One-line help for the active editing tool. */
function ToolHint({ tool, sketching }: { tool: string; sketching: boolean }) {
  let text = HINTS[tool];
  if (tool === "profile")
    text = sketching
      ? "Click the end node: the profile is drawn."
      : "Click the start node of a profile (Shift+click extends the current profile through another node).";
  if (!text && /^add-(junction|outfall|divider|storage)$/.test(tool)) text = `Click to add a ${tool.slice(4)}.`;
  if (!text && tool.startsWith("add-"))
    text = sketching
      ? "Click to add vertices, then click the end node. Backspace removes the last vertex, Escape cancels."
      : `Click the start node of the ${tool.slice(4)}.`;
  if (!text) return null;
  return <div className="map-hint">{text} Escape: back to selection.</div>;
}
