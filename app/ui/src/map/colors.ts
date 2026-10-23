// Per-object colours and sizes from a style.

import { classOf, rampColors, type RGB } from "../classify";
import type { LayerStyle, StyledKind } from "../store";

export const NODE_TYPE_COLORS: RGB[] = [
  [40, 90, 160], // junction
  [30, 150, 70], // outfall
  [230, 140, 20], // divider
  [140, 60, 170], // storage
];
export const NODE_TYPE_NAMES = ["Junction", "Outfall", "Divider", "Storage"];
export const LINK_TYPE_COLORS: RGB[] = [
  [70, 110, 160], // conduit
  [220, 40, 40], // pump
  [230, 140, 20], // orifice
  [150, 60, 180], // weir
  [20, 160, 160], // outlet
];
export const LINK_TYPE_NAMES = ["Conduit", "Pump", "Orifice", "Weir", "Outlet"];
export const SUB_COLOR: RGB = [120, 170, 110];
export const NO_DATA: RGB = [150, 150, 150];

export interface Styled {
  /** RGBA per object. */
  colors: Uint8Array;
  /** Size (px) per object. */
  sizes: Float32Array;
}

/** Colours and sizes of every object of a kind. `values` is null when coloured by type. */
export function styleObjects(
  kind: StyledKind,
  style: LayerStyle,
  count: number,
  types: Uint8Array | null,
  values: Float32Array | null,
): Styled {
  const colors = new Uint8Array(4 * count);
  const sizes = new Float32Array(count);
  const alpha = kind === "subcatchment" ? 150 : 255;
  const byValue = style.source !== "type" && values !== null;
  const palette = rampColors(style.ramp, style.breaks.length + 1);
  const nClasses = style.breaks.length + 1;
  for (let i = 0; i < count; i++) {
    let c: RGB;
    let size = style.size;
    if (byValue) {
      const k = classOf(values![i], style.breaks);
      c = k < 0 ? NO_DATA : palette[k];
      if (style.sizeByClass && k >= 0) size = style.size * (1 + (1.5 * k) / Math.max(1, nClasses - 1));
    } else if (kind === "node") {
      const t = types ? types[i] : 0;
      c = NODE_TYPE_COLORS[t] ?? NO_DATA;
      if (t === 3) size = style.size * 1.6;
    } else if (kind === "link") {
      c = LINK_TYPE_COLORS[types ? types[i] : 0] ?? NO_DATA;
    } else {
      c = SUB_COLOR;
    }
    colors[4 * i] = c[0];
    colors[4 * i + 1] = c[1];
    colors[4 * i + 2] = c[2];
    colors[4 * i + 3] = alpha;
    sizes[i] = size;
  }
  return { colors, sizes };
}
