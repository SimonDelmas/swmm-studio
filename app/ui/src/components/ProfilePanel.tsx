import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { esc, exportTable, savePng, saveSvg, ticks } from "../exporting";
import { formatDateTime, periodMs } from "../format";
import { ObjLink } from "../objects";
import {
  currentProfileView,
  getState,
  notify,
  openProfileView,
  setState,
  showProfile,
  updateProfileView,
  useStore,
  type ProfileView,
} from "../store";
import type { ObjRef, ProfileDto } from "../types";
import { useSize } from "../useSize";

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** Objects drawn highlighted in the panel, which also makes conduits and nodes clickable (exports leave it out). */
export interface Selected {
  nodes: Set<number>;
  links: Set<number>;
}

// The map highlights the selection in yellow (255, 200, 0): darker here, on white.
const SEL_STROKE = "#e0a000";
const SEL_FILL = "rgba(255,200,0,0.3)";
const SEL_HALO = "#ffe58a";

/** The profile as an SVG document: ground, conduits, node walls, HGL now and its maximum. */
export function profileSvg(
  p: ProfileDto,
  heads: Float32Array | null,
  headsB: Float32Array | null,
  W: number,
  H: number,
  opts: { title?: string; unit: string; selected?: Selected },
): string {
  const sel = opts.selected;
  // Legend in the top margin, node names above the ground.
  const m = { l: 60, r: 14, t: (opts.title ? 24 : 4) + 20, b: 34 };
  const pw = Math.max(10, W - m.l - m.r);
  const ph = Math.max(10, H - m.t - m.b);
  const x1 = Math.max(1e-9, p.nodes[p.nodes.length - 1]?.station ?? 1);
  let lo = Infinity;
  let hi = -Infinity;
  const see = (v: number | null | undefined) => fin(v) && ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
  for (const n of p.nodes) (see(n.invert), see(n.rim));
  for (const l of p.links) {
    see(l.invert_start);
    see(l.invert_end);
    if (fin(l.height)) (see((l.invert_start ?? NaN) + l.height), see((l.invert_end ?? NaN) + l.height));
  }
  p.max_head.forEach(see);
  heads?.forEach((v) => see(v));
  if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
  if (hi - lo < 1e-6) [lo, hi] = [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const X = (s: number) => m.l + (s / x1) * pw;
  const Y = (z: number) => m.t + ph - ((z - lo) / (hi - lo)) * ph;
  const f = (v: number) => v.toFixed(1);
  const out: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`];
  if (opts.title) out.push(`<text x="${W / 2}" y="17" text-anchor="middle" font-size="13" font-weight="bold">${esc(opts.title)}</text>`);
  for (const t of ticks(lo, hi, Math.max(2, Math.floor(ph / 40)))) {
    out.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${f(Y(t))}" y2="${f(Y(t))}" stroke="#eee"/>`);
    out.push(`<text x="${m.l - 4}" y="${f(Y(t) + 3)}" text-anchor="end" font-size="10">${esc(formatNumber(t))}</text>`);
  }
  for (const t of ticks(0, x1, Math.max(2, Math.floor(pw / 90)))) {
    out.push(`<text x="${f(X(t))}" y="${m.t + ph + 13}" text-anchor="middle" font-size="10">${esc(formatNumber(t))}</text>`);
  }
  out.push(`<text transform="translate(13,${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="11">Elevation (${esc(opts.unit)})</text>`);
  out.push(`<text x="${m.l + pw}" y="${m.t + ph + 26}" text-anchor="end" font-size="10">Distance (${esc(opts.unit)})</text>`);
  // Water: between each link's invert and the head at its ends.
  const water = (h: Float32Array, fill: string, stroke: string, dash: string) => {
    let poly = "";
    let line = "";
    p.links.forEach((l, i) => {
      const [ha, hb] = [h[i], h[i + 1]];
      if (!fin(l.invert_start) || !fin(l.invert_end) || !fin(ha) || !fin(hb)) return;
      const ta = Math.max(ha, l.invert_start);
      const tb = Math.max(hb, l.invert_end);
      if (fill) {
        poly += `<polygon points="${f(X(l.start))},${f(Y(l.invert_start))} ${f(X(l.end))},${f(Y(l.invert_end))} ${f(X(l.end))},${f(Y(tb))} ${f(X(l.start))},${f(Y(ta))}" fill="${fill}"/>`;
      }
      line += `${line ? "L" : "M"}${f(X(l.start))} ${f(Y(ta))}L${f(X(l.end))} ${f(Y(tb))}`;
    });
    return poly + (line ? `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ""}/>` : "");
  };
  if (heads) out.push(water(heads, "rgba(80,150,230,0.35)", "#1f6fd1", ""));
  // Conduits. In the panel each one catches clicks: by an invisible fill, or a wide invisible line without a height.
  for (const l of p.links) {
    if (!fin(l.invert_start) || !fin(l.invert_end)) continue;
    const a = `${f(X(l.start))},${f(Y(l.invert_start))}`;
    const b = `${f(X(l.end))},${f(Y(l.invert_end))}`;
    const on = sel?.links.has(l.index) ?? false;
    const look = `stroke="${on ? SEL_STROKE : "#555"}" stroke-width="${on ? 2.5 : 1}"`;
    let shape: string;
    if (fin(l.height)) {
      const c = `${f(X(l.end))},${f(Y(l.invert_end + l.height))}`;
      const d = `${f(X(l.start))},${f(Y(l.invert_start + l.height))}`;
      const fill = on ? `fill="${SEL_FILL}"` : sel ? `fill="#fff" fill-opacity="0"` : `fill="none"`;
      shape = `<polygon class="pf-shape" points="${a} ${b} ${c} ${d}" ${fill} ${look}/>`;
    } else {
      shape = `<polyline class="pf-shape" points="${a} ${b}" fill="none" ${look} stroke-dasharray="${on ? "6 3" : "2 2"}"/>`;
      if (sel) shape = `<polyline points="${a} ${b}" fill="none" stroke="#fff" stroke-opacity="0" stroke-width="10"/>${shape}`;
    }
    out.push(sel ? `<g data-link="${l.index}" class="pf-pick">${shape}</g>` : shape);
  }
  // Max HGL, run B HGL.
  const maxLine = p.nodes
    .map((n, i) => (fin(p.max_head[i]) ? `${f(X(n.station))},${f(Y(p.max_head[i]!))}` : null))
    .filter(Boolean)
    .join(" ");
  if (maxLine) out.push(`<polyline points="${maxLine}" fill="none" stroke="#d62728" stroke-width="1.2" stroke-dasharray="6 3"/>`);
  if (headsB) out.push(water(headsB, "", "#ff7f0e", "4 2"));
  // Ground and node walls.
  const ground = p.nodes.filter((n) => fin(n.rim)).map((n) => `${f(X(n.station))},${f(Y(n.rim!))}`).join(" ");
  if (ground) out.push(`<polyline points="${ground}" fill="none" stroke="#7a5230" stroke-width="1.6"/>`);
  // Names where they do not overlap (always the first and the last node).
  let lastX = -Infinity;
  p.nodes.forEach((n, i) => {
    const px = X(n.station);
    const x = f(px);
    const on = sel?.nodes.has(n.index) ?? false;
    if (fin(n.invert) && fin(n.rim)) {
      const ys = `y1="${f(Y(n.invert))}" y2="${f(Y(n.rim))}"`;
      const wall = `<line class="pf-shape" x1="${x}" x2="${x}" ${ys} stroke="${on ? SEL_STROKE : "#999"}" stroke-width="${on ? 3 : 1}"/>`;
      const hit = `<line x1="${x}" x2="${x}" ${ys} stroke="#fff" stroke-opacity="0" stroke-width="9"/>`;
      out.push(sel ? `<g data-node="${n.index}" class="pf-pick">${hit}${wall}</g>` : wall);
    }
    const w = 6 * n.id.length + 8;
    const isLast = i === p.nodes.length - 1;
    // A selected node always gets its name.
    if (px - lastX < w && !isLast && !on) return;
    const top = Math.max(...[n.rim, n.invert, p.max_head[i], heads?.[i]].filter(fin));
    const y = Math.max(m.t + 10, Y(Number.isFinite(top) ? top : lo) - 5);
    const anchor = i === 0 ? "start" : isLast ? "end" : "middle";
    out.push(
      `<g data-node="${n.index}" style="cursor:pointer"><text x="${x}" y="${f(y)}" text-anchor="${anchor}" font-size="10" fill="#222"${on ? ` font-weight="bold"` : ""} paint-order="stroke" stroke="${on ? SEL_HALO : "#fff"}" stroke-width="3">${esc(n.id)}</text></g>`,
    );
    lastX = px;
  });
  out.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#888"/>`);
  // Legend.
  const items: [string, string, string][] = [
    ["Ground", "#7a5230", ""],
    ["HGL", "#1f6fd1", ""],
    ["Max HGL", "#d62728", "6 3"],
  ];
  if (headsB) items.push(["HGL run B", "#ff7f0e", "4 2"]);
  items.forEach(([t, c, d], i) => {
    const lx = m.l + i * 90;
    const ly = m.t - 10;
    out.push(`<line x1="${lx}" x2="${lx + 18}" y1="${ly}" y2="${ly}" stroke="${c}" stroke-width="2"${d ? ` stroke-dasharray="${d}"` : ""}/>`);
    out.push(`<text x="${lx + 22}" y="${ly + 4}" font-size="10">${t}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">${out.join("")}</svg>`;
}

const ROUND = new Set(["CIRCULAR", "FORCE_MAIN", "FILLED_CIRCULAR"]);

/** Geometry of a profile node or link, for the hover tooltip: a title, a subtitle and label / value rows. */
export function profileInfo(p: ProfileDto, hit: ObjRef, unit: string): { title: string; sub: string; rows: [string, string][] } | null {
  const v = (x: number | null | undefined, u = unit) => (fin(x) ? `${formatNumber(x)} ${u}` : "–");
  if (hit.kind === "node") {
    const n = p.nodes.find((n) => n.index === hit.index);
    if (!n) return null;
    return {
      title: n.id,
      sub: "Node",
      rows: [
        ["Rim", v(n.rim)],
        ["Invert", v(n.invert)],
        ["Depth", fin(n.rim) && fin(n.invert) ? v(n.rim - n.invert) : "–"],
        ["Distance", v(n.station)],
      ],
    };
  }
  const l = p.links.find((l) => l.index === hit.index);
  if (!l) return null;
  const len = l.end - l.start;
  const kind = l.kind[0].toUpperCase() + l.kind.slice(1);
  const rows: [string, string][] = [];
  if (l.kind === "conduit") rows.push(["Length", v(len)]);
  if (fin(l.height)) rows.push([ROUND.has(l.shape) ? "Diameter" : "Height", v(l.height)]);
  rows.push(["Invert", fin(l.invert_start) || fin(l.invert_end) ? `${v(l.invert_start)} → ${v(l.invert_end)}` : "–"]);
  if (l.kind === "conduit" && len > 0 && fin(l.invert_start) && fin(l.invert_end)) {
    rows.push(["Slope", `${formatNumber(((l.invert_start - l.invert_end) / len) * 100)} %`]);
  }
  return { title: l.id, sub: l.shape ? `${kind} · ${l.shape.toLowerCase().replace(/_/g, " ")}` : kind, rows };
}

/** A profile saved in the project: its control nodes, by ID (indices change with edits). */
export interface SavedProfile {
  name: string;
  nodes: string[];
}

const NONE: SavedProfile[] = [];

export function savedProfiles(s = getState()): SavedProfile[] {
  const list = s.model?.project.ui.profiles;
  return Array.isArray(list) ? (list as SavedProfile[]) : NONE;
}

function storeProfiles(list: SavedProfile[]) {
  const m = getState().model;
  if (!m) return;
  const ui = { ...m.project.ui, profiles: list };
  setState({ model: { ...m, project: { ...m.project, ui } } });
  api.updateProject(undefined, ui).catch((e) => notify(errorText(e), true));
}

/** Saves the current profile under `name` (replaces a profile of the same name). */
export function saveProfile(name: string) {
  const { profile, profileNodes } = getState();
  if (!profile) return;
  const idOf = new Map(profile.nodes.map((n) => [n.index, n.id]));
  const nodes = profileNodes.map((i) => idOf.get(i)).filter((id): id is string => id !== undefined);
  storeProfiles([...savedProfiles().filter((p) => p.name !== name), { name, nodes }]);
}

export function deleteProfile(name: string) {
  storeProfiles(savedProfiles().filter((p) => p.name !== name));
}

/** Opens a saved profile: in the profile tab shown if it is still empty, else in a new tab. */
export async function loadProfile(name: string) {
  const saved = savedProfiles().find((p) => p.name === name);
  if (!saved) return;
  const refs = await Promise.all(saved.nodes.map((id) => api.findObject(id).catch(() => null)));
  const missing = saved.nodes.filter((_, i) => refs[i]?.kind !== "node");
  if (missing.length > 0) return notify(`Profile “${name}”: node${missing.length > 1 ? "s" : ""} ${missing.join(", ")} no longer in the model.`, true);
  const nodes = refs.map((r) => r!.index);
  const cur = currentProfileView();
  if (cur && cur.nodes.length < 2) updateProfileView(cur.id, { nodes, name });
  else openProfileView(nodes, name);
}

/**
 * Profile tool: the first click picks the start node, the second draws the profile in a new
 * tab (or the profile tab shown, if still empty); Shift+click extends the profile shown.
 */
export function profileClick(hit: ObjRef | null, shift: boolean) {
  if (hit?.kind !== "node") return;
  const { profileStart } = getState();
  const cur = currentProfileView();
  if (shift && profileStart === null && cur && cur.nodes.length >= 2) {
    if (cur.nodes[cur.nodes.length - 1] !== hit.index) updateProfileView(cur.id, { nodes: [...cur.nodes, hit.index] });
  } else if (profileStart === null || profileStart === hit.index) {
    setState({ profileStart: hit.index });
  } else {
    showProfile([profileStart, hit.index]);
  }
}

/** Computes the profile path whenever its nodes or the model change (mounted once, in the app). */
export function useProfile() {
  const nodes = useStore((s) => s.profileNodes);
  const revision = useStore((s) => s.model?.revision ?? 0);
  const resultsPath = useStore((s) => s.model?.results?.path);
  const cacheState = useStore((s) => s.model?.results?.cache.state);
  useEffect(() => {
    setState({ profile: null, profileError: null });
    if (nodes.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .profile(nodes)
        .then((profile) => live && setState({ profile }))
        .catch((e) => live && setState({ profileError: errorText(e) }));
    }, 100);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [nodes, revision, resultsPath, cacheState]);
}

/** Draws the profile through the selected nodes (in selection order), in the profile tab shown or a new one. */
export function profileFromSelection() {
  const nodes = getState()
    .selection.filter((o) => o.kind === "node")
    .map((o) => o.index);
  if (nodes.length < 2) return notify("Select two nodes or more (Shift+click), in order along the profile.", true);
  showProfile(nodes, true);
}

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
  const want = useRef<number | null>(null);
  const ids = dto?.nodes.map((n) => n.index) ?? null;
  const idsKey = ids?.join(",") ?? "";
  useEffect(() => {
    setError(null);
    if (!ids || !results) {
      setHeads(null);
      setHeadsB(null);
      return;
    }
    want.current = period;
    const pump = () => {
      if (busy.current || want.current === null) return;
      const p = want.current;
      want.current = null;
      busy.current = true;
      Promise.all([api.heads(ids, p), compare && showB ? api.heads(ids, p, true).catch(() => null) : Promise.resolve(null)])
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
    setState({ selection: sel, fitSelection: getState().fitSelection + 1 });
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
    if (hit) setState({ selection: [hit], fitSelection: getState().fitSelection + 1 });
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
