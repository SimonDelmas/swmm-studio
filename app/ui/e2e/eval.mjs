// Evaluates an expression in the running app (debug helper, 20 s timeout).
import { chromium } from "playwright-core";
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push(String(e)));
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), Number(process.env.PROBE_TIMEOUT ?? 20000)));
try {
  console.log(JSON.stringify(await Promise.race([page.evaluate(process.argv[2]), timeout]), null, 1));
  if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
} catch (e) {
  console.log("ERROR", e.message);
}
await new Promise((r) => setTimeout(r, 300));
if (errs.length) console.log("console errors:", errs.slice(0, 10));
process.exit(0);
