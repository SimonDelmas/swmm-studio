// X-Y plot test of the running desktop app (see edit.mjs for how to start it): runs the
// model, opens an X-Y tab from the "+" menu, plots depth vs flow of a conduit, the flows
// of other conduits against a fixed x, a system pair; joins the points, zooms with a box,
// clicks a point to set the current time, removes a series, and checks the values against
// the series of the results.
//
//   node e2e/xy.mjs <copy of testdata/tiny.inp> <runswmm.exe> [screenshot folder]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, engine, shots = "xy-shots"] = process.argv.slice(2);
if (!model || !engine) {
  console.error("usage: node e2e/xy.mjs <model.inp> <runswmm.exe> [screenshot folder]");
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
const view = () => S(() => window.swmmStudio.getState().xyViews.find((v) => v.id === window.swmmStudio.getState().xyView));
const select = (kind, ids) =>
  S(
    ([kind, ids]) => {
      const st = window.swmmStudio;
      st.setState({ selection: ids.map((id) => ({ kind, index: st.getState().ids[kind].indexOf(id) })) });
    },
    [kind, ids],
  );
/** Sets a <select> of the X-Y toolbar by its title. */
const choose = (title, label) => page.locator(`.plot-panel .panel-toolbar select[title="${title}"]`).selectOption({ label });
const canvasBox = async () => {
  const b = await page.locator(".xy-area canvas").boundingBox();
  if (!b) fail("no X-Y canvas");
  return b;
};

await step("open the model and run it", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await waitIdle();
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await S(async () => {
    const st = window.swmmStudio;
    st.setState({ ids: { node: await st.api.ids("node"), link: await st.api.ids("link"), subcatchment: await st.api.ids("subcatchment") } });
  });
  await S((p) => window.swmmStudio.api.addEngine("epa", p), engine);
  await S(() => window.swmmStudio.setState({ engine: "epa" }));
  await S(() => window.swmmStudio.startRun("xy"));
  await until(() => !window.swmmStudio.getState().run.running && window.swmmStudio.getState().run.last, null, 120000);
  await waitIdle();
  await until(() => !!window.swmmStudio.getState().model.results);
  return S(() => window.swmmStudio.getState().model.results.n_periods);
});

await step("“+” menu → X-Y opens an empty tab", async () => {
  await page.locator(".bottom .tab-add").click();
  await page.locator(".bottom .menu-items > button", { hasText: "X-Y" }).click();
  await until(() => window.swmmStudio.getState().bottomTab === "xy");
  const v = await view();
  if (!v || v.pairs.length !== 0 || v.name !== "X-Y 1") fail(JSON.stringify(v));
  if (!(await page.locator(".bottom .view-tab.active", { hasText: "X-Y 1" }).count())) fail("no active X-Y tab");
  return v.name;
});

await step("depth vs flow of C2: one pair, values equal to the results", async () => {
  await select("link", ["C2"]);
  await choose("Variable of the links on the x axis", "depth");
  await choose("Variable of the links on the y axis", "flow");
  await page.locator(".plot-panel button", { hasText: "+ Add selected" }).click();
  await until(() => document.querySelector(".xy-area canvas") !== null);
  const v = await view();
  if (v.pairs.length !== 1 || v.pairs[0].x.label !== "C2 depth" || v.pairs[0].y.label !== "C2 flow") fail(JSON.stringify(v.pairs));
  // The values plotted are those of the results at every period (short run: no stride).
  const check = await S(async () => {
    const st = window.swmmStudio;
    const r = st.getState().model.results;
    const c2 = st.getState().ids.link.indexOf("C2");
    const vals = await st.api.seriesValues("link", c2, 0, 0, r.n_periods, 1);
    const mm = await st.api.series("link", c2, 0, 0, r.n_periods, r.n_periods);
    const strided = await st.api.seriesValues("link", c2, 0, 0, r.n_periods, 3);
    const same = vals.length === r.n_periods && vals.every((x, i) => x === mm.min[i] || (Number.isNaN(x) && Number.isNaN(mm.min[i])));
    const stride = strided.length === Math.ceil(r.n_periods / 3) && strided.every((x, i) => x === vals[3 * i] || Number.isNaN(x));
    return { n: vals.length, same, stride, max: Math.max(...vals) };
  });
  if (!check.same || !check.stride || !(check.max > 0)) fail(JSON.stringify(check));
  return check;
});
await shot("1-depth-flow");

await step("fixed x: flows of C1 and C3 against the flow of C3 → C1 only (C3 vs itself left out)", async () => {
  await select("link", ["C3"]);
  await choose("Variable of the links on the x axis", "flow");
  await page.locator(".plot-panel button", { hasText: "Fix x" }).click();
  await until(() => window.swmmStudio.getState().xyViews[0].fixedX !== null);
  await select("link", ["C1", "C3"]);
  await choose("Variable of the links on the y axis", "flow");
  await page.locator(".plot-panel button", { hasText: "+ Add selected" }).click();
  await until(() => window.swmmStudio.getState().xyViews[0].pairs.length === 2);
  const v = await view();
  const labels = await page.locator(".plot-graph-head .chip").allInnerTexts();
  if (v.pairs[1].x.label !== "C3 flow" || v.pairs[1].y.label !== "C1 flow") fail(JSON.stringify(v.pairs[1]));
  // The x chip clears the fixed x.
  await page.locator(".plot-panel .panel-toolbar .chip button").click();
  await until(() => window.swmmStudio.getState().xyViews[0].fixedX === null);
  return labels.map((l) => l.replace("×", "").trim());
});

await step("system rainfall vs runoff; adding the same pair again does nothing", async () => {
  await choose("System variable on the x axis", "rainfall");
  await choose("System variable on the y axis", "runoff");
  await page.locator(".plot-panel button", { hasText: "+ System" }).click();
  await until(() => window.swmmStudio.getState().xyViews[0].pairs.length === 3);
  await page.locator(".plot-panel button", { hasText: "+ System" }).click();
  await page.waitForTimeout(300);
  const v = await view();
  if (v.pairs.length !== 3) fail(`${v.pairs.length} pairs`);
  return v.pairs[2].key;
});

await step("join points; box zoom, double-click shows all again", async () => {
  await page.locator(".plot-panel label", { hasText: "Join points" }).locator("input").check();
  await until(() => window.swmmStudio.getState().xyViews[0].lines);
  const b = await canvasBox();
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.locator(".plot-graph-head button", { hasText: "Show all" }).waitFor();
  await shot("2-zoomed");
  await page.mouse.dblclick(b.x + b.width * 0.4, b.y + b.height * 0.4);
  await page.locator(".plot-graph-head button", { hasText: "Show all" }).waitFor({ state: "detached" });
});
await shot("3-joined");

await step("hover a point shows its values; a click on it sets the current time", async () => {
  // Remove the other pairs: only C2 depth vs flow, whose peak is a point far from the others.
  for (let i = 0; i < 2; i++) await page.locator(".plot-graph-head .chip button").last().click();
  await until(() => window.swmmStudio.getState().xyViews[0].pairs.length === 1);
  await S(() => window.swmmStudio.setState({ period: 0 }));
  // The point of the peak flow: the top right of the data range, inside the 5% padding.
  const b = await canvasBox();
  const target = await S(async () => {
    const st = window.swmmStudio;
    const r = st.getState().model.results;
    const c2 = st.getState().ids.link.indexOf("C2");
    const q = await st.api.seriesValues("link", c2, 0, 0, r.n_periods, 1);
    let k = 0;
    q.forEach((x, i) => x > q[k] && (k = i));
    return k;
  });
  // Scan the top of the plot for the point under the pointer (tip shown).
  let found = null;
  for (let fx = 0.98; fx > 0.1 && !found; fx -= 0.01) {
    for (let fy = 0.02; fy < 0.3 && !found; fy += 0.01) {
      const x = b.x + 64 + (b.width - 80) * fx;
      const y = b.y + 10 + (b.height - 50) * fy;
      await page.mouse.move(x, y);
      if (await page.locator(".xy-tip").count()) found = [x, y];
    }
  }
  if (!found) fail("no point found under the pointer");
  const tip = await page.locator(".xy-tip").innerText();
  await shot("4-hover");
  await page.mouse.click(...found);
  await until(() => window.swmmStudio.getState().period > 0);
  const period = await S(() => window.swmmStudio.getState().period);
  if (period !== target) fail(`clicked the peak (period ${target}), current time set to period ${period}`);
  return { tip: tip.split("\n"), period, peak: target };
});

await step("tab rename, close; closing all closes X-Y tabs too", async () => {
  await page.locator(".bottom .view-tab", { hasText: "X-Y 1" }).locator("button").first().dblclick();
  await page.locator(".bottom input.narrow-name").fill("Rating C2");
  await page.locator(".bottom input.narrow-name").press("Enter");
  await until(() => window.swmmStudio.getState().xyViews[0].name === "Rating C2");
  await page.locator(".bottom .tab-add").click();
  await page.locator(".bottom .menu-items > button", { hasText: "X-Y" }).click();
  await until(() => window.swmmStudio.getState().xyViews.length === 2);
  await page.locator(".bottom .tabs-tool", { hasText: "Close all tabs" }).click();
  await until(() => window.swmmStudio.getState().xyViews.length === 0 && window.swmmStudio.getState().bottomTab === "table");
});

if (errors.length) fail(`errors in the page:\n${errors.join("\n")}`);
console.log("all X-Y checks passed");
await browser.close();
