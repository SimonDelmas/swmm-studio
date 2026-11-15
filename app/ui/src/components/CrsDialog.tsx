import { useEffect, useState } from "react";
import { applyCrs } from "../actions/model";
import { api, errorText } from "../api";
import { setState, useStore } from "../store";
import type { CrsEntry } from "../types";
import { Modal } from "./Modal";
import { latest } from "../latest";

export function CrsDialog() {
  const model = useStore((s) => s.model);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<CrsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q.startsWith("+")) return setList([]);
    return latest(() => api.searchCrs(q), setList, (e) => setError(errorText(e)), 150);
  }, [query]);

  if (!model) return null;
  const use = (id: string | null) => applyCrs(id).catch((e) => setError(errorText(e)));
  const close = () => setState({ crsDialog: false });
  return (
    <Modal title="Coordinate system of the model" onClose={close}>
        <p className="muted">
          The coordinates in the .inp file stay unchanged; they are converted for display over the basemap. Current:{" "}
          <b>{model.crs ? `${model.crs.id} – ${model.crs.name}` : "none (local coordinates)"}</b>
        </p>
        {model.crs_hint && !model.crs && (
          <p>
            Suggested from the coordinates:{" "}
            <button className="primary" onClick={() => use(model.crs_hint!.id)}>
              {model.crs_hint.id} – {model.crs_hint.name}
            </button>
          </p>
        )}
        <input
          autoFocus
          className="wide"
          placeholder="EPSG code or name, e.g. 2154, Lambert-93, CC44, UTM 31N, or a PROJ string (+proj=…)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim().startsWith("+")) use(query.trim());
            if (e.key === "Escape") close();
          }}
        />
        {query.trim().startsWith("+") && (
          <button className="primary" onClick={() => use(query.trim())}>
            Use this PROJ string
          </button>
        )}
        <div className="crs-list">
          {list.map((c) => (
            <div key={c.id} className="crs-item" onClick={() => use(c.id)}>
              <b>{c.id}</b> {c.name} {c.geographic && <span className="muted">(geographic)</span>}
            </div>
          ))}
          {query.trim().length >= 2 && !query.trim().startsWith("+") && list.length === 0 && (
            <div className="muted">No match.</div>
          )}
        </div>
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button onClick={() => use(null)}>None (local coordinates)</button>
          <button onClick={close}>Cancel</button>
        </div>
    </Modal>
  );
}
