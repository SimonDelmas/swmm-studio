import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { baseName, chooseObservedFile, observedLink, saveObserved } from "../actions/observed";
import { formatDateTime } from "../format";
import { useStore } from "../store";
import type { DateOrder, ObservedFile, ObservedLink } from "../types";
import { Modal } from "./Modal";

type Kind = ObservedLink["kind"];

const ORDERS: [DateOrder, string][] = [
  ["auto", "found from the dates"],
  ["dmy", "day first (31/01/2024)"],
  ["mdy", "month first (01/31/2024)"],
];

/** Keeps the columns of `mapping` that the file still has. */
function keep(mapping: Record<string, string>, f: ObservedFile): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).filter(([v, c]) => f.series.includes(c) && f.variables.some((x) => x.name === v)));
}

/** The unit written in the title of column `col`, if variable `v` can be in it and it is not the results' unit. */
function titleUnit(f: ObservedFile, col: string, v: string): string | undefined {
  const u = f.column_units[col];
  const opts = f.unit_options[v] ?? [];
  return u && opts.includes(u) && u !== opts[0] ? u : undefined;
}

/**
 * Links a file of observed series to an object: the file, its sheet, its column of dates
 * and the column of each variable of the object (proposed from the column titles).
 */
export function ObservedDialog({ kind, id, onClose }: { kind: Kind; id: string; onClose: () => void }) {
  const existing = useStore((s) => observedLink(kind, id, s.model));
  const flowUnits = useStore((s) => s.model?.results?.flow_units ?? s.model?.flow_units ?? "");
  const [file, setFile] = useState<ObservedFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  /** Unit of each mapped variable's column, when not the results' unit. */
  const [unitOf, setUnitOf] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<DateOrder>(existing?.date_order ?? "auto");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const req = useRef(0);

  /** Reads the file with these settings; `map`, `units`: the mapping to keep (default: the one proposed). */
  const read = async (
    path: string,
    sheet: string | null,
    time: string | null,
    o: DateOrder,
    map?: Record<string, string>,
    units?: Record<string, string>,
  ) => {
    const n = ++req.current;
    setBusy(true);
    try {
      const f = await api.inspectObserved(path, kind, id, sheet, time, o);
      if (n !== req.current) return;
      setFile(f);
      setOrder(o);
      const kept = map ? keep(map, f) : {};
      if (Object.keys(kept).length > 0) {
        setMapping(kept);
        setUnitOf(Object.fromEntries(Object.entries(units ?? {}).filter(([v, u]) => kept[v] && f.unit_options[v]?.includes(u))));
      } else {
        setMapping(f.mapping);
        setUnitOf(f.units);
      }
      setError(null);
    } catch (e) {
      if (n === req.current) setError(errorText(e));
    } finally {
      if (n === req.current) setBusy(false);
    }
  };

  const choose = async () => {
    const path = await chooseObservedFile();
    if (path) await read(path, null, null, "auto");
  };

  // Opens on the linked file, else asks for one.
  useEffect(() => {
    if (existing)
      void read(existing.file, existing.sheet ?? null, existing.time_column, existing.date_order, existing.columns, existing.units ?? {});
    else void choose();
  }, []);

  const ok = async () => {
    if (!file?.time_column) return;
    setBusy(true);
    try {
      await saveObserved(kind, id, {
        kind,
        id,
        file: file.path,
        sheet: file.format === "workbook" ? file.sheet : null,
        time_column: file.time_column,
        date_order: order,
        columns: mapping,
        units: Object.fromEntries(Object.entries(unitOf).filter(([v]) => mapping[v])),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await saveObserved(kind, id, null);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const mapped = new Set(Object.values(mapping));
  const canSave = !!file && !!file.time_column && !file.time_error && Object.keys(mapping).length > 0 && !busy;

  return (
    <Modal title={`Observed data of ${id}`} className="wide-modal observed-modal">
      <div className="row">
        <button onClick={choose} disabled={busy}>
          {file ? "Other file…" : "Choose a file…"}
        </button>
        {file && (
          <span className="observed-path" title={file.path}>
            {baseName(file.path)}
          </span>
        )}
        {busy && <span className="muted">Reading…</span>}
      </div>
      {!file && !busy && !error && <p className="muted">A CSV, text, Excel, OpenDocument or Parquet file with a column of dates and times.</p>}
      {file && (
        <>
          <div className="row">
            {file.format === "workbook" && (
              <label>
                Sheet{" "}
                <select value={file.sheet ?? ""} onChange={(e) => read(file.path, e.target.value, null, order)}>
                  {file.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Dates and times{" "}
              <select value={file.time_column ?? ""} onChange={(e) => read(file.path, file.sheet, e.target.value, order, mapping)}>
                {!file.time_column && <option value="">—</option>}
                {file.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.kind === "time" ? " (dates)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label title="How to read dates such as 01/02/2024">
              Dates{" "}
              <select value={order} onChange={(e) => read(file.path, file.sheet, file.time_column, e.target.value as DateOrder, mapping)}>
                {ORDERS.map(([o, label]) => (
                  <option key={o} value={o}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {file.time_error ? (
            <div className="panel-error">{file.time_error}</div>
          ) : (
            <p className="muted">
              {file.rows} rows
              {file.start_ms !== null && file.end_ms !== null && `, ${formatDateTime(file.start_ms)} – ${formatDateTime(file.end_ms)}`}
              {file.skipped > 0 && `; ${file.skipped} without a date that can be read (left out)`}
              {file.date_order_ambiguous && order === "auto" && ". The dates could be day or month first: read day first."}
            </p>
          )}
          <h4>Series of {id}</h4>
          {file.series.length === 0 ? (
            <div className="panel-error">The file has no column of numbers.</div>
          ) : (
            <table className="kv edit observed-mapping">
              <tbody>
                {file.variables.map((v) => (
                  <tr key={v.name}>
                    <td>{v.name}</td>
                    <td>
                      <select
                        value={mapping[v.name] ?? ""}
                        onChange={(e) => {
                          const m = { ...mapping };
                          const u = { ...unitOf };
                          delete u[v.name];
                          if (e.target.value) {
                            m[v.name] = e.target.value;
                            // The unit written in the column's title, if the variable can be in it.
                            const t = titleUnit(file, e.target.value, v.name);
                            if (t) u[v.name] = t;
                          } else delete m[v.name];
                          setMapping(m);
                          setUnitOf(u);
                        }}
                      >
                        <option value="">—</option>
                        {file.series.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="unit">
                      {mapping[v.name] && (file.unit_options[v.name]?.length ?? 0) > 1 ? (
                        <select
                          title={`Unit of the column; the values are converted to ${v.unit}`}
                          value={unitOf[v.name] ?? file.unit_options[v.name][0]}
                          onChange={(e) => {
                            const u = { ...unitOf };
                            if (e.target.value === file.unit_options[v.name][0]) delete u[v.name];
                            else u[v.name] = e.target.value;
                            setUnitOf(u);
                          }}
                        >
                          {file.unit_options[v.name].map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted">{v.unit}</span>
                      )}
                    </td>
                    <td className="muted">{unitOf[v.name] && mapping[v.name] ? `→ ${v.unit}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">
            The values are converted from the unit chosen to the unit of the results{flowUnits ? ` (flows in ${flowUnits})` : ""}.
          </p>
          <div className="observed-preview">
            <table className="kv">
              <thead>
                <tr>
                  {file.columns.map((c) => (
                    <th key={c.name} className={c.name === file.time_column ? "time" : mapped.has(c.name) ? "mapped" : undefined}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {file.preview.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error && <div className="panel-error">{error}</div>}
      <div className="row end">
        {existing && (
          <button className="danger" onClick={remove} disabled={busy}>
            Remove the link
          </button>
        )}
        <span className="grow" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!canSave} onClick={ok}>
          OK
        </button>
      </div>
    </Modal>
  );
}
