// Exports of tables (CSV / Excel, written by the backend) and figures (SVG / PNG).

import { save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { formatNumber } from "./classify";
import { notify } from "./store";

type Cell = string | number | null | undefined;

const text = (c: Cell) => (c === null || c === undefined ? "" : typeof c === "number" ? (Number.isFinite(c) ? String(c) : "") : c);

/** Asks for a file (CSV or Excel workbook) and writes the table to it. */
export async function exportTable(name: string, title: string, columns: string[], rows: Cell[][]) {
  const path = await save({
    defaultPath: `${name}.csv`,
    filters: [
      { name: "CSV", extensions: ["csv"] },
      { name: "Excel workbook", extensions: ["xlsx"] },
    ],
  });
  if (!path) return;
  try {
    await api.exportTable(path, title, columns, rows.map((r) => r.map(text)));
    notify(`Saved ${path}`);
  } catch (e) {
    notify(errorText(e), true);
  }
}

export async function saveSvg(name: string, svg: string) {
  const path = await save({ defaultPath: `${name}.svg`, filters: [{ name: "SVG image", extensions: ["svg"] }] });
  if (!path) return;
  await api
    .saveFile(path, new TextEncoder().encode(svg))
    .then(() => notify(`Saved ${path}`))
    .catch((e) => notify(errorText(e), true));
}

/** Saves a canvas (or an SVG drawn into one) as a PNG with an opaque white background. */
export async function savePng(name: string, source: HTMLCanvasElement | { svg: string; width: number; height: number }) {
  const path = await save({ defaultPath: `${name}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
  if (!path) return;
  let canvas: HTMLCanvasElement;
  if (source instanceof HTMLCanvasElement) canvas = source;
  else {
    const scale = 2;
    canvas = document.createElement("canvas");
    canvas.width = source.width * scale;
    canvas.height = source.height * scale;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([source.svg], { type: "image/svg+xml" }));
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("cannot draw the figure"));
      img.src = url;
    });
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
  }
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  if (!blob) return;
  await api
    .saveFile(path, new Uint8Array(await blob.arrayBuffer()))
    .then(() => notify(`Saved ${path}`))
    .catch((e) => notify(errorText(e), true));
}

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
    let d = "";
    let pen = false;
    for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i];
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
    parts.push(`<line x1="${lx}" x2="${lx + 18}" y1="${ly - 4}" y2="${ly - 4}" stroke="${s.color}" stroke-width="2"/>`);
    parts.push(`<text x="${lx + 22}" y="${ly}" font-size="10">${esc(`${s.label} (${s.unit})`)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">${parts.join("")}</svg>`;
}

/** Export buttons of a table. */
export function tableExport(name: string, title: string, columns: string[], rows: () => Cell[][]) {
  return () => exportTable(name, title, columns, rows());
}
