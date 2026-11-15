// Dialog keyboard test of the running desktop app (see edit.mjs for how to start it):
// Escape closes a confirmation without touching the selection, does not discard a dialog
// with unsaved input, and Tab stays inside the dialog.
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

await step("Escape does not discard the options dialog; Tab stays inside it", async () => {
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

if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
console.log("all dialog checks passed");
await browser.close();
