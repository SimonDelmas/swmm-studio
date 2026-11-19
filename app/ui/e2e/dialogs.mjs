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
    window.idsOriginal ??= api.ids;
    api.ids = (kind) => (window.idsCalls.push(kind), window.idsOriginal(kind));
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
  await S(() => (window.swmmStudio.api.ids = window.idsOriginal));
  return calls;
});

await step("opening a model waits for the edit asked before it; an edit asked while it opens is not sent; dialogs close", async () => {
  // The back-end is slowed down so that the order is the one of the queue, not of chance.
  const r = await S(async (p) => {
    const st = window.swmmStudio;
    const api = st.api;
    const orig = { open: api.openModel, edit: api.edit };
    const log = [];
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    api.openModel = async (path) => {
      log.push("open start");
      await wait(400);
      const m = await orig.open(path);
      log.push("open end");
      return m;
    };
    api.edit = async (req, sel) => {
      log.push("edit start");
      await wait(300);
      const o = await orig.edit(req, sel);
      log.push("edit end");
      return o;
    };
    try {
      const j1 = await api.findObject("J1");
      if (!j1) return { error: "J1 is missing before the test" };
      // A dialog left open edits the model it was opened on: opening another one closes it.
      st.setState({ dialog: "options" });
      // Asked before the open: it belongs to the model shown, and must finish first.
      const before = st.tryEdit({ op: "delete", objects: [j1] }).then(() => "applied", (e) => String(e?.message ?? e));
      const opening = st.openModel(p);
      // Asked while the model opens, with the indices of the old one: it must not be sent,
      // whether it reports errors inline (tryEdit) or in the status bar (edit).
      const during = st.tryEdit({ op: "delete", objects: [j1] }).then(() => "applied", (e) => String(e?.message ?? e));
      const duringBar = st.edit({ op: "delete", objects: [j1] });
      const [b, , d, bar] = await Promise.all([before, opening, during, duringBar]);
      return {
        log,
        before: b,
        during: d,
        duringBar: bar === null ? "dropped" : "applied",
        message: st.getState().message?.text ?? "",
        dirty: st.getState().model?.dirty,
        dialog: st.getState().dialog,
        j1After: await api.findObject("J1"),
      };
    } finally {
      api.openModel = orig.open;
      api.edit = orig.edit;
    }
  }, model);
  if (r.error) fail(r.error);
  if (r.log.join(",") !== "edit start,edit end,open start,open end") fail(`back-end calls in the wrong order: ${r.log.join(", ")}`);
  if (r.before !== "applied") fail(`the edit asked before the open failed: ${r.before}`);
  if (!/another model was opened/.test(r.during)) fail(`the edit asked during the open was ${r.during}`);
  if (r.duringBar !== "dropped") fail("the edit asked during the open through edit() was applied");
  if (/another model was opened/.test(r.message)) fail(`the status bar shows the dropped edit: "${r.message}"`);
  if (r.dialog !== null) fail(`the options dialog of the previous model stayed open: ${r.dialog}`);
  if (r.dirty || !r.j1After) fail(`the model opened again was changed: dirty=${r.dirty}, J1=${JSON.stringify(r.j1After)}`);
  return r.log;
});

await step("a model whose map cannot be read is shown anyway, with the reason", async () => {
  const r = await S(async (p) => {
    const st = window.swmmStudio;
    const api = st.api;
    const geometry = api.geometry;
    const seq = st.getState().modelSeq;
    api.geometry = async () => {
      throw new Error("test: no geometry");
    };
    try {
      await st.openModel(p);
    } finally {
      api.geometry = geometry;
    }
    const s = st.getState();
    const out = { opened: s.modelSeq === seq + 1, geometry: s.geometry, message: s.message?.text ?? "" };
    // An edit that needs the map read again still shows its change when the map cannot be read.
    const revision = s.model.revision;
    const j1 = await api.findObject("J1");
    api.geometry = async () => {
      throw new Error("test: no geometry");
    };
    let edited;
    let undone;
    try {
      await st.tryEdit({ op: "delete", objects: [j1] });
      const e = st.getState();
      edited = { revision: e.model.revision > revision, dirty: e.model.dirty, message: e.message?.text ?? "" };
      // Undo says what it undid and why the map is still empty.
      await st.undo();
      undone = { message: st.getState().message?.text ?? "", j1: await api.findObject("J1") };
    } finally {
      api.geometry = geometry;
      // Back to a model with its map, for what follows, whatever happened above.
      await st.openModel(p);
      st.setState({ crsDialog: false });
    }
    return { ...out, edited, undone, mapAfter: st.getState().geometry !== null };
  }, model);
  if (!r.opened) fail("the model was not shown when its map could not be read");
  if (r.geometry !== null) fail("the map of the previous model was kept");
  if (!/map cannot be drawn: .*test: no geometry/.test(r.message)) fail(`no reason given: "${r.message}"`);
  if (!r.edited.revision || !r.edited.dirty) fail(`an edit without a map was not shown: ${JSON.stringify(r.edited)}`);
  if (!/map cannot be drawn/.test(r.edited.message)) fail(`no reason given after the edit: "${r.edited.message}"`);
  if (!/deleted/.test(r.edited.message)) fail(`the edit's own message was lost: "${r.edited.message}"`);
  if (!r.undone.j1 || !/map cannot be drawn/.test(r.undone.message) || !/^Undo/i.test(r.undone.message))
    fail(`undo without a map: ${JSON.stringify(r.undone)}`);
  if (!r.mapAfter) fail("opening again did not bring the map back");
  return r.message;
});

await step("the app stays busy while a model opens, even when another task ends meanwhile", async () => {
  const r = await S(async (p) => {
    const st = window.swmmStudio;
    const api = st.api;
    const open = api.openModel;
    const setCrs = api.setCrs;
    let release;
    const gate = new Promise((res) => (release = res));
    api.openModel = async (path) => {
      await gate;
      return open(path);
    };
    // The other task changes nothing in the back-end: the model it answers is the one shown.
    api.setCrs = async () => st.getState().model;
    let opening = null;
    try {
      opening = st.openModel(p);
      // Another task that marks the app busy, and ends while the model is still opening.
      await st.applyCrs(null).catch(() => {});
      const during = st.getState().busy;
      release();
      await opening;
      return { during, after: st.getState().busy };
    } finally {
      // Never leave the open waiting: the app would stay busy for good.
      release();
      await opening;
      api.openModel = open;
      api.setCrs = setCrs;
      st.setState({ crsDialog: false });
    }
  }, model);
  if (r.during !== "Opening model…") fail(`busy while the model was still opening: ${JSON.stringify(r.during)}`);
  if (r.after !== null) fail(`still busy once everything ended: ${JSON.stringify(r.after)}`);
  return r;
});

await step("a delete waiting for its plan is dropped when another model opens meanwhile", async () => {
  const r = await S(async (p) => {
    const st = window.swmmStudio;
    const api = st.api;
    const plan = api.deletePlan;
    const edit = api.edit;
    let edits = 0;
    let plans = 0;
    api.edit = async (...a) => (edits++, edit(...a));
    const run = async (answer) => {
      let release;
      const gate = new Promise((res) => (release = res));
      api.deletePlan = async (objects) => {
        plans++;
        await gate;
        if (answer === "fail") throw new Error("test: plan failed");
        return plan(objects);
      };
      st.setState({ message: null });
      const j1 = await api.findObject("J1");
      if (!j1) throw new Error("J1 is missing before the test");
      // J1 has links: its delete asks for confirmation once the plan is known.
      const deleting = st.deleteObjects([j1]);
      await st.openModel(p);
      release();
      await deleting;
      const s = st.getState();
      return { pending: s.pendingDelete !== null, message: s.message?.text ?? "", dirty: s.model?.dirty };
    };
    try {
      const ok = await run("ok");
      const failed = await run("fail");
      return { ok, failed, edits, plans };
    } finally {
      api.deletePlan = plan;
      api.edit = edit;
      st.setState({ crsDialog: false });
    }
  }, model);
  if (r.plans !== 2) fail(`the delete plan was asked ${r.plans} times instead of twice`);
  if (r.ok.pending) fail("the confirmation of a delete in the previous model was shown");
  if (r.edits !== 0 || r.ok.dirty) fail(`the delete reached the model opened since: ${r.edits} edits, dirty=${r.ok.dirty}`);
  if (/plan failed/.test(r.failed.message)) fail(`the failure of the previous model's delete was shown: "${r.failed.message}"`);
  return r;
});

await step("a model reopened with its labels on and its view saved draws its map", async () => {
  // The labels ask for the extent in view as the map is created, before deck.gl is ready.
  await S(() => window.swmmStudio.setState({ labels: true, selection: [], pendingDelete: null, dialog: null }));
  // The labels and the view are saved in the project after a second or so.
  await page.waitForTimeout(2500);
  await S((p) => window.swmmStudio.openModel(p), model);
  await page.waitForFunction(() => window.swmmStudio.getState().busy === null && window.swmmStudio.getState().model, null, { timeout: 30000 });
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await page.waitForTimeout(2500);
  const r = await S(() => ({
    map: !!document.querySelector(".map"),
    crashed: document.body.innerText.includes("Something went wrong"),
    labels: window.swmmStudio.getState().labels,
  }));
  if (r.crashed || !r.map) fail(`the map is not drawn: ${JSON.stringify(r)}`);
  if (!r.labels) fail("the labels saved in the project are not shown");
  // Saved off again: the copy can be tested once more.
  await S(() => window.swmmStudio.setState({ labels: false }));
  await page.waitForTimeout(1500);
  return r;
});

if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
console.log("all dialog checks passed");
await browser.close();
