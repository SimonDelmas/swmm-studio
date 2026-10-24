import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { exportTable } from "../exporting";
import { formatDateTime, periodMs } from "../format";
import { getState, setState, useStore } from "../store";
import type { ElementKind, EventDto, EventTable } from "../types";
import { addToPlot } from "./PlotPanel";
import { VirtualTable, type CellValue } from "./VirtualTable";

type Kind = "node" | "link" | "subcatchment";
type Scope = "all" | "selected" | "outfalls";

const DEFAULT_VAR: Record<Kind, string> = { node: "total_inflow", link: "flow", subcatchment: "runoff" };

const num = (v: CellValue) => (typeof v === "number" ? formatNumber(v) : (v ?? ""));

/** Long-term event statistics: events above a threshold, separated by a minimum dry time. */
export function EventsPanel() {
  const results = useStore((s) => s.model?.results ?? null);
  const compare = useStore((s) => s.model?.compare ?? null);
  const [kind, setKind] = useState<Kind>("node");
  const [v, setV] = useState<number>(-1);
  const [threshold, setThreshold] = useState("0");
  const [gap, setGap] = useState("6");
  const [scope, setScope] = useState<Scope>("outfalls");
  const [b, setB] = useState(false);
  const [table, setTable] = useState<EventTable | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [row, setRow] = useState<number | null>(null);
  const [events, setEvents] = useState<EventDto[] | null>(null);
  const vars = results?.variables[kind] ?? [];
  const varIndex = v >= 0 && v < vars.length ? v : Math.max(0, vars.findIndex((x) => x.name === DEFAULT_VAR[kind]));
  const src = b ? compare : results;

  useEffect(() => {
    setTable(null);
    setRow(null);
    setEvents(null);
  }, [results?.path, compare?.path]);

  const params = { threshold: Number(threshold), gap: Number(gap) };
  const valid = Number.isFinite(params.threshold) && Number.isFinite(params.gap) && params.gap >= 0;

  const compute = async () => {
    if (!valid) return setError("threshold and minimum inter-event time must be numbers");
    const sel = getState()
      .selection.filter((o) => o.kind === kind)
      .map((o) => o.index);
    if (scope === "selected" && sel.length === 0) return setError(`Select ${kind}s on the map first.`);
    setBusy(true);
    setError(null);
    try {
      const t = await api.eventStats({
        kind,
        var: varIndex,
        threshold: params.threshold,
        min_gap_hours: params.gap,
        objects: scope === "selected" ? sel : null,
        outfalls_only: scope === "outfalls" && kind === "node",
        b,
      });
      setTable(t);
      setRow(null);
      setEvents(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: CellValue[][] = useMemo(
    () => table?.rows.map((r) => [r.id, r.count, r.per_year, r.total, r.hours, r.peak]) ?? [],
    [table],
  );
  const pick = async (i: number) => {
    if (!table) return;
    setRow(i);
    const r = table.rows[i];
    setState({ selection: [{ kind, index: r.index }], fitSelection: getState().fitSelection + 1 });
    try {
      setEvents(await api.objectEvents(kind, r.index, varIndex, params.threshold, params.gap, b));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const changeKind = (k: Kind) => {
    setKind(k);
    setV(-1);
    if (k !== "node" && scope === "outfalls") setScope("all");
  };

  if (!results) return <div className="panel-empty">Load results to compute event statistics.</div>;
  const unit = vars[varIndex]?.unit ?? "";
  const r = row !== null ? table?.rows[row] : null;
  const time = (p: number) => (src ? formatDateTime(periodMs(src, p)) : String(p));
  const jump = (p: number) => {
    // Times of run B are shown on the timeline of the loaded run.
    if (!b || !src) return setState({ period: p });
    const ms = periodMs(src, p);
    const a = getState().model?.results;
    if (a) setState({ period: Math.max(0, Math.min(a.n_periods - 1, Math.round((ms - a.start_ms) / (a.step_secs * 1000)))) });
  };
  const headers = ["Object", "Events", "Events / year", `Total (${table?.total_unit ?? ""})`, "Duration (h)", `Max peak (${table?.unit ?? unit})`];
  const evHeaders = ["Start", "End", "Duration (h)", `Peak (${unit})`, "Time of peak", `Total (${table?.total_unit ?? ""})`];
  const evRows: CellValue[][] = events?.map((e) => [time(e.start), time(e.end - 1), e.hours, e.peak, time(e.peak_period), e.total]) ?? [];
  return (
    <div className="events-panel">
      <div className="panel-toolbar">
        <select value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
          <option value="node">Nodes</option>
          <option value="link">Links</option>
          <option value="subcatchment">Subcatchments</option>
        </select>
        <select value={varIndex} onChange={(e) => setV(Number(e.target.value))}>
          {vars.map((x, i) => (
            <option key={x.name} value={i}>
              {x.name}
            </option>
          ))}
        </select>
        <label title="An event is a period of values strictly above the threshold">
          above
          <input className="narrow" value={threshold} onChange={(e) => setThreshold(e.target.value)} /> {unit}
        </label>
        <label title="Events closer than this are merged into one">
          min. inter-event
          <input className="narrow" value={gap} onChange={(e) => setGap(e.target.value)} /> h
        </label>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="all">all {kind}s</option>
          <option value="selected">selected {kind}s</option>
          {kind === "node" && <option value="outfalls">outfalls</option>}
        </select>
        {compare && (
          <label title="Statistics of the compared run">
            <input type="checkbox" checked={b} onChange={(e) => setB(e.target.checked)} /> run B
          </label>
        )}
        <button className="primary" disabled={busy || !valid} onClick={compute}>
          {busy ? "Computing…" : "Compute"}
        </button>
        {table && (
          <span className="muted">
            {table.rows.length} objects · {formatNumber(table.years)} years · {table.seconds.toFixed(2)} s
          </span>
        )}
        <span className="grow" />
        <button disabled={!table} onClick={() => exportTable("events", "Events", headers, rows)}>
          Export
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {!table && !error && (
        <div className="panel-empty">
          Counts the events of a variable above a threshold over the run (e.g. overflows at outfalls: total inflow above 0, 6 h apart), with
          their frequency per year, volume, duration and peak. Click a row for its events; click an event to jump to it.
        </div>
      )}
      {table && (
        <div className="events-body">
          <div className="events-main">
            <VirtualTable
              columns={[{ title: headers[0] }, ...headers.slice(1).map((t) => ({ title: t, numeric: true, format: num }))]}
              rows={rows}
              onRow={pick}
              active={row}
              resetKey={table}
            />
          </div>
          <div className="events-side">
            {r ? (
              <>
                <div className="panel-toolbar">
                  <b>{r.id}</b>
                  <span className="muted">{r.count} events</span>
                  <span className="grow" />
                  <button onClick={() => addToPlot(kind as ElementKind, r.index, varIndex, b)}>Plot</button>
                  <button onClick={() => exportTable(`events_${r.id}`, r.id, evHeaders, evRows)}>Export</button>
                </div>
                <table className="kv years">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th>Events</th>
                      <th>Total</th>
                      <th>Hours</th>
                      <th>Peak</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.years.map((y) => (
                      <tr key={y.year}>
                        <td>{y.year}</td>
                        <td className="num">{y.count}</td>
                        <td className="num">{formatNumber(y.total)}</td>
                        <td className="num">{formatNumber(y.hours)}</td>
                        <td className="num">{y.peak === null ? "–" : formatNumber(y.peak)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <VirtualTable
                  columns={evHeaders.map((t, i) => ({ title: t, numeric: i === 2 || i === 3 || i === 5, format: i === 2 || i === 3 || i === 5 ? num : undefined }))}
                  rows={evRows}
                  onRow={(i) => events && jump(events[i].start)}
                  resetKey={events}
                />
              </>
            ) : (
              <div className="panel-empty">Click an object for its events.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
