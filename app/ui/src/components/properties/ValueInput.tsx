import { ObjLink } from "../ObjLink";
import { resolveName, useNameIndex } from "../../hooks/useNameIndex";
import { useEffect, useState } from "react";
import { errorText } from "../../api";
import type { Field, ObjKind, RefKind } from "../../types";
import { useNames } from "../../hooks/useNames";

/** Kinds whose names are offered in a list (the network kinds can be far too many). */
export const LISTED: RefKind[] = ["gage", "curve", "timeseries", "pattern", "hydrograph", "transect", "street", "snowpack", "aquifer"];

/** Reference kinds naming objects of the network (an outlet is a node or a subcatchment). */
export const OBJECT_REF: Partial<Record<RefKind, ObjKind | null>> = { node: "node", link: "link", subcatchment: "subcatchment", gage: "gage", outlet: null };

/** Selects the object a reference field names, when there is one. */
export function RefJump({ name, kind }: { name: string; kind: ObjKind | null | undefined }) {
  const o = resolveName(useNameIndex(), name, kind);
  return o ? (
    <ObjLink obj={o} zoom={false} title={`Select ${name}`}>
      ➜
    </ObjLink>
  ) : null;
}

export function NameList({ id, kind }: { id: string; kind: RefKind }) {
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
