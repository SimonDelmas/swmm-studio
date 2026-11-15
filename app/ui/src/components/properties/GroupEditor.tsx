import { NameLink } from "../ObjLink";
import { LinkButton } from "../LinkButton";
import { edit, tryEdit } from "../../edit";
import type { ObjectInfo, PropertyGroup } from "../../types";
import { LISTED, OBJECT_REF, RefJump, ValueInput } from "./ValueInput";

export function GroupEditor({ g, info }: { g: PropertyGroup; info: ObjectInfo }) {
  const main = g.fields[0]?.type === "id";
  return (
    <div>
      <h4>
        [{g.title}]
        {g.removable && (
          <LinkButton
            className="group-action"
            title="Remove this line"
            onClick={() => edit({ op: "remove_line", section: g.section, key: g.key })}
          >
            remove
          </LinkButton>
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
                    <span className="mono">{f.type === "ref" && OBJECT_REF[f.to] !== undefined ? <NameLink name={f.value} kind={OBJECT_REF[f.to]} /> : f.value}</span>
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
                <td className="muted unit">
                  {f.unit}
                  {g.editable && f.key !== null && f.type === "ref" && OBJECT_REF[f.to] !== undefined && f.value && <RefJump name={f.value} kind={OBJECT_REF[f.to]} />}
                </td>
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
