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
  return { kind: o.kind, var: st.source === "result" && st.field !== "" ? Number(st.field) : DEFAULT_VAR[o.kind] };
}
