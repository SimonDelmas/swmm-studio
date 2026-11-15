// Object names by kind, loaded on demand and kept in the store (`state.ids`).

import { api } from "../api";
import { getState, setState } from "../store";
import type { ElementKind, ObjKind } from "../types";

/** Index of an object name in a list of names, whatever its case (-1: not there). */
export function indexOfId(list: string[] | undefined, id: string): number {
  const up = id.toUpperCase();
  return list ? list.findIndex((x) => x.toUpperCase() === up) : -1;
}

/** Loads in progress, by model and kinds: many components ask for the same names at once. */
const loading = new Map<string, Promise<void>>();

/** Loads the names of the kinds that are not in the store yet (`system` has none). */
export function ensureIds(kinds: readonly (ObjKind | ElementKind)[]): Promise<void> {
  const missing = Array.from(new Set(kinds))
    .filter((k): k is ObjKind => k !== "system" && !getState().ids[k])
    .sort();
  if (missing.length === 0) return Promise.resolve();
  const key = `${getState().model?.path}|${missing.join(",")}`;
  let load = loading.get(key);
  if (!load) {
    load = loadIds(missing).finally(() => loading.delete(key));
    loading.set(key, load);
  }
  return load;
}

async function loadIds(missing: ObjKind[]): Promise<void> {
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
