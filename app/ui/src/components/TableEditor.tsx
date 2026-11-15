// Editors of curves, time series, time patterns, unit hydrographs and transects.

import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { tryEdit } from "../edit";
import { setState, useStore } from "../store";
import type { Table } from "../types";
import { Modal } from "./Modal";
import { CurveForm, HydrographForm, PatternForm, TimeseriesForm, TransectForm } from "./tables/forms";

const TITLES: Record<Table["kind"], string> = {
  curve: "Curve",
  timeseries: "Time series",
  pattern: "Time pattern",
  hydrograph: "Unit hydrograph",
  transect: "Transect",
};

export function TableEditor() {
  const target = useStore((s) => s.tableEditor);
  const [table, setTable] = useState<Table | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    // Nothing of the table shown before stays while the new one loads (or fails to).
    setTable(null);
    setDirty(false);
    setError(null);
    if (!target) return;
    setName(target.name);
    let current = true;
    api.table(target.kind, target.name).then(
      (t) => {
        if (!current) return;
        setTable(t);
        setName(t.name);
      },
      (e) => current && setError(errorText(e)),
    );
    return () => {
      current = false;
    };
  }, [target?.kind, target?.name]);

  if (!target) return null;
  const close = () => setState({ tableEditor: null });
  const set = (t: Table) => {
    setTable(t);
    setDirty(true);
  };
  const apply = async (andClose: boolean) => {
    if (!table) return;
    try {
      const t = { ...table, name: name.trim() } as Table;
      await tryEdit({ op: "set_table", table: t, old_name: target.name });
      setDirty(false);
      setError(null);
      if (andClose) close();
      else setState({ tableEditor: { kind: target.kind, name: t.name } });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal
      title={`${TITLES[target.kind]} ${name}`}
      heading={
        <>
          {TITLES[target.kind]}{" "}
          <input
            className="name-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </>
      }
      // Changes are dropped with the Discard button only, not by a click outside or Escape.
      onClose={dirty ? undefined : close}
      className="wide-modal"
    >
        {!table && !error && <div className="muted">Loading…</div>}
        {table?.kind === "curve" && <CurveForm t={table} set={set} />}
        {table?.kind === "timeseries" && <TimeseriesForm t={table} set={set} />}
        {table?.kind === "pattern" && <PatternForm t={table} set={set} />}
        {table?.kind === "hydrograph" && <HydrographForm t={table} set={set} />}
        {table?.kind === "transect" && <TransectForm t={table} set={set} />}
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button className="primary" onClick={() => apply(true)} disabled={!table}>
            OK
          </button>
          <button onClick={() => apply(false)} disabled={!table || !dirty}>
            Apply
          </button>
          <button onClick={close}>{dirty ? "Discard" : "Close"}</button>
        </div>
    </Modal>
  );
}
