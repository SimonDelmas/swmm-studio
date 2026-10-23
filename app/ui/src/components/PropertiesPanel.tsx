import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { deleteObjects, edit, tryEdit } from "../edit";
import { formatDateTime, periodMs } from "../format";
import { getState, setState, useStore } from "../store";
import type { ElementKind, Field, ObjectInfo, ObjKind, ObjRef, PropertyGroup, RefKind } from "../types";
import { addToPlot } from "./PlotPanel";

const KIND_LABEL: Record<ObjKind, string> = { node: "Nodes", link: "Links", subcatchment: "Subcatchments", gage: "Rain gages" };

/** Kinds whose names are offered in a list (the network kinds can be far too many). */
const LISTED: RefKind[] = ["gage", "curve", "timeseries", "pattern", "hydrograph", "transect", "street", "snowpack"];

function select(o: ObjRef) {
  setState({ selection: [o] });
}

/** Names of objects of a kind, reloaded when the model changes. */
export function useNames(kind: RefKind | null): string[] {
  const revision = useStore((s) => s.model?.revision ?? 0);
  const path = useStore((s) => s.model?.path);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!kind || !path) return setNames([]);
    api.names(kind).then(setNames, () => setNames([]));
  }, [kind, revision, path]);
  return names;
}

function NameList({ id, kind }: { id: string; kind: RefKind }) {
  const names = useNames(kind);
  return (
    <datalist id={id}>
      {names.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}

/** One editable value: committed on Enter or when leaving the field, Escape restores it. */
export function ValueInput({
  field,
  onCommit,
  listId,
}: {
  field: Field;
  onCommit: (v: string) => Promise<unknown>;
  listId?: string;
}) {
  const [text, setText] = useState(field.value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(field.value);
    setError(null);
  }, [field.value]);
  const commit = (v: string) => {
    if (v.trim() === field.value) return setError(null);
    onCommit(v.trim()).then(
      () => setError(null),
      (e) => setError(errorText(e)),
    );
  };
  if (field.type === "choice") {
    const options = field.options.includes(field.value) || !field.value ? field.options : [field.value, ...field.options];
    return (
      <>
        <select value={field.value || field.default} onChange={(e) => commit(e.target.value)}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        {error && <div className="field-error">{error}</div>}
      </>
    );
  }
  return (
    <>
      <input
        className={`value ${error ? "invalid" : ""}`}
        value={text}
        placeholder={field.present ? "" : field.default}
        list={listId}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(field.value);
            setError(null);
          }
        }}
      />
      {error && <div className="field-error">{error}</div>}
    </>
  );
}

function GroupEditor({ g, info }: { g: PropertyGroup; info: ObjectInfo }) {
  const main = g.fields[0]?.type === "id";
  return (
    <div>
      <h4>
        [{g.title}]
        {g.removable && (
          <a
            className="group-action"
            title="Remove this line"
            onClick={() => edit({ op: "remove_line", section: g.section, key: g.key })}
          >
            remove
          </a>
        )}
      </h4>
      <table className="kv edit">
        <tbody>
          {g.fields.map((f, j) => {
            // The key of secondary lines is the object itself: shown once, at the top.
            if (j < g.key.length && !main) return null;
            const listId = f.type === "ref" && LISTED.includes(f.to) ? `names-${f.to}` : undefined;
            return (
              <tr key={j} className={f.present ? "" : "absent"}>
                <td title={f.key ?? undefined}>{f.name}</td>
                <td>
                  {!g.editable || f.key === null ? (
                    <span className="mono">{f.value}</span>
                  ) : f.type === "id" ? (
                    <ValueInput
                      field={f}
                      onCommit={(v) => tryEdit({ op: "rename", kind: info.object.kind, old: info.id, new: v })}
                    />
                  ) : (
                    <ValueInput
                      field={f}
                      listId={listId}
                      onCommit={(v) => tryEdit({ op: "set_field", section: g.section, key: g.key, field: j, value: v })}
                    />
                  )}
                </td>
                <td className="muted unit">{f.unit}</td>
              </tr>
            );
          })}
          {g.comment && (
            <tr>
              <td>Comment</td>
              <td className="muted" colSpan={2}>
                {g.comment}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function BulkEditor({ selection }: { selection: ObjRef[] }) {
  const [sample, setSample] = useState<ObjectInfo | null>(null);
  const [kind, setKind] = useState<ObjKind | null>(null);
  const [group, setGroup] = useState(0);
  const [field, setField] = useState(1);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const kinds: ObjKind[] = Array.from(new Set(selection.map((o) => o.kind))).filter((k) => k !== "gage");
  const k = kind && kinds.includes(kind) ? kind : (kinds[0] ?? null);
  useEffect(() => {
    const first = selection.find((o) => o.kind === k);
    if (!first) return setSample(null);
    api.objectInfo(first, null).then(setSample, () => setSample(null));
  }, [k, selection]);
  if (!k || !sample) return null;
  const groups = sample.groups.filter((g) => g.editable);
  const g = groups[Math.min(group, groups.length - 1)];
  if (!g) return null;
  const fields = g.fields.map((f, i) => ({ f, i })).filter(({ f, i }) => i >= g.key.length && f.key && f.type !== "id");
  const fsel = fields.find((x) => x.i === field) ?? fields[0];
  const objects = selection.filter((o) => o.kind === k);
  const apply = () => {
    if (!fsel) return;
    tryEdit({ op: "set_field_bulk", objects, section: g.section, field: fsel.f.key!, value }).then(
      () => setError(null),
      (e) => setError(errorText(e)),
    );
  };
  return (
    <div className="bulk">
      <h4>Set a value on the selection</h4>
      <div className="row">
        {kinds.length > 1 && (
          <select value={k} onChange={(e) => setKind(e.target.value as ObjKind)}>
            {kinds.map((x) => (
              <option key={x} value={x}>
                {KIND_LABEL[x]}
              </option>
            ))}
          </select>
        )}
        <select value={groups.indexOf(g)} onChange={(e) => setGroup(Number(e.target.value))}>
          {groups.map((x, i) => (
            <option key={i} value={i}>
              {x.section}
            </option>
          ))}
        </select>
        <select value={fsel?.i} onChange={(e) => setField(Number(e.target.value))}>
          {fields.map(({ f, i }) => (
            <option key={i} value={i}>
              {f.name}
              {f.unit ? ` (${f.unit})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        {fsel?.f.type === "choice" ? (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value=""></option>
            {fsel.f.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        ) : (
          <input className="value" value={value} placeholder="value" onChange={(e) => setValue(e.target.value)} />
        )}
        <button className="primary" disabled={!fsel} onClick={apply}>
          Apply to {objects.length} {KIND_LABEL[k].toLowerCase()}
        </button>
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

/** Assigns a unit hydrograph and sewershed area to the selected nodes. */
function RdiiAssign({ nodes }: { nodes: number[] }) {
  const uhs = useNames("hydrograph");
  const [uh, setUh] = useState("");
  const [area, setArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hydrograph = uh || uhs[0] || "";
  const areaUnit = useStore((s) => (s.model && ["CMS", "LPS", "MLD"].includes(s.model.flow_units) ? "ha" : "ac"));
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e) => setError(errorText(e)));
  return (
    <div className="bulk">
      <h4>RDII of the {nodes.length} selected node(s)</h4>
      <div className="row">
        <label>
          Unit hydrograph
          <select value={hydrograph} onChange={(e) => setUh(e.target.value)}>
            {uhs.length === 0 && <option value="">(none defined)</option>}
            {uhs.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label title="Leave empty to keep each node's sewershed area (0 for new assignments)">
          Area <input className="narrow" value={area} placeholder="keep" onChange={(e) => setArea(e.target.value)} />
          <span className="muted">{areaUnit}</span>
        </label>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={!hydrograph}
          onClick={() => run(tryEdit({ op: "assign_rdii", nodes, hydrograph, area: area.trim() || null }))}
        >
          Assign
        </button>
        <button onClick={() => run(tryEdit({ op: "remove_rdii", nodes }))}>Remove RDII</button>
        <button onClick={() => setState({ sideTab: "data" })}>Unit hydrographs…</button>
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
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
  const nodes = selection.filter((o) => o.kind === "node").map((o) => o.index);
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
        <button className="danger" onClick={() => deleteObjects(selection)}>
          Delete…
        </button>
      </div>
      <BulkEditor selection={selection} />
      {nodes.length > 0 && <RdiiAssign nodes={nodes} />}
      <h4>Objects</h4>
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
  const revision = useStore((s) => s.model?.revision ?? 0);
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
  }, [one?.kind, one?.index, period, results?.path, results?.cache.state, revision]);

  if (selection.length === 0)
    return (
      <div className="panel-empty">
        Click an object on the map to see and edit its properties. Use the box or lasso tools (or Shift) to select several
        and edit them together.
      </div>
    );
  if (!one) return <MultiSelection selection={selection} />;
  if (error) return <div className="panel-error">{error}</div>;
  if (!info || info.object.kind !== one.kind || info.object.index !== one.index)
    return <div className="panel-empty">Loading…</div>;

  const refKinds = new Set<RefKind>();
  info.groups.forEach((g) => g.fields.forEach((f) => f.type === "ref" && LISTED.includes(f.to) && refKinds.add(f.to)));

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
                    <a onClick={() => select(c.object)}>{c.id}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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
                      <a
                        title={`At ${formatDateTime(periodMs(results, v.max_period))}: go`}
                        onClick={() => setState({ period: v.max_period! })}
                      >
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
    </div>
  );
}
