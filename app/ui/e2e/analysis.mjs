// Analysis test of the running desktop app (M3), driven over the WebView2 DevTools
// protocol with real mouse and keyboard events where the UI matters.
//
// 1. Start the app with remote debugging (use a scratch settings file):
//      set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//      set SWMM_STUDIO_SETTINGS=%TEMP%\swmm-test-settings.json
// 2. node e2e/analysis.mjs <copy of testdata/tiny.inp> <runswmm.exe> [screenshot folder]
//
// Runs the model twice (the second time with rougher pipes), then: run history, comparison
// and difference map, envelope / aggregation maps, profile, events, aggregated plot,
// tabular editor (typing, copy / paste), validation, climatology, section text, exports.

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [model, engine, shots = "analysis-shots"] = process.argv.slice(2);
if (!model || !engine) {
  console.error("usage: node e2e/analysis.mjs <model.inp> <runswmm.exe> [screenshot folder]");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages().find((p) => !p.url().startsWith("devtools"));
if (!page) throw new Error("no app page found");
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const S = (fn, arg) => page.evaluate(fn, arg);
const step = async (name, fn) => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`ok  ${name} (${Date.now() - t0} ms)${r !== undefined ? ` → ${JSON.stringify(r)}` : ""}`);
  return r;
};
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });
const waitIdle = () => until(() => window.swmmStudio.getState().busy === null, null, 60000);
const fail = (msg) => {
  throw new Error(msg);
};
const tab = (label) => page.locator(".bottom .tabs button", { hasText: label }).first().click();
const nodeXY = (id) =>
  S((id) => {
    const st = window.swmmStudio.getState();
    const i = st.ids.node.indexOf(id);
    const g = st.geometry;
    return window.swmmStudio.mapProject([g.nodes[2 * i], g.nodes[2 * i + 1]]);
  }, id);
const run = async (label) => {
  await S((l) => window.swmmStudio.startRun(l), label);
  await until(() => !window.swmmStudio.getState().run.running && window.swmmStudio.getState().run.last, null, 120000);
  await waitIdle();
  const last = await S(() => window.swmmStudio.getState().run.last.status);
  if (last !== "success" && last !== "warnings") fail(`run ${label}: ${last}`);
  await until(() => window.swmmStudio.getState().model.results?.cache.state === "ready", null, 60000);
  return last;
};

await step("open the model, register the engine", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await waitIdle();
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await S(() => window.swmmStudio.applyCrs("EPSG:2154"));
  await S(async () => {
    const st = window.swmmStudio;
    st.setState({ ids: { node: await st.api.ids("node"), link: await st.api.ids("link") } });
    const map = document.querySelector(".map").__map;
    const b = st.getState().model.bounds;
    if (map) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 120, duration: 0 });
  });
  const e = await S((p) => window.swmmStudio.api.addEngine("epa", p), engine);
  await S(() => window.swmmStudio.setState({ engine: "epa" }));
  return e.engines.map((x) => `${x.name} ${x.version}`);
});

await step("run twice: base, then with rougher conduits", async () => {
  const a = await run("base");
  await S(async () => {
    const st = window.swmmStudio;
    const objects = st.getState().ids.link.map((_, index) => ({ kind: "link", index }));
    await st.tryEdit({ op: "set_field_bulk", objects, section: "CONDUITS", field: "n", value: "0.03" });
  });
  const b = await run("rough");
  return [a, b];
});

await step("Runs tab: two runs, label edited, older one compared", async () => {
  await tab("Runs");
  await page.waitForSelector("table.grid.runs tbody tr:nth-child(2)");
  const rows = page.locator("table.grid.runs tbody tr");
  if ((await rows.count()) !== 2) fail(`${await rows.count()} runs`);
  // The loaded run is the newest (first row).
  if (!(await rows.nth(0).getAttribute("class"))?.includes("active-row")) fail("newest run not marked loaded");
  const input = rows.nth(1).locator("input");
  await input.fill("base case");
  await input.press("Enter");
  await until(() => true);
  await rows.nth(1).locator("button", { hasText: "Compare" }).click();
  await until(() => window.swmmStudio.getState().model.compare !== null);
  await until(() => window.swmmStudio.getState().model.compare.cache.state === "ready", null, 60000);
  const runs = await S(() => window.swmmStudio.api.runs());
  if (runs[1].record.label !== "base case" || !runs[1].compared || !runs[0].loaded) fail(JSON.stringify(runs.map((r) => [r.record.label, r.loaded, r.compared])));
  return runs.map((r) => r.record.label);
});
await shot("1-runs");

await step("Compare tab: delta table, difference map", async () => {
  await tab("Compare");
  await page.waitForSelector(".events-panel table.grid tbody tr.link-row");
  const n = await page.locator(".events-panel table.grid tbody tr.link-row").count();
  await page.locator("button", { hasText: "Difference map" }).click();
  await until(() => window.swmmStudio.getState().styles.node.source === "compare");
  // Max depth differs: rougher pipes back water up.
  const d = await S(async () => {
    const st = window.swmmStudio;
    const a = await st.api.statValues("node", 0, { stat: "max" }, 0, 1e9);
    const b = await st.api.statValues("node", 0, { stat: "max" }, 0, 1e9, true);
    return Array.from(a, (x, i) => x - b[i]);
  });
  if (!d.some((x) => x > 0.001)) fail(`no deeper node: ${d}`);
  // Animated difference at a time of the run.
  await page.locator("button", { hasText: "Animated difference" }).click();
  await until(() => window.swmmStudio.getState().styles.node.stat === "value");
  await S(() => window.swmmStudio.setState({ period: 60 }));
  const f = await S(async () => Array.from(await window.swmmStudio.api.compareFrame("node", 0, 60)));
  if (!f.every((x) => Number.isFinite(x))) fail(`frame difference ${f}`);
  return { rows: n, maxDepthDiff: d.map((x) => +x.toFixed(3)), frameDiff: f.map((x) => +x.toFixed(3)) };
});
await page.waitForTimeout(500);
await shot("2-compare");

await step("Map style: envelope map of max depth over the day of the current time", async () => {
  await S(() => window.swmmStudio.setState({ sideTab: "style" }));
  const sel = page.locator(".style-section").first().locator("select").first();
  await sel.selectOption("stat:0");
  await until(() => window.swmmStudio.getState().styles.node.source === "stat");
  const scope = page.locator(".style-section").first().locator("label.field", { hasText: "Over" }).locator("select");
  await scope.selectOption("day");
  await until(() => window.swmmStudio.getState().styles.node.scope === "day" && window.swmmStudio.getState().styles.node.breaks.length > 0);
  const st = page.locator(".style-section").first().locator("label.field", { hasText: /^Statistic/ }).locator("select");
  await st.selectOption("time_of_max");
  await until(() => window.swmmStudio.getState().styles.node.stat === "time_of_max");
  await page.waitForTimeout(600);
  const legend = await page.locator(".style-section").first().locator(".legend input").first().inputValue();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(legend)) fail(`time-of-max legend: ${legend}`);
  await st.selectOption("periods_above");
  const th = page.locator(".style-section").first().locator("label.field", { hasText: "Threshold" }).locator("input");
  await th.fill("0.1");
  await th.press("Enter");
  await until(() => window.swmmStudio.getState().styles.node.threshold === 0.1);
  const hours = await S(async () => Array.from(await window.swmmStudio.api.statValues("node", 0, { stat: "periods_above", threshold: 0.1 }, 0, 1e9)));
  return { legend, hoursAbove: hours.map((x) => +x.toFixed(2)) };
});
await shot("3-envelope");

await step("Profile: shift-click J1 and Out1 on the map, animated HGL", async () => {
  await S(() => window.swmmStudio.setState({ tool: "select", selection: [] }));
  const [x1, y1] = await nodeXY("J1");
  const [x2, y2] = await nodeXY("Out1");
  await page.mouse.click(x1, y1);
  await page.keyboard.down("Shift");
  await page.mouse.click(x2, y2);
  await page.keyboard.up("Shift");
  await until(() => window.swmmStudio.getState().selection.length === 2);
  await tab("Profile");
  await page.locator("button", { hasText: "From selected nodes" }).click();
  await page.waitForSelector(".plot-area svg polygon");
  const info = await S(() => {
    const svg = document.querySelector(".plot-area svg");
    return {
      conduits: svg.querySelectorAll('polygon[stroke="#555"]').length,
      water: svg.querySelectorAll('path[stroke="#1f6fd1"]').length,
      max: svg.querySelectorAll('polyline[stroke="#d62728"]').length,
      labels: Array.from(svg.querySelectorAll("[data-node] text")).map((t) => t.textContent),
    };
  });
  if (info.conduits !== 3 || info.water !== 1 || info.max !== 1) fail(JSON.stringify(info));
  const before = await S(() => document.querySelector('.plot-area svg path[stroke="#1f6fd1"]').getAttribute("d"));
  // Play to a later time: the water line moves.
  await page.locator(".map").click({ position: { x: 3, y: 3 } }).catch(() => {});
  await S(() => window.swmmStudio.setState({ period: 200, selection: [] }));
  await page.waitForTimeout(400);
  const after = await S(() => document.querySelector('.plot-area svg path[stroke="#1f6fd1"]').getAttribute("d"));
  if (before === after) fail("HGL did not move with the timeline");
  // Clicking a node label selects it.
  await page.locator(".plot-area svg [data-node] text", { hasText: "J2" }).click();
  await until(() => window.swmmStudio.getState().selection[0]?.kind === "node");
  return info;
});
await shot("4-profile");

await step("Events: overflow-like events at the outfall, jump to one", async () => {
  await tab("Events");
  await page.locator(".events-panel .panel-toolbar input").first().fill("10");
  await page.locator(".events-panel button.primary").click();
  await page.waitForSelector(".events-main table.grid tbody tr.link-row");
  const rows = await page.locator(".events-main table.grid tbody tr.link-row").count();
  await page.locator(".events-main table.grid tbody tr.link-row").first().click();
  await page.waitForSelector(".events-side table.grid tbody tr.link-row");
  const evs = await S(() => Array.from(document.querySelectorAll(".events-side table.grid tbody tr.link-row")).map((r) => r.textContent));
  await page.locator(".events-side table.grid tbody tr.link-row").first().click();
  const p = await S(() => window.swmmStudio.getState().period);
  // All nodes, with run B.
  await page.locator(".events-panel select").nth(2).selectOption("all");
  await page.locator("label", { hasText: "run B" }).locator("input").check();
  await page.locator(".events-panel button.primary").click();
  await until(() => document.querySelectorAll(".events-main table.grid tbody tr.link-row").length === 4);
  return { outfallRows: rows, events: evs.length, jumpedTo: p };
});
await shot("5-events");

await step("Time series: daily maximum of J1 depth, A and B", async () => {
  await S(async () => {
    const st = window.swmmStudio;
    st.setState({ plot: [] });
    await st.addToPlot("node", st.getState().ids.node.indexOf("J1"), 0);
    await st.addToPlot("node", st.getState().ids.node.indexOf("J1"), 0, true);
  });
  await tab("Time series");
  await page.locator('label[title="Time aggregation"] select').selectOption("day");
  await until(() => window.swmmStudio.getState().plotAgg?.unit === "day");
  await page.waitForSelector(".plot-area .u-over");
  const agg = await S(async () => {
    const st = window.swmmStudio;
    return await st.api.aggregate("node", st.getState().ids.node.indexOf("J1"), 0, "day", { stat: "max" });
  });
  if (agg.values.length !== 2) fail(`days: ${agg.values.length}`);
  await page.locator('label[title="Time aggregation"] select').selectOption("");
  return agg.values.map((v) => +v.toFixed(3));
});
await shot("6-plot");

await step("Table: type a roughness, copy two cells, paste them two rows down, undo", async () => {
  await tab("Table");
  await page.locator(".table-panel select").first().selectOption("CONDUITS");
  await page.waitForSelector(".grid-editor tbody tr td.id-cell");
  const col = await S(() => Array.from(document.querySelectorAll(".grid-editor thead th")).findIndex((t) => t.textContent.startsWith("Roughness")));
  const cell = (r, c) => page.locator(".grid-editor tbody tr").nth(r + 1).locator("td").nth(c);
  await cell(0, col).click();
  await page.keyboard.type("0.015");
  await page.keyboard.press("Enter");
  await until(() => window.swmmStudio.getState().model.undo === "Edit C1");
  const v = await S(async () => (await window.swmmStudio.api.grid("CONDUITS")).rows[0].cells);
  // Copy C1 roughness + inlet offset, paste on C3.
  await cell(0, col).click();
  await cell(0, col + 1).click({ modifiers: ["Shift"] });
  // CDP key events do not run the browser's copy / paste commands: send the clipboard
  // events they would fire to the table's keyboard target.
  const copied = await S(() => {
    const dt = new DataTransfer();
    document.querySelector("textarea.grid-keys").dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData("text/plain");
  });
  if (copied !== "0.015\t0") fail(`copied ${JSON.stringify(copied)}`);
  await cell(2, col).click();
  await S((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.querySelector("textarea.grid-keys").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "0.015\t0.1\r\n");
  await until(() => window.swmmStudio.getState().model.undo === "Edit 2 cells of [CONDUITS]");
  const c3 = await S(async () => (await window.swmmStudio.api.grid("CONDUITS")).rows[2].cells);
  if (c3[col] !== "0.015" || c3[col + 1] !== "0.1") fail(`pasted: ${c3}`);
  await page.keyboard.press("Control+z");
  await until(() => window.swmmStudio.getState().model.undo === "Edit C1");
  return { c1: v[col], c3: c3[col] };
});
await shot("7-table");

await step("Issues: break a reference, the check finds it and links the object", async () => {
  await S(() => window.swmmStudio.tryEdit({ op: "set_field", section: "CONDUITS", key: ["C2"], field: 2, value: "Nowhere" }));
  await tab("Issues");
  await until(() => (window.swmmStudio.getState().issues ?? []).some((i) => i.code === "unknown_reference"));
  await page.locator(".events-panel table.grid tbody tr", { hasText: "Nowhere" }).first().click();
  const sel = await S(() => window.swmmStudio.getState().selection);
  await S(() => window.swmmStudio.undo());
  await until(() => !(window.swmmStudio.getState().issues ?? []).some((i) => i.code === "unknown_reference"));
  return { selected: sel, badge: await page.locator(".bottom .tabs button", { hasText: "Issues" }).textContent() };
});
await shot("8-issues");

await step("Climatology dialog: monthly evaporation and rainfall adjustments", async () => {
  await S(() => window.swmmStudio.setState({ sideTab: "data" }));
  await page.locator("button", { hasText: "Climatology…" }).click();
  await page.waitForSelector(".climate-body");
  await page.locator(".climate-body label.option", { hasText: "Source" }).locator("select").selectOption("MONTHLY");
  const months = page.locator(".climate-body .month-grid input");
  for (let i = 0; i < 12; i++) await months.nth(i).fill(String((i + 1) / 10));
  await page.locator(".modal .tabs button", { hasText: "Adjustments" }).click();
  await page.locator(".climate-body label", { hasText: "Rainfall (multiplier)" }).locator("input[type=checkbox]").check();
  await page.locator(".modal button.primary", { hasText: "OK" }).click();
  await until(() => window.swmmStudio.getState().dialog === null);
  const c = await S(() => window.swmmStudio.api.climate());
  if (c.evap_source !== "MONTHLY" || c.evap_values[11] !== "1.2" || c.adj_rainfall.length !== 12) fail(JSON.stringify(c));
  return { evap: c.evap_values.join(" "), rain: c.adj_rainfall[0] };
});

await step("Sections as text: edit [REPORT] and apply", async () => {
  await page.locator("button", { hasText: "Sections as text…" }).click();
  await page.waitForSelector(".sections-text textarea");
  await page.locator(".sections-list label input").check();
  await page.locator(".sections-list .summary-item", { hasText: "[REPORT]" }).click();
  await until(() => !document.querySelector(".sections-text textarea").disabled);
  const ta = page.locator(".sections-text textarea");
  await ta.fill((await ta.inputValue()) + "NODES J1 J2\n");
  await page.locator(".modal button.primary", { hasText: "Apply" }).click();
  await until(() => window.swmmStudio.getState().model.undo === "Edit [REPORT]");
  const t = await S(() => window.swmmStudio.api.sectionText("REPORT"));
  await page.locator(".modal button", { hasText: "Close" }).click();
  if (!t.includes("NODES J1 J2")) fail(t);
  return t.trim().split("\n").slice(-1)[0];
});

await step("exports: CSV and Excel table, profile SVG", async () => {
  const dir = shots;
  const csv = join(dir, "events.csv");
  const xlsx = join(dir, "events.xlsx");
  await S(
    async ([csv, xlsx]) => {
      const st = window.swmmStudio;
      const cols = ["Node", "Max depth (m)"];
      const rows = [["J1", "0.25"], ["Out1", "1e-3"]];
      await st.api.exportTable(csv, "Events", cols, rows);
      await st.api.exportTable(xlsx, "Events", cols, rows);
    },
    [csv, xlsx],
  );
  const text = readFileSync(csv, "utf8");
  const zip = readFileSync(xlsx);
  if (!text.startsWith("Node,Max depth (m)") || zip.subarray(0, 2).toString() !== "PK") fail("bad export");
  return { csv: text.length, xlsx: statSync(xlsx).size, exists: existsSync(xlsx) };
});

await shot("9-end");
if (errors.length) {
  console.log("page errors:", errors.slice(0, 10));
  process.exit(1);
}
console.log("all analysis steps passed");
process.exit(0);
