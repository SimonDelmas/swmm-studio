// Object names by kind, loaded on demand and kept in the store (`state.ids`).

import { api } from "../api";
import { getState, setState } from "../store";
import type { ElementKind, ObjKind } from "../types";

/** Loads the names of the kinds that are not in the store yet (`system` has none). */
export async function ensureIds(kinds: readonly (ObjKind | ElementKind)[]): Promise<void> {
  const missing = Array.from(new Set(kinds)).filter((k): k is ObjKind => k !== "system" && !getState().ids[k]);
  if (missing.length === 0) return;
  const lists = await Promise.all(missing.map((k) => api.ids(k)));
  const ids = { ...getState().ids };
  missing.forEach((k, i) => (ids[k] = lists[i]));
  setState({ ids });
}
