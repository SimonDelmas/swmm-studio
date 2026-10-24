import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { computeBreaks, formatNumber, RAMPS, rampColors, type RGB } from "../classify";
import { formatDateTime, periodAt, periodMs } from "../format";
import { LINK_TYPE_COLORS, LINK_TYPE_NAMES, NODE_TYPE_COLORS, NODE_TYPE_NAMES, SUB_COLOR } from "../map/colors";
import { statValues } from "../map/useLayerValues";
import { getState, makeStat, notify, setState, setStyle, useStore, type LayerStyle, type StatName, type StyledKind } from "../store";

const TITLES: Record<StyledKind, string> = { node: "Nodes", link: "Links", subcatchment: "Subcatchments" };

export const STATS: [StatName, string][] = [
  ["max", "Maximum"],
  ["min", "Minimum"],
  ["mean", "Mean"],
  ["time_of_max", "Time of maximum"],
  ["total", "Total (volume, depth)"],
  ["periods_above", "Duration above threshold"],
];

const SCOPES: [LayerStyle["scope"], string][] = [
  ["run", "whole run"],
  ["year", "year of the current time"],
  ["month", "month of the current time"],
  ["day", "day of the current time"],
];

const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

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

export async function applyStyle(kind: StyledKind, patch: Partial<LayerStyle>) {
  const next = { ...getState().styles[kind], ...patch };
  setStyle(kind, patch);
  if (next.source === "type" || next.method === "custom") return;
  try {
    const breaks = await recompute(kind, next);
    setStyle(kind, { breaks });
  } catch (e) {
    notify(errorText(e), true);
  }
}

/** Formats and parses class limits: dates for times of maximum. */
function limitFormat(style: LayerStyle): [(v: number) => string, (s: string) => number] {
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

function Legend({ kind, style, unit }: { kind: StyledKind; style: LayerStyle; unit: string }) {
  if (style.source === "type" || style.field === "") {
    const items: [string, RGB][] =
      kind === "node"
        ? NODE_TYPE_NAMES.map((n, i) => [n, NODE_TYPE_COLORS[i]])
        : kind === "link"
          ? LINK_TYPE_NAMES.map((n, i) => [n, LINK_TYPE_COLORS[i]])
          : [["Subcatchment", SUB_COLOR]];
    return (
      <div className="legend">
        {items.map(([n, c]) => (
          <div key={n} className="legend-row">
            <span className="swatch" style={{ background: css(c) }} /> {n}
          </div>
        ))}
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
          <span className="swatch" style={{ background: css(c) }} />
          {i === 0 ? "≤ " : "> "}
          {i < style.breaks.length ? (
            <input
              className={style.stat === "time_of_max" && style.source === "stat" ? "" : "narrow"}
              key={`${i}:${style.breaks[i]}`}
              defaultValue={fmt(style.breaks[i])}
              onBlur={(e) => setBreak(i, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span>{fmt(style.breaks[i - 1])}</span>
          )}
          {i > 0 && i < style.breaks.length && <span className="muted"> (to {fmt(style.breaks[i])})</span>}
          <span className="muted"> {unit}</span>
        </div>
      ))}
      <div className="legend-row">
        <span className="swatch" style={{ background: "rgb(150,150,150)" }} /> no data
      </div>
    </div>
  );
}

/** Unit shown in the legend. */
function useUnit(kind: StyledKind, style: LayerStyle): string {
  const results = useStore((s) => s.model?.results ?? null);
  const [unit, setUnit] = useState("");
  const vars = results?.variables[kind] ?? [];
  const base = vars[Number(style.field)]?.unit ?? "";
  useEffect(() => {
    if (style.source === "type" || style.source === "attribute" || !results) return setUnit("");
    if (style.source === "result" || style.stat === "value") return setUnit(base);
    if (style.stat === "time_of_max") return setUnit("");
    api
      .statUnit(kind, Number(style.field), makeStat(style.stat, style.threshold))
      .then(setUnit)
      .catch(() => setUnit(base));
  }, [kind, style.source, style.field, style.stat, results?.path, base]);
  return unit;
}

function LayerSection({ kind }: { kind: StyledKind }) {
  const style = useStore((s) => s.styles[kind]);
  const model = useStore((s) => s.model);
  const results = model?.results ?? null;
  const compare = model?.compare ?? null;
  const attrs = model?.attributes[kind] ?? [];
  const vars = results?.variables[kind] ?? [];
  const value = style.source === "type" ? "type" : `${style.source}:${style.field}`;
  const unit = useUnit(kind, style);
  const onSource = (v: string) => {
    if (v === "type") return applyStyle(kind, { source: "type", field: "" });
    const [source, field] = v.split(/:(.*)/s) as ["attribute" | "result" | "stat" | "compare", string];
    const patch: Partial<LayerStyle> = { source, field, method: style.method === "custom" ? "equal" : style.method };
    if (source === "compare") {
      patch.ramp = "diverging";
      if (style.source !== "compare") patch.stat = "value";
    } else if (style.source === "compare" && style.ramp === "diverging") patch.ramp = defaultRamp(kind);
    if (source === "stat" && (style.stat === "value" || style.source !== "stat")) patch.stat = "max";
    applyStyle(kind, patch);
  };
  const isStat = style.source === "stat" || style.source === "compare";
  return (
    <div className="style-section">
      <div className="style-head">
        <label>
          <input type="checkbox" checked={style.visible} onChange={(e) => setStyle(kind, { visible: e.target.checked })} />
          <b>{TITLES[kind]}</b>
        </label>
        {kind !== "subcatchment" && (
          <label title="Size in pixels">
            size
            <input
              type="range"
              min={1}
              max={kind === "node" ? 12 : 10}
              step={0.5}
              value={style.size}
              onChange={(e) => setStyle(kind, { size: Number(e.target.value) })}
            />
          </label>
        )}
      </div>
      <label className="field">
        Colour by
        <select value={value} onChange={(e) => onSource(e.target.value)}>
          <option value="type">Type</option>
          <optgroup label="Input">
            {attrs.map((a) => (
              <option key={a} value={`attribute:${a}`}>
                {a.replace(/_/g, " ")}
              </option>
            ))}
          </optgroup>
          {vars.length > 0 && (
            <optgroup label="Results (animated)">
              {vars.map((v, i) => (
                <option key={v.name} value={`result:${i}`}>
                  {v.name} ({v.unit})
                </option>
              ))}
            </optgroup>
          )}
          {vars.length > 0 && (
            <optgroup label="Statistics (envelope)">
              {vars.map((v, i) => (
                <option key={v.name} value={`stat:${i}`}>
                  {v.name} statistic
                </option>
              ))}
            </optgroup>
          )}
          {compare && vars.length > 0 && (
            <optgroup label="Difference with the compared run">
              {vars
                .map((v, i) => [v, i] as const)
                .filter(([v]) => compare.variables[kind]?.some((w) => w.name === v.name))
                .map(([v, i]) => (
                  <option key={v.name} value={`compare:${i}`}>
                    Δ {v.name}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
      </label>
      {isStat && (
        <div className="style-grid">
          <label className="field">
            Statistic
            <select value={style.stat} onChange={(e) => applyStyle(kind, { stat: e.target.value as LayerStyle["stat"] })}>
              {style.source === "compare" && <option value="value">At the current time (animated)</option>}
              {STATS.filter(([s]) => style.source === "stat" || s !== "time_of_max").map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {style.stat === "periods_above" && (
            <label className="field">
              Threshold ({vars[Number(style.field)]?.unit})
              <input
                className="narrow"
                key={style.threshold}
                defaultValue={style.threshold}
                onBlur={(e) => Number.isFinite(Number(e.target.value)) && applyStyle(kind, { threshold: Number(e.target.value) })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
          )}
          {style.stat !== "value" && (
            <label className="field">
              Over
              <select value={style.scope} onChange={(e) => applyStyle(kind, { scope: e.target.value as LayerStyle["scope"] })}>
                {SCOPES.map(([s, label]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {style.source !== "type" && (
        <div className="style-grid">
          <label className="field">
            Classes
            <select value={style.method} onChange={(e) => applyStyle(kind, { method: e.target.value as LayerStyle["method"] })}>
              <option value="equal">Equal interval</option>
              <option value="quantile">Quantile</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="field">
            Count
            <select value={style.classes} onChange={(e) => applyStyle(kind, { classes: Number(e.target.value) })}>
              {[2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Ramp
            <select value={style.ramp} onChange={(e) => setStyle(kind, { ramp: e.target.value })}>
              {Object.keys(RAMPS).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          {kind !== "subcatchment" && (
            <label>
              <input
                type="checkbox"
                checked={style.sizeByClass}
                onChange={(e) => setStyle(kind, { sizeByClass: e.target.checked })}
              />
              size by class
            </label>
          )}
          <button
            title="Recompute the class limits (results: from the maximum of each object over the run)"
            onClick={() => applyStyle(kind, { method: style.method === "custom" ? "equal" : style.method })}
          >
            Recompute
          </button>
        </div>
      )}
      {isStat && style.scope !== "run" && style.stat !== "value" && (
        <div className="muted">Follows the current time: the map changes when the timeline enters another {style.scope}.</div>
      )}
      <Legend kind={kind} style={style} unit={unit} />
    </div>
  );
}

function defaultRamp(kind: StyledKind) {
  return kind === "subcatchment" ? "greens" : "blue-red";
}

export function StylePanel() {
  const model = useStore((s) => s.model);
  const labels = useStore((s) => s.labels);
  if (!model) return <div className="panel-empty">Open a model first.</div>;
  return (
    <div className="style-panel">
      <label>
        <input type="checkbox" checked={labels} onChange={(e) => setState({ labels: e.target.checked })} /> Labels (when
        zoomed in)
      </label>
      <LayerSection kind="node" />
      <LayerSection kind="link" />
      <LayerSection kind="subcatchment" />
    </div>
  );
}
