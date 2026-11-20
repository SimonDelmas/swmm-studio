// Tooltip of the object under the pointer: its ID, its type and its values at the current
// time (the one its layer is coloured by, and the result variable of interest).

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { focusVar, formatNumber } from "../format";
import { getState, useStore } from "../store";
import type { ObjRef, Pt } from "../types";
import { STATS, type LayerStyle, type StyledKind } from "../uiTypes";
import { isShown } from "./shown";
import type { Viewer } from "./viewers";

/** Time the pointer rests before the tooltip is looked up (ms). */
const DELAY = 150;

/** Values the map is coloured with, by layer. */
export type LayerValues = Record<StyledKind, Float32Array | null>;

interface Tip {
  p: Pt;
  title: string;
  lines: string[];
}

/** What a layer is coloured by, when it is a value (null: by type). */
function styleLabel(kind: StyledKind, s: LayerStyle): string | null {
  if (s.source === "type" || !s.field) return null;
  if (s.source === "attribute") return s.field.replace(/_/g, " ");
  const v = getState().model?.results?.variables[kind]?.[Number(s.field)];
  if (!v) return null;
  if (s.source === "result") return null; // Shown with the results at the current time.
  const stat = s.stat === "value" ? "" : `${STATS.find(([n]) => n === s.stat)?.[1] ?? s.stat} of `;
  return s.source === "compare" ? `${stat}${v.name} (A − B)` : `${stat}${v.name}`;
}

/**
 * The tooltip follows the pointer: `move` with the pointer position in the map element
 * (null: hide it, e.g. while a button is pressed or the pointer left the map).
 */
export function useTooltip(viewer: React.RefObject<Viewer | null>, values: LayerValues) {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef(0);
  // Each lookup is numbered: an answer that comes after the pointer moved is dropped.
  const seq = useRef(0);
  const period = useStore((s) => s.period);
  const last = useRef<Pt | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const lookup = (p: Pt) => {
    const v = viewer.current;
    if (!v) return;
    const n = ++seq.current;
    const [x, y] = v.unproject(p);
    const { styles, geometry } = getState();
    api
      .pickAll(x, y, 6 * v.unitsPerPixel())
      .then((all) => all.find((h) => isShown(h, styles, geometry)) ?? null)
      .then(async (hit: ObjRef | null) => {
        if (n !== seq.current) return;
        if (!hit) return setTip(null);
        const st = getState();
        const info = await api.objectInfo(hit, st.model?.results ? st.period : null);
        if (n !== seq.current) return;
        const lines: string[] = [];
        if (hit.kind !== "gage") {
          const label = styleLabel(hit.kind, st.styles[hit.kind]);
          const value = valuesRef.current[hit.kind]?.[hit.index];
          if (label && value !== undefined && Number.isFinite(value)) lines.push(`${label}: ${formatNumber(value)}`);
          const focus = focusVar(st, hit);
          const r = focus && info.results?.[focus.var];
          if (r) lines.push(`${r.name}: ${formatNumber(r.value)}${r.unit ? ` ${r.unit}` : ""}`);
        }
        setTip({ p, title: `${info.id} · ${info.type}`, lines });
      })
      .catch(() => n === seq.current && setTip(null));
  };

  const move = (p: Pt | null) => {
    clearTimeout(timer.current);
    seq.current++;
    last.current = p;
    setTip(null);
    if (p) timer.current = window.setTimeout(() => lookup(p), DELAY);
  };

  // A new time step: the values of the tooltip shown are read again.
  useEffect(() => {
    if (last.current && tip) lookup(last.current);
  }, [period]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const node = tip && (
    <div className="map-tooltip" style={{ left: tip.p[0] + 14, top: tip.p[1] + 14 }}>
      <b>{tip.title}</b>
      {tip.lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
  return { move, node };
}
