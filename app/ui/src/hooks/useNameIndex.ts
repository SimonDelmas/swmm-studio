// The names of the model's objects, to recognise them wherever the UI shows text.

import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { ObjKind, ObjRef } from "../types";

const KINDS: ObjKind[] = ["node", "link", "subcatchment", "gage"];

/** Objects by upper-case name (SWMM names are case-insensitive), in kind order. */
export type NameIndex = Map<string, ObjRef[]> & { names?: string[][] };

let cache: { key: string; index: NameIndex | null; loading: Promise<void> | null } = { key: "", index: null, loading: null };
const waiting = new Set<() => void>();

function load(key: string) {
  const samePath = (k: string) => k.slice(0, k.lastIndexOf("#")) === key.slice(0, key.lastIndexOf("#"));
  cache = { key, index: samePath(cache.key) ? cache.index : null, loading: null };
  cache.loading = Promise.all(KINDS.map((k) => api.ids(k).catch(() => [] as string[]))).then((lists) => {
    if (cache.key !== key) return;
    const index: NameIndex = new Map();
    lists.forEach((ids, ki) =>
      ids.forEach((id, i) => {
        const u = id.toUpperCase();
        const refs = index.get(u);
        const r = { kind: KINDS[ki], index: i };
        if (refs) refs.push(r);
        else index.set(u, [r]);
      }),
    );
    index.names = lists;
    cache.index = index;
    cache.loading = null;
    waiting.forEach((f) => f());
  });
}

/** Index of the model's object names, loaded on first use and reloaded when the model changes. */
export function useNameIndex(): NameIndex | null {
  const [, bump] = useState(0);
  const key = useStore((s) => (s.model ? `${s.model.path}#${s.model.revision}` : null));
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    waiting.add(f);
    return () => {
      waiting.delete(f);
    };
  }, []);
  useEffect(() => {
    if (key && (cache.key !== key || (!cache.index && !cache.loading))) load(key);
  }, [key]);
  // A stale index (the model was just edited) still serves until the new one is loaded.
  return key ? cache.index : null;
}

/** The object a name refers to, preferring kind `prefer` when several share it. */
export function resolveName(index: NameIndex | null, name: string, prefer?: ObjKind | null): ObjRef | null {
  const refs = index?.get(name.trim().toUpperCase());
  if (!refs) return null;
  return (prefer && refs.find((r) => r.kind === prefer)) || refs[0];
}

/** Name of an object, from the index. */
export function nameOf(index: NameIndex | null, o: ObjRef): string | null {
  return index?.names?.[KINDS.indexOf(o.kind)]?.[o.index] ?? null;
}
