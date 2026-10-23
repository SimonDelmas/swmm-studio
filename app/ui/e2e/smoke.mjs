// Smoke test of the running desktop app, driven over the WebView2 DevTools protocol.
//
// 1. Start the app with remote debugging:
//      set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//      cargo tauri dev            (from app/src-tauri)
// 2. node e2e/smoke.mjs <model.inp> [EPSG:xxxx] [screenshot folder]
//
// The model should have results (<model>.out / .rpt) next to it. The test opens it, sets
// the CRS, selects an object, colours links by flow, animates, plots and opens the report.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [model, crs = "", shots = "smoke-shots"] = process.argv.slice(2);
if (!model) {
  console.error("usage: node e2e/smoke.mjs <model.inp> [EPSG:xxxx] [screenshot folder]");
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
const waitIdle = () => page.waitForFunction(() => window.swmmStudio.getState().busy === null, null, { timeout: 60000 });

await step("open model", async () => {
  await S((p) => window.swmmStudio.openModel(p), model);
  await waitIdle();
  return S(() => {
    const m = window.swmmStudio.getState().model;
    if (!m) throw new Error("model not loaded");
    return { counts: m.counts, results: m.results?.n_periods ?? null, report: m.report?.blocks.length ?? null };
  });
});
await S(() => window.swmmStudio.setState({ crsDialog: false }));
await page.waitForTimeout(800);
await shot("1-model");

if (crs) {
  await step(`set CRS ${crs}`, async () => {
    await S((c) => window.swmmStudio.applyCrs(c), crs);
    return S(() => window.swmmStudio.getState().model.crs);
  });
  await page.waitForTimeout(2500); // basemap tiles
  await shot("2-crs");
}

const first = await step("pick the first node", async () => {
  const g = await S(() => {
    const g = window.swmmStudio.getState().geometry;
    return [g.nodes[0], g.nodes[1]];
  });
  const hit = await S(([x, y]) => window.swmmStudio.api.pick(x, y, 1), g);
  if (!hit || hit.kind !== "node" || hit.index !== 0) throw new Error(`pick returned ${JSON.stringify(hit)}`);
  await S((h) => window.swmmStudio.setState({ selection: [h] }), hit);
  await page.waitForSelector(".props h3", { timeout: 10000 });
  return page.textContent(".props h3");
});

await step("box-select the whole model", async () => {
  const n = await S(async () => {
    const m = window.swmmStudio.getState().model;
    const b = m.bounds;
    return (await window.swmmStudio.api.selectRect([b[0], b[1]], [b[2], b[3]])).length;
  });
  const total = await S(() => {
    const c = window.swmmStudio.getState().model.counts;
    return c.nodes + c.links + c.subcatchments + c.gages;
  });
  if (n < total * 0.9) throw new Error(`selected ${n} of ${total}`);
  return `${n}/${total}`;
});

if (crs) {
  await step("mouse: click a node, box-select, CRS dialog search", async () => {
    // Centre the view on node 0 and click it.
    const xy = await S(async () => {
      const st = window.swmmStudio;
      const g = st.getState().geometry;
      const map = document.querySelector(".map").__map;
      map.jumpTo({ center: [g.nodes[0], g.nodes[1]], zoom: 18 });
      await new Promise((r) => setTimeout(r, 300));
      const p = map.project([g.nodes[0], g.nodes[1]]);
      const r = document.querySelector(".map").getBoundingClientRect();
      st.setState({ selection: [] });
      return [r.left + p.x, r.top + p.y];
    });
    await page.mouse.click(xy[0], xy[1]);
    await page.waitForFunction(() => window.swmmStudio.getState().selection.length === 1, null, { timeout: 5000 });
    const clicked = await S(() => window.swmmStudio.getState().selection[0]);
    // Box tool: drag around the node.
    await page.click('button[title^="Box selection"]');
    await page.mouse.move(xy[0] - 30, xy[1] - 30);
    await page.mouse.down();
    await page.mouse.move(xy[0] + 30, xy[1] + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => window.swmmStudio.getState().selection.some((o) => o.kind === "node" && o.index === 0), null, {
      timeout: 5000,
    });
    const boxed = await S(() => window.swmmStudio.getState().selection.length);
    await page.click('button[title^="Select: click"]');
    // CRS dialog: search by name.
    await S(() => window.swmmStudio.setState({ crsDialog: true }));
    await page.fill(".modal input", "lambert 93");
    await page.waitForSelector(".crs-item", { timeout: 5000 });
    const first = await page.textContent(".crs-item");
    await shot("2b-crs-dialog");
    await page.click(".modal button:has-text('Cancel')");
    return { clicked, boxed, crsSearch: first.trim() };
  });
}

const hasResults = await S(() => !!window.swmmStudio.getState().model.results);
if (hasResults) {
  await step("mouse: timeline wheel zoom and click", async () => {
    const box = await page.locator(".timeline-canvas canvas").boundingBox();
    const before = await S(() => window.swmmStudio.getState().period);
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -300);
    await page.mouse.click(box.x + box.width * 0.25, box.y + 20);
    const after = await S(() => window.swmmStudio.getState().period);
    if (after === before) throw new Error("timeline click did not change the period");
    return { before, after };
  });
}
if (hasResults) {
  await step("colour links by flow and nodes by depth", async () => {
    await S(() => window.swmmStudio.applyStyle("link", { source: "result", field: "0", method: "quantile" }));
    await S(() => window.swmmStudio.applyStyle("node", { source: "result", field: "0" }));
    return S(() => window.swmmStudio.getState().styles.link.breaks);
  });
  await step("animate 40 frames", async () => {
    const n = await S(() => window.swmmStudio.getState().model.results.n_periods);
    const target = Math.min(n - 1, Math.floor(n / 2));
    await S((p) => window.swmmStudio.setState({ period: p, stride: 1, fps: 60, selection: [] }), target);
    const t0 = Date.now();
    await S(() => window.swmmStudio.setState({ playing: true }));
    await page.waitForTimeout(1000);
    await S(() => window.swmmStudio.setState({ playing: false }));
    const p = await S(() => window.swmmStudio.getState().period);
    return { periods_advanced: p - target, ms: Date.now() - t0 };
  });
  await step("time step change latency (frame read + colour update + draw)", () =>
    S(async () => {
      const st = window.swmmStudio;
      const n = st.getState().model.results.n_periods;
      const ms = [];
      for (let i = 0; i < 30; i++) {
        const p = (st.getState().period + 1) % n;
        st.mapPerf.steps.length = 0;
        st.setState({ period: p });
        const t0 = performance.now();
        const done = () => st.mapPerf.steps.filter((s) => s.period === p);
        // Layers may update in one render or in several: wait for the first, then a little more.
        while (done().length === 0 && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 1));
        await new Promise((r) => setTimeout(r, 40));
        ms.push(Math.max(...done().map((s) => s.ms)));
      }
      ms.sort((a, b) => a - b);
      return { median_ms: +ms[15].toFixed(1), p90_ms: +ms[27].toFixed(1) };
    }),
  );
  if (crs) {
    await step("pan at 60 fps target", () =>
      S(async () => {
        const map = document.querySelector(".map").__map;
        let frames = 0;
        const t0 = performance.now();
        map.panBy([400, 150], { duration: 1500, easing: (t) => t });
        await new Promise((r) => {
          const f = () => {
            frames++;
            if (performance.now() - t0 < 1500) requestAnimationFrame(f);
            else r();
          };
          requestAnimationFrame(f);
        });
        const z = map.getZoom();
        map.zoomTo(z + 2, { duration: 1500 });
        let zf = 0;
        const t1 = performance.now();
        await new Promise((r) => {
          const f = () => {
            zf++;
            if (performance.now() - t1 < 1500) requestAnimationFrame(f);
            else r();
          };
          requestAnimationFrame(f);
        });
        map.zoomTo(z, { duration: 0 });
        return { pan_fps: Math.round(frames / 1.5), zoom_fps: Math.round(zf / 1.5) };
      }),
    );
  }
  await page.waitForTimeout(500);
  await shot("3-animated");
  await step("plot the first node and the system", async () => {
    await S((h) => window.swmmStudio.addToPlot("node", h, 0), 0);
    await S(() => window.swmmStudio.addToPlot("system", 0, 4));
    await page.waitForSelector(".plot-area canvas", { timeout: 15000 });
    return S(() => window.swmmStudio.getState().plot.map((p) => p.label));
  });
  await page.waitForTimeout(800);
  await shot("4-plot");
  await step("layout follows window resizes", async () => {
    const orig = await S(() => [innerWidth, innerHeight]);
    await page.setViewportSize({ width: orig[0] + 400, height: orig[1] });
    await page.waitForTimeout(600);
    await page.setViewportSize({ width: orig[0] - 200, height: orig[1] });
    await page.waitForTimeout(600);
    const w = await S(() => [innerWidth, Math.round(document.querySelector(".main").getBoundingClientRect().width)]);
    await page.setViewportSize({ width: orig[0], height: orig[1] });
    if (w[1] > w[0]) throw new Error(`layout ${w[1]} px wider than the window ${w[0]} px`);
    return w;
  });
}

if (await S(() => !!window.swmmStudio.getState().model.report)) {
  await step("report", async () => {
    await S(() => window.swmmStudio.setState({ bottomTab: "report" }));
    await page.waitForSelector(".report-panel", { timeout: 5000 });
    const blocks = await page.$$eval(".summary-item", (els) => els.length);
    // Open the first table block.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll(".summary-item")];
      const t = items.find((e) => /Node Depth Summary/.test(e.textContent));
      t?.click();
    });
    await page.waitForTimeout(500);
    const rows = await page.$$eval("table.grid tbody tr", (els) => els.length);
    return { blocks, renderedRows: rows };
  });
  await shot("5-report");
}

console.log(first ? "selected:" : "", first);
if (errors.length) {
  console.log("page errors:\n" + errors.join("\n"));
  process.exitCode = 1;
}
await browser.close();
