import { api, errorText } from "../api";
import { computeBreaks, formatNumber, RAMPS, rampColors, type RGB } from "../classify";
import { LINK_TYPE_COLORS, LINK_TYPE_NAMES, NODE_TYPE_COLORS, NODE_TYPE_NAMES, SUB_COLOR } from "../map/colors";
import { getState, notify, setState, setStyle, useStore, type LayerStyle, type StyledKind } from "../store";

const TITLES: Record<StyledKind, string> = { node: "Nodes", link: "Links", subcatchment: "Subcatchments" };

const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Class limits from the data: run maxima for results (stable while animating), else values. */
async function recompute(kind: StyledKind, s: LayerStyle): Promise<number[]> {
  if (s.source === "type" || s.field === "") return [];
  let values: Float32Array;
  if (s.source === "attribute") values = await api.attribute(kind, s.field);
  else {
    const v = Number(s.field);
    try {
      values = await api.envelope(kind, v);
    } catch {
      values = await api.frame(kind, v, getState().period);
    }
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
  const colors = rampColors(style.ramp, style.breaks.length + 1);
  const setBreak = (i: number, v: string) => {
    const x = Number(v);
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
              className="narrow"
              key={`${i}:${style.breaks[i]}`}
              defaultValue={formatNumber(style.breaks[i])}
              onBlur={(e) => setBreak(i, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span>{formatNumber(style.breaks[i - 1])}</span>
          )}
          {i > 0 && i < style.breaks.length && <span className="muted"> (to {formatNumber(style.breaks[i])})</span>}
          <span className="muted"> {unit}</span>
        </div>
      ))}
      <div className="legend-row">
        <span className="swatch" style={{ background: "rgb(150,150,150)" }} /> no data
      </div>
    </div>
  );
}

function LayerSection({ kind }: { kind: StyledKind }) {
  const style = useStore((s) => s.styles[kind]);
  const model = useStore((s) => s.model);
  const results = model?.results ?? null;
  const attrs = model?.attributes[kind] ?? [];
  const vars = results?.variables[kind] ?? [];
  const value = style.source === "type" ? "type" : `${style.source}:${style.field}`;
  const unit = style.source === "result" ? (vars[Number(style.field)]?.unit ?? "") : "";
  const onSource = (v: string) => {
    if (v === "type") return applyStyle(kind, { source: "type", field: "" });
    const [source, field] = v.split(/:(.*)/s) as ["attribute" | "result", string];
    applyStyle(kind, { source, field, method: style.method === "custom" ? "equal" : style.method });
  };
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
        </select>
      </label>
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
      <Legend kind={kind} style={style} unit={unit} />
    </div>
  );
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
