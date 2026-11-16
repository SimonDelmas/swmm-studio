// The names of the model's objects, to recognise them wherever the UI shows text.

import { useEffect } from "react";
import { ensureIds } from "../actions/ids";
import { useStore, type State } from "../store";
import type { ObjKind, ObjRef } from "../types";

const KINDS: ObjKind[] = ["node", "link", "subcatchment", "gage"];

/** Objects by upper-case name (SWMM names are case-insensitive), in kind order. */
export type NameIndex = Map<string, ObjRef[]> & { names: string[][] };

function build(names: string[][]): NameIndex {
  const index = Object.assign(new Map<string, ObjRef[]>(), { names });
  names.forEach((ids, ki) =>
    ids.forEach((id, i) => {
      const u = id.toUpperCase();
      const refs = index.get(u);
      const r = { kind: KINDS[ki], index: i };
      if (refs) refs.push(r);
      else index.set(u, [r]);
    }),
  );
  return index;
}

/** The index of the names last seen in the store: built once for all the components that read it. */
// No index until every kind is known: names of an earlier state of the model would link to
// the wrong objects once indices have changed.
let built: { ids: State["ids"]; index: NameIndex | null } = { ids: {}, index: null };

function indexOf(ids: State["ids"]): NameIndex | null {
  if (built.ids !== ids) {
    const names = KINDS.map((k) => ids[k]);
    built = { ids, index: names.every((n) => n !== undefined) ? build(names as string[][]) : null };
  }
  return built.index;
}

/**
 * Index of the model's object names. The names are those of the store (`state.ids`),
 * loaded on first use and kept in step with the edits there.
 */
export function useNameIndex(): NameIndex | null {
  const ids = useStore((s) => s.ids);
  const model = useStore((s) => s.model?.path ?? null);
  const revision = useStore((s) => s.model?.revision ?? 0);
  useEffect(() => {
    // Without the names the text is shown as it is, without links; a load that failed
    // is tried again after the next edit.
    if (model) ensureIds(KINDS).catch(() => {});
  }, [model, ids, revision]);
  return model ? indexOf(ids) : null;
}

/** The object a name refers to, preferring kind `prefer` when several share it. */
export function resolveName(index: NameIndex | null, name: string, prefer?: ObjKind | null): ObjRef | null {
  const refs = index?.get(name.trim().toUpperCase());
  if (!refs) return null;
  return (prefer && refs.find((r) => r.kind === prefer)) || refs[0];
}

/** Name of an object, from the index. */
export function nameOf(index: NameIndex | null, o: ObjRef): string | null {
  return index?.names[KINDS.indexOf(o.kind)]?.[o.index] ?? null;
}
