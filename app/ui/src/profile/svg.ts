// The longitudinal profile as an SVG drawing, and the details of what is under the pointer.

import { esc, ticks } from "../chartSvg";
import { formatNumber } from "../format";
import type { ProfileDto } from "../analysisTypes";
import type { ObjRef } from "../types";

export const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

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
