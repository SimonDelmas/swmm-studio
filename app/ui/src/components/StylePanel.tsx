import { NumberInput } from "./CommitInput";
import { useEffect, useState } from "react";
import { api } from "../api";
import { RAMPS } from "../classify";
import { makeStat, setState, setStyle, STATS, useStore, type LayerStyle, type StyledKind } from "../store";
import { applyStyle } from "../actions/style";
import { BasemapSection } from "./style/BasemapSection";
import { Legend, TypeList } from "./style/Legend";

const TITLES: Record<StyledKind, string> = { node: "Nodes", link: "Links", subcatchment: "Subcatchments" };

const SCOPES: [LayerStyle["scope"], string][] = [
  ["run", "whole run"],
  ["year", "year of the current time"],
  ["month", "month of the current time"],
  ["day", "day of the current time"],
];

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
    // The unit of a statistic chosen earlier, answered late, is dropped.
    let current = true;
    api
      .statUnit(kind, Number(style.field), makeStat(style.stat, style.threshold))
      .then((u) => current && setUnit(u))
      .catch(() => current && setUnit(base));
    return () => {
      current = false;
    };
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
        {kind === "subcatchment" && (
          <label title="Draw a line from each subcatchment to its outlet (node or subcatchment)">
            <input type="checkbox" checked={style.outletLinks} onChange={(e) => setStyle(kind, { outletLinks: e.target.checked })} />
            outlet links
          </label>
        )}
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
              <NumberInput className="narrow" value={style.threshold} onCommit={(threshold) => applyStyle(kind, { threshold })} />
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
      <TypeList kind={kind} style={style} />
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
      {model.space.kind === "lonlat" && <BasemapSection basemap={model.project.basemap} />}
    </div>
  );
}
