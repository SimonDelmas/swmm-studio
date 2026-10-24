import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { formatNumber } from "../classify";
import { esc, exportTable, savePng, saveSvg, ticks } from "../exporting";
import { formatDateTime, periodMs } from "../format";
import { getState, notify, setState, useStore } from "../store";
import type { ObjRef, ProfileDto } from "../types";
import { useSize } from "../useSize";

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** The profile as an SVG document: ground, conduits, node walls, HGL now and its maximum. */
export function profileSvg(
  p: ProfileDto,
  heads: Float32Array | null,
  headsB: Float32Array | null,
  W: number,
  H: number,
  opts: { title?: string; unit: string },
): string {
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
  // Conduits.
  for (const l of p.links) {
    if (!fin(l.invert_start) || !fin(l.invert_end)) continue;
    const a = `${f(X(l.start))},${f(Y(l.invert_start))}`;
    const b = `${f(X(l.end))},${f(Y(l.invert_end))}`;
    if (fin(l.height)) {
      const c = `${f(X(l.end))},${f(Y(l.invert_end + l.height))}`;
      const d = `${f(X(l.start))},${f(Y(l.invert_start + l.height))}`;
      out.push(`<polygon points="${a} ${b} ${c} ${d}" fill="none" stroke="#555" stroke-width="1"/>`);
    } else {
      out.push(`<polyline points="${a} ${b}" fill="none" stroke="#555" stroke-dasharray="2 2"/>`);
    }
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
    if (fin(n.invert) && fin(n.rim)) out.push(`<line x1="${x}" x2="${x}" y1="${f(Y(n.invert))}" y2="${f(Y(n.rim))}" stroke="#999"/>`);
    const w = 6 * n.id.length + 8;
    const isLast = i === p.nodes.length - 1;
    if (px - lastX < w && !isLast) return;
    const top = Math.max(...[n.rim, n.invert, p.max_head[i], heads?.[i]].filter(fin));
    const y = Math.max(m.t + 10, Y(Number.isFinite(top) ? top : lo) - 5);
    const anchor = i === 0 ? "start" : isLast ? "end" : "middle";
    out.push(
      `<g data-node="${n.index}" style="cursor:pointer"><text x="${x}" y="${f(y)}" text-anchor="${anchor}" font-size="10" fill="#222" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(n.id)}</text></g>`,
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

/** Sets the profile to go through the selected nodes (in selection order). */
export function profileFromSelection() {
  const nodes = getState()
    .selection.filter((o) => o.kind === "node")
    .map((o) => o.index);
  if (nodes.length < 2) return notify("Select two nodes or more (Shift+click), in order along the profile.", true);
  setState({ profileNodes: nodes, bottomTab: "profile" });
}

export function ProfilePanel() {
  const nodes = useStore((s) => s.profileNodes);
  const model = useStore((s) => s.model);
  const period = useStore((s) => s.period);
  const results = model?.results ?? null;
  const compare = model?.compare ?? null;
  const [dto, setDto] = useState<ProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heads, setHeads] = useState<Float32Array | null>(null);
  const [headsB, setHeadsB] = useState<Float32Array | null>(null);
  const [showB, setShowB] = useState(true);
  const [sizeRef, size] = useSize<HTMLDivElement>({ w: 800, h: 220 });
  const revision = model?.revision ?? 0;
  const unit = model && ["CFS", "GPM", "MGD"].includes(model.flow_units) ? "ft" : "m";

  useEffect(() => {
    setDto(null);
    setError(null);
    if (nodes.length < 2) return;
    const t = setTimeout(() => {
      api
        .profile(nodes)
        .then(setDto)
        .catch((e) => setError(errorText(e)));
    }, 100);
    return () => clearTimeout(t);
  }, [nodes, revision, results?.path, results?.cache.state]);

  // Heads at the current time (coalesced while playing).
  const busy = useRef(false);
  const want = useRef<number | null>(null);
  const ids = dto?.nodes.map((n) => n.index) ?? null;
  const idsKey = ids?.join(",") ?? "";
  useEffect(() => {
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
  const svg = dto ? profileSvg(dto, heads, headsB, size.w, Math.max(120, size.h - 4), { unit }) : "";
  const selectPath = () => {
    if (!dto) return;
    const sel: ObjRef[] = [...dto.links.map((l) => ({ kind: "link" as const, index: l.index })), ...dto.nodes.map((n) => ({ kind: "node" as const, index: n.index }))];
    setState({ selection: sel, fitSelection: getState().fitSelection + 1 });
  };
  const exportData = () => {
    if (!dto) return;
    const rows = dto.nodes.map((n, i) => [n.id, n.station, n.invert, n.rim, heads?.[i] ?? null, dto.max_head[i]]);
    exportTable("profile", "Profile", ["Node", `Distance (${unit})`, `Invert (${unit})`, `Ground (${unit})`, `Head at ${when} (${unit})`, `Max head (${unit})`], rows);
  };
  const onClick = (e: React.MouseEvent) => {
    const g = (e.target as Element).closest("[data-node]");
    if (g) setState({ selection: [{ kind: "node", index: Number(g.getAttribute("data-node")) }] });
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
              <b>{title}</b> · {dto.links.length} links · {formatNumber(dto.nodes[dto.nodes.length - 1].station)} {unit}
            </span>
            <button onClick={selectPath}>Select on map</button>
          </>
        )}
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
          Select a start and an end node (Shift+click; more nodes to force the path), then click “From selected nodes”. The profile follows the
          shortest path; the water line follows the timeline.
        </div>
      )}
      <div ref={sizeRef} className="plot-area" onClick={onClick} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
