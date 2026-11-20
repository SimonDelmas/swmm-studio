// The measure tool: click points on the map to read the distance along them and, from three
// points, the area they enclose. A double-click or Enter ends the measure; the next click
// starts another one.

import { useEffect, useMemo, useRef, useState } from "react";
import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { Geometry, Pt } from "../types";
import type { Tool } from "../uiTypes";
import { formatArea, formatLength, pathLength, ringArea } from "./measure";
import type { EditTools } from "./useEditTools";
import type { Viewer } from "./viewers";

type Rgba = [number, number, number, number];
const LINE: Rgba = [230, 90, 0, 240];
const FILL: Rgba = [230, 90, 0, 40];
/** A second click within this time (ms) and distance (px) of the first is a double-click. */
const DOUBLE_MS = 350;
const DOUBLE_PX = 6;

/** Layers of a measure: the area, the path (to the pointer while measuring) and its points. */
function measureLayers(pts: Pt[], hover: Pt | null, lonlat: boolean): Layer[] {
  if (pts.length === 0) return [];
  const path = hover ? [...pts, hover] : pts;
  const common = { coordinateSystem: lonlat ? COORDINATE_SYSTEM.LNGLAT : COORDINATE_SYSTEM.CARTESIAN, pickable: false };
  return [
    new SolidPolygonLayer<Pt[]>({ ...common, id: "measure-area", data: path.length >= 3 ? [path] : [], getPolygon: (r) => r, getFillColor: FILL }),
    new PathLayer<Pt[]>({ ...common, id: "measure-path", data: [path], getPath: (p) => p, getColor: LINE, getWidth: 2, widthUnits: "pixels" }),
    new ScatterplotLayer<Pt>({
      ...common,
      id: "measure-points",
      data: pts,
      getPosition: (p) => p,
      getRadius: 4,
      radiusUnits: "pixels",
      getFillColor: [255, 255, 255, 255],
      stroked: true,
      getLineColor: LINE,
      getLineWidth: 2,
      lineWidthUnits: "pixels",
    }),
  ];
}

export function useMeasureTool(viewer: React.RefObject<Viewer | null>, g: Geometry | null, tool: Tool): EditTools & { panel: React.ReactNode } {
  const [pts, setPts] = useState<Pt[]>([]);
  const [done, setDone] = useState(false);
  const [hover, setHover] = useState<Pt | null>(null);
  const lastClick = useRef<{ t: number; p: Pt } | null>(null);
  const active = tool === "measure";
  const lonlat = g?.space === "lonlat";

  // Another tool or another model ends the measure.
  useEffect(() => {
    setPts([]);
    setDone(false);
    setHover(null);
  }, [tool, g?.space]);

  const onClick = (rel: Pt): boolean => {
    const v = viewer.current;
    if (!active || !v) return false;
    const now = performance.now();
    const prev = lastClick.current;
    lastClick.current = { t: now, p: rel };
    // The second click of a double-click ends the measure (the first one added the last point).
    if (!done && prev && now - prev.t < DOUBLE_MS && Math.hypot(rel[0] - prev.p[0], rel[1] - prev.p[1]) < DOUBLE_PX) {
      lastClick.current = null;
      setDone(true);
      return true;
    }
    const p = v.unproject(rel);
    if (done) {
      setPts([p]);
      setDone(false);
    } else setPts([...pts, p]);
    return true;
  };

  const onMove = (rel: Pt) => {
    if (active && pts.length > 0 && viewer.current) setHover(viewer.current.unproject(rel));
  };

  const cancel = () => {
    if (pts.length === 0) return false;
    setPts([]);
    setDone(false);
    return true;
  };
  const finish = () => {
    if (pts.length > 0) setDone(true);
  };
  /** Removes the last point (a finished measure stays finished). */
  const back = () => {
    if (pts.length === 0) return false;
    setPts(pts.slice(0, -1));
    return true;
  };

  const shownHover = done ? null : hover;
  const layers = useMemo(() => (active ? measureLayers(pts, shownHover, lonlat) : []), [active, pts, shownHover, lonlat]);

  let panel: React.ReactNode = null;
  if (active && pts.length > 0) {
    const all = shownHover ? [...pts, shownHover] : pts;
    const length = pathLength(all, lonlat);
    panel = (
      <div className="map-measure">
        <div>
          Distance <b>{formatLength(length, lonlat)}</b>
        </div>
        {all.length >= 3 && (
          <div>
            Area <b>{formatArea(ringArea(all, lonlat), lonlat)}</b> (perimeter {formatLength(length + pathLength([all[all.length - 1], all[0]], lonlat), lonlat)})
          </div>
        )}
      </div>
    );
  }

  return {
    layers,
    onDownCapture: () => false,
    onClick,
    onMove,
    cancel,
    finish,
    back,
    busy: active && pts.length > 0,
    panel,
  };
}
