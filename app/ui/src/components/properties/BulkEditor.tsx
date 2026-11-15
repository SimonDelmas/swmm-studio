import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { tryEdit } from "../../edit";
import type { ObjectInfo, ObjKind, ObjRef } from "../../types";

export const KIND_LABEL: Record<ObjKind, string> = { node: "Nodes", link: "Links", subcatchment: "Subcatchments", gage: "Rain gages" };

export function BulkEditor({ selection }: { selection: ObjRef[] }) {
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
