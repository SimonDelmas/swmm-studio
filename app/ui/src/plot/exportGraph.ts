// A graph as a table of values and as a figure, for the exports.

import { chartSvg } from "../chartSvg";
import { bucketLabel, formatDateTime } from "../format";
import type { PlotAgg } from "../uiTypes";
import { drawnIds, runDash, type Built } from "./data";
import { COLORS } from "./series";

/** A time of the x axis as text: the bucket of an aggregate, or the date and time. */
const timeText = (agg: PlotAgg | null, x: number) => (agg ? bucketLabel(agg.unit, x * 1000) : formatDateTime(x * 1000, true));

/** Which drawn lines are shown: the lines hidden from the legend are not exported. */
const shownMask = (built: Built, hidden: ReadonlySet<string>) => drawnIds(built).map((id) => !hidden.has(id));

/** Column titles and rows of the plotted values (other runs, then observed values last). */
export function graphTable(
  built: Built,
  agg: PlotAgg | null,
  hidden: ReadonlySet<string> = new Set(),
): { head: string[]; rows: (string | number | null)[][] } {
  const shown = shownMask(built, hidden);
  const [x, ...all] = built.data;
  const ys = all.filter((_, i) => shown[i]);
  const titles = [
    ...built.series.map((p, i) => `${p.label} (${built.units[i]})${built.decimated ? " [min/max per bucket]" : ""}`),
    ...built.runs.map((r) => `${r.label} (${built.units[r.parent]})${built.decimated ? " [min/max per bucket]" : ""}`),
    ...built.obs.map((o) => `${o.label} (${built.units[o.parent]})`),
  ];
  const head = [agg ? agg.unit : "time", ...titles.filter((_, i) => shown[i])];
  const rows = Array.from(x, (t, i) => [timeText(agg, Number(t)), ...ys.map((y) => y[i] ?? null)]);
  return { head, rows };
}

/** The graph as a standalone SVG document. */
export function graphSvg(built: Built, agg: PlotAgg | null, size: { w: number; h: number }, hidden: ReadonlySet<string> = new Set()): string {
  const shown = shownMask(built, hidden);
  const [x, ...ys] = built.data;
  const n = built.series.length;
  const k0 = n + built.runs.length;
  return chartSvg(
    [
      ...built.series.map((p, i) => ({
        label: p.label,
        unit: built.units[i],
        color: COLORS[i % COLORS.length],
        x: Array.from(x),
        y: Array.from(ys[i] as (number | null)[]),
        stepped: built.stepped,
      })),
      ...built.runs.map((r, k) => ({
        label: r.label,
        unit: built.units[r.parent],
        color: COLORS[r.parent % COLORS.length],
        x: Array.from(x),
        y: Array.from(ys[n + k] as (number | null)[]),
        stepped: built.stepped,
        dash: runDash(r.run),
      })),
      ...built.obs.map((o, k) => ({
        label: o.label,
        unit: built.units[o.parent],
        color: COLORS[o.parent % COLORS.length],
        x: Array.from(x),
        y: Array.from(ys[k0 + k] as (number | null)[]),
        points: true,
      })),
    ].filter((_, i) => shown[i]),
    { width: Math.max(600, size.w), height: Math.max(320, size.h), xLabel: (t) => timeText(agg, t).slice(0, 16) },
  );
}
