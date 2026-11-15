// Map styles: the values a layer is coloured by and its class limits.

import { api, errorText } from "../api";
import { computeBreaks } from "../classify";
import { bucketRange, periodAt, periodMs } from "../format";
import type { ResultsInfo } from "../types";
import { getState, notify, setState } from "../store";
import { makeStat, type LayerStyle, type StyledKind } from "../uiTypes";

/** Values of a style, for its class limits. Results: each object's maximum over the run, so colours stay comparable while animating. */
async function styleValues(kind: StyledKind, s: LayerStyle): Promise<Float32Array> {
  if (s.source === "attribute") return api.attribute(kind, s.field);
  const v = Number(s.field);
  if (s.source === "result") {
    try {
      return await api.envelope(kind, v);
    } catch {
      return api.frame(kind, v, getState().period);
    }
  }
  if (s.source === "compare" && s.stat === "value") {
    // Differences over the run are not known in advance: use the difference of the maxima.
    try {
      return await statValues(kind, { ...s, stat: "max", scope: "run" }, getState().period);
    } catch {
      return statValues(kind, s, getState().period);
    }
  }
  return statValues(kind, s, getState().period);
}

/** Periods `[p0, p1)` of a style's statistic in a results set, at the time of period `p` of the loaded results. */
export function statRange(style: LayerStyle, r: ResultsInfo, loaded: ResultsInfo, p: number): [number, number] {
  if (style.scope === "run") return [0, r.n_periods];
  const q = r === loaded ? p : periodAt(r, periodMs(loaded, p));
  const [a, b] = bucketRange(r, style.scope, q);
  return [a, b];
}

/** Values of a style: a statistic over its period range, or loaded minus compared. */
export async function statValues(kind: StyledKind, style: LayerStyle, period: number): Promise<Float32Array> {
  const m = getState().model;
  const a = m?.results;
  if (!a) throw new Error("no results loaded");
  const v = Number(style.field);
  if (style.stat === "value") {
    return style.source === "compare" ? api.compareFrame(kind, v, period) : api.frame(kind, v, period);
  }
  const stat = makeStat(style.stat, style.threshold);
  const [p0, p1] = statRange(style, a, a, period);
  const va = await api.statValues(kind, v, stat, p0, p1);
  if (style.source !== "compare") return va;
  const b = m.compare;
  if (!b) throw new Error("no results to compare with");
  const [q0, q1] = statRange(style, b, a, period);
  const vb = await api.statValues(kind, v, stat, q0, q1, true);
  return va.map((x, i) => x - vb[i]);
}

async function recompute(kind: StyledKind, s: LayerStyle): Promise<number[]> {
  if (s.source === "type" || s.field === "") return [];
  const values = await styleValues(kind, s);
  if (s.source === "compare") {
    // Classes symmetric around zero for differences.
    let m = 0;
    for (const x of values) if (Number.isFinite(x)) m = Math.max(m, Math.abs(x));
    if (m === 0) return [0];
    return computeBreaks([-m, m], "equal", s.classes);
  }
  return computeBreaks(values, s.method === "custom" ? "equal" : s.method, s.classes);
}

export function setStyle(kind: StyledKind, patch: Partial<LayerStyle>) {
  setState((s) => ({ styles: { ...s.styles, [kind]: { ...s.styles[kind], ...patch } } }));
}

/** Latest `applyStyle` call per layer: class limits computed for an earlier one are dropped. */
const styleSeq: Record<StyledKind, number> = { node: 0, link: 0, subcatchment: 0 };

/** Drops the class limits being computed for a layer (the user set them by hand meanwhile). */
export function cancelPendingLimits(kind: StyledKind) {
  styleSeq[kind]++;
}

export async function applyStyle(kind: StyledKind, patch: Partial<LayerStyle>) {
  const next = { ...getState().styles[kind], ...patch };
  const seq = ++styleSeq[kind];
  setStyle(kind, patch);
  if (next.source === "type" || next.method === "custom") return;
  try {
    const breaks = await recompute(kind, next);
    if (seq === styleSeq[kind]) setStyle(kind, { breaks });
  } catch (e) {
    if (seq === styleSeq[kind]) notify(errorText(e), true);
  }
}
