// End-to-end smoke test of the built page in preview mode (in-memory store).
// Usage: node e2e/smoke.mjs [outdir]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = process.argv[2] ?? "e2e/out";
mkdirSync(out, { recursive: true });
const html = readFileSync("dist/nebula.html", "utf8");
const page_html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
const react = readFileSync("node_modules/react/umd/react.production.min.js", "utf8");
const reactDom = readFileSync("node_modules/react-dom/umd/react-dom.production.min.js", "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
writeFileSync(`${out}/req.png`, png);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("fonts") && errors.push("console: " + m.text()));
await page.route("**/*", (route) => {
  const u = route.request().url();
  if (u === "http://nebula.test/") return route.fulfill({ contentType: "text/html", body: page_html });
  if (u.includes("react-dom.production")) return route.fulfill({ contentType: "text/javascript", body: reactDom });
  if (u.includes("react.production")) return route.fulfill({ contentType: "text/javascript", body: react });
  return route.abort();
});
const step = async (name, f) => {
  try { await f(); console.log("ok  ", name); }
  catch (e) { console.log("FAIL", name, "-", e.message.split("\n")[0]); await page.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, "-")}.png` }); throw e; }
};
const toastWait = (t) => page.locator(".toast", { hasText: t }).first().waitFor({ timeout: 5000 });

await page.goto("http://nebula.test/");
await step("dashboard renders", () => page.locator("h1").first().waitFor());
await page.screenshot({ path: `${out}/01-dashboard-empty.png` });

await step("load starter master data", async () => {
  await page.goto("http://nebula.test/#admin");
  await page.getByRole("button", { name: /Load starter master data/ }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Government House Clinic") || document.body.innerText.match(/4\d\s*items/i), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
});

await step("register requisition", async () => {
  await page.goto("http://nebula.test/#requisitions");
  await page.getByRole("button", { name: "New requisition" }).first().click();
  await page.setInputFiles("#new-files", `${out}/req.png`);
  await page.getByRole("button", { name: "Register requisition" }).click();
  await page.waitForURL(/#req-/);
  await page.locator("h1.mono").waitFor();
});
const number = await page.locator("h1.mono").innerText();
console.log("     number:", number);

await step("fill header", async () => {
  await page.click("#hdr-facility");
  await page.locator(".search-results a", { hasText: "Government House Clinic" }).first().click();
  await page.fill("#hdr-reqdate", new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
  await page.locator("#hdr-reqdate").blur();
  await page.waitForTimeout(300);
});

await step("add and fill a line", async () => {
  await page.getByRole("button", { name: "Add line" }).click();
  await page.locator("[id^=ln-item-]").first().waitFor();
  const lid = (await page.locator("[id^=ln-item-]").first().getAttribute("id")).replace("ln-item-", "");
  await page.click(`#ln-item-${lid}`);
  await page.fill(`#ln-item-${lid}`, "Amoxicillin");
  await page.locator(".search-results a").first().click();
  await page.waitForTimeout(200);
  await page.selectOption(`#ln-prog-${lid}`, { label: "DRF" });
  await page.fill(`#ln-qty-${lid}`, "100");
  await page.locator(`#ln-qty-${lid}`).blur();
  await page.waitForTimeout(200);
  const unit = await page.inputValue(`#ln-unit-${lid}`);
  if (!unit) { await page.fill(`#ln-unit-${lid}`, "capsule"); await page.locator(`#ln-unit-${lid}`).blur(); }
  await page.waitForTimeout(300);
});
await page.screenshot({ path: `${out}/02-review.png`, fullPage: true });

await step("validate", async () => { await page.getByRole("button", { name: "Validate", exact: true }).click(); await toastWait("Validated"); });
await step("finalize", async () => { await page.getByRole("button", { name: "Finalize", exact: true }).click(); await toastWait("Finalized"); });

await step("record finance as not applicable", async () => {
  await page.getByRole("tab", { name: "Lifecycle" }).click();
  await page.getByRole("button", { name: "Record Finance" }).click();
  await page.locator("input[name=ev-status]").nth(1).check();
  await page.fill("#ev-na", "Free programme, no payment required");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await toastWait("Finance recorded");
});
for (const s of ["Invoicing", "Pick & Pack", "Dispatched", "Completed"]) {
  await step(`record ${s}`, async () => {
    await page.getByRole("button", { name: `Record ${s}` }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await toastWait(`${s} recorded`);
  });
}
await page.screenshot({ path: `${out}/03-lifecycle.png`, fullPage: true });

await step("record issued quantities", async () => {
  await page.getByRole("tab", { name: "Fulfillment" }).click();
  await page.getByRole("button", { name: "Record issued quantities" }).click();
  await page.locator("[id^=fr-qty-]").first().fill("70");
  await page.getByRole("button", { name: "Save records" }).click();
  await toastWait("issued record");
});
await step("correct the issued record", async () => {
  await page.getByRole("button", { name: "Correct", exact: true }).first().click();
  await page.fill("#fc-qty", "75");
  await page.fill("#fc-reason", "Pick slip re-checked");
  await page.getByRole("button", { name: "Save correction" }).click();
  await toastWait("Correction saved");
});
await step("issued OFR shows 75%", async () => {
  await page.waitForFunction(() => document.body.innerText.includes("75%"), null, { timeout: 5000 });
});
await step("close fulfillment", async () => { await page.getByRole("button", { name: "Close fulfillment" }).click(); await toastWait("Fulfillment closed"); });
await page.screenshot({ path: `${out}/04-fulfillment.png`, fullPage: true });

await step("finalized lock blocks direct edits", async () => {
  await page.getByRole("tab", { name: "Details & lines" }).click();
  await page.locator(".note-box", { hasText: "locked" }).waitFor();
});
await step("audit tab lists events", async () => {
  await page.getByRole("tab", { name: "Audit history" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("fulfillment.corrected"), null, { timeout: 5000 });
});
for (const [route, name] of [["dashboard", "05-dashboard"], ["analytics", "06-analytics"], ["facilities", "07-facilities"], ["items", "08-items"], ["approvals", "09-approvals"], ["audit", "10-audit"], ["admin", "11-admin"]]) {
  await step(`page ${route}`, async () => { await page.goto(`http://nebula.test/#${route}`); await page.locator("h1").first().waitFor(); await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); });
}
await step("phone width has no horizontal scroll", async () => {
  await page.setViewportSize({ width: 400, height: 860 });
  for (const r of ["dashboard", "requisitions", "analytics", "admin"]) {
    await page.goto(`http://nebula.test/#${r}`);
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 401) throw new Error(`#${r} scrollWidth ${w}`);
  }
  await page.screenshot({ path: `${out}/12-phone.png` });
});
await step("dark theme renders", async () => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("http://nebula.test/#dashboard");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/13-dark.png` });
});
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
