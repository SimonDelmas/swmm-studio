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
  // The names must be those of the model as it is when they arrive: after an edit they
  // are asked again, and those of another model are dropped.
  let lists: string[][] = [];
  for (let attempt = 0; ; attempt++) {
    const before = getState().model;
    lists = await Promise.all(missing.map((k) => api.ids(k)));
    const now = getState().model;
    if (now?.path !== before?.path) return;
    if (now?.revision === before?.revision) break;
    if (attempt === 3) return;
  }
  const ids = { ...getState().ids };
  missing.forEach((k, i) => (ids[k] = lists[i]));
  setState({ ids });
}
