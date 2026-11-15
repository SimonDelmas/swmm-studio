// Object names by kind, loaded on demand and kept in the store (`state.ids`).

import { api } from "../api";
import { getState, setState } from "../store";
import type { ElementKind, ObjKind } from "../types";

/** Index of an object name in a list of names, whatever its case (-1: not there). */
export function indexOfId(list: string[] | undefined, id: string): number {
  const up = id.toUpperCase();
  return list ? list.findIndex((x) => x.toUpperCase() === up) : -1;
}

/** Loads the names of the kinds that are not in the store yet (`system` has none). */
export async function ensureIds(kinds: readonly (ObjKind | ElementKind)[]): Promise<void> {
  const missing = Array.from(new Set(kinds)).filter((k): k is ObjKind => k !== "system" && !getState().ids[k]);
  if (missing.length === 0) return;
  const before = getState().model;
  const lists = await Promise.all(missing.map((k) => api.ids(k)));
  // Names of another model, or of the objects as they were before an edit, are dropped.
  const now = getState().model;
  if (now?.path !== before?.path || now?.revision !== before?.revision) return;
  const ids = { ...getState().ids };
  missing.forEach((k, i) => (ids[k] = lists[i]));
  setState({ ids });
}
