// Symbols of the node and link types, drawn on the map (icon atlas) and in the legend (SVG).
// Paths are in a 64 × 64 cell centred on (32, 32); link symbols point along +x (downstream).

export type Shape = "circle" | "triangle" | "diamond" | "square" | "arrow" | "bar" | "bowtie" | "chevron";

export const SHAPE_PATHS: Record<Shape, string> = {
  circle: "M4 32 A28 28 0 1 0 60 32 A28 28 0 1 0 4 32 Z",
  triangle: "M32 3 L61 56 H3 Z",
  diamond: "M32 1 L63 32 L32 63 L1 32 Z",
  square: "M9 9 H55 V55 H9 Z",
  arrow: "M8 6 L60 32 L8 58 Z",
  bar: "M23 2 H41 V62 H23 Z",
  bowtie: "M4 6 L32 32 L4 58 Z M60 6 L32 32 L60 58 Z",
  chevron: "M8 4 L36 32 L8 60 H24 L52 32 L24 4 Z",
};

/** Junction, outfall, divider, storage. */
export const NODE_TYPE_SHAPES: Shape[] = ["circle", "triangle", "diamond", "square"];
/** Conduit (a plain line), pump, orifice, weir, outlet. */
export const LINK_TYPE_SHAPES: (Shape | null)[] = [null, "arrow", "bar", "bowtie", "chevron"];

/** Radius of the circle in the cell: a node of size s (px) is drawn as an icon of s × ICON_SCALE px. */
export const ICON_SCALE = 64 / 28;
/** Pointed shapes look smaller than a circle of the same size. */
export const SHAPE_SCALE: Partial<Record<Shape, number>> = { triangle: 1.3, diamond: 1.25 };

let atlas: { canvas: HTMLCanvasElement; mapping: Record<string, object> } | null = null;

/** All the shapes, white on transparent, for a masked deck.gl IconLayer (tinted per object). */
export function shapeAtlas() {
  if (atlas) return atlas;
  const names = Object.keys(SHAPE_PATHS) as Shape[];
  const canvas = document.createElement("canvas");
  canvas.width = 64 * names.length;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  const mapping: Record<string, object> = {};
  names.forEach((n, i) => {
    ctx.save();
    ctx.translate(64 * i, 0);
    ctx.fill(new Path2D(SHAPE_PATHS[n]));
    ctx.restore();
    mapping[n] = { x: 64 * i, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true };
  });
  atlas = { canvas, mapping };
  return atlas;
}
