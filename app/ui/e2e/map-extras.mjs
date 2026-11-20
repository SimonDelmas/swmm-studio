// Map extras test of the running desktop app (see edit.mjs for how to start it): runs the
// model, draws the flow arrows, greys the basemap, hovers an object for its tooltip and
// measures a distance and an area with the measure tool (real mouse and keyboard).
//
//   node e2e/map-extras.mjs <copy of testdata/tiny.inp> <runswmm.exe> [screenshot folder]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, engine, shots = "map-extras-shots"] = process.argv.slice(2);
if (!model || !engine) {
  console.error("usage: node e2e/map-extras.mjs <model.inp> <runswmm.exe> [screenshot folder]");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`);
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
/** Page position of a node. */
const nodeXY = (id) =>
  S((id) => {
    const st = window.swmmStudio.getState();
    const i = st.ids.node.indexOf(id);
    const g = st.geometry;
    return window.swmmStudio.mapProject([g.nodes[2 * i], g.nodes[2 * i + 1]]);
  }, id);
/** The flow arrows drawn: link index under each arrow is not kept, so their angles and count. */
const arrows = () =>
  S(() => {
    const l = window.swmmStudio.mapPerf.layers.find((l) => l.id === "flow-arrows");
    if (!l) return null;
    const d = l.props.data;
    return { count: d.length, angles: Array.from(d.attributes.getAngle.value).map((a) => Math.round(a)) };
  });
const setLinkStyle = (patch) =>
  S((patch) => {
    const st = window.swmmStudio;
    const s = st.getState().styles;
    st.setState({ styles: { ...s, link: { ...s.link, ...patch } } });
  }, patch);

await step("open the model in Lambert 93 and run it", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await waitIdle();
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await S(() => window.swmmStudio.applyCrs("EPSG:2154"));
  await waitIdle();
  await S(async () => {
    const st = window.swmmStudio;
    st.setState({ ids: { ...st.getState().ids, node: await st.api.ids("node"), link: await st.api.ids("link") } });
  });
  await S((p) => window.swmmStudio.api.addEngine("epa", p), engine);
  await S(() => window.swmmStudio.setState({ engine: "epa" }));
  await S(() => window.swmmStudio.startRun("map-extras"));
  await until(() => !window.swmmStudio.getState().run.running && window.swmmStudio.getState().run.last, null, 120000);
  await waitIdle();
  await until(() => !!window.swmmStudio.getState().model.results);
  await S(() => window.swmmStudio.setState({ fitExtent: window.swmmStudio.getState().fitExtent + 1 }));
  await page.waitForTimeout(800);
});

await step("flow arrows point downstream where the conduits flow", async () => {
  // The period of the highest flow in C1.
  const p = await S(async () => {
    const st = window.swmmStudio;
    const flow = st.getState().model.results.variables.link.findIndex((v) => /flow/i.test(v.name));
    return st.api.timeOfMax("link", 0, flow);
  });
  await S((p) => window.swmmStudio.setState({ period: p }), p);
  await setLinkStyle({ flowArrows: true });
  await until(() => window.swmmStudio.mapPerf.layers.some((l) => l.id === "flow-arrows"));
  const flows = await S(async (p) => {
    const st = window.swmmStudio;
    const flow = st.getState().model.results.variables.link.findIndex((v) => /flow/i.test(v.name));
    return Array.from(await st.api.frame("link", flow, p));
  }, p);
  const a = await arrows();
  const flowing = flows.filter((f) => Math.abs(f) >= 1e-6);
  if (a.count !== flowing.length) fail(`${a.count} arrows for flows ${JSON.stringify(flows)}`);
  // C1 goes from J1 to J2: (100, -50) in Lambert 93, about -27° on the screen.
  if (flows[0] > 0 && !near(a.angles[0], -27, 2)) fail(`C1 arrow at ${a.angles[0]}°`);
  await shot("arrows");
  return { period: p, flows, ...a };
});

await step("arrows off: none drawn", async () => {
  await setLinkStyle({ flowArrows: false });
  await until(() => !window.swmmStudio.mapPerf.layers.some((l) => l.id === "flow-arrows"));
  return "off";
});

await step("the basemap turns grey from the style panel and is saved", async () => {
  await page.getByRole("button", { name: "Map style", exact: true }).click();
  await page.locator("label", { hasText: /^grey$/ }).locator("input").check();
  await until(() => document.querySelector(".map").__map.getPaintProperty("basemap", "raster-saturation") === -1);
  const saved = await S(() => window.swmmStudio.getState().model.project.basemap.greyscale);
  if (saved !== true) fail("greyscale not in the project");
  await page.waitForTimeout(1500);
  await shot("greyscale");
  await page.locator("label", { hasText: /^grey$/ }).locator("input").uncheck();
  await until(() => document.querySelector(".map").__map.getPaintProperty("basemap", "raster-saturation") === 0);
});

await step("hovering J2 shows its tooltip, moving away hides it", async () => {
  await setLinkStyle({ flowArrows: true });
  const [x, y] = await nodeXY("J2");
  await page.mouse.move(x - 30, y - 30);
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForSelector(".map-tooltip", { timeout: 5000 });
  const text = await S(() => document.querySelector(".map-tooltip").innerText);
  if (!/J2/.test(text) || !/Junction/i.test(text) || !/depth/i.test(text)) fail(text);
  await shot("tooltip");
  // A conduit: its flow.
  const [x1, y1] = await nodeXY("J1");
  await page.mouse.move((x + x1) / 2, (y + y1) / 2, { steps: 4 });
  await until(() => /C1/.test(document.querySelector(".map-tooltip")?.innerText ?? ""), null, 5000);
  const link = await S(() => document.querySelector(".map-tooltip").innerText);
  if (!/conduit/i.test(link) || !/flow/i.test(link)) fail(link);
  await page.mouse.move(x + 200, y - 200, { steps: 4 });
  await page.waitForTimeout(600);
  if (await S(() => !!document.querySelector(".map-tooltip"))) fail("tooltip left over an empty spot");
  return [text, link].map((t) => t.replace(/\n/g, " | "));
});

await step("measure J1 → J2 → J3: distance and area", async () => {
  // Letter shortcuts do not apply in a form field (the grey checkbox has the focus).
  await S(() => document.activeElement?.blur());
  await page.keyboard.press("d");
  if ((await S(() => window.swmmStudio.getState().tool)) !== "measure") fail("D did not pick the measure tool");
  for (const id of ["J1", "J2", "J3"]) {
    const [x, y] = await nodeXY(id);
    await page.mouse.click(x, y);
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Enter");
  const text = await S(() => document.querySelector(".map-measure")?.innerText ?? "");
  // 111.8 m + 138.9 m in Lambert 93 (scale factor close to 1), triangle of 500 m².
  const dist = Number(/Distance ([\d.,]+) m/.exec(text)?.[1].replace(/,/g, ""));
  const area = Number(/Area ([\d.,]+) m²/.exec(text)?.[1].replace(/,/g, ""));
  if (!near(dist, 250.7, 2.5) || !near(area, 500, 10)) fail(text);
  // Ended: moving the pointer no longer changes it.
  await page.mouse.move(50, 50);
  if ((await S(() => document.querySelector(".map-measure").innerText)) !== text) fail("measure changed after Enter");
  await shot("measure");
  return text.replace(/\n/g, " | ");
});

await step("Backspace removes the last point, Escape clears, Escape again leaves the tool", async () => {
  await page.keyboard.press("Backspace");
  const text = await S(() => document.querySelector(".map-measure")?.innerText ?? "");
  if (/Area/.test(text)) fail(`area left with two points: ${text}`);
  await page.keyboard.press("Escape");
  if (await S(() => !!document.querySelector(".map-measure"))) fail("measure not cleared");
  await page.keyboard.press("Escape");
  if ((await S(() => window.swmmStudio.getState().tool)) !== "select") fail("tool not back to select");
});

await step("a double-click ends a measure", async () => {
  await page.keyboard.press("d");
  const [x1, y1] = await nodeXY("J1");
  const [x2, y2] = await nodeXY("Out1");
  const zoom0 = await S(() => document.querySelector(".map").__map.getZoom());
  await page.mouse.click(x1, y1);
  await page.mouse.dblclick(x2, y2);
  await page.waitForTimeout(300);
  const text = await S(() => document.querySelector(".map-measure")?.innerText ?? "");
  const zoom = await S(() => document.querySelector(".map").__map.getZoom());
  if (zoom !== zoom0) fail(`the double-click zoomed the map (${zoom0} → ${zoom})`);
  await page.mouse.move(10, 10);
  if ((await S(() => document.querySelector(".map-measure")?.innerText ?? "")) !== text) fail("still measuring after a double-click");
  // J1 → Out1 in a straight line: (300, -150), 335.4 m.
  const dist = Number(/Distance ([\d.,]+) m/.exec(text)?.[1].replace(/,/g, ""));
  if (!near(dist, 335.4, 3)) fail(text);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  return { text, zoom };
});

if (errors.length) fail(`console errors: ${errors.join("\n")}`);
console.log("all map extras checks passed");
await browser.close();
