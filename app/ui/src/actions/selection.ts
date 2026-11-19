// Selecting objects and showing them on the map.

import { api } from "../api";
import { getState, setState } from "../store";
import type { ObjKind, ObjRef } from "../types";

/** Selects one object; by default the map zooms to it. */
export function selectObject(o: ObjRef, zoom = true) {
  selectObjects([o], zoom);
}

/** Selects objects and, with `zoom`, shows them on the map. */
export function selectObjects(selection: ObjRef[], zoom = true) {
  setState(zoom ? { selection, fitSelection: getState().fitSelection + 1 } : { selection });
}

/** Zooms the map to the selected objects. */
export function zoomToSelection() {
  setState({ fitSelection: getState().fitSelection + 1 });
}

/** How the objects found by a query make the new selection. */
export type QueryMode = "replace" | "add" | "intersect" | "remove";

/**
 * The selection `current` combined with the objects of `kind` found by a query: replaced
 * by them, with them added, kept only where found (intersect), or without them (remove).
 */
export function combineSelection(current: ObjRef[], kind: ObjKind, found: ArrayLike<number>, mode: QueryMode): ObjRef[] {
  const hits = Array.from(found, (index) => ({ kind, index }));
  if (mode === "replace") return hits;
  const set = new Set(hits.map((o) => o.index));
  const inFound = (o: ObjRef) => o.kind === kind && set.has(o.index);
  if (mode === "intersect") return current.filter(inFound);
  if (mode === "remove") return current.filter((o) => !inFound(o));
  const have = new Set(current.filter((o) => o.kind === kind).map((o) => o.index));
  return current.concat(hits.filter((o) => !have.has(o.index)));
}

/**
 * Selects the objects of a layer matching an attribute query (`diameter < 0.3`), combined
 * with the current selection; result variables are read at the current time step. Returns
 * the number of objects the query found and the size of the new selection.
 */
export async function selectByQuery(kind: ObjKind, query: string, mode: QueryMode): Promise<{ found: number; selected: number }> {
  const s = getState();
  const found = await api.selectQuery(kind, query, s.model?.results ? s.period : null);
  const selection = combineSelection(getState().selection, kind, found, mode);
  selectObjects(selection, selection.length > 0);
  return { found: found.length, selected: selection.length };
}
