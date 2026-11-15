// Checks that the modules of src/ only import from their own layer or from a lower one
// (see "Front-end layout" in the README). Run by `npm run build`.
//
//   node scripts/check-layers.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Lowest first. A folder name stands for every file under it; the others are root modules. */
const LAYERS = [
  ["types", ["types", "analysisTypes", "uiTypes"]],
  ["libraries", ["api", "chartSvg", "classify", "format", "geometryPatch", "latest"]],
  ["store", ["store"]],
  ["actions", ["actions/", "dragSeries", "exporting"]],
  ["features", ["hooks/", "plot/", "profile/"]],
  ["map", ["map/"]],
  ["components", ["components/"]],
  ["application", ["App", "main", "vite-env.d"]],
];

function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Module path relative to src, with `/` and without extension. */
const moduleOf = (file) => relative(SRC, file).split(sep).join("/").replace(/\.tsx?$/, "");

function layerOf(module) {
  const i = LAYERS.findIndex(([, members]) => members.some((m) => (m.endsWith("/") ? module.startsWith(m) : module === m)));
  return i;
}

const problems = [];
for (const file of files(SRC)) {
  const from = moduleOf(file);
  const layer = layerOf(from);
  if (layer < 0) {
    problems.push(`${from}: not in any layer (add it to scripts/check-layers.mjs)`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/^(?:import|export)\b[^;]*?from\s+"(\.[^"]*)"/gm)) {
    const to = moduleOf(resolve(dirname(file), m[1]));
    const target = layerOf(to);
    if (target < 0) problems.push(`${from}: imports ${to}, which is not in any layer`);
    else if (target > layer) problems.push(`${from} (${LAYERS[layer][0]}) imports ${to} (${LAYERS[target][0]})`);
  }
}

if (problems.length > 0) {
  console.error(`Module layers: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("Module layers: ok");
