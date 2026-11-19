// Tabs of the bottom panel: a run's report opens in a tab (once), the tab comes back as it
// was left (section, sort, scroll), tabs are moved by dragging, and all close at once.
//
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   cargo tauri dev            (from app/src-tauri, with SWMM_STUDIO_SETTINGS on a scratch file)
//   node e2e/tabs.mjs copy/tiny.inp "C:\Program Files\EPA SWMM 5.2.4 (64-bit)\runswmm.exe" [screenshot folder]
//
// Use a copy of testdata/tiny.inp and storm.dat: the test runs the model twice.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, engine, shots = "tabs-shots"] = process.argv.slice(2);
if (!model || !engine) {
  console.error("usage: node e2e/tabs.mjs <model.inp> <runswmm.exe> [screenshot folder]");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
if (!page) throw new Error("no app page found");
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const S = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });
const waitIdle = () => until(() => window.swmmStudio.getState().busy === null, null, 60000);
const fail = (msg) => {
  throw new Error(msg);
};
const step = async (name, fn) => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`ok  ${name} (${Date.now() - t0} ms)${r !== undefined ? ` → ${JSON.stringify(r)}` : ""}`);
  return r;
};
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const viewTabs = () => S(() => [...document.querySelectorAll(".bottom .view-tab")].map((e) => e.querySelector(".view-tab-name").textContent));
const run = async (label) => {
  await S((l) => window.swmmStudio.startRun(l), label);
  await until(() => !window.swmmStudio.getState().run.running && window.swmmStudio.getState().run.last, null, 120000);
  await waitIdle();
};

await step("open the model, run it twice", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await waitIdle();
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await S((p) => window.swmmStudio.api.addEngine("epa", p), engine);
  await S(() => window.swmmStudio.setState({ engine: "epa" }));
  await run("first");
  await run("second");
  await S(() => window.swmmStudio.setState({ bottomMax: true }));
  await until(() => window.swmmStudio.getState().runs?.length >= 2);
});

await step("clicking a run opens its report in a tab, once", async () => {
  await S(() => window.swmmStudio.setState({ bottomTab: "simulation", simView: null }));
  const rows = page.locator("table.grid.runs tbody tr");
  await rows.nth(1).locator("td").nth(2).click();
  await page.waitForSelector(".report-panel");
  await page.locator(".bottom .tabs > button", { hasText: "Simulation" }).click();
  await rows.nth(1).locator("td").nth(2).click();
  const st = await S(() => {
    const s = window.swmmStudio.getState();
    return { tab: s.bottomTab, reports: s.reportViews.length };
  });
  if (st.tab !== "report" || st.reports !== 1) fail(JSON.stringify(st));
  return await viewTabs();
});

let left;
await step("section, sort and scroll are kept while another tab is open", async () => {
  // A small model's report fits: the panel is made short so that its lists scroll.
  const squeeze = await page.addStyleTag({ content: ".report-panel { height: 90px !important; flex: none !important; }" });
  const section = page.locator(".report-side .summary-item", { hasText: "Node Depth Summary" });
  await section.click();
  await page.waitForSelector(".report-block table.grid");
  await page.locator(".report-block table.grid th").nth(1).click();
  // Scroll whatever can scroll: the table, the section list.
  left = await S(() => {
    const table = document.querySelector(".report-block .table-box");
    const side = document.querySelector(".report-side");
    table.scrollTop = 40;
    side.scrollTop = 30;
    return { table: table.scrollTop, side: side.scrollTop, sort: document.querySelector(".report-block th:nth-child(2)").textContent };
  });
  await page.waitForTimeout(100);
  await page.locator(".bottom .tabs > button", { hasText: "Table" }).click();
  await page.waitForSelector(".report-panel", { state: "detached" });
  await page.locator(".bottom .view-tab button").first().click();
  await page.waitForSelector(".report-block table.grid");
  const back = await S(() => ({
    section: document.querySelector(".report-side .summary-item.active")?.textContent,
    table: document.querySelector(".report-block .table-box").scrollTop,
    side: document.querySelector(".report-side").scrollTop,
    sort: document.querySelector(".report-block th:nth-child(2)").textContent,
  }));
  if (!/Node Depth Summary/.test(back.section ?? "")) fail(`section ${back.section}`);
  if (back.sort !== left.sort || !/[▲▼]/.test(back.sort)) fail(`sort ${back.sort} (left ${left.sort})`);
  if (back.table !== left.table || back.side !== left.side) fail(`scroll ${JSON.stringify(back)} (left ${JSON.stringify(left)})`);
  if (left.table === 0 || left.side === 0) fail(`nothing scrolled: ${JSON.stringify(left)}`);
  await squeeze.evaluate((e) => e.remove());
  return { left, back };
});
await shot("1-report-tab");

await step("a second report, then dragging the first after it", async () => {
  await page.locator(".bottom .tabs > button", { hasText: "Simulation" }).click();
  await page.locator("table.grid.runs tbody tr").nth(0).locator("td").nth(2).click();
  await page.waitForSelector(".report-panel");
  await S(() => window.swmmStudio.setState({ bottomTab: "table" }));
  const before = await viewTabs();
  if (before.length !== 2) fail(`tabs ${before}`);
  const a = await page.locator(".bottom .view-tab").nth(0).boundingBox();
  const b = await page.locator(".bottom .view-tab").nth(1).boundingBox();
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width - 5, b.y + b.height / 2, { steps: 8 });
  const marked = await S(() => !!document.querySelector(".view-tab.tab-drop-after"));
  await page.mouse.up();
  const after = await viewTabs();
  if (!marked) fail("no drop marker while dragging");
  if (after[0] !== before[1] || after[1] !== before[0]) fail(`order ${after} (before ${before})`);
  // The release does not open the dragged tab.
  if ((await S(() => window.swmmStudio.getState().bottomTab)) !== "table") fail("the drag opened the tab");
  return { before, after };
});

await step("close all the tabs", async () => {
  await page.locator(".bottom .tabs-tool", { hasText: "Close all tabs" }).click();
  const st = await S(() => {
    const s = window.swmmStudio.getState();
    return { tabs: document.querySelectorAll(".bottom .view-tab").length, reports: s.reportViews.length, tab: s.bottomTab };
  });
  if (st.tabs !== 0 || st.reports !== 0) fail(JSON.stringify(st));
  return st;
});

await S(() => window.swmmStudio.setState({ bottomMax: false }));
if (errors.length) {
  console.log("page errors:\n" + errors.join("\n"));
  process.exitCode = 1;
}
await browser.close();
