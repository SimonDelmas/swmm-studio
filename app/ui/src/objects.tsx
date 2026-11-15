// Clickable object names: wherever the UI shows the name of a network object, clicking it
// selects the object (and zooms the map to it).

import { LinkButton } from "./components/LinkButton";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { getState, setState, useStore } from "./store";
import type { ObjKind, ObjRef } from "./types";

const KINDS: ObjKind[] = ["node", "link", "subcatchment", "gage"];

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

/** A link selecting `obj`. */
export function ObjLink({ obj, children, zoom = true, title }: { obj: ObjRef; children: ReactNode; zoom?: boolean; title?: string }) {
  return (
    <LinkButton
      className="obj-link"
      title={title ?? "Select"}
      onClick={(e) => {
        e.stopPropagation();
        selectObject(obj, zoom);
      }}
    >
      {children}
    </LinkButton>
  );
}

/** A name, clickable when it is the name of an object of the model. */
export function NameLink({ name, kind, zoom }: { name: string; kind?: ObjKind | null; zoom?: boolean }) {
  const index = useNameIndex();
  const o = resolveName(index, name, kind);
  return o ? (
    <ObjLink obj={o} zoom={zoom}>
      {name}
    </ObjLink>
  ) : (
    <>{name}</>
  );
}

/** Words that announce an object name in messages ("Node J1", "conduit C3", …). */
const KIND_WORDS: Record<string, ObjKind> = {
  node: "node",
  nodes: "node",
  junction: "node",
  outfall: "node",
  divider: "node",
  storage: "node",
  unit: "node",
  link: "link",
  links: "link",
  conduit: "link",
  pump: "link",
  orifice: "link",
  weir: "link",
  outlet: "link",
  regulator: "link",
  subcatchment: "subcatchment",
  subcatchments: "subcatchment",
  gage: "gage",
  raingage: "gage",
};

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i;
const SEPARATORS = /(\s+|[,;()[\]{}'"`<>=]+)/;

function find(index: NameIndex, word: string): { name: string; tail: string } | null {
  if (index.has(word.toUpperCase())) return { name: word, tail: "" };
  const m = /^(.*?)([.:]+)$/.exec(word);
  if (m && m[1] && index.has(m[1].toUpperCase())) return { name: m[1], tail: m[2] };
  return null;
}

/**
 * Splits `text` into plain text and links for the object names it mentions. A name made
 * of digits only is linked only after a word naming its kind ("node 12"), or when it is
 * `hint`'s name, so that plain numbers stay text.
 */
export function linkify(text: string, index: NameIndex | null, hint?: ObjRef | null, hintName?: string | null): ReactNode[] {
  if (!index || !text) return [text];
  const parts = text.split(SEPARATORS);
  const out: ReactNode[] = [];
  let plain = "";
  let prevWord = "";
  parts.forEach((p, i) => {
    const sep = i % 2 === 1;
    const hit = !sep && p ? find(index, p) : null;
    if (hit) {
      const kind = KIND_WORDS[prevWord.toLowerCase().replace(/[:.]$/, "")];
      const isHint = !!hint && !!hintName && hit.name.toUpperCase() === hintName.toUpperCase();
      if (!NUMBER.test(hit.name) || kind || isHint) {
        const o = isHint ? hint! : resolveName(index, hit.name, kind);
        if (o) {
          if (plain) out.push(plain);
          out.push(
            <ObjLink key={i} obj={o}>
              {hit.name}
            </ObjLink>,
          );
          plain = hit.tail;
          prevWord = p;
          return;
        }
      }
    }
    plain += p;
    if (!sep && p) prevWord = p;
  });
  if (plain) out.push(plain);
  return out;
}

/** Name of an object, from the index. */
export function nameOf(index: NameIndex | null, o: ObjRef): string | null {
  return index?.names?.[KINDS.indexOf(o.kind)]?.[o.index] ?? null;
}

/**
 * Text whose object names are clickable. `hint` is the object it is about, when known: with
 * `whole`, the whole text links to it when it does not name it.
 */
export function Linkified({ text, hint, whole }: { text: string; hint?: ObjRef | null; whole?: boolean }) {
  const index = useNameIndex();
  const parts = linkify(text, index, hint, hint ? nameOf(index, hint) : null);
  if (whole && hint && parts.every((p) => typeof p === "string")) return <ObjLink obj={hint}>{text}</ObjLink>;
  return <>{parts}</>;
}
