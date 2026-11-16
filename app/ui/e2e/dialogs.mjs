// Dialog keyboard and name link test of the running desktop app (see edit.mjs for how to
// start it): Escape closes a confirmation without touching the selection, does not discard
// a dialog with unsaved input, and Tab stays inside the dialog; the object names shown as
// links are loaded once and select their object.
//
//   node e2e/dialogs.mjs <copy of testdata/tiny.inp>

import { chromium } from "playwright-core";

const [model] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/dialogs.mjs <model.inp>");
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
const state = () => S(() => ({ selection: window.swmmStudio.getState().selection, dialog: window.swmmStudio.getState().dialog, pending: !!window.swmmStudio.getState().pendingDelete, tool: window.swmmStudio.getState().tool }));

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
await S(() => window.swmmStudio.setState({ crsDialog: false, sideTab: "props" }));

await step("Escape closes the delete confirmation and keeps the selection", async () => {
  // J2 has connected links: deleting it asks first.
  const j2 = await S(() => window.swmmStudio.api.findObject("J2"));
  await S((o) => window.swmmStudio.setState({ selection: [o], tool: "select" }), j2);
  await page.locator(".map").click({ position: { x: 5, y: 5 }, modifiers: ["Shift"] });
  await S((o) => window.swmmStudio.setState({ selection: [o] }), j2);
  await page.keyboard.press("Delete");
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });
  const s = await state();
  if (s.pending) fail("the confirmation is still pending");
  if (s.selection.length !== 1 || s.selection[0].index !== j2.index) fail(`selection lost: ${JSON.stringify(s.selection)}`);
  return s.selection;
});

await step("Escape does not discard the options dialog; Tab and Shift+Tab stay inside it", async () => {
  await S(() => window.swmmStudio.setState({ dialog: "options" }));
  await page.waitForSelector(".modal .options-grid", { timeout: 5000 });
  // Right after the dialog opens, going backwards must not land on the page behind.
  await page.keyboard.press("Shift+Tab");
  if (!(await S(() => !!document.activeElement?.closest(".modal")))) fail("Shift+Tab left the dialog as it opened");
  await page.locator(".modal .options-grid input").first().fill("12");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  if ((await state()).dialog !== "options") fail("Escape closed a dialog with unsaved input");
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (!(await S(() => !!document.activeElement?.closest(".modal")))) fail(`Tab left the dialog after ${i + 1} presses`);
  }
  await page.locator(".modal button", { hasText: "Cancel" }).click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });
  return (await state()).dialog;
});

await step("object names are asked once for all the links of a panel; a link selects its object", async () => {
  // Every name request is counted from before the model is opened anew (with no names
  // loaded), so that a load started as it opens counts too. Nothing else on screen shows names.
  await S(() => {
    const api = window.swmmStudio.api;
    if (!window.idsCalls) {
      const ids = api.ids;
      api.ids = (kind) => (window.idsCalls.push(kind), ids(kind));
    }
    window.idsCalls = [];
    window.swmmStudio.setState({ selection: [], message: null, labels: false, sideTab: "props" });
  });
  await S((p) => window.swmmStudio.openModel(p), model);
  await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
  // Map labels load node and link names on their own: the count below is for links only.
  if (await S(() => window.swmmStudio.getState().labels)) fail("the project of this copy turns map labels on: use a fresh copy of tiny.inp");
  await S(() => window.swmmStudio.setState({ crsDialog: false, sideTab: "props" }));
  // C1 goes from J1 to J2: its properties show both names as links.
  const c1 = await S(() => window.swmmStudio.api.findObject("C1"));
  await S((o) => window.swmmStudio.setState({ selection: [o] }), c1);
  const link = page.locator(".tab-body .obj-link", { hasText: /^J2$/ }).first();
  await link.waitFor({ timeout: 5000 });
  const calls = await S(() => window.idsCalls.slice().sort());
  if (calls.join() !== "gage,link,node,subcatchment") fail(`names asked ${calls.length} times: ${calls.join()}`);
  await link.click();
  await page.waitForFunction(() => window.swmmStudio.getState().selection[0]?.kind === "node", null, { timeout: 5000 });
  const j2 = await S(() => window.swmmStudio.api.findObject("J2"));
  const s = await state();
  if (s.selection.length !== 1 || s.selection[0].index !== j2.index) fail(`the link selected ${JSON.stringify(s.selection)}`);
  // After a deletion that shifts the indices, a link still selects the object it names.
  const j1 = await S(() => window.swmmStudio.api.findObject("J1"));
  await S((o) => window.swmmStudio.tryEdit({ op: "delete", objects: [o] }), j1);
  const c2 = await S(() => window.swmmStudio.api.findObject("C2"));
  const j2now = await S(() => window.swmmStudio.api.findObject("J2"));
  if (!c2 || !j2now || j2now.index === j2.index) fail(`the deletion did not shift J2: ${JSON.stringify([j2, j2now])}`);
  await S((o) => window.swmmStudio.setState({ selection: [o] }), c2);
  const link2 = page.locator(".tab-body .obj-link", { hasText: /^J2$/ }).first();
  await link2.waitFor({ timeout: 5000 });
  await link2.click();
  await page.waitForFunction((i) => { const s = window.swmmStudio.getState().selection; return s[0]?.kind === "node" && s[0].index === i; }, j2now.index, { timeout: 5000 });
  await S(() => window.swmmStudio.undo());
  return calls;
});

if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
console.log("all dialog checks passed");
await browser.close();
