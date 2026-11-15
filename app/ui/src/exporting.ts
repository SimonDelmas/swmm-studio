// Saving tables (CSV / Excel, written by the backend) and figures (SVG / PNG) to files the user chooses.

import { save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
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
