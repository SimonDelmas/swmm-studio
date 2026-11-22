// Bulk edit with expressions test of the running desktop app (see edit.mjs for how to start
// it): with the links of testdata/tiny.inp selected, `diameter = diameter * 1.2 where
// slope < 0.005` changes the one flat conduit, the panel says what changed, one undo
// reverts it, a field of another section and a text are set, and a wrong expression says
// why without changing the model.
//
//   node e2e/bulk.mjs <copy of testdata/tiny.inp> [shots folder]

import { chromium } from "playwright-core";

const [model, shots] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/bulk.mjs <model.inp> [shots]");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? "http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
if (!page) throw new Error("no app page found");
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const S = (fn, arg) => page.evaluate(fn, arg);
const fail = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};
const step = async (name, fn) => {
  const r = await fn();
  console.log(`ok  ${name}${r !== undefined ? ` → ${JSON.stringify(r)}` : ""}`);
};
/** Values of a numeric attribute of the links, rounded. */
const links = (name) =>
  S(async (n) => Array.from(await window.swmmStudio.api.attribute("link", n), (x) => Math.round(x * 1e4) / 1e4), name);
const input = () => page.locator("input[aria-label='Bulk edit expression']");
/** Types an expression, applies it with Enter, and returns what the panel says. */
const apply = async (text) => {
  await input().fill(text);
  await input().press("Enter");
  await page.waitForFunction(() => document.querySelector(".bulk .field-error, .bulk > .muted:last-child"), null, { timeout: 5000 });
  await page.waitForTimeout(200);
  return page.locator(".bulk .field-error, .bulk > .muted:last-child").last().textContent();
};

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
const nLinks = await S(async () => (await window.swmmStudio.api.ids("link")).length);
await S((n) => window.swmmStudio.setState({ crsDialog: false, dialog: null, selection: Array.from({ length: n }, (_, index) => ({ kind: "link", index })) }), nLinks);
const before = await links("geom1");

await step("the panel shows for the selected links", async () => {
  await input().waitFor({ timeout: 5000 });
  const label = await page.locator(".bulk button.primary", { hasText: "Apply to" }).last().textContent();
  if (!label?.includes(`${nLinks} links`)) fail(`button: ${label}`);
  return label;
});

await step("diameter = diameter * 1.2 where slope < 0.005 changes the flat conduit", async () => {
  const said = await apply("diameter = diameter * 1.2 where slope < 0.005");
  if (!said?.startsWith("1 of 3 links changed")) fail(`panel: ${said}`);
  const after = await links("geom1");
  const changed = after.map((x, i) => x !== before[i]);
  if (changed.filter(Boolean).length !== 1 || after[1] !== Math.round(before[1] * 1.2 * 1e4) / 1e4) fail(`geom1: ${after}`);
  const undo = await S(() => window.swmmStudio.getState().model.undo);
  if (undo !== "Set diameter on 1 links") fail(`undo label: ${undo}`);
  if (shots) await page.screenshot({ path: `${shots}/bulk.png` });
  return { said, after };
});

await step("one undo reverts it", async () => {
  await S(() => window.swmmStudio.undo());
  await page.waitForTimeout(300);
  const after = await links("geom1");
  if (JSON.stringify(after) !== JSON.stringify(before)) fail(`geom1: ${after}`);
  return after;
});

await step("a field by key and a text", async () => {
  const said = await apply("n = n + 0.002 where shape = circular");
  if (!said?.startsWith("3 of 3 links changed")) fail(`panel: ${said}`);
  const n = await links("roughness");
  if (!n.every((x) => x === 0.015)) fail(`roughness: ${n}`);
  const said2 = await apply("shape = RECT_CLOSED where length > 100");
  if (!said2?.includes("changed")) fail(`panel: ${said2}`);
  return [said, said2];
});

await step("a wrong expression says why and changes nothing", async () => {
  const undo = await S(() => window.swmmStudio.getState().model.undo);
  const said = await apply("diametre = 1");
  if (!said?.includes("no field diametre")) fail(`panel: ${said}`);
  const said2 = await apply("diameter = 0 - 1");
  if (!said2?.includes("at least")) fail(`panel: ${said2}`);
  if ((await S(() => window.swmmStudio.getState().model.undo)) !== undo) fail("an edit was recorded");
  return [said, said2];
});

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("all bulk expression checks passed");
await browser.close();
