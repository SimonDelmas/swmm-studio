// Editing test of the running desktop app, driven over the WebView2 DevTools protocol
// with real mouse and keyboard events.
//
// 1. Start the app with remote debugging (use a scratch settings file):
//      set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//      set SWMM_STUDIO_SETTINGS=%TEMP%\swmm-test-settings.json
// 2. node e2e/edit.mjs <copy of testdata/tiny.inp> [runswmm.exe] [screenshot folder] [EPSG:2154 | none]
//
// The model file is modified (save as writes <model>_edited.inp next to it). With an
// engine path, the edited model is also run and its results loaded.

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [model, engine = "", shots = "edit-shots", crs = "EPSG:2154"] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/edit.mjs <model.inp> [runswmm.exe] [screenshot folder]");
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
const waitIdle = () => until(() => window.swmmStudio.getState().busy === null, null, 60000);
const counts = () => S(() => window.swmmStudio.getState().model.counts);
const fail = (msg) => {
  throw new Error(msg);
};

/** Screen position of a node (by ID) on the map. */
const nodeXY = (id) =>
  S((id) => {
    const st = window.swmmStudio.getState();
    const i = st.ids.node ? st.ids.node.indexOf(id) : -1;
    if (i < 0) throw new Error(`node ${id} not in the id list`);
    const g = st.geometry;
    return window.swmmStudio.mapProject([g.nodes[2 * i], g.nodes[2 * i + 1]]);
  }, id);
const loadIds = () =>
  S(async () => {
    const st = window.swmmStudio;
    st.setState({ ids: { ...st.getState().ids, node: await st.api.ids("node"), link: await st.api.ids("link") } });
  });
/** The map geometry, updated in place by edits, equals a fresh reload. */
const geometryMatches = () =>
  S(async () => {
    const st = window.swmmStudio;
    const a = st.getState().geometry;
    const b = await st.api.geometry();
    const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i] || (Number.isNaN(v) && Number.isNaN(y[i])));
    return ['nodes', 'gages', 'linkStarts', 'linkPts', 'linkEnds', 'subStarts', 'subPts', 'subOutlets'].filter((k) => !eq(a[k], b[k]));
  });
const fieldInput = (name) => page.locator("table.kv.edit tr", { has: page.locator(`td:text-is("${name}")`) }).locator("input, select").first();
const propValue = (kind, id, section, field) =>
  S(
    async ([kind, id, section, field]) => {
      const st = window.swmmStudio;
      const o = await st.api.findObject(id);
      if (!o) return null;
      const info = await st.api.objectInfo(o, null);
      const g = info.groups.find((g) => g.section === section);
      return g ? (g.fields.find((f) => f.name === field)?.value ?? null) : null;
    },
    [kind, id, section, field],
  );

await step(`open model (${crs})`, async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await waitIdle();
  await S(() => window.swmmStudio.setState({ crsDialog: false }));
  await S((c) => window.swmmStudio.applyCrs(c === "none" ? null : c), crs);
  await loadIds();
  // Zoom on the network.
  await S(async () => {
    const map = document.querySelector(".map").__map;
    const b = window.swmmStudio.getState().model.bounds;
    if (map && window.swmmStudio.getState().model.space.kind === "lonlat") map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 120, duration: 0 });
    await new Promise((r) => setTimeout(r, 400));
  });
  return { counts: await counts(), space: await S(() => window.swmmStudio.getState().model.space.kind) };
});
await page.waitForTimeout(1500);
await shot("1-open");

await step("edit a field in the properties panel, undo and redo with the keyboard", async () => {
  await S(() => {
    const st = window.swmmStudio;
    st.setState({ selection: [{ kind: "node", index: st.getState().ids.node.indexOf("J1") }], sideTab: "props" });
  });
  await page.waitForSelector(".props h3:has-text('J1')");
  const input = fieldInput("Invert elevation");
  await input.fill("101.25");
  await input.press("Enter");
  await until(() => window.swmmStudio.getState().model.dirty);
  const after = await propValue("node", "J1", "JUNCTIONS", "Invert elevation");
  if (after !== "101.25") fail(`value after edit: ${after}`);
  // Invalid value: refused, shown inline.
  const depth = fieldInput("Max depth");
  await depth.fill("-2");
  await depth.press("Enter");
  await page.waitForSelector(".field-error");
  await depth.press("Escape");
  await page.locator(".map").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await S(() => document.activeElement.blur());
  await page.keyboard.press("Control+z");
  await until(() => !window.swmmStudio.getState().model.dirty);
  const undone = await propValue("node", "J1", "JUNCTIONS", "Invert elevation");
  await page.keyboard.press("Control+y");
  await until(() => window.swmmStudio.getState().model.dirty);
  const redone = await propValue("node", "J1", "JUNCTIONS", "Invert elevation");
  if (undone !== "100.0" || redone !== "101.25") fail(`undo ${undone}, redo ${redone}`);
  return { undone, redone };
});

await step("add a junction and a conduit with the mouse", async () => {
  await S(() => window.swmmStudio.setState({ selection: [] }));
  await page.selectOption('select[title="Add objects on the map"]', "add-junction");
  const [x, y] = await nodeXY("J3");
  await page.mouse.click(x + 60, y - 70);
  await until(() => window.swmmStudio.getState().model.counts.nodes === 5);
  await loadIds();
  const sel = await S(() => window.swmmStudio.getState().selection);
  await page.selectOption('select[title="Add objects on the map"]', "add-conduit");
  await page.mouse.click(x, y);
  // A vertex on the way, then the new node.
  await page.mouse.click(x + 20, y - 50);
  const [x4, y4] = await nodeXY("J4");
  await page.mouse.click(x4, y4);
  await until(() => window.swmmStudio.getState().model.counts.links === 4);
  await loadIds();
  const c4 = await S(async () => {
    const st = window.swmmStudio;
    const info = await st.api.objectInfo({ kind: "link", index: 3 }, null);
    return { id: info.id, from: info.connections[0].id, to: info.connections[1].id, groups: info.groups.map((g) => g.section) };
  });
  if (c4.from !== "J3" || c4.to !== "J4" || !c4.groups.includes("VERTICES")) fail(JSON.stringify(c4));
  await page.keyboard.press("Escape");
  return { added: sel, conduit: c4 };
});
await step("draw a subcatchment outline (Enter finishes it)", async () => {
  await page.selectOption('select[title="Add objects on the map"]', "add-subcatchment");
  const [x1, y1] = await nodeXY("J1");
  const [x2, y2] = await nodeXY("J2");
  for (const [x, y] of [
    [x1 - 40, y1 + 40],
    [x2 - 10, y2 + 40],
    [x2 - 40, y2 + 100],
  ]) {
    await page.mouse.click(x, y);
  }
  await page.keyboard.press("Enter");
  await until(() => window.swmmStudio.getState().model.counts.subcatchments === 3);
  const s = await S(async () => {
    const st = window.swmmStudio;
    const info = await st.api.objectInfo(st.getState().selection[0], null);
    const f = (n) => info.groups[0].fields.find((x) => x.name === n).value;
    return { id: info.id, outlet: f("Outlet"), area: Number(f("Area")), gage: f("Rain gage") };
  });
  if (s.id !== "S3" || s.gage !== "RG1" || !(s.area > 0) || !["J1", "J2"].includes(s.outlet)) fail(JSON.stringify(s));
  await page.keyboard.press("Escape");
  return s;
});

await page.waitForTimeout(300);
await shot("2-added");

await step("drag the new node; its conduit follows", async () => {
  await page.click('button[title^="Move: drag"]');
  const [x, y] = await nodeXY("J4");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 25, { steps: 6 });
  await page.mouse.up();
  await until(() => window.swmmStudio.getState().model.undo?.startsWith("Move J4"));
  const [x2, y2] = await nodeXY("J4");
  if (Math.abs(x2 - x - 40) > 2 || Math.abs(y2 - y - 25) > 2) fail(`node at ${x2 - x}, ${y2 - y}`);
  // The conduit ends at the node.
  const ok = await S(() => {
    const st = window.swmmStudio.getState();
    const g = st.geometry;
    const n = st.ids.node.indexOf("J4");
    const end = g.linkStarts[4] - 1;
    return g.linkPts[2 * end] === g.nodes[2 * n] && g.linkPts[2 * end + 1] === g.nodes[2 * n + 1];
  });
  if (!ok) fail("conduit does not follow the node");
  const diff = await geometryMatches();
  if (diff.length) fail(`patched geometry differs: ${diff}`);
  return { dx: x2 - x, dy: y2 - y };
});

await step("vertex editing: insert by dragging a midpoint, delete with Alt+click", async () => {
  await S(() => window.swmmStudio.setState({ selection: [{ kind: "link", index: 3 }], tool: "vertex" }));
  await page.waitForTimeout(200);
  // Midpoint of the first segment (J3 → existing vertex).
  const mid = await S(() => {
    const g = window.swmmStudio.getState().geometry;
    const a = g.linkStarts[3];
    return window.swmmStudio.mapProject([(g.linkPts[2 * a] + g.linkPts[2 * a + 2]) / 2, (g.linkPts[2 * a + 1] + g.linkPts[2 * a + 3]) / 2]);
  });
  await page.mouse.move(mid[0], mid[1]);
  await page.mouse.down();
  await page.mouse.move(mid[0] - 30, mid[1] + 10, { steps: 5 });
  await page.mouse.up();
  await until(() => window.swmmStudio.getState().geometry.linkStarts[4] - window.swmmStudio.getState().geometry.linkStarts[3] === 4);
  await shot("3-vertex");
  // Alt+click the inserted vertex removes it.
  await page.keyboard.down("Alt");
  await page.mouse.click(mid[0] - 30, mid[1] + 10);
  await page.keyboard.up("Alt");
  await until(() => window.swmmStudio.getState().geometry.linkStarts[4] - window.swmmStudio.getState().geometry.linkStarts[3] === 3);
  const diff = await geometryMatches();
  if (diff.length) fail(`patched geometry differs: ${diff}`);
  return "ok";
});

await step("reconnect the conduit end to Out1 by dragging it", async () => {
  const end = await nodeXY("J4");
  const out1 = await nodeXY("Out1");
  await page.mouse.move(end[0], end[1]);
  await page.mouse.down();
  await page.mouse.move(out1[0], out1[1], { steps: 8 });
  await page.mouse.up();
  await until(() => window.swmmStudio.getState().model.undo?.startsWith("Reconnect"));
  const to = await S(async () => (await window.swmmStudio.api.objectInfo({ kind: "link", index: 3 }, null)).connections[1].id);
  if (to !== "Out1") fail(`to = ${to}`);
  await page.keyboard.press("Control+z");
  await until(() => !window.swmmStudio.getState().model.undo?.startsWith("Reconnect"));
  await page.keyboard.press("Escape");
  return to;
});

await step("delete J4 with the Delete key: cascade dialog, then undo", async () => {
  await S(() => {
    const st = window.swmmStudio;
    st.setState({ selection: [{ kind: "node", index: st.getState().ids.node.indexOf("J4") }] });
  });
  await page.keyboard.press("Delete");
  await page.waitForSelector(".modal:has-text('connected link')");
  await shot("4-delete-dialog");
  await page.click(".modal button.danger");
  await until(() => window.swmmStudio.getState().model.counts.nodes === 4 && window.swmmStudio.getState().model.counts.links === 3);
  await page.keyboard.press("Control+z");
  await until(() => window.swmmStudio.getState().model.counts.nodes === 5);
  const sel = await S(() => window.swmmStudio.getState().selection.length);
  return { restoredSelected: sel };
});

await step("create a storage curve in the data editor", async () => {
  await page.click(".sidebar .tabs button:has-text('Data')");
  await page.click(".data-cat:has-text('Curves') button");
  await page.waitForSelector(".modal .name-input");
  await page.fill(".modal .name-input", "SC1");
  for (const [x, y] of [
    ["0", "50"],
    ["1", "80"],
    ["2.5", "120"],
  ]) {
    await page.click(".modal button:has-text('Add row')");
    const row = page.locator(".modal table.edit-grid tbody tr").last();
    await row.locator("input").nth(0).fill(x);
    await row.locator("input").nth(1).fill(y);
  }
  await shot("5-curve");
  await page.click(".modal button:has-text('OK')");
  await until(() => !document.querySelector(".modal"));
  const curve = await S(() => window.swmmStudio.api.table("curve", "SC1"));
  if (curve.points.length !== 3 || curve.curve_type !== "STORAGE") fail(JSON.stringify(curve));
  return curve.points;
});

await step("assign RDII to two selected nodes", async () => {
  await S(() => {
    const st = window.swmmStudio;
    const ids = st.getState().ids.node;
    st.setState({ selection: ["J1", "J3"].map((id) => ({ kind: "node", index: ids.indexOf(id) })), sideTab: "props" });
  });
  await page.waitForSelector(".bulk:has-text('RDII')");
  await page.fill(".bulk:has-text('RDII') input", "3.5");
  await page.click(".bulk:has-text('RDII') button:has-text('Assign')");
  await until(() => window.swmmStudio.getState().model.undo?.startsWith("Assign RDII"));
  const uh = await propValue("node", "J3", "RDII", "Unit hydrograph");
  const area = await propValue("node", "J1", "RDII", "Sewershed area");
  if (uh !== "UH1" || area !== "3.5") fail(`${uh} ${area}`);
  return { uh, area };
});

await step("simulation options dialog", async () => {
  await page.click("button[title='Simulation options']");
  await page.click(".modal .tabs button:has-text('Time steps')");
  const input = page.locator(".modal label.option", { hasText: "Reporting" }).locator("input");
  await input.fill("00:10:00");
  await page.click(".modal button:has-text('OK')");
  await until(() => !document.querySelector(".modal"));
  const o = await S(() => window.swmmStudio.api.options());
  const step = o.values.find(([k]) => k === "REPORT_STEP")?.[1];
  if (step !== "00:10:00") fail(step);
  return step;
});

if (engine) {
  await step("register the engine and run the edited model", async () => {
    await S((p) => window.swmmStudio.api.addEngine("EPA 5.2.4", p), engine);
    await S(async () => window.swmmStudio.setState({ engine: (await window.swmmStudio.api.engines()).effective }));
    await page.click("button:has-text('▶ Run')");
    await until(() => window.swmmStudio.getState().run.last !== null, null, 120000);
    const r = await S(() => {
      const st = window.swmmStudio.getState();
      return { status: st.run.last.status, seconds: st.run.last.seconds, periods: st.model.results?.n_periods, matched: st.model.results?.matched };
    });
    if (!["success", "warnings"].includes(r.status)) fail(JSON.stringify(r));
    // 2 days at 10 min.
    if (r.periods !== 288 || r.matched.node !== 5) fail(JSON.stringify(r));
    return r;
  });
  await page.waitForTimeout(500);
  await shot("6-run");

  await step("cancel a long run", async () => {
    await S(() => window.swmmStudio.tryEdit({ op: "set_options", values: [["END_DATE", "06/01/2044"]] }));
    await page.click("button:has-text('▶ Run')");
    await until(() => window.swmmStudio.getState().run.running);
    await page.waitForTimeout(1500);
    const progress = await S(() => window.swmmStudio.getState().run.progress);
    await page.click(".run-controls button:has-text('Cancel')");
    await until(() => window.swmmStudio.getState().run.last !== null, null, 30000);
    const status = await S(() => window.swmmStudio.getState().run.last.status);
    if (status !== "cancelled") fail(status);
    await S(() => window.swmmStudio.undo());
    return { progressWhenCancelled: progress, status };
  });
}

await step("save as", async () => {
  const target = join(dirname(model), "tiny_edited.inp");
  await S((p) => window.swmmStudio.api.saveModel(p).then((m) => window.swmmStudio.setState({ model: m })), target);
  const dirty = await S(() => window.swmmStudio.getState().model.dirty);
  if (dirty || !existsSync(target)) fail("not saved");
  const text = readFileSync(target, "utf8");
  for (const want of ["J4 ", "SC1 ", "REPORT_STEP          00:10:00", "J1               101.25"]) {
    if (!text.includes(want.trim())) fail(`${want} missing`);
  }
  return target;
});

await shot("7-final");
if (errors.length) {
  console.log("console errors:", errors);
  process.exit(1);
}
console.log("all edit checks passed");
await browser.close();
process.exit(0);
