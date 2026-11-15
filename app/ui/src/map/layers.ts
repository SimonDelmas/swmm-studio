// deck.gl layers of the map, built from the geometry buffers. Pure functions: the
// component decides when to rebuild them.

import type { CoordinateSystem, Layer } from "@deck.gl/core";
import { IconLayer, LineLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { StyledKind } from "../store";
import type { Geometry } from "../types";
import type { styleObjects } from "./colors";
import { ICON_SCALE, LINK_TYPE_SHAPES, NODE_TYPE_SHAPES, SHAPE_SCALE, shapeAtlas, type Shape } from "./shapes";
import type { OutletSegments } from "./outlets";

type Rgba = [number, number, number, number];
/** Lines from subcatchments to their outlets. */
const OUTLET_LINK: Rgba = [50, 50, 50, 190];

/** Colours and sizes of the objects of a layer (see `styleObjects`). */
type Styled = ReturnType<typeof styleObjects>;

/**
 * Symbols tinted per object over a white halo. Sizes are icon heights in pixels (0: not drawn,
 * as for hidden types, whose colour is also transparent); angles in degrees, counter-clockwise.
 */
function shapeLayers(
  id: string,
  common: object,
  length: number,
  position: { value: Float64Array; size: number },
  angle: { value: Float32Array; size: number } | null,
  shapeOf: (i: number) => Shape,
  colors: Uint8Array,
  sizes: Float32Array,
): Layer[] {
  const { canvas, mapping } = shapeAtlas();
  const haloColors = new Uint8Array(4 * length);
  const haloSizes = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const shown = sizes[i] > 0 && colors[4 * i + 3] > 0;
    haloColors.set([255, 255, 255, shown ? 220 : 0], 4 * i);
    haloSizes[i] = shown ? sizes[i] + 2.5 : 0;
  }
  const layer = (suffix: string, c: Uint8Array, s: Float32Array) =>
    new IconLayer({
      ...common,
      id: id + suffix,
      data: {
        length,
        attributes: {
          getPosition: position,
          getColor: { value: c, size: 4, normalized: true },
          getSize: { value: s, size: 1 },
          ...(angle && { getAngle: angle }),
        },
      },
      iconAtlas: canvas,
      iconMapping: mapping,
      getIcon: (_: unknown, { index }: { index: number }) => shapeOf(index),
      sizeUnits: "pixels",
    } as never);
  return [layer("-halo", haloColors, haloSizes), layer("", colors, sizes)];
}

/**
 * Static geometry. Links are drawn as one instance per segment so that colours and
 * widths are plain per-instance arrays: deck.gl uploads them directly, without running
 * accessors or re-tessellating paths (a time step only replaces the colour arrays).
 */
export function staticGeometry(g: Geometry) {
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
  // Symbols of the links that have one, on the middle segment, pointing downstream.
  const sym: number[] = [];
  const symPos: number[] = [];
  const symAngle: number[] = [];
  for (let i = 0; i < nLinks; i++) {
    const a = g.linkStarts[i];
    const b = g.linkStarts[i + 1];
    if (b - a < 2 || !LINK_TYPE_SHAPES[g.linkTypes[i]]) continue;
    const m = a + Math.floor((b - a - 1) / 2);
    const [x0, y0, x1, y1] = [g.linkPts[2 * m], g.linkPts[2 * m + 1], g.linkPts[2 * m + 2], g.linkPts[2 * m + 3]];
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    // Longitude / latitude: the angle on the (Mercator) screen.
    const sx = g.space === "lonlat" ? Math.cos((((y0 + y1) / 2) * Math.PI) / 180) : 1;
    sym.push(i);
    symPos.push((x0 + x1) / 2, (y0 + y1) / 2);
    symAngle.push((Math.atan2(y1 - y0, (x1 - x0) * sx) * 180) / Math.PI);
  }
  return {
    nSeg,
    segLink,
    symLink: Uint32Array.from(sym),
    symPos: { value: Float64Array.from(symPos), size: 2 },
    symAngle: { value: Float32Array.from(symAngle), size: 1 },
    src: { value: src, size: 2 },
    tgt: { value: tgt, size: 2 },
    nodePos: { value: g.nodes, size: 2 },
    gagePos: { value: g.gages, size: 2 },
    subs: { length: g.subStarts.length - 1, startIndices: g.subStarts, attributes: { getPolygon: { value: g.subPts, size: 2 } } },
    outlines: { length: g.subStarts.length - 1, startIndices: g.subStarts, attributes: { getPath: { value: g.subPts, size: 2 } } },
  };
}
export type StaticGeometry = ReturnType<typeof staticGeometry>;

/** Subcatchments, outlet lines, links with their symbols, nodes and rain gages. */
export function baseLayers(
  g: Geometry,
  geo: StaticGeometry,
  outlets: OutletSegments | null,
  nodeStyled: Styled,
  linkStyled: Styled,
  subStyled: Styled,
  visible: Record<StyledKind, boolean>,
  coordSystem: CoordinateSystem,
): Layer[] {
  const common = { coordinateSystem: coordSystem, pickable: false };
  const layers: Layer[] = [];
  if (visible.subcatchment && geo.subs.length > 0 && g.subPts.length > 0) {
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
  if (visible.subcatchment && outlets && outlets.length > 0) {
    layers.push(
      new LineLayer({
        ...common,
        id: "outlet-links",
        data: {
          length: outlets.length,
          attributes: { getSourcePosition: { value: outlets.src, size: 2 }, getTargetPosition: { value: outlets.tgt, size: 2 } },
        },
        getColor: OUTLET_LINK,
        getWidth: 1.5,
        widthUnits: "pixels",
      } as never),
      new ScatterplotLayer({
        ...common,
        id: "outlet-links-start",
        data: { length: outlets.length, attributes: { getPosition: { value: outlets.src, size: 2 } } },
        getFillColor: OUTLET_LINK,
        getRadius: 2.5,
        radiusUnits: "pixels",
      } as never),
    );
  }
  if (visible.link && geo.nSeg > 0) {
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
  if (visible.link && geo.symLink.length > 0) {
    const n = geo.symLink.length;
    const colors = new Uint8Array(4 * n);
    const sizes = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const i = geo.symLink[k];
      colors.set(linkStyled.colors.subarray(4 * i, 4 * i + 4), 4 * k);
      sizes[k] = colors[4 * k + 3] ? 3 * linkStyled.sizes[i] + 8 : 0;
    }
    const types = g.linkTypes;
    layers.push(
      ...shapeLayers("link-symbols", common, n, geo.symPos, geo.symAngle, (k) => LINK_TYPE_SHAPES[types[geo.symLink[k]]]!, colors, sizes),
    );
  }
  if (visible.node && g.nodeTypes.length > 0) {
    const types = g.nodeTypes;
    const shapeOf = (i: number) => NODE_TYPE_SHAPES[types[i]] ?? "circle";
    const sizes = nodeStyled.sizes.map((s, i) => s * ICON_SCALE * (SHAPE_SCALE[shapeOf(i)] ?? 1));
    layers.push(...shapeLayers("nodes", common, types.length, geo.nodePos, null, shapeOf, nodeStyled.colors, sizes));
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
}
