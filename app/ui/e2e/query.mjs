// Select by query test of the running desktop app (see edit.mjs for how to start it): the
// dialog opens with Q, a query selects the matching objects, the selection is replaced,
// added to, intersected and reduced, and a wrong query says why without changing it.
//
//   node e2e/query.mjs <copy of testdata/tiny.inp> [shots folder]

import { chromium } from "playwright-core";

const [model, shots] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/query.mjs <model.inp> [shots]");
  process.exit(2);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
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
/** IDs of the selected objects, as `kind:id`, sorted. */
const selected = () =>
  S(async () => {
    const st = window.swmmStudio.getState();
    const out = [];
    for (const o of st.selection) out.push(`${o.kind}:${(await window.swmmStudio.api.ids(o.kind))[o.index]}`);
    return out.sort();
  });

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
await S(() => window.swmmStudio.setState({ crsDialog: false, dialog: null, selection: [] }));

const query = async (layer, text, mode) => {
  await page.locator(".modal select").selectOption(layer);
  await page.locator(".modal input[aria-label=Query]").fill(text);
  await page.locator(".modal label", { hasText: mode }).locator("input").check();
  await page.locator(".modal input[aria-label=Query]").press("Enter");
  await page.waitForFunction(() => document.querySelector(".modal .muted:last-of-type, .modal .panel-error"), null, { timeout: 5000 });
  await page.waitForTimeout(150);
};

await step("Q opens the dialog", async () => {
  await page.locator(".map").click({ position: { x: 5, y: 5 } });
  await S(() => window.swmmStudio.setState({ selection: [] }));
  await page.keyboard.press("q");
  await page.waitForSelector(".modal input[aria-label=Query]", { timeout: 5000 });
  if (!(await S(() => document.activeElement?.getAttribute("aria-label") === "Query"))) fail("the query field has no focus");
});

await step("type = outfall selects the outfalls", async () => {
  await query("node", "type = outfall", "New selection");
  const s = await selected();
  if (s.length === 0 || !s.every((x) => x.startsWith("node:"))) fail(`selection: ${s}`);
  return s;
});

await step("Add: junctions other than J1 are added", async () => {
  const before = (await selected()).length;
  await query("node", "type = junction and id != 'J1'", "Add");
  const s = await selected();
  if (s.length <= before || s.includes("node:J1")) fail(`selection: ${s}`);
  return s;
});

await step("Intersect keeps the selected objects the query finds", async () => {
  await query("node", "type = junction", "Intersect");
  const s = await selected();
  if (s.length === 0 || s.some((x) => x.includes("Out")) || s.includes("node:J1")) fail(`selection: ${s}`);
  return s;
});

await step("Remove takes the objects found out of the selection", async () => {
  const before = await selected();
  await query("node", `id = '${before[0].slice(5)}'`, "Remove");
  const s = await selected();
  if (s.length !== before.length - 1 || s.includes(before[0])) fail(`selection: ${s}`);
  return s;
});

await step("diameter on links, from the names offered", async () => {
  await page.locator(".modal select").selectOption("link");
  await page.locator(".modal input[aria-label=Query]").fill("");
  await page.locator(".modal .query-name", { hasText: /^diameter$/ }).click();
  await page.keyboard.type(" > 0");
  const text = await page.locator(".modal input[aria-label=Query]").inputValue();
  if (text !== "diameter > 0") fail(`query: ${text}`);
  await page.locator(".modal label", { hasText: "New selection" }).locator("input").check();
  await page.locator(".modal button", { hasText: "Select" }).click();
  await page.waitForTimeout(300);
  const s = await selected();
  if (s.length === 0 || !s.every((x) => x.startsWith("link:"))) fail(`selection: ${s}`);
  if (shots) await page.screenshot({ path: `${shots}/query.png` });
  return s;
});

await step("a wrong query says why and leaves the selection", async () => {
  const before = await selected();
  await query("link", "diametre < 0.3", "New selection");
  const err = await page.locator(".modal .panel-error").textContent();
  if (!err?.includes("diametre")) fail(`error: ${err}`);
  if (JSON.stringify(await selected()) !== JSON.stringify(before)) fail("the selection changed");
  return err;
});

await step("Escape closes the dialog and keeps the selection", async () => {
  const before = await selected();
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });
  if (JSON.stringify(await selected()) !== JSON.stringify(before)) fail("the selection changed");
});

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("all query checks passed");
await browser.close();
