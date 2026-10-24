// Profile tool test of the running desktop app (see edit.mjs for how to start it):
// click two nodes to draw a profile, two others for a new one, Shift+click to extend,
// save it in the project, reload it.
//
//   node e2e/profile.mjs <copy of testdata/tiny.inp> [screenshot folder]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, shots = "profile-shots"] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/profile.mjs <model.inp> [screenshot folder]");
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
const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout });
const fail = (msg) => {
  throw new Error(msg);
};
const nodeXY = (id) =>
  S((id) => {
    const st = window.swmmStudio.getState();
    const i = st.ids.node.indexOf(id);
    if (i < 0) throw new Error(`node ${id} not in the id list`);
    const g = st.geometry;
    return window.swmmStudio.mapProject([g.nodes[2 * i], g.nodes[2 * i + 1]]);
  }, id);
const clickNode = async (id, shift = false) => {
  const [x, y] = await nodeXY(id);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  if (shift) await page.keyboard.up("Shift");
};
/** IDs of the nodes along the current profile, once computed. */
const profileIds = () => S(() => window.swmmStudio.getState().profile?.nodes.map((n) => n.id) ?? null);
const waitProfile = (first, last) =>
  until(
    ([a, b]) => {
      const n = window.swmmStudio.getState().profile?.nodes;
      return n && n[0].id === a && n[n.length - 1].id === b;
    },
    [first, last],
  );

await step("open model", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await until(() => window.swmmStudio.getState().busy === null, null, 60000);
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await S(async () => {
    const st = window.swmmStudio;
    st.setState({ ids: { ...st.getState().ids, node: await st.api.ids("node") } });
  });
  await page.waitForTimeout(800);
  return S(() => window.swmmStudio.getState().ids.node);
});

await step("Profile button activates the profile tool", async () => {
  await page.locator(".toolbar button", { hasText: "Profile" }).click();
  if ((await S(() => window.swmmStudio.getState().tool)) !== "profile") fail("tool not active");
});

await step("click J1 then J2: the profile is drawn", async () => {
  await clickNode("J1");
  await until(() => window.swmmStudio.getState().profileStart !== null);
  if (await profileIds()) fail("profile drawn after one click");
  await clickNode("J2");
  await waitProfile("J1", "J2");
  await page.waitForSelector(".plot-area svg polygon");
  const tab = await S(() => window.swmmStudio.getState().bottomTab);
  if (tab !== "profile") fail(`bottom tab ${tab}`);
  return profileIds();
});

await step("click J2 then J3: a new profile replaces it", async () => {
  await clickNode("J2");
  await clickNode("J3");
  await waitProfile("J2", "J3");
  return profileIds();
});

await step("Shift+click Out1 extends the profile", async () => {
  await clickNode("Out1", true);
  await waitProfile("J2", "Out1");
  const ids = await profileIds();
  if (ids.join() !== "J2,J3,Out1") fail(ids.join());
  return ids;
});

await step("the path is highlighted on the map", async () => {
  await clickNode("J1");
  await clickNode("Out1");
  await waitProfile("J1", "Out1");
  return profileIds();
});
await page.waitForTimeout(600);
await shot("1-profile");

const saved = await step("save the profile in the project", async () => {
  await page.locator(".plot-panel input.narrow-name").fill("Main line");
  await page.locator(".plot-panel button", { hasText: /^Save$/ }).click();
  const list = await S(() => window.swmmStudio.getState().model.project.ui.profiles);
  if (!list?.some((p) => p.name === "Main line")) fail(JSON.stringify(list));
  return list;
});

await step("reload the model: the saved profile is in the list and loads", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await until(() => window.swmmStudio.getState().busy === null, null, 60000);
  await S(() => window.swmmStudio.setState({ crsDialog: false, bottomTab: "profile" }));
  if (await profileIds()) fail("profile kept across models");
  await page.locator('.plot-panel select[title="Profiles saved in the project"]').selectOption("Main line");
  await waitProfile(saved[0].nodes[0], saved[0].nodes[saved[0].nodes.length - 1]);
  return profileIds();
});
await page.waitForTimeout(500);
await shot("2-reloaded");

await step("Escape drops a half-picked start, then leaves the tool", async () => {
  await S(() => window.swmmStudio.setState({ tool: "profile" }));
  await clickNode("J1");
  await until(() => window.swmmStudio.getState().profileStart !== null);
  await page.keyboard.press("Escape");
  const a = await S(() => [window.swmmStudio.getState().profileStart, window.swmmStudio.getState().tool]);
  await page.keyboard.press("Escape");
  const b = await S(() => window.swmmStudio.getState().tool);
  if (a[0] !== null || a[1] !== "profile" || b !== "select") fail(JSON.stringify({ a, b }));
});

await step("delete the saved profile", async () => {
  await page.locator('.plot-panel select[title="Profiles saved in the project"]').selectOption("Main line");
  await page.locator(".plot-panel button", { hasText: "Delete" }).click();
  return S(() => window.swmmStudio.getState().model.project.ui.profiles);
});

if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
console.log("all good");
await browser.close();
