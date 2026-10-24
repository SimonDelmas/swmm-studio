// Time helpers. Model times are shown as they are in the model (UTC, no time zone).

import type { ElementKind, ObjRef, ResultsInfo } from "./types";
import type { State } from "./store";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function periodMs(r: ResultsInfo, p: number): number {
  return r.start_ms + p * r.step_secs * 1000;
}

export function formatDateTime(ms: number, seconds = false): string {
  const d = new Date(ms);
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return seconds ? `${s}:${pad(d.getUTCSeconds())}` : s;
}

/** `YYYY-MM-DDTHH:MM` for `<input type="datetime-local">`. */
export function toInputValue(ms: number): string {
  return formatDateTime(ms).replace(" ", "T");
}

export function fromInputValue(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Period closest to a time, clamped to the run. */
export function periodAt(r: ResultsInfo, ms: number): number {
  const p = Math.round((ms - r.start_ms) / (r.step_secs * 1000));
  return Math.max(0, Math.min(r.n_periods - 1, p));
}

const DEFAULT_VAR: Record<string, number> = { node: 0, link: 0, subcatchment: 4, system: 0 };

/** Result variable "of interest" for an object: the one its layer is coloured by. */
export function focusVar(s: State, o: ObjRef): { kind: ElementKind; var: number } | null {
  if (o.kind === "gage") return null;
  const st = s.styles[o.kind];
  const fromResults = st.source === "result" || st.source === "stat" || st.source === "compare";
  return { kind: o.kind, var: fromResults && st.field !== "" ? Number(st.field) : DEFAULT_VAR[o.kind] };
}

/**
 * First period whose interval starts at or after a time. Values are reported at the end
 * of each step: period `p` stands for `(time(p) - step, time(p)]` (as in swmm-analysis).
 */
function firstAt(r: ResultsInfo, ms: number): number {
  return Math.max(0, Math.ceil((ms - r.start_ms) / (r.step_secs * 1000) + 1 - 1e-9));
}

/** Periods `[p0, p1)` of the day, month or year that contains period `p` (model clock). */
export function bucketRange(r: ResultsInfo, unit: "day" | "month" | "year", p: number): [number, number, number] {
  const d = new Date(periodMs(r, Math.max(0, Math.min(r.n_periods - 1, p))) - r.step_secs * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const [a, b] =
    unit === "day"
      ? [Date.UTC(y, m, d.getUTCDate()), Date.UTC(y, m, d.getUTCDate() + 1)]
      : unit === "month"
        ? [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)]
        : [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];
  return [firstAt(r, a), Math.min(r.n_periods, firstAt(r, b)), a];
}

/** Label of a calendar interval starting at `ms`. */
export function bucketLabel(unit: "day" | "month" | "year", ms: number): string {
  const t = formatDateTime(ms);
  return unit === "day" ? t.slice(0, 10) : unit === "month" ? t.slice(0, 7) : t.slice(0, 4);
}
