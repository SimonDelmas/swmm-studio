import { zoomToSelection } from "../actions/selection";
import { ObjLink } from "./ObjLink";
import { LinkButton } from "./LinkButton";
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatDateTime, formatNumber, periodMs } from "../format";
import { deleteObjects, edit } from "../actions/edit";
import { notify, setState, useStore } from "../store";
import type { ElementKind, ObjectInfo, RefKind } from "../types";
import { addToPlot } from "../plot/series";
import { startSeriesDrag } from "../dragSeries";
import { GroupEditor } from "./properties/GroupEditor";
import { MultiSelection } from "./properties/MultiSelection";
import { LISTED, NameList } from "./properties/ValueInput";
import { latest } from "../latest";
import { baseName, observedLink, saveObserved } from "../actions/observed";
import { ObservedDialog } from "./ObservedDialog";

/** The file of observed series linked to the object, the column of each variable, and the dialog to link one. */
function ObservedSection({ kind, index, id }: { kind: "node" | "link" | "subcatchment"; index: number; id: string }) {
  const link = useStore((s) => observedLink(kind, id, s.model));
  const results = useStore((s) => s.model?.results ?? null);
  const [open, setOpen] = useState(false);
  const plot = (name: string) => {
    const v = results?.variables[kind].findIndex((x) => x.name === name) ?? -1;
    if (v >= 0) void addToPlot(kind, index, v, false, undefined, "new");
  };
  const remove = () => saveObserved(kind, id, null).catch((e) => notify(errorText(e), true));
  return (
    <>
      <h4>Observed data</h4>
      {link ? (
        <>
          <div className="muted" title={link.file}>
            {baseName(link.file)}
            {link.sheet ? ` – ${link.sheet}` : ""}
          </div>
          <table className="kv">
            <tbody>
              {Object.entries(link.columns).map(([v, c]) => (
                <tr key={v}>
                  <td>
                    {results?.variables[kind].some((x) => x.name === v) ? (
                      <LinkButton title="Plot the result with the observed values in a new time series tab" onClick={() => plot(v)}>
                        {v}
                      </LinkButton>
                    ) : (
                      v
                    )}
                  </td>
                  <td>{c}</td>
                  <td className="muted">{link.units?.[v] ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button onClick={() => setOpen(true)}>Edit…</button>
            <button onClick={remove}>Remove</button>
          </div>
        </>
      ) : (
        <div className="row">
          <button title="Link a file of measured series (CSV, Excel, Parquet…) to this object" onClick={() => setOpen(true)}>
            Link a file…
          </button>
        </div>
      )}
      {open && <ObservedDialog kind={kind} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PropertiesPanel() {
  const selection = useStore((s) => s.selection);
  const period = useStore((s) => s.period);
  const results = useStore((s) => s.model?.results ?? null);
  const revision = useStore((s) => s.model?.revision ?? 0);
  const [info, setInfo] = useState<ObjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const one = selection.length === 1 ? selection[0] : null;

  useEffect(() => {
    if (!one) return setInfo(null);
    // The values of the object shown follow the time without a request per period played.
    const delay = info && info.object.kind === one.kind && info.object.index === one.index ? 120 : 0;
    return latest(
      () => api.objectInfo(one, results ? period : null),
      (i) => {
        setInfo(i);
        setError(null);
      },
      (e) => setError(errorText(e)),
      delay,
    );
  }, [one?.kind, one?.index, period, results?.path, results?.cache.state, revision]);

  if (selection.length === 0)
    return (
      <div className="panel-empty">
        Click an object on the map to see and edit its properties. Use the box or lasso tools (or Shift) to select several and edit them
        together.
      </div>
    );
  if (!one) return <MultiSelection selection={selection} />;
  if (error) return <div className="panel-error">{error}</div>;
  if (!info || info.object.kind !== one.kind || info.object.index !== one.index) return <div className="panel-empty">Loading…</div>;

  /** Plots result variable `v` of the object in a new time series tab. */
  const plotNew = (v: number) => void addToPlot(one.kind as ElementKind, one.index, v, false, undefined, "new");
  const refKinds = new Set<RefKind>();
  info.groups.forEach((g) => g.fields.forEach((f) => f.type === "ref" && LISTED.includes(f.to) && refKinds.add(f.to)));

  return (
    <div className="props props-split">
      <div className="props-scroll">
        <h3>
          {info.id} <span className="muted">{info.type}</span>
        </h3>
        <div className="row">
          <button onClick={zoomToSelection}>Zoom to</button>
          {results && one.kind !== "gage" && (
            <button
              title="Plot its main result in a new time series tab"
              onClick={() => addToPlot(one.kind as ElementKind, one.index, one.kind === "subcatchment" ? 4 : 0, false, undefined, "new")}
            >
              Plot
            </button>
          )}
          {(one.kind === "link" || one.kind === "subcatchment") && (
            <button title="Drag, add or delete vertices on the map" onClick={() => setState({ tool: "vertex" })}>
              Edit vertices
            </button>
          )}
          <button className="danger" onClick={() => deleteObjects([one])}>
            Delete
          </button>
        </div>
        {Array.from(refKinds).map((k) => (
          <NameList key={k} id={`names-${k}`} kind={k} />
        ))}
        {info.groups.map((g, i) => (
          <GroupEditor key={`${g.section}:${g.key.join(" ")}:${i}`} g={g} info={info} />
        ))}
        {info.addable.length > 0 && (
          <div className="row">
            {info.addable.map((a) => (
              <button key={a.section} onClick={() => edit({ op: "add_line", section: a.section, key: a.key })}>
                + {a.title}
              </button>
            ))}
          </div>
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
                      <ObjLink obj={c.object} zoom={false}>
                        {c.id}
                      </ObjLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {one.kind !== "gage" && <ObservedSection kind={one.kind} index={one.index} id={info.id} />}
      </div>
      {info.results && results && (
        <div className="props-results">
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
                    <LinkButton
                      className="drag-result"
                      title="Click: plot in a new time series tab; drag onto a graph (or a time series tab) to add it there"
                      onPointerDown={(e) =>
                        startSeriesDrag(
                          e,
                          {
                            kind: one.kind as ElementKind,
                            index: one.index,
                            var: i,
                            label: `${info.id} ${v.name}`,
                          },
                          () => plotNew(i),
                        )
                      }
                      onActivate={() => plotNew(i)}
                    >
                      {v.name}
                    </LinkButton>
                  </td>
                  <td className="num">{formatNumber(v.value)}</td>
                  <td className="num">
                    {v.max !== null && v.max_period !== null ? (
                      <LinkButton
                        title={`At ${formatDateTime(periodMs(results, v.max_period))}: go`}
                        onClick={() => setState({ period: v.max_period! })}
                      >
                        {formatNumber(v.max)}
                      </LinkButton>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="muted">{v.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
