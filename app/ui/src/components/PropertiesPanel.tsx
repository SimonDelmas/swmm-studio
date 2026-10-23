import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { formatDateTime, periodMs } from "../format";
import { getState, setState, useStore } from "../store";
import type { ElementKind, ObjectInfo, ObjKind, ObjRef } from "../types";
import { addToPlot } from "./PlotPanel";

const KIND_LABEL: Record<ObjKind, string> = { node: "Nodes", link: "Links", subcatchment: "Subcatchments", gage: "Rain gages" };

function select(o: ObjRef) {
  setState({ selection: [o] });
}

function MultiSelection({ selection }: { selection: ObjRef[] }) {
  const ids = useStore((s) => s.ids);
  useEffect(() => {
    const need = Array.from(new Set(selection.map((o) => o.kind))).filter((k) => !getState().ids[k]);
    if (need.length === 0) return;
    Promise.all(need.map((k) => api.ids(k))).then((all) => {
      const next = { ...getState().ids };
      need.forEach((k, i) => (next[k] = all[i]));
      setState({ ids: next });
    });
  }, [selection]);
  const counts = new Map<ObjKind, number>();
  selection.forEach((o) => counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1));
  return (
    <div className="props">
      <h3>{selection.length} objects selected</h3>
      <div>
        {Array.from(counts).map(([k, n]) => (
          <div key={k}>
            {KIND_LABEL[k]}: {n}
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={() => setState({ fitSelection: getState().fitSelection + 1 })}>Zoom to selection</button>
        <button onClick={() => setState({ selection: [] })}>Clear</button>
      </div>
      <div className="id-list">
        {selection.slice(0, 300).map((o) => (
          <a key={`${o.kind}${o.index}`} onClick={() => select(o)}>
            {ids[o.kind]?.[o.index] ?? `${o.kind} #${o.index + 1}`}
          </a>
        ))}
        {selection.length > 300 && <span className="muted">… {selection.length - 300} more</span>}
      </div>
    </div>
  );
}

export function PropertiesPanel() {
  const selection = useStore((s) => s.selection);
  const period = useStore((s) => s.period);
  const results = useStore((s) => s.model?.results ?? null);
  const [info, setInfo] = useState<ObjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const one = selection.length === 1 ? selection[0] : null;

  useEffect(() => {
    if (!one) return setInfo(null);
    const t = setTimeout(
      () => {
        api
          .objectInfo(one, results ? period : null)
          .then((i) => {
            setInfo(i);
            setError(null);
          })
          .catch((e) => setError(errorText(e)));
      },
      info && info.object.kind === one.kind && info.object.index === one.index ? 120 : 0,
    );
    return () => clearTimeout(t);
  }, [one?.kind, one?.index, period, results?.path, results?.cache.state]);

  if (selection.length === 0)
    return (
      <div className="panel-empty">
        Click an object on the map to see its properties. Use the box or lasso tools (or Shift) to select several.
      </div>
    );
  if (!one) return <MultiSelection selection={selection} />;
  if (error) return <div className="panel-error">{error}</div>;
  if (!info) return <div className="panel-empty">Loading…</div>;

  return (
    <div className="props">
      <h3>
        {info.id} <span className="muted">{info.type}</span>
      </h3>
      <div className="row">
        <button onClick={() => setState({ fitSelection: getState().fitSelection + 1 })}>Zoom to</button>
        {results && one.kind !== "gage" && (
          <button onClick={() => addToPlot(one.kind as ElementKind, one.index, one.kind === "subcatchment" ? 4 : 0)}>
            Plot
          </button>
        )}
      </div>
      {info.results && results && (
        <>
          <h4>Results at {formatDateTime(periodMs(results, period))}</h4>
          <table className="kv">
            <thead>
              <tr>
                <th></th>
                <th>Value</th>
                <th>Max</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {info.results.map((v, i) => (
                <tr key={v.name}>
                  <td>
                    <a title="Plot" onClick={() => addToPlot(one.kind as ElementKind, one.index, i)}>
                      {v.name}
                    </a>
                  </td>
                  <td className="num">{formatNumber(v.value)}</td>
                  <td className="num">
                    {v.max !== null && v.max_period !== null ? (
                      <a title={`At ${formatDateTime(periodMs(results, v.max_period))}: go`} onClick={() => setState({ period: v.max_period! })}>
                        {formatNumber(v.max)}
                      </a>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="muted">{v.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {info.connections.length > 0 && (
        <>
          <h4>Connections</h4>
          <table className="kv">
            <tbody>
              {info.connections.map((c, i) => (
                <tr key={i}>
                  <td>{c.role}</td>
                  <td>
                    <a onClick={() => select(c.object)}>{c.id}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {info.groups.map((g, i) => (
        <div key={i}>
          <h4>[{g.title}]</h4>
          <table className="kv">
            <tbody>
              {g.fields.map(([k, v], j) => (
                <tr key={j}>
                  <td>{k}</td>
                  <td className="mono">{v}</td>
                </tr>
              ))}
              {g.comment && (
                <tr>
                  <td>Comment</td>
                  <td className="muted">{g.comment}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
