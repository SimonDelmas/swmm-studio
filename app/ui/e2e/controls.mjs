// Control rules editor test of the running desktop app (see edit.mjs for how to start it):
// a rule naming a missing node is reported in the Issues tab with its line; clicking the
// issue opens the rules at that line, highlighted; fixing the text clears the problem.
//
//   node e2e/controls.mjs <copy of testdata/tiny.inp> [screenshot folder]

import { chromium } from "playwright-core";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, shots = "controls-shots"] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/controls.mjs <copy of testdata/tiny.inp> [screenshot folder]");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });
// The model is a scratch copy: the rules are added to it.
appendFileSync(
  model,
  "\n[CONTROLS]\n; storm rule\nRULE R1\nIF NODE J9 DEPTH > 1.5\nTHEN CONDUIT C1 STATUS = CLOSED\nPRIORITY 1\n",
);

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

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
await S(() => window.swmmStudio.setState({ crsDialog: false, dialog: null, bottomTab: "issues" }));

await step("the rule naming a missing node is an issue with its line", async () => {
  await page.waitForFunction(() => (window.swmmStudio.getState().issues ?? []).some((i) => i.code === "unknown_rule_object"), null, { timeout: 10000 });
  const i = await S(() => window.swmmStudio.getState().issues.find((i) => i.code === "unknown_rule_object"));
  if (i.line !== 3 || i.section !== "CONTROLS") fail(JSON.stringify(i));
  return i.message;
});

await step("clicking the issue opens the rules at the line", async () => {
  await page.getByText("rule R1: node J9 does not exist").first().click();
  await page.waitForSelector(".rules-editor textarea:not([disabled])");
  await page.waitForTimeout(400);
  const r = await S(() => {
    const a = document.querySelector(".rules-editor textarea");
    return { dialog: window.swmmStudio.getState().dialog, selected: a.value.slice(a.selectionStart, a.selectionEnd), focused: document.activeElement === a };
  });
  if (r.dialog !== "sections" || r.selected !== "IF NODE J9 DEPTH > 1.5" || !r.focused) fail(JSON.stringify(r));
  return r.selected;
});

await step("the rules are highlighted and the line is marked", async () => {
  await page.waitForSelector(".rules-gutter .rk-mark-error");
  const r = await S(() => ({
    clauses: [...document.querySelectorAll(".rules-code .rk-clause")].map((e) => e.textContent),
    names: [...document.querySelectorAll(".rules-code .rk-name")].map((e) => e.textContent),
    comment: document.querySelector(".rules-code .rk-comment")?.textContent,
    marked: document.querySelector(".rules-gutter .rk-mark-error")?.textContent,
    problems: document.querySelector(".rules-problems")?.textContent,
  }));
  if (r.clauses.join(" ") !== "RULE IF THEN PRIORITY" || r.names.join(" ") !== "R1 J9 C1" || r.marked !== "3" || r.comment !== "; storm rule") fail(JSON.stringify(r));
  await page.screenshot({ path: join(shots, "1-rules.png") });
  return r;
});

await step("typing checks the rules again", async () => {
  await page.keyboard.press("Home");
  await page.keyboard.type("X");
  await page.waitForFunction(() => document.querySelector(".rules-problems")?.textContent.includes("is not a rule keyword"), null, { timeout: 5000 });
  await S(() => {
    const a = document.querySelector(".rules-editor textarea");
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(a, a.value.replace("XIF NODE J9", "IF NODE J2"));
    a.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector(".rules-problems")?.textContent.includes("No problem found"), null, { timeout: 5000 });
  await page.screenshot({ path: join(shots, "2-fixed.png") });
});

await step("applying the fix clears the issue", async () => {
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForFunction(() => !(window.swmmStudio.getState().issues ?? []).some((i) => i.section === "CONTROLS"), null, { timeout: 10000 });
  await page.getByRole("button", { name: "Close" }).click();
});

if (errors.length) fail(errors.join("\n"));
console.log("all passed");
await browser.close();
