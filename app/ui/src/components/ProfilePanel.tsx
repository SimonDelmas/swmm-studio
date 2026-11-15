import { selectObject, selectObjects } from "../actions/selection";
import { ObjLink } from "./ObjLink";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { exportTable, savePng, saveSvg } from "../exporting";
import { formatDateTime, periodMs } from "../format";
import { getState, setState, updateProfileView, useStore, type ProfileView } from "../store";
import type { ObjRef } from "../types";
import { useSize } from "../useSize";
import { profileFromSelection, saveProfile } from "../profile/profiles";
import { profileInfo, profileSvg, type Selected } from "../profile/svg";

/** A profile tab. */
export function ProfilePanel({ view }: { view: ProfileView }) {
  const nodes = useStore((s) => s.profileNodes);
  const model = useStore((s) => s.model);
  const period = useStore((s) => s.period);
  const results = model?.results ?? null;
  const compare = model?.compare ?? null;
  const dto = useStore((s) => s.profile);
  const selection = useStore((s) => s.selection);
  const profileError = useStore((s) => s.profileError);
  const [headsError, setError] = useState<string | null>(null);
  const error = profileError ?? headsError;
  const [newName, setNewName] = useState("");
  const [heads, setHeads] = useState<Float32Array | null>(null);
  const [headsB, setHeadsB] = useState<Float32Array | null>(null);
  const [showB, setShowB] = useState(true);
  const [sizeRef, size] = useSize<HTMLDivElement>({ w: 800, h: 220 });
  const [tip, setTip] = useState<{ x: number; y: number; hit: ObjRef } | null>(null);
  const unit = model && ["CFS", "GPM", "MGD"].includes(model.flow_units) ? "ft" : "m";

  // Heads at the current time (coalesced while playing).
  const busy = useRef(false);
  // The request to send next: read when the one in flight ends, so it is never stale.
  const want = useRef<{ period: number; nodes: number[]; b: boolean } | null>(null);
  const ids = dto?.nodes.map((n) => n.index) ?? null;
  const idsKey = ids?.join(",") ?? "";
  useEffect(() => {
    setError(null);
    if (!ids || !results) {
      setHeads(null);
      setHeadsB(null);
      return;
    }
    want.current = { period, nodes: ids, b: !!compare && showB };
    const pump = () => {
      const w = want.current;
      if (busy.current || w === null) return;
      want.current = null;
      busy.current = true;
      Promise.all([api.heads(w.nodes, w.period), w.b ? api.heads(w.nodes, w.period, true).catch(() => null) : Promise.resolve(null)])
        .then(([a, b]) => {
          setHeads(a);
          setHeadsB(b);
        })
        .catch((e) => setError(errorText(e)))
        .finally(() => {
          busy.current = false;
          pump();
        });
    };
    pump();
  }, [idsKey, period, results?.path, compare?.path, showB]);

  if (!model) return <div className="panel-empty">Open a model first.</div>;
  const title = dto ? `${dto.nodes[0]?.id} → ${dto.nodes[dto.nodes.length - 1]?.id}` : "";
  const when = results ? formatDateTime(periodMs(results, period)) : "";
  const selected: Selected = {
    nodes: new Set(selection.filter((o) => o.kind === "node").map((o) => o.index)),
    links: new Set(selection.filter((o) => o.kind === "link").map((o) => o.index)),
  };
  const svg = dto ? profileSvg(dto, heads, headsB, size.w, Math.max(120, size.h - 4), { unit, selected }) : "";
  const selectPath = () => {
    if (!dto) return;
    const sel: ObjRef[] = [...dto.links.map((l) => ({ kind: "link" as const, index: l.index })), ...dto.nodes.map((n) => ({ kind: "node" as const, index: n.index }))];
    selectObjects(sel);
  };
  const save = () => {
    const name = (newName.trim() || title).trim();
    if (!dto || !name) return;
    saveProfile(name);
    updateProfileView(view.id, { name });
    setNewName("");
  };
  const exportData = () => {
    if (!dto) return;
    const rows = dto.nodes.map((n, i) => [n.id, n.station, n.invert, n.rim, heads?.[i] ?? null, dto.max_head[i]]);
    exportTable("profile", "Profile", ["Node", `Distance (${unit})`, `Invert (${unit})`, `Ground (${unit})`, `Head at ${when} (${unit})`, `Max head (${unit})`], rows);
  };
  /** The node or conduit under the pointer. */
  const hitOf = (e: React.MouseEvent): ObjRef | null => {
    const g = (e.target as Element).closest("[data-node], [data-link]");
    if (!g) return null;
    const node = g.getAttribute("data-node");
    return node !== null ? { kind: "node", index: Number(node) } : { kind: "link", index: Number(g.getAttribute("data-link")) };
  };
  // Click: select it and show it on the map (panned to when out of view); Ctrl/Shift+click: add or remove it.
  const onClick = (e: React.MouseEvent) => {
    const hit = hitOf(e);
    const st = getState();
    if (!hit) {
      if (!e.ctrlKey && !e.shiftKey && !e.metaKey) setState({ selection: [] });
      return;
    }
    const same = (o: ObjRef) => o.kind === hit.kind && o.index === hit.index;
    let next: ObjRef[] = [hit];
    if (e.ctrlKey || e.shiftKey || e.metaKey) next = st.selection.some(same) ? st.selection.filter((o) => !same(o)) : [...st.selection, hit];
    setState({ selection: next, panSelection: st.panSelection + 1 });
  };
  // Hover: the geometry of the node or conduit under the pointer.
  const onMouseMove = (e: React.MouseEvent) => {
    const hit = hitOf(e);
    setTip(hit ? { x: e.clientX, y: e.clientY, hit } : null);
  };
  const info = tip && dto ? profileInfo(dto, tip.hit, unit) : null;
  // Double-click: zoom the map to it.
  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitOf(e);
    if (hit) selectObject(hit);
  };
  return (
    <div className="plot-panel">
      <div className="panel-toolbar">
        <button onClick={profileFromSelection} title="Profile through the selected nodes, in the order they were selected">
          From selected nodes
        </button>
        {dto && (
          <>
            <span>
              <b title={title}>
                {dto.nodes.length > 0 && (
                  <>
                    <ObjLink obj={{ kind: "node", index: dto.nodes[0].index }}>{dto.nodes[0].id}</ObjLink> →{" "}
                    <ObjLink obj={{ kind: "node", index: dto.nodes[dto.nodes.length - 1].index }}>{dto.nodes[dto.nodes.length - 1].id}</ObjLink>
                  </>
                )}
              </b>{" "}
              · {dto.links.length} links · {formatNumber(dto.nodes[dto.nodes.length - 1].station)} {unit}
            </span>
            <button onClick={selectPath}>Select on map</button>
          </>
        )}
        <input
          className="narrow-name"
          disabled={!dto}
          placeholder={dto ? title : "Profile name"}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button disabled={!dto} onClick={save} title="Save this profile in the project (under the name typed, or its start → end), to reopen it later from the + menu">
          Save
        </button>
        {compare && (
          <label>
            <input type="checkbox" checked={showB} onChange={(e) => setShowB(e.target.checked)} /> run B
          </label>
        )}
        <span className="grow" />
        {results && dto && <span className="muted">{when}</span>}
        <button disabled={!dto} onClick={exportData}>
          Data
        </button>
        <button disabled={!dto} onClick={() => saveSvg("profile", profileSvg(dto!, heads, headsB, 1000, 420, { unit, title: `${title} – ${when}` }))}>
          SVG
        </button>
        <button
          disabled={!dto}
          onClick={() => savePng("profile", { svg: profileSvg(dto!, heads, headsB, 1000, 420, { unit, title: `${title} – ${when}` }), width: 1000, height: 420 })}
        >
          PNG
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {nodes.length < 2 && (
        <div className="panel-empty">
          With the Profile tool (toolbar), click a start node then an end node; Shift+click extends the profile through another node. Or select nodes
          in order and click “From selected nodes”. The profile follows the shortest path; the water line follows the timeline.
        </div>
      )}
      <div
        ref={sizeRef}
        className="plot-area profile-area"
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setTip(null)}
        onDoubleClick={onDoubleClick}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {info && tip && (
        <div
          className="profile-tip"
          style={{
            // Beside the pointer, flipped to the other side near the window's right / bottom edge.
            left: tip.x + 14 + 220 > window.innerWidth ? undefined : tip.x + 14,
            right: tip.x + 14 + 220 > window.innerWidth ? window.innerWidth - tip.x + 14 : undefined,
            top: tip.y + 14 + 140 > window.innerHeight ? undefined : tip.y + 14,
            bottom: tip.y + 14 + 140 > window.innerHeight ? window.innerHeight - tip.y + 14 : undefined,
          }}
        >
          <div className="profile-tip-title">
            <b>{info.title}</b> <span className="muted">{info.sub}</span>
          </div>
          <table>
            <tbody>
              {info.rows.map(([k, val]) => (
                <tr key={k}>
                  <td className="muted">{k}</td>
                  <td>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="profile-tip-hint muted">Click: select · Ctrl+click: add · Double-click: zoom</div>
        </div>
      )}
    </div>
  );
}
