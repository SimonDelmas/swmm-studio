import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { bucketRange, periodAt, periodMs } from "../format";
import { getState, makeStat, notify, type LayerStyle, type StyledKind } from "../store";
import type { ResultsInfo } from "../types";

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

/** Key of the values of a statistic style: they change only when it changes. */
function statKey(style: LayerStyle, period: number): string {
  const m = getState().model;
  const a = m?.results;
  if (!a) return "";
  const range = style.stat === "value" ? `p${period}` : statRange(style, a, a, period).join("-");
  return `${style.source}:${style.field}:${style.stat}:${style.threshold}:${range}`;
}

/**
 * Values used to colour a layer: an input attribute, a result variable at the current
 * period, a statistic over a period range, or a difference with the compared results.
 * Requests that follow the current period are coalesced: while one is in flight only the
 * latest wanted one is kept, so playback runs as fast as the backend answers.
 */
export function useLayerValues(
  kind: StyledKind,
  style: LayerStyle,
  period: number,
  resultsKey: string | null,
  modelKey: string | null,
  compareKey: string | null = null,
): Float32Array | null {
  const [values, setValues] = useState<Float32Array | null>(null);
  const req = useRef<{ busy: boolean; next: { f: () => Promise<Float32Array>; token: number } | null; token: number }>({
    busy: false,
    next: null,
    token: 0,
  });

  // Attribute or no colouring: (re)load when the choice or the model changes.
  useEffect(() => {
    req.current.token++;
    if (style.source === "type" || !style.field) {
      setValues(null);
      return;
    }
    if (style.source === "attribute") {
      const token = req.current.token;
      api
        .attribute(kind, style.field)
        .then((v) => token === req.current.token && setValues(v))
        .catch((e) => notify(errorText(e), true));
    }
  }, [kind, style.source, style.field, modelKey]);

  const load = (f: () => Promise<Float32Array>, token: number) => {
    const r = req.current;
    if (r.busy) {
      r.next = { f, token };
      return;
    }
    r.busy = true;
    f()
      .then((v) => token === r.token && setValues(v))
      .catch((e) => token === r.token && notify(errorText(e), true))
      .finally(() => {
        r.busy = false;
        const n = r.next;
        r.next = null;
        if (n && n.token === r.token) load(n.f, n.token);
      });
  };

  // Result at the current period.
  useEffect(() => {
    if (style.source !== "result" || !resultsKey || style.field === "") return;
    const v = Number(style.field);
    load(() => api.frame(kind, v, period), req.current.token);
  }, [kind, style.source, style.field, period, resultsKey]);

  // Statistics and differences: reloaded when their period range changes.
  const key = style.source === "stat" || style.source === "compare" ? statKey(style, period) : "";
  useEffect(() => {
    if (!key || !resultsKey || style.field === "" || (style.source === "compare" && !compareKey)) return;
    const p = period;
    load(() => statValues(kind, style, p), req.current.token);
  }, [kind, key, resultsKey, compareKey]);

  return values;
}
