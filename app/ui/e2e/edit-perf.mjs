// Edit latency on a large model (run against the app like e2e/edit.mjs):
//   node e2e/edit-perf.mjs <model.inp> [EPSG:xxxx]
// Measures, from the UI: a field edit, its undo, a node move (with the geometry reload),
// adding a junction and deleting it (network rebuilt). The model is not saved.

import { chromium } from "playwright-core";

const [model, crs = ""] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const S = (fn, arg) => page.evaluate(fn, arg);

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null, null, { timeout: 120000 });
await S(() => window.swmmStudio.setState({ crsDialog: false }));
if (crs) await S((c) => window.swmmStudio.applyCrs(c), crs);

const result = await S(async () => {
  const st = window.swmmStudio;
  const counts = st.getState().model.counts;
  const node = { kind: "node", index: Math.floor(counts.nodes / 2) };
  const info = await st.api.objectInfo(node, null);
  const main = info.groups[0];
  st.setState({ selection: [node] });
  // Lets React render and the map draw the new state.
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const time = async (f) => {
    const t0 = performance.now();
    await f();
    await frame();
    return performance.now() - t0;
  };
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const edits = [];
  const undos = [];
  for (let i = 0; i < 10; i++) {
    edits.push(await time(() => st.tryEdit({ op: "set_field", section: main.section, key: main.key, field: 2, value: String(3 + i / 10) })));
    undos.push(await time(() => st.undo()));
  }
  // The same edit through the IPC only (no UI update).
  const raw = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await st.api.edit({ op: "set_field", section: main.section, key: main.key, field: 2, value: String(4 + i / 10) }, []);
    raw.push(performance.now() - t0);
    await st.api.undo([]);
  }
  const g = st.getState().geometry;
  const p = [g.nodes[2 * node.index], g.nodes[2 * node.index + 1]];
  const d = st.getState().model.space.kind === "lonlat" ? 0.0001 : 5;
  const moves = [];
  for (let i = 0; i < 5; i++) {
    moves.push(await time(() => st.tryEdit({ op: "set_geometry", object: node, points: [[p[0] + d * (i + 1), p[1]]] })));
  }
  const add = await time(() => st.tryEdit({ op: "add_node", node_type: "junction", xy: [p[0] + d, p[1] + d] }));
  const del = await time(() => st.tryEdit({ op: "delete", objects: st.getState().selection }));
  for (let i = 0; i < 7; i++) await st.undo();
  return {
    counts,
    field_edit_ms: Math.round(med(edits)),
    field_edit_ipc_only_ms: Math.round(med(raw)),
    undo_ms: Math.round(med(undos)),
    move_node_ms: Math.round(med(moves)),
    add_junction_ms: Math.round(add),
    delete_junction_ms: Math.round(del),
    dirty_after_undo: st.getState().model.dirty,
  };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
process.exit(0);
