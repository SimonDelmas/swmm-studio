import { LinkButton } from "./LinkButton";
import { useState } from "react";
import { edit } from "../actions/edit";
import { setState, useStore } from "../store";
import type { TableKind } from "../types";
import { useNames } from "../hooks/useNames";

const KINDS: [TableKind, string][] = [
  ["hydrograph", "Unit hydrographs (RDII)"],
  ["curve", "Curves"],
  ["timeseries", "Time series"],
  ["pattern", "Time patterns"],
  ["transect", "Transects"],
  ["aquifer", "Aquifers"],
  ["snowpack", "Snow packs"],
];

function Category({ kind, title }: { kind: TableKind; title: string }) {
  const names = useNames(kind);
  const [open, setOpen] = useState(kind === "hydrograph" || names.length < 30);
  const openEditor = (name: string) => setState({ tableEditor: { kind, name } });
  const add = async () => {
    const o = await edit({ op: "add_table", kind });
    if (o?.created) openEditor(o.created);
  };
  return (
    <div className="data-cat">
      <div className="data-head">
        <LinkButton onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {title}
        </LinkButton>
        <span className="muted">{names.length}</span>
        <span className="grow" />
        <button title={`New ${title.toLowerCase()}`} onClick={add}>
          +
        </button>
      </div>
      {open && (
        <div className="data-list">
          {names.map((n) => (
            <div key={n} className="data-item" onDoubleClick={() => openEditor(n)}>
              <LinkButton onClick={() => openEditor(n)}>{n}</LinkButton>
              <span className="grow" />
              <LinkButton
                className="muted"
                title="Delete"
                onClick={() => edit({ op: "delete_table", kind, name: n })}
              >
                ✕
              </LinkButton>
            </div>
          ))}
          {names.length === 0 && <div className="muted data-item">None</div>}
        </div>
      )}
    </div>
  );
}

/** Non-visual data of the model (simulation options are in the header). */
export function DataPanel() {
  const model = useStore((s) => s.model);
  if (!model) return <div className="panel-empty">Open a model.</div>;
  return (
    <div className="data-panel">
      <div className="row">
        <button onClick={() => setState({ dialog: "climate" })} title="Evaporation, temperature, wind speed, snowmelt, areal depletion, monthly adjustments">
          Climatology…
        </button>
        <button onClick={() => setState({ dialog: "sections" })} title="Raw text of any section (water quality, LID…)">
          Sections as text…
        </button>
        <button onClick={() => setState({ bottomTab: "table" })} title="Edit the objects of a section in a table">
          Tables
        </button>
      </div>
      {KINDS.map(([k, t]) => (
        <Category key={k} kind={k} title={t} />
      ))}
    </div>
  );
}
