// Time series legend test of the running desktop app (see edit.mjs for how to start it): runs
// the model, plots J1 and J2 depths on one graph, hides J1 from the legend, checks that it
// stays hidden when the chart is made again (a series added), then shows it again.
//
//   node e2e/legend.mjs <copy of testdata/tiny.inp> <runswmm.exe> [screenshot folder]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, engine, shots = "legend-shots"] = process.argv.slice(2);
if (!model || !engine) {
  console.error("usage: node e2e/legend.mjs <model.inp> <runswmm.exe> [screenshot folder]");
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
const add = (id, v = 0) => S(([id, v]) => window.swmmStudio.addToPlot("node", window.swmmStudio.getState().ids.node.indexOf(id), v), [id, v]);
/** Legend entries of the graph (without the time) and whether each is hidden. */
const legend = () =>
  S(() =>
    Array.from(document.querySelectorAll(".plot-graph .u-legend .u-series"))
      .slice(1)
      .map((e) => ({ label: e.querySelector(".u-label")?.textContent ?? "", off: e.classList.contains("u-off") })),
  );
const chips = () => S(() => Array.from(document.querySelectorAll(".plot-graph-head .chip")).map((c) => c.classList.contains("off")));
const entry = (label) => page.locator(".plot-graph .u-legend .u-series", { has: page.locator(".u-label", { hasText: label }) }).first();

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
  await S(() => window.swmmStudio.startRun("legend"));
  await until(() => !window.swmmStudio.getState().run.running && window.swmmStudio.getState().run.last, null, 120000);
  await waitIdle();
  await until(() => !!window.swmmStudio.getState().model.results);
});

await step("J1 and J2 depths on one graph", async () => {
  await add("J1");
  await add("J2");
  await until(() => document.querySelectorAll(".plot-graph .u-legend .u-series").length === 3);
  const l = await legend();
  if (l.some((e) => e.off)) fail(JSON.stringify(l));
  return l.map((e) => e.label);
});

await step("a click on J1 in the legend hides it", async () => {
  await entry("J1").click();
  const l = await legend();
  if (!l[0].off || l[1].off) fail(JSON.stringify(l));
  const c = await chips();
  if (!c[0] || c[1]) fail(`chips ${JSON.stringify(c)}`);
  return l;
});
await shot("1-hidden");

await step("J1 stays hidden when the chart is made again", async () => {
  await add("J3");
  await until(() => document.querySelectorAll(".plot-graph .u-legend .u-series").length === 4);
  const l = await legend();
  if (!l[0].off || l[1].off || l[2].off) fail(JSON.stringify(l));
  return l;
});

await step("a second click shows J1 again", async () => {
  await entry("J1").click();
  const l = await legend();
  if (l.some((e) => e.off)) fail(JSON.stringify(l));
  const c = await chips();
  if (c.some(Boolean)) fail(`chips ${JSON.stringify(c)}`);
});
await shot("2-shown");

if (errors.length) fail(`console errors:\n${errors.join("\n")}`);
console.log("legend test passed");
await browser.close();
