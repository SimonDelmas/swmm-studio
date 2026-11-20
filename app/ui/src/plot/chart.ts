// The uPlot chart of a graph: its axes, its series and what the pointer does on it.

import uPlot from "uplot";
import { updatePlotView } from "../actions/views";
import { formatDateTime, periodMs } from "../format";
import { cssVar } from "../hooks/useSize";
import { getState } from "../store";
import type { PlotView } from "../uiTypes";
import { drawnIds, runDash, zoomPeriods, type Built } from "./data";
import { COLORS } from "./series";

/** Time axis labels in the model clock (UTC), 24 h. */
function timeLabels(_u: uPlot, splits: number[], _ax: number, _space: number, incr: number): string[] {
  return splits.map((s, i) => {
    const t = formatDateTime(s * 1000);
    const date = t.slice(0, 10);
    const prevDate = i > 0 ? formatDateTime(splits[i - 1] * 1000).slice(0, 10) : "";
    if (incr >= 28 * 86400) return t.slice(0, 7);
    if (incr >= 86400) return date;
    return date !== prevDate ? `${t.slice(11)}
${date}` : t.slice(11);
  });
}

/** What a chart reads when it draws or is used, which changes without the chart being made again. */
export interface LiveChart {
  view(): PlotView;
  /** The current period, shown as a vertical line. */
  period(): number;
  /** Ids (`drawnIds`) of the lines hidden from the legend. */
  hidden(): ReadonlySet<string>;
  /** A line was shown or hidden from the legend. */
  toggled(id: string, show: boolean): void;
}

/**
 * Options of the chart of some series: one y axis per unit, a line at the current time,
 * and a horizontal drag that zooms the view. `syncKey`: the charts with the same key share
 * their cursor.
 */
export function chartOptions(built: Built, units: string[], size: { w: number; h: number }, syncKey: string, live: LiveChart): uPlot.Options {
  const fg = cssVar("--fg", "#222");
  const stepped = built.stepped ? uPlot.paths.stepped!({ align: 1 }) : undefined;
  const ids = drawnIds(built);
  const hidden = live.hidden();
  const opts: uPlot.Options = {
    width: size.w,
    height: size.h - 34,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), "Etc/UTC"),
    cursor: {
      drag: { x: true, y: false },
      // Share the cursor with the other graphs of the view, not the drag selection.
      sync: { key: syncKey, setSeries: false, filters: { pub: (type) => type !== "mousedown" && type !== "mouseup" } },
    },
    scales: { x: { time: true }, ...Object.fromEntries(units.map((u) => [u, { auto: true }])) },
    axes: [
      { stroke: fg, grid: { stroke: "rgba(128,128,128,0.15)" }, values: timeLabels, size: 44 },
      ...units.map((u, i) => ({
        scale: u,
        label: u,
        side: i % 2 === 0 ? 3 : 1,
        stroke: fg,
        grid: { show: i === 0, stroke: "rgba(128,128,128,0.15)" },
        size: 60,
      })),
    ] as uPlot.Axis[],
    series: [
      { value: (_u, v) => (v == null ? "" : formatDateTime(v * 1000)) },
      ...(
        [
          ...built.series.map((p, i) => ({
            label: p.label,
            scale: built.units[i],
            stroke: COLORS[i % COLORS.length],
            width: 1.25,
            dash: p.b ? [6, 3] : undefined,
            points: { show: false },
            spanGaps: false,
            paths: stepped,
          })),
          // Other runs: dashed, with the colour of their series.
          ...built.runs.map((r) => ({
            label: r.label,
            scale: built.units[r.parent],
            stroke: COLORS[r.parent % COLORS.length],
            width: 1.25,
            dash: runDash(r.run),
            points: { show: false },
            spanGaps: false,
          })),
          // Observed values: points only, with the colour of their series.
          ...built.obs.map((o) => {
            const color = COLORS[o.parent % COLORS.length];
            return {
              label: o.label,
              scale: built.units[o.parent],
              stroke: color,
              width: 1,
              paths: () => null,
              points: { show: true, size: 4, width: 1, stroke: color, fill: color },
            };
          }),
        ] as uPlot.Series[]
      ).map((s, i) => ({ ...s, show: !hidden.has(ids[i]) })),
    ],
    hooks: {
      // A click on a legend entry hides or shows its line.
      setSeries: [
        (u, i) => {
          if (i !== null && i > 0) live.toggled(ids[i - 1], u.series[i].show !== false);
        },
      ],
      draw: [
        (u) => {
          const r = getState().model?.results;
          if (!r || live.view().agg) return;
          const x = u.valToPos(periodMs(r, live.period()) / 1000, "x", true);
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
          u.ctx.save();
          u.ctx.strokeStyle = "#e5534b";
          u.ctx.lineWidth = 1.5 * devicePixelRatio;
          u.ctx.beginPath();
          u.ctx.moveTo(x, u.bbox.top);
          u.ctx.lineTo(x, u.bbox.top + u.bbox.height);
          u.ctx.stroke();
          u.ctx.restore();
        },
      ],
      setSelect: [
        (u) => {
          if (u.select.width < 5) return;
          const r = getState().model?.results;
          if (!r) return;
          const a = u.posToVal(u.select.left, "x");
          const b = u.posToVal(u.select.left + u.select.width, "x");
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          const v = live.view();
          if (!v.agg) {
            const [p0, p1] = zoomPeriods(r, [a, b]);
            if (p1 - p0 < 2) return;
          }
          updatePlotView(v.id, { zoom: [a, b] });
        },
      ],
    },
  };
  return opts;
}
