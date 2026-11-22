// External changes test of the running desktop app (see edit.mjs for how to start it): the
// model and the loaded results changed by another program are offered to be reloaded, once
// per change; kept, a change is not offered again; saving from the app is not a change.
//
//   node e2e/files.mjs <model.inp with <model>.out beside it>
//
// A model with results: `swmm-cli out synth m.out --nodes 20 --links 20 --subcatchments 5 --periods 50 --inp m.inp`.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [model] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/files.mjs <model.inp>");
  process.exit(2);
}
const out = model.replace(/\.inp$/i, ".out");

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
const get = (key) => S((k) => window.swmmStudio.getState()[k], key);
const dialog = (title) => page.locator(".modal", { has: page.locator("h3", { hasText: title }) });
const shown = (title) => dialog(title).waitFor({ timeout: 8000 });
const gone = (title) => dialog(title).waitFor({ state: "detached", timeout: 8000 });
const idle = () => page.waitForFunction(() => window.swmmStudio.getState().busy === null, null, { timeout: 30000 });
/** No dialog within a few polls of the backend. */
const none = async (title) => {
  await page.waitForTimeout(3500);
  if ((await dialog(title).count()) > 0) fail(`"${title}" shown`);
};

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
await S(() => window.swmmStudio.setState({ crsDialog: false, dialog: null }));
if (!(await get("model")).results) fail(`no results loaded beside ${model}`);

await step("nothing is offered while the files stay as they were read", () => none("Model changed on disk"));

await step("the model changed by another program is offered; kept, it is not offered again", async () => {
  appendFileSync(model, "\n; changed by another program\n");
  await shown("Model changed on disk");
  await dialog("Model changed on disk").locator("button", { hasText: "Keep this version" }).click();
  await gone("Model changed on disk");
  await none("Model changed on disk");
});

await step("a new change is offered again; Reload reads the model again", async () => {
  const seq = await get("modelSeq");
  appendFileSync(model, "; changed again\n");
  await shown("Model changed on disk");
  await dialog("Model changed on disk").locator("button", { hasText: "Reload" }).click();
  await gone("Model changed on disk");
  await idle();
  if ((await get("modelSeq")) === seq) fail("the model was not opened again");
  await none("Model changed on disk");
});

await step("an unsaved edit is said to be lost by Reload; Escape keeps it", async () => {
  await S(() => window.swmmStudio.setState({ model: { ...window.swmmStudio.getState().model, dirty: true } }));
  appendFileSync(model, "; and again\n");
  await shown("Model changed on disk");
  const text = await dialog("Model changed on disk").textContent();
  if (!text.includes("discards the unsaved changes")) fail(`no warning: ${text}`);
  await page.keyboard.press("Escape");
  await gone("Model changed on disk");
  await S(() => window.swmmStudio.setState({ model: { ...window.swmmStudio.getState().model, dirty: false } }));
  await none("Model changed on disk");
});

await step("saving from the app is not a change", async () => {
  await S(() => window.swmmStudio.saveModel());
  await none("Model changed on disk");
});

await step("the results changed by another program are offered; Reload reads them again", async () => {
  const before = (await get("model")).results.n_periods;
  // Written back as it is: only its time of change differs.
  const bytes = readFileSync(out);
  try {
    writeFileSync(out, bytes);
  } catch (e) {
    return `skipped: the loaded results cannot be written over (${e.code})`;
  }
  await shown("Results changed on disk");
  await dialog("Results changed on disk").locator("button", { hasText: "Reload results" }).click();
  await gone("Results changed on disk");
  await idle();
  const after = (await get("model")).results.n_periods;
  if (after !== before) fail(`periods ${before} → ${after}`);
  await none("Results changed on disk");
  return after;
});

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("files: all ok");
await browser.close();
