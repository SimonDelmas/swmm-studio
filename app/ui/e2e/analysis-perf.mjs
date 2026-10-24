// Timings of the analysis features on a large model (running app, see analysis.mjs):
//   node e2e/analysis-perf.mjs <model.inp> [EPSG:2154]
// Waits for the results cache, then times each request from the UI (IPC included).

import { chromium } from "playwright-core";

const [model, crs = "EPSG:2154"] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const S = (fn, arg) => page.evaluate(fn, arg);

await S(
  async ([p, c]) => {
    const st = window.swmmStudio;
    await st.openModel(p);
    st.setState({ crsDialog: false });
    await st.applyCrs(c);
  },
  [model, crs],
);
await page.waitForFunction(() => window.swmmStudio.getState().model.results?.cache.state === "ready", null, { timeout: 600000 });

const results = await S(async () => {
  const st = window.swmmStudio;
  const api = st.api;
  const m = st.getState().model;
  const n = m.results.n_periods;
  const out = {};
  const time = async (name, f, runs = 3) => {
    const ms = [];
    let r;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      r = await f();
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    out[name] = `${ms[Math.floor(ms.length / 2)].toFixed(1)} ms`;
    return r;
  };
  out.objects = `${m.counts.nodes} nodes, ${m.counts.links} links, ${m.counts.subcatchments} subcatchments, ${n} periods`;
  const issues = await time("validate", () => api.validate());
  out.issues = issues.length;
  const g = await time("grid CONDUITS", () => api.grid("CONDUITS"));
  out.gridRows = g.rows.length;
  await time("envelope max, all links (whole run)", () => api.statValues("link", 0, { stat: "max" }, 0, n));
  await time("time of max, all nodes", () => api.statValues("node", 0, { stat: "time_of_max" }, 0, n));
  await time("duration above 0.5, all nodes", () => api.statValues("node", 0, { stat: "periods_above", threshold: 0.5 }, 0, n));
  await time("total volume, all links, 1/3 of the run", () => api.statValues("link", 0, { stat: "total" }, Math.floor(n / 3), Math.floor((2 * n) / 3)));
  const q = { kind: "node", var: 0, threshold: 0.5, min_gap_hours: 6, objects: null, outfalls_only: true, b: false };
  const ev = await time("events, outfalls", () => api.eventStats(q), 1);
  out.outfalls = ev.rows.length;
  const all = await time("events, all nodes", () => api.eventStats({ ...q, outfalls_only: false }), 1);
  out.eventsAll = all.rows.reduce((s, r) => s + r.count, 0);
  await time("events of one node", () => api.objectEvents("node", 0, 0, 0.5, 6));
  await time("daily maxima of one node", () => api.aggregate("node", 0, 0, "day", { stat: "max" }));
  await time("monthly volumes of one link", () => api.aggregate("link", 0, 0, "month", { stat: "total" }));
  const prof = await time("profile node 0 → last node", () => api.profile([0, m.counts.nodes - 1]));
  out.profileLinks = prof.links.length;
  const ids = prof.nodes.map((x) => x.index);
  await time("profile heads at a period", () => api.heads(ids, Math.floor(n / 2)), 5);
  await api.openComparison(m.results.path);
  await time("difference frame, all nodes", () => api.compareFrame("node", 0, Math.floor(n / 2)), 5);
  await api.closeComparison();
  return out;
});
// Tabular editor: show the junctions (real selection in the UI).
await S(() => window.swmmStudio.setState({ bottomTab: "table" }));
await page.waitForSelector(".table-panel select");
const n = await S(async () => (await window.swmmStudio.api.grid("JUNCTIONS")).rows.length);
const t0 = Date.now();
await page.locator(".table-panel select").first().selectOption("JUNCTIONS");
await page.waitForFunction((n) => document.querySelector(".table-panel .panel-toolbar")?.textContent.includes(`${n} / ${n} rows`), n, { timeout: 60000 });
results["table JUNCTIONS shown"] = `${Date.now() - t0} ms (incl. 120 ms debounce)`;
// Scroll to the end of the table and type in a cell.
const t1 = Date.now();
await page.locator(".grid-editor").evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(50);
results["table scroll to end"] = `${Date.now() - t1} ms`;
console.log(JSON.stringify(results, null, 1));
process.exit(0);
