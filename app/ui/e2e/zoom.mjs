// Time series zoom test of the running desktop app (see smoke.mjs for how to start it): plots a
// system series, zooms with the wheel around the pointer, pans with Shift+drag and right-drag,
// goes back and forward through the zooms (buttons and mouse buttons), zooms in and out from the
// toolbar, types the range shown, zooms to a box, and checks the narrowest zoom.
//
//   node e2e/zoom.mjs <model.inp with results> [screenshot folder]
//
// A model with results: `swmm-cli out synth m.out --nodes 20 --links 20 --subcatchments 5 --periods 2000 --inp m.inp`.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, shots = "zoom-shots"] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/zoom.mjs <model.inp> [screenshot folder]");
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
const fail = (msg) => {
  throw new Error(msg);
};
const view = () =>
  S(() => {
    const s = window.swmmStudio.getState();
    const v = s.plotViews.find((x) => x.id === s.plotView);
    return { zoom: v.zoom, back: v.zoomBack?.length ?? 0, fwd: v.zoomForward?.length ?? 0 };
  });
const run = () =>
  S(() => {
    const r = window.swmmStudio.getState().model.results;
    return { a: r.start_ms / 1000, b: (r.start_ms + (r.n_periods - 1) * r.step_secs * 1000) / 1000, step: r.step_secs };
  });
const near = (x, y, tol) => Math.abs(x - y) <= tol;
/** The x scale of the chart (what is drawn) and the plot box in CSS pixels. */
const chart = () =>
  S(() => {
    const over = document.querySelector(".plot-graph .u-over");
    const r = over.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
const settle = () => page.waitForTimeout(700);

await step("open the model with its results", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await until(() => window.swmmStudio.getState().busy === null && !!window.swmmStudio.getState().model?.results, null, 60000);
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
});

const R = await run();

await step("plot a system series", async () => {
  await S(() => window.swmmStudio.addToPlot("system", 0, 0));
  await page.waitForSelector(".plot-area canvas", { timeout: 15000 });
  await settle();
  const v = await view();
  if (v.zoom !== null || v.back !== 0) fail(JSON.stringify(v));
});

await step("wheel zooms in around the pointer, one history step", async () => {
  const c = await chart();
  const px = c.x + c.w * 0.25;
  const t = R.a + (R.b - R.a) * 0.25;
  await page.mouse.move(px, c.y + c.h / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await settle();
  const v = await view();
  if (!v.zoom || v.back !== 1) fail(JSON.stringify(v));
  const w = v.zoom[1] - v.zoom[0];
  if (w > (R.b - R.a) * 0.5) fail(`not zoomed in enough: ${w}`);
  // The time under the pointer stays there.
  const at = v.zoom[0] + w * 0.25;
  if (!near(at, t, (R.b - R.a) * 0.01)) fail(`pointer time moved: ${at} vs ${t}`);
  await shot("1-wheel");
  return { width_h: w / 3600 };
});

await step("Shift+drag pans (same width, earlier)", async () => {
  const before = (await view()).zoom;
  const c = await chart();
  await page.keyboard.down("Shift");
  await page.mouse.move(c.x + c.w * 0.3, c.y + c.h / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.w * 0.6, c.y + c.h / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await settle();
  const v = await view();
  const w0 = before[1] - before[0];
  if (!near(v.zoom[1] - v.zoom[0], w0, 1)) fail(`width changed ${JSON.stringify(v)}`);
  if (!near(before[0] - v.zoom[0], w0 * 0.3, w0 * 0.03)) fail(`pan ${before[0] - v.zoom[0]} vs ${w0 * 0.3}`);
  if (v.back !== 2) fail(JSON.stringify(v));
});

await step("right-drag pans (later)", async () => {
  const before = (await view()).zoom;
  const c = await chart();
  await page.mouse.move(c.x + c.w * 0.6, c.y + c.h / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(c.x + c.w * 0.4, c.y + c.h / 2, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await settle();
  const v = await view();
  const w0 = before[1] - before[0];
  if (!near(v.zoom[0] - before[0], w0 * 0.2, w0 * 0.03)) fail(`pan ${v.zoom[0] - before[0]}`);
  return { back: v.back };
});

await step("◀ goes back, ▶ forward again", async () => {
  const cur = await view();
  await page.locator(".plot-zoom button", { hasText: "◀" }).click();
  const b = await view();
  if (b.fwd !== 1 || b.back !== cur.back - 1 || JSON.stringify(b.zoom) === JSON.stringify(cur.zoom)) fail(JSON.stringify(b));
  await page.locator(".plot-zoom button", { hasText: "▶" }).click();
  const f = await view();
  if (JSON.stringify(f.zoom) !== JSON.stringify(cur.zoom) || f.fwd !== 0) fail(JSON.stringify(f));
});

await step("mouse back and forward buttons", async () => {
  const cur = await view();
  const btn = (button) =>
    S((button) => document.querySelector(".plot-graph .u-over").dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true, cancelable: true })), button);
  await btn(3);
  if ((await view()).back !== cur.back - 1) fail("back button");
  await btn(4);
  if (JSON.stringify((await view()).zoom) !== JSON.stringify(cur.zoom)) fail("forward button");
});

await step("toolbar + and −", async () => {
  const z0 = (await view()).zoom;
  await page.locator(".plot-zoom button", { hasText: "+" }).click();
  const z1 = (await view()).zoom;
  if (!near(z1[1] - z1[0], (z0[1] - z0[0]) / 2, 1)) fail(JSON.stringify(z1));
  await page.locator(".plot-zoom button", { hasText: "−" }).click();
  const z2 = (await view()).zoom;
  if (!near(z2[1] - z2[0], z0[1] - z0[0], 1)) fail(JSON.stringify(z2));
});

await step("typed start and end of the range", async () => {
  const iso = (s) => new Date(s * 1000).toISOString().slice(0, 16);
  const a = R.a + Math.round((R.b - R.a) * 0.4 / 60) * 60;
  const b = a + 6 * 3600;
  const [start, end] = [page.locator(".plot-zoom input").nth(0), page.locator(".plot-zoom input").nth(1)];
  // From the whole run: the end first, then the start.
  await page.locator(".plot-zoom button", { hasText: "Whole run" }).click();
  await end.fill(iso(b));
  await end.press("Enter");
  await start.fill(iso(a));
  await start.press("Enter");
  await settle();
  const v = await view();
  if (!near(v.zoom[0], a, 1) || !near(v.zoom[1], b, 1)) fail(`${JSON.stringify(v.zoom)} vs ${a} ${b}`);
  await shot("2-typed");
  return { start: iso(a), end: iso(b) };
});

await step("drag box zoom, then the narrowest zoom is 2 time steps", async () => {
  const c = await chart();
  const before = (await view()).zoom;
  await page.mouse.move(c.x + c.w * 0.2, c.y + c.h / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.w * 0.5, c.y + c.h / 2, { steps: 6 });
  await page.mouse.up();
  await settle();
  const v = await view();
  const w0 = before[1] - before[0];
  if (!near(v.zoom[1] - v.zoom[0], w0 * 0.3, w0 * 0.03)) fail(`box ${JSON.stringify(v.zoom)}`);
  await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -200);
  await settle();
  const n = (await view()).zoom;
  if (!near(n[1] - n[0], 2 * R.step, 1)) fail(`narrowest ${n[1] - n[0]} vs ${2 * R.step}`);
  await shot("3-narrowest");
});

await step("double-click shows the whole run; ◀ comes back", async () => {
  const before = (await view()).zoom;
  const c = await chart();
  await page.mouse.dblclick(c.x + c.w / 2, c.y + c.h / 2);
  await settle();
  if ((await view()).zoom !== null) fail("not reset");
  await page.locator(".plot-zoom button", { hasText: "◀" }).click();
  if (JSON.stringify((await view()).zoom) !== JSON.stringify(before)) fail("back after reset");
});

await step("zooming out stops at the whole run", async () => {
  const c = await chart();
  await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 300);
  await settle();
  if ((await view()).zoom !== null) fail(JSON.stringify(await view()));
});

if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
console.log("all ok");
await browser.close();
