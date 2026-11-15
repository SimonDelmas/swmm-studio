// The two map back-ends behind one interface: MapLibre with a deck.gl overlay when the
// model has a coordinate system (basemap), a plain orthographic deck.gl view otherwise.

import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { Deck, OrthographicView, type Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Basemap, Geometry, ObjRef } from "../types";

/** Circumference of the Earth at the equator, in Web Mercator metres. */
const EARTH = 40075016.686;

// MapLibre looks for its worker next to its own module, which is not where Vite serves or bundles it.
maplibregl.setWorkerUrl(maplibreWorker);

export type Pt = [number, number];
export type Extent = [number, number, number, number];

/** What the map needs from either back-end (MapLibre + overlay, or a plain Deck). */
export interface Viewer {
  setLayers(layers: Layer[]): void;
  unproject(p: Pt): Pt;
  /** Display coordinates → pixels in the map element. */
  project(p: Pt): Pt;
  /** Size of a screen pixel in spatial-index units (Web Mercator metres or model units). */
  unitsPerPixel(): number;
  /** Shows an extent with a margin around it (`exact`: without, to restore a saved view). */
  fit(b: Extent, exact?: boolean): void;
  /** Pans to a point (display coordinates), keeping the zoom. */
  center(p: Pt): void;
  /** Visible extent in display coordinates. */
  extent(): Extent;
  /** Double-click zoom gets in the way while drawing. */
  setDoubleClickZoom(on: boolean): void;
  /** Applies the basemap settings (nothing to do without a basemap). */
  setBasemap(bm: Basemap): void;
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

/** Display-coordinate bounds of a set of objects. */
export function selectionBounds(g: Geometry, sel: ObjRef[]): Extent | null {
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

export function createMapViewer(container: HTMLDivElement, bm: Basemap, onView: () => void): Viewer {
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
    // The arrow keys step the timeline.
    keyboard: false,
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
  // Read by the UI tests.
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
    fit: (b, exact = false) =>
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: exact ? 0 : 40, duration: 0, maxZoom: exact ? 24 : 19 },
      ),
    center: (p) => map.easeTo({ center: p, duration: 300 }),
    extent: () => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
    setDoubleClickZoom: (on) => {
      if (on) map.doubleClickZoom.enable();
      else map.doubleClickZoom.disable();
    },
    setBasemap: (next) => {
      const apply = () => {
        if (!map.getLayer("basemap")) return;
        map.setLayoutProperty("basemap", "visibility", next.visible ? "visible" : "none");
        map.setPaintProperty("basemap", "raster-opacity", next.opacity);
        const source = map.getSource("basemap") as maplibregl.RasterTileSource | undefined;
        if (source && source.tiles?.[0] !== next.url) source.setTiles([next.url]);
      };
      if (map.isStyleLoaded()) apply();
      else map.once("load", apply);
    },
    destroy: () => {
      ro.disconnect();
      map.remove();
      delete (container as unknown as { __map?: maplibregl.Map }).__map;
    },
  };
}

export function createDeckViewer(container: HTMLDivElement, onView: () => void): Viewer {
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
    fit: (b, exact = false) => {
      const margin = exact ? 0 : 80;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      const sx = Math.max(b[2] - b[0], 1e-6);
      const sy = Math.max(b[3] - b[1], 1e-6);
      const zoom = Math.log2(Math.min((w - margin) / sx, (h - margin) / sy));
      viewState = { ...viewState, target: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], zoom };
      deck.setProps({ initialViewState: { ...viewState } });
      onView();
    },
    center: (p) => {
      viewState = { ...viewState, target: [p[0], p[1], 0] };
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
    setBasemap: () => {},
    destroy: () => deck.finalize(),
  };
}
