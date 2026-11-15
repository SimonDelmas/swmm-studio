// Clickable object names: wherever the UI shows the name of a network object, clicking it
// selects the object (and zooms the map to it).

import type { ReactNode } from "react";
import { selectObject } from "../actions/selection";
import { nameOf, resolveName, useNameIndex, type NameIndex } from "../hooks/useNameIndex";
import type { ObjKind, ObjRef } from "../types";
import { LinkButton } from "./LinkButton";

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
