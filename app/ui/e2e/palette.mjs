// Command palette test of the running desktop app (see edit.mjs for how to start it):
// Ctrl+P opens it, also from a field; typing filters the commands usable now; Enter, the
// arrows and a click run them; the last used come first; Escape closes it.
//
//   node e2e/palette.mjs <copy of testdata/tiny.inp>

import { chromium } from "playwright-core";

const [model] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/palette.mjs <model.inp>");
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
const get = (key) => S((k) => window.swmmStudio.getState()[k], key);
const labels = () => page.locator(".palette-list .palette-label").allTextContents();
const active = () => page.locator(".palette-list li.active .palette-label").textContent();
const open = async () => {
  await page.keyboard.press("Control+p");
  await page.waitForSelector(".palette-input", { timeout: 5000 });
};
const closed = () => page.waitForSelector(".palette-modal", { state: "detached", timeout: 5000 });

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
await S(() => window.swmmStudio.setState({ crsDialog: false, dialog: null, selection: [], labels: false, tool: "select" }));
await page.locator(".map").click({ position: { x: 5, y: 5 } });

await step("Ctrl+P opens the palette with the keyboard in its field; commands not usable now are left out", async () => {
  await open();
  if (!(await S(() => document.activeElement?.classList.contains("palette-input")))) fail("the field has not the focus");
  const all = await labels();
  if (all.length < 20) fail(`only ${all.length} commands listed`);
  if (all.includes("Delete the selected objects")) fail("Delete is listed with nothing selected");
  if (all.includes("Select tool")) fail("the tool in use is listed");
  return all.length;
});

await step("typing filters; Enter runs the first command and closes the palette", async () => {
  await page.keyboard.type("labels");
  const first = await active();
  if (first !== "Labels (show / hide)") fail(`first match: ${first}`);
  await page.keyboard.press("Enter");
  await closed();
  if (!(await get("labels"))) fail("the labels are not shown");
  if ((await get("dialog")) !== null) fail("the palette is still open");
});

await step("the command last run comes first", async () => {
  await open();
  const first = await active();
  if (first !== "Labels (show / hide)") fail(`first: ${first}`);
  return first;
});

await step("starts of words match (\"zsel\" → Zoom to the selection, \"sim opt\" → Simulation options); a command opens its dialog", async () => {
  await S(() => window.swmmStudio.setState({ selection: [{ kind: "node", index: 0 }] }));
  await page.keyboard.type("zsel");
  if ((await active()) !== "Zoom to the selection") fail(`zsel: ${await active()}`);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("sim opt");
  if ((await active()) !== "Simulation options") fail(`first match: ${await active()}`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal .options-grid", { timeout: 5000 });
  await page.locator(".modal button", { hasText: "Cancel" }).click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });
});

await step("arrows move through the list and go round; a click runs a command", async () => {
  await open();
  await page.keyboard.type("tool");
  const all = await labels();
  // In the label or the group ("Map tools").
  const stray = (await page.locator(".palette-list li").allTextContents()).filter((l) => !/tool/i.test(l));
  if (stray.length) fail(`"tool" also lists ${stray.join(", ")}`);
  await page.keyboard.press("ArrowDown");
  if ((await active()) !== all[1]) fail(`ArrowDown: ${await active()}`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  if ((await active()) !== all[all.length - 1]) fail(`ArrowUp from the first: ${await active()}`);
  await page.locator(".palette-list li", { hasText: "Box selection tool" }).click();
  await closed();
  if ((await get("tool")) !== "box") fail(`tool: ${await get("tool")}`);
  return all;
});

await step("no match says so; Escape closes the palette and leaves the tool and selection", async () => {
  await S(() => window.swmmStudio.setState({ tool: "box" }));
  await open();
  await page.keyboard.type("zzqxw");
  if ((await page.locator(".palette-none").count()) !== 1) fail("no 'No command matches'");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await closed();
  if ((await get("tool")) !== "box") fail("Escape also left the tool");
});

await step("Ctrl+P works from the Find field; Ctrl+P inside the palette moves down instead of printing", async () => {
  await page.locator("#find-object").focus();
  await open();
  const first = await active();
  await page.keyboard.press("Control+p");
  if ((await active()) === first) fail("Ctrl+P did not move to the next command");
  await page.keyboard.press("Escape");
  await closed();
});

await S(() => window.swmmStudio.setState({ tool: "select", labels: false }));
if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("palette: all ok");
await browser.close();
