// Which objects the map draws.

import type { Geometry, ObjRef } from "../types";
import type { LayerStyle, StyledKind } from "../uiTypes";

/** Whether the map draws an object: its layer is shown and, for nodes and links, its type too. */
export function isShown(h: ObjRef, styles: Record<StyledKind, LayerStyle>, g: Geometry | null): boolean {
  if (h.kind === "subcatchment") return styles.subcatchment.visible;
  if (h.kind !== "node" && h.kind !== "link") return true;
  const style = styles[h.kind];
  if (!style.visible) return false;
  const t = h.kind === "node" ? g?.nodeTypes[h.index] : g?.linkTypes[h.index];
  return t === undefined || !style.hiddenTypes.includes(t);
}
