// Observed data test of the running desktop app (see edit.mjs for how to start it): a file of
// measured series is linked to a link through the dialog, with the mapping proposed from the
// column titles; the link is kept in the project, and the observed values are drawn with the
// results in the time series tab.
//
//   node e2e/observed.mjs <model.inp with results> <observed file> <link id> [shots folder]
//
// The observed file must have columns named after the link with a flow and a depth (e.g.
// "C1 Débit (l/s)", "C1 Hauteur (m)") and columns of other objects.

import { chromium } from "playwright-core";

const [model, file, id, shots] = process.argv.slice(2);
if (!model || !file || !id) {
  console.error("usage: node e2e/observed.mjs <model.inp> <observed file> <link id> [shots folder]");
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
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

await S((p) => window.swmmStudio.openModel(p), model);
await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model?.results, null, {
  timeout: 30000,
});
await S(() => window.swmmStudio.setState({ crsDialog: false, sideTab: "props" }));
// Start from no link (a previous run of the test leaves one in the project).
await S((id) => window.swmmStudio.api.setObserved("link", id, null), id);
await S(() => window.swmmStudio.api.modelInfo().then((m) => window.swmmStudio.setState({ model: m })));

const link = await S((id) => window.swmmStudio.api.findObject(id), id);
if (!link || link.kind !== "link") fail(`no link ${id}`);
await S((o) => window.swmmStudio.setState({ selection: [o] }), link);

await step("the dialog reads the file and proposes the mapping from the column titles", async () => {
  await S((f) => (window.swmmStudio.observedChooser.next = f), file);
  await page.locator(".props button", { hasText: "Link a file…" }).click();
  await page.waitForSelector(".observed-modal .observed-mapping", { timeout: 10000 });
  const selects = page.locator(".observed-mapping tr");
  const rows = await selects.evaluateAll((trs) => trs.map((tr) => [tr.cells[0].textContent, tr.querySelector("select").value]));
  const map = Object.fromEntries(rows.filter(([, c]) => c));
  if (!/débit/i.test(map.flow ?? "") || !map.flow.startsWith(`${id} `)) fail(`flow mapped to ${map.flow}`);
  if (!/hauteur/i.test(map.depth ?? "")) fail(`depth mapped to ${map.depth}`);
  if (Object.keys(map).length !== 2) fail(`unexpected mapping ${JSON.stringify(map)}`);
  const time = await page.locator(".observed-modal label", { hasText: "Dates and times" }).locator("select").inputValue();
  if (time !== "Horodatage") fail(`time column ${time}`);
  await shot("observed-dialog");
  return map;
});

await step("the user changes the mapping, OK saves the link in the project", async () => {
  // Drop the depth, keep the flow.
  await page.locator(".observed-mapping tr", { hasText: "depth" }).locator("select").selectOption("");
  await page.locator(".observed-modal button", { hasText: "OK" }).click();
  await page.waitForSelector(".observed-modal", { state: "detached", timeout: 10000 });
  const links = await S(() => window.swmmStudio.getState().model.project.observed);
  if (links?.length !== 1 || links[0].id !== id || Object.keys(links[0].columns).join() !== "flow") fail(JSON.stringify(links));
  const reopened = await S(() => window.swmmStudio.api.modelInfo().then((m) => m.project.observed));
  if (JSON.stringify(reopened) !== JSON.stringify(links)) fail(`back-end has ${JSON.stringify(reopened)}`);
  return links[0].columns;
});

await step("the properties panel lists the link; plotting the flow draws the observed values", async () => {
  await page.locator(".props table.kv [role=button]", { hasText: /^flow$/ }).last().click();
  await page.waitForFunction(() => document.querySelectorAll(".plot-area canvas").length > 0, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const legend = await page.locator(".plot-area .u-legend .u-series .u-label").allTextContents();
  if (!legend.some((l) => / observed$/.test(l))) fail(`no observed series in the legend: ${JSON.stringify(legend)}`);
  const note = await page.locator(".plot-window-note").allTextContents();
  if (note.some((n) => n.includes("Observed data not shown"))) fail(note.join());
  await shot("observed-plot");
  return legend;
});

await step("removing the link takes the observed values off the graph", async () => {
  await page.locator(".props button", { hasText: "Remove" }).click();
  await page.waitForFunction(() => !(window.swmmStudio.getState().model.project.observed ?? []).length, null, { timeout: 5000 });
  await page.waitForTimeout(500);
  const legend = await page.locator(".plot-area .u-legend .u-series .u-label").allTextContents();
  if (legend.some((l) => / observed$/.test(l))) fail(`observed series still shown: ${JSON.stringify(legend)}`);
  return legend;
});

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("all observed data checks passed");
await browser.close();
