import { CommitInput } from "../CommitInput";
// Legend of a layer: its classes or its object types, which can be shown or hidden.

import { formatNumber, rampColors, type RGB } from "../../classify";
import { formatDateTime, periodAt, periodMs } from "../../format";
import { LINK_TYPE_COLORS, LINK_TYPE_NAMES, NODE_TYPE_COLORS, NODE_TYPE_NAMES, SUB_COLOR } from "../../map/colors";
import { LINK_TYPE_SHAPES, NODE_TYPE_SHAPES, SHAPE_PATHS, type Shape } from "../../map/shapes";
import { getState, setStyle, type LayerStyle, type StyledKind } from "../../store";

export const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** Type symbols when the colour comes from a value. */
export const TYPE_NEUTRAL: RGB = [110, 110, 110];

/** Formats and parses class limits: dates for times of maximum. */
export function limitFormat(style: LayerStyle): [(v: number) => string, (s: string) => number] {
  const r = getState().model?.results;
  if (style.stat === "time_of_max" && style.source === "stat" && r) {
    return [
      (v) => (Number.isFinite(v) ? formatDateTime(periodMs(r, v)) : "–"),
      (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s.trim());
        return m ? periodAt(r, Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0))) : NaN;
      },
    ];
  }
  return [formatNumber, (s) => Number(s)];
}

/** Legend symbol as on the map: the node type's shape, a line with the link type's symbol, an area. */
export function Swatch({ kind, color, shape }: { kind: StyledKind; color: RGB; shape?: Shape | null }) {
  const fill = css(color);
  if (kind === "subcatchment") return <span className="swatch" style={{ background: fill }} />;
  if (kind === "node") {
    return (
      <svg className="swatch-svg" width={22} height={14} viewBox="-28 -6 120 76">
        <path d={SHAPE_PATHS[shape ?? "circle"]} fill={fill} stroke="rgba(0,0,0,0.35)" strokeWidth={4} />
      </svg>
    );
  }
  return (
    <svg className="swatch-svg" width={22} height={14} viewBox="-28 -6 120 76">
      <rect x={-28} y={26} width={120} height={12} rx={6} fill={fill} />
      {shape && (
        <g transform="translate(14 14) scale(0.56)">
          <path d={SHAPE_PATHS[shape]} fill={fill} stroke="#fff" strokeWidth={6} paintOrder="stroke" />
        </g>
      )}
    </svg>
  );
}

export function toggleType(kind: StyledKind, style: LayerStyle, t: number, shown: boolean) {
  const hiddenTypes = shown ? style.hiddenTypes.filter((h) => h !== t) : [...style.hiddenTypes, t].sort((a, b) => a - b);
  setStyle(kind, { hiddenTypes });
}

/** Node and link types: their symbol, and whether they are drawn (whatever they are coloured by). */
export function TypeList({ kind, style }: { kind: StyledKind; style: LayerStyle }) {
  if (kind === "subcatchment") return null;
  const [names, colors, shapes] =
    kind === "node" ? [NODE_TYPE_NAMES, NODE_TYPE_COLORS, NODE_TYPE_SHAPES] : [LINK_TYPE_NAMES, LINK_TYPE_COLORS, LINK_TYPE_SHAPES];
  const byType = style.source === "type" || style.field === "";
  return (
    <div className="legend">
      {names.map((n, t) => (
        <label key={n} className="legend-row" title="Show or hide this type on the map">
          <input type="checkbox" checked={!style.hiddenTypes.includes(t)} onChange={(e) => toggleType(kind, style, t, e.target.checked)} />
          <Swatch kind={kind} color={byType ? colors[t] : TYPE_NEUTRAL} shape={shapes[t]} /> {n}
        </label>
      ))}
    </div>
  );
}

export function Legend({ kind, style, unit }: { kind: StyledKind; style: LayerStyle; unit: string }) {
  if (style.source === "type" || style.field === "") {
    if (kind !== "subcatchment") return null;
    return (
      <div className="legend">
        <div className="legend-row">
          <Swatch kind={kind} color={SUB_COLOR} /> Subcatchment
        </div>
      </div>
    );
  }
  const [fmt, parse] = limitFormat(style);
  const colors = rampColors(style.ramp, style.breaks.length + 1);
  const setBreak = (i: number, v: string) => {
    const x = parse(v);
    if (!Number.isFinite(x)) return;
    const b = [...style.breaks];
    b[i] = x;
    setStyle(kind, { breaks: b.sort((p, q) => p - q), method: "custom" });
  };
  return (
    <div className="legend">
      {colors.map((c, i) => (
        <div key={i} className="legend-row">
          <Swatch kind={kind} color={c} />
          {i === 0 ? "≤ " : "> "}
          {i < style.breaks.length ? (
            <CommitInput
              className={style.stat === "time_of_max" && style.source === "stat" ? "" : "narrow"}
              value={fmt(style.breaks[i])}
              onCommit={(text) => setBreak(i, text)}
            />
          ) : (
            <span>{fmt(style.breaks[i - 1])}</span>
          )}
          {i > 0 && i < style.breaks.length && <span className="muted"> (to {fmt(style.breaks[i])})</span>}
          <span className="muted"> {unit}</span>
        </div>
      ))}
      <div className="legend-row">
        <Swatch kind={kind} color={[150, 150, 150]} /> no data
      </div>
    </div>
  );
}
