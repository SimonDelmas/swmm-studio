import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { tryEdit } from "../edit";
import { setState, useStore } from "../store";
import type { Climate } from "../types";
import { useNames } from "./PropertiesPanel";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SNOW = ["Dividing temperature (snow / rain)", "ATI weight", "Negative melt ratio", "Elevation above MSL", "Latitude (degrees)", "Longitude correction (min)"];
const SNOW_DEFAULT = ["34", "0.5", "0.6", "0", "50", "0"];
const ADC_DEFAULT = ["1", "1", "1", "1", "1", "1", "1", "1", "1", "1"];

/** A row of numbers (12 months, 10 depletion points…); empty means "no line". */
function Values({ labels, values, onChange, optional, fill }: { labels: string[]; values: string[]; onChange: (v: string[]) => void; optional?: string; fill: string[] }) {
  const on = values.length > 0;
  return (
    <div>
      {optional && (
        <label>
          <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? [...fill] : [])} /> {optional}
        </label>
      )}
      {(on || !optional) && (
        <div className="month-grid" style={{ gridTemplateColumns: `repeat(${Math.min(labels.length, 12)}, 1fr)` }}>
          {labels.map((l, i) => (
            <label key={i} className="month">
              <span className="muted">{l}</span>
              <input value={values[i] ?? ""} onChange={(e) => onChange(labels.map((_, k) => (k === i ? e.target.value : (values[k] ?? fill[k] ?? "0"))))} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const TABS = ["Evaporation", "Temperature", "Wind speed", "Snowmelt", "Areal depletion", "Adjustments"] as const;

/** Climatology: evaporation, temperature, wind speed, snowmelt, areal depletion, monthly adjustments. */
export function ClimateDialog() {
  const units = useStore((s) => s.model?.flow_units ?? "CMS");
  const us = ["CFS", "GPM", "MGD"].includes(units);
  const series = useNames("timeseries");
  const patterns = useNames("pattern");
  const [c, setC] = useState<Climate | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Evaporation");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.climate().then(setC, (e) => setError(errorText(e)));
  }, []);
  const close = () => setState({ dialog: null });
  if (!c) return null;
  const set = (p: Partial<Climate>) => setC({ ...c, ...p });
  const ok = async () => {
    try {
      await tryEdit({ op: "set_climate", climate: c });
      close();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const evapUnit = us ? "in/day" : "mm/day";
  const src = c.evap_source;
  const setSource = (s: string) => {
    const values = s === "CONSTANT" ? ["0.0"] : s === "MONTHLY" ? Array(12).fill("0.0") : s === "TIMESERIES" ? [series[0] ?? ""] : [];
    set({ evap_source: s, evap_values: values });
  };
  return (
    <div className="modal-back">
      <div className="modal wide-modal">
        <h3>Climatology</h3>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="climate-body">
          {tab === "Evaporation" && (
            <>
              <label className="option">
                <span>Source</span>
                <select value={src} onChange={(e) => setSource(e.target.value)}>
                  <option value="">None</option>
                  <option value="CONSTANT">Constant</option>
                  <option value="MONTHLY">Monthly averages</option>
                  <option value="TIMESERIES">Time series</option>
                  <option value="TEMPERATURE">Computed from temperatures</option>
                  <option value="FILE">Climate file (pan evaporation)</option>
                </select>
              </label>
              {src === "CONSTANT" && (
                <label className="option">
                  <span>Rate ({evapUnit})</span>
                  <input value={c.evap_values[0] ?? ""} onChange={(e) => set({ evap_values: [e.target.value] })} />
                </label>
              )}
              {src === "MONTHLY" && <Values labels={MONTHS} values={c.evap_values} fill={Array(12).fill("0.0")} onChange={(v) => set({ evap_values: v })} />}
              {src === "TIMESERIES" && (
                <label className="option">
                  <span>Time series ({evapUnit})</span>
                  <select value={c.evap_values[0] ?? ""} onChange={(e) => set({ evap_values: [e.target.value] })}>
                    <option value=""></option>
                    {series.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              )}
              {src === "FILE" && (
                <Values labels={MONTHS} values={c.evap_values} fill={Array(12).fill("1.0")} optional="Pan coefficients" onChange={(v) => set({ evap_values: v })} />
              )}
              {src === "TEMPERATURE" && <div className="muted">Computed with the Hargreaves method from the temperatures of the Temperature tab.</div>}
              <label className="option">
                <span>Soil recovery pattern</span>
                <select value={c.evap_recovery} onChange={(e) => set({ evap_recovery: e.target.value })}>
                  <option value="">None</option>
                  {patterns.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" checked={c.evap_dry_only} onChange={(e) => set({ evap_dry_only: e.target.checked })} /> Evaporate only in dry periods
              </label>
            </>
          )}
          {tab === "Temperature" && (
            <>
              <label className="option">
                <span>Source</span>
                <select value={c.temp_source} onChange={(e) => set({ temp_source: e.target.value })}>
                  <option value="">No data</option>
                  <option value="TIMESERIES">Time series</option>
                  <option value="FILE">Climate file</option>
                </select>
              </label>
              {c.temp_source === "TIMESERIES" && (
                <label className="option">
                  <span>Time series ({us ? "°F" : "°C"})</span>
                  <select value={c.temp_series} onChange={(e) => set({ temp_series: e.target.value })}>
                    <option value=""></option>
                    {series.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              )}
              {c.temp_source === "FILE" && (
                <>
                  <label className="option">
                    <span>Climate file</span>
                    <input value={c.temp_file} onChange={(e) => set({ temp_file: e.target.value })} />
                  </label>
                  <label className="option">
                    <span>Start reading at (MM/DD/YYYY, optional)</span>
                    <input value={c.temp_file_start} onChange={(e) => set({ temp_file_start: e.target.value })} />
                  </label>
                </>
              )}
            </>
          )}
          {tab === "Wind speed" && (
            <>
              <label className="option">
                <span>Source</span>
                <select
                  value={c.wind_source}
                  onChange={(e) => set({ wind_source: e.target.value, wind_monthly: e.target.value === "MONTHLY" ? Array(12).fill("0.0") : [] })}
                >
                  <option value="">None</option>
                  <option value="MONTHLY">Monthly averages</option>
                  <option value="FILE">Climate file</option>
                </select>
              </label>
              {c.wind_source === "MONTHLY" && (
                <Values labels={MONTHS} values={c.wind_monthly} fill={Array(12).fill("0.0")} onChange={(v) => set({ wind_monthly: v })} />
              )}
            </>
          )}
          {tab === "Snowmelt" && (
            <Values
              labels={SNOW}
              values={c.snowmelt}
              fill={SNOW_DEFAULT}
              optional="Snowmelt parameters"
              onChange={(v) => set({ snowmelt: v })}
            />
          )}
          {tab === "Areal depletion" && (
            <>
              <Values
                labels={["0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9"]}
                values={c.adc_impervious}
                fill={ADC_DEFAULT}
                optional="Impervious area (fraction covered at each depth ratio)"
                onChange={(v) => set({ adc_impervious: v })}
              />
              <Values
                labels={["0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9"]}
                values={c.adc_pervious}
                fill={ADC_DEFAULT}
                optional="Pervious area"
                onChange={(v) => set({ adc_pervious: v })}
              />
            </>
          )}
          {tab === "Adjustments" && (
            <>
              <Values labels={MONTHS} values={c.adj_temperature} fill={Array(12).fill("0.0")} optional="Temperature (added)" onChange={(v) => set({ adj_temperature: v })} />
              <Values labels={MONTHS} values={c.adj_evaporation} fill={Array(12).fill("0.0")} optional="Evaporation (added)" onChange={(v) => set({ adj_evaporation: v })} />
              <Values labels={MONTHS} values={c.adj_rainfall} fill={Array(12).fill("1.0")} optional="Rainfall (multiplier)" onChange={(v) => set({ adj_rainfall: v })} />
              <Values
                labels={MONTHS}
                values={c.adj_conductivity}
                fill={Array(12).fill("1.0")}
                optional="Soil conductivity (multiplier)"
                onChange={(v) => set({ adj_conductivity: v })}
              />
            </>
          )}
        </div>
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button className="primary" onClick={ok}>
            OK
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
