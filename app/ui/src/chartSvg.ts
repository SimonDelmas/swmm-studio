// A line chart as SVG text, for the exported figures.

import { formatNumber } from "./format";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** About `n` round tick values covering `[lo, hi]`. */
export function ticks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi <= lo) return [lo];
  const raw = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface SvgSeries {
  label: string;
  unit: string;
  color: string;
  /** x values (any unit) and y values (null: gap). */
  x: number[];
  y: (number | null)[];
  stepped?: boolean;
  /** Drawn as points (observed values), not as a line. */
  points?: boolean;
}

/** Line chart as a standalone SVG document; one y axis per unit (left, then right). */
export function chartSvg(series: SvgSeries[], opts: { width: number; height: number; xLabel: (x: number) => string; title?: string }): string {
  const { width: W, height: H } = opts;
  const units = Array.from(new Set(series.map((s) => s.unit)));
  const m = { l: 64, r: units.length > 1 ? 64 : 16, t: opts.title ? 28 : 12, b: 40 + 16 * Math.ceil(series.length / 3) };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const s of series) for (const x of s.x) ((x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)));
  const range: Record<string, [number, number]> = {};
  for (const u of units) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series.filter((s) => s.unit === u)) for (const y of s.y) if (y !== null && Number.isFinite(y)) ((lo = Math.min(lo, y)), (hi = Math.max(hi, y)));
    if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
    if (hi === lo) [lo, hi] = [lo - 1, hi + 1];
    const pad = (hi - lo) * 0.05;
    range[u] = [lo - pad, hi + pad];
  }
  const X = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * pw;
  const Y = (u: string, y: number) => m.t + ph - ((y - range[u][0]) / (range[u][1] - range[u][0])) * ph;
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);
  if (opts.title) parts.push(`<text x="${W / 2}" y="18" text-anchor="middle" font-size="13" font-weight="bold">${esc(opts.title)}</text>`);
  // Grid and axes.
  const xt = ticks(x0, x1, Math.max(2, Math.floor(pw / 110)));
  for (const t of xt) {
    parts.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${m.t + ph}" stroke="#ddd"/>`);
    parts.push(`<text x="${X(t)}" y="${m.t + ph + 14}" text-anchor="middle" font-size="10">${esc(opts.xLabel(t))}</text>`);
  }
  units.slice(0, 2).forEach((u, i) => {
    const ax = i === 0 ? m.l : m.l + pw;
    for (const t of ticks(range[u][0], range[u][1])) {
      if (i === 0) parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(u, t)}" y2="${Y(u, t)}" stroke="#eee"/>`);
      parts.push(
        `<text x="${i === 0 ? ax - 4 : ax + 4}" y="${Y(u, t) + 3}" text-anchor="${i === 0 ? "end" : "start"}" font-size="10">${esc(formatNumber(t))}</text>`,
      );
    }
    const lx = i === 0 ? 14 : W - 10;
    parts.push(`<text transform="translate(${lx},${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="11">${esc(u)}</text>`);
  });
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#888"/>`);
  // Series.
  for (const s of series) {
    if (s.points) {
      const dots: string[] = [];
      s.x.forEach((x, i) => {
        const y = s.y[i];
        if (y !== null && y !== undefined && Number.isFinite(y)) dots.push(`<circle cx="${X(x).toFixed(1)}" cy="${Y(s.unit, y).toFixed(1)}" r="2"/>`);
      });
      parts.push(`<g fill="${s.color}">${dots.join("")}</g>`);
      continue;
    }
    let d = "";
    let pen = false;
    for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i];
      // Undefined: no value at this x (series aligned on the x of others), not a gap.
      if (y === undefined) continue;
      if (y === null || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      const px = X(s.x[i]).toFixed(1);
      const py = Y(s.unit, y).toFixed(1);
      if (!pen) d += `M${px} ${py}`;
      else if (s.stepped) d += `H${px}V${py}`;
      else d += `L${px} ${py}`;
      pen = true;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.3"/>`);
  }
  // Legend.
  series.forEach((s, i) => {
    const lx = m.l + (i % 3) * (pw / 3);
    const ly = m.t + ph + 30 + 16 * Math.floor(i / 3);
    parts.push(
      s.points
        ? `<circle cx="${lx + 9}" cy="${ly - 4}" r="2.5" fill="${s.color}"/>`
        : `<line x1="${lx}" x2="${lx + 18}" y1="${ly - 4}" y2="${ly - 4}" stroke="${s.color}" stroke-width="2"/>`,
    );
    parts.push(`<text x="${lx + 22}" y="${ly}" font-size="10">${esc(`${s.label} (${s.unit})`)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">${parts.join("")}</svg>`;
}
