// End-to-end test of the V2 web build against a real local backend (FastAPI +
// PostgreSQL) using the development sign-in. Starts its own server on a fresh
// database.  Usage: node build.mjs --web && node e2e/smoke-web.mjs [outdir]
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = resolve(process.argv[2] ?? "e2e/out-web");
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const PG = process.env.E2E_PG ?? "postgresql://nebula@127.0.0.1:5433";
const DB = "nebula_e2e";
const backendDir = resolve("../backend");

execSync(`psql "${PG}/postgres" -qc "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" -c "CREATE DATABASE ${DB}"`, { stdio: "inherit" });
const files = `/var/tmp/nebula-e2e-files-${Date.now()}`;
const server = spawn("bash", ["-c", `. .venv/bin/activate && exec uvicorn app.main:app --port ${PORT}`], {
  cwd: backendDir,
  env: {
    ...process.env, NEBULA_ENV: "development", NEBULA_SECRET_KEY: "e2e-secret", DATABASE_URL: `${PG}/${DB}`, STORAGE_DIR: files,
    RUN_WORKER: "0", STATIC_DIR: resolve("dist/web"), CLERK_PUBLISHABLE_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stopServer);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 500));
  if (i === 59) { console.log(serverLog); throw new Error("backend did not start"); }
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
writeFileSync(`${out}/req.png`, png);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.text()) && errors.push("console: " + m.text()));
page.on("response", (r) => r.url().startsWith(`${BASE}/api`) && r.status() >= 500 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

let failed = 0;
const step = async (name, f) => {
  try { await f(); console.log("ok  ", name); }
  catch (e) {
    failed++;
    console.log("FAIL", name, "-", e.message.split("\n")[0]);
    await page.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, "-")}.png`, fullPage: true }).catch(() => {});
    throw e;
  }
};
const toastWait = (t) => page.locator(".toast", { hasText: t }).first().waitFor({ timeout: 8000 });
const signIn = async (email, role) => {
  await page.goto(BASE + "/");
  await page.locator("#dev-email").waitFor();
  await page.fill("#dev-email", email);
  await page.selectOption("#dev-role", role);
  await page.getByRole("button", { name: /Sign in \(development\)/ }).click();
  await page.locator(".rail").waitFor();
};
const signOut = async () => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("#dev-email").waitFor();
};

try {
  await step("dev sign-in as admin", () => signIn("admin@example.org", "admin"));
  await page.screenshot({ path: `${out}/01-dashboard.png` });

  await step("load starter master data", async () => {
    await page.goto(`${BASE}/#admin`);
    await page.getByRole("tab", { name: "Setup" }).click();
    await page.getByRole("button", { name: /Load starter master data/ }).click();
    await toastWait("Starter master data loaded");
  });

  await step("AI settings tab renders without a key", async () => {
    await page.getByRole("tab", { name: "Document reading (AI)" }).click();
    await page.locator("text=Add an OpenRouter API key").waitFor();
    await page.screenshot({ path: `${out}/02-ai-settings.png`, fullPage: true });
  });
  await step("usage tab renders", async () => {
    await page.getByRole("tab", { name: "Usage & credits" }).click();
    await page.locator("text=This month's budget").waitFor();
    await page.screenshot({ path: `${out}/03-usage.png`, fullPage: true });
  });

  await step("register requisition (AI off, manual entry)", async () => {
    await page.goto(`${BASE}/#requisitions`);
    await page.getByRole("button", { name: "New requisition" }).first().click();
    if (!(await page.locator("#new-read").isDisabled())) throw new Error("AI reading should be unavailable without a key");
    await page.setInputFiles("#new-files", `${out}/req.png`);
    await page.getByRole("button", { name: "Register requisition" }).click();
    await page.waitForURL(/#req-/);
    await page.locator("h1.mono").waitFor();
  });
  const reqUrl = page.url();
  console.log("     number:", await page.locator("h1.mono").innerText());

  await step("original document shows via signed URL", async () => {
    await page.waitForFunction(() => { const i = document.querySelector(".doc-view img"); return i && i.complete && i.naturalWidth > 0 && i.src.includes("/files/"); }, null, { timeout: 8000 });
  });

  await step("fill header", async () => {
    await page.click("#hdr-facility");
    await page.locator(".search-results a", { hasText: "Government House Clinic" }).first().click();
    await toastWait("").catch(() => {});
    await page.fill("#hdr-reqdate", new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
    await page.locator("#hdr-reqdate").blur();
    await page.waitForTimeout(500);
  });

  await step("add and fill a line", async () => {
    await page.getByRole("button", { name: "Add line" }).click();
    await page.locator("[id^=ln-item-]").first().waitFor();
    const lid = (await page.locator("[id^=ln-item-]").first().getAttribute("id")).replace("ln-item-", "");
    await page.click(`#ln-item-${lid}`);
    await page.fill(`#ln-item-${lid}`, "Amoxicillin");
    await page.locator(".search-results a").first().click();
    await page.waitForTimeout(400);
    await page.selectOption(`#ln-prog-${lid}`, { label: "DRF" });
    await page.waitForTimeout(400);
    await page.fill(`#ln-qty-${lid}`, "100");
    await page.locator(`#ln-qty-${lid}`).blur();
    await page.waitForTimeout(400);
    const unit = await page.inputValue(`#ln-unit-${lid}`);
    if (!unit) { await page.fill(`#ln-unit-${lid}`, "capsule"); await page.locator(`#ln-unit-${lid}`).blur(); }
    await page.waitForTimeout(500);
  });
  await page.screenshot({ path: `${out}/04-review.png`, fullPage: true });

  await step("validate", async () => { await page.getByRole("button", { name: "Validate", exact: true }).click(); await toastWait("Validated"); });
  await step("finalize", async () => { await page.getByRole("button", { name: "Finalize", exact: true }).click(); await toastWait("Finalized"); });

  await step("record Finance as not applicable", async () => {
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
  await step("issued OFR shows 75%", () => page.waitForFunction(() => document.body.innerText.includes("75%"), null, { timeout: 8000 }));
  await step("close fulfillment", async () => { await page.getByRole("button", { name: "Close fulfillment" }).click(); await toastWait("Fulfillment closed"); });
  await page.screenshot({ path: `${out}/05-fulfillment.png`, fullPage: true });

  await step("requisition audit tab lists server events", async () => {
    await page.getByRole("tab", { name: "Audit history" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("fulfillment.corrected"), null, { timeout: 8000 });
  });

  await step("RA requests an edit to the finalized requisition", async () => {
    await signOut();
    await signIn("ra@example.org", "ra");
    await page.goto(reqUrl);
    await page.getByRole("button", { name: "Request edit" }).click();
    await page.selectOption("#er-field-0", "requisitionDateEstimated");
    await page.selectOption("#er-val-0", "true");
    await page.fill("#er-reason", "The date on the form is illegible");
    await page.getByRole("button", { name: "Submit request" }).click();
    await toastWait("Edit request submitted");
  });
  await step("RA cannot approve own request", async () => {
    await page.getByRole("tab", { name: /Edit requests/ }).click();
    await page.locator("text=You can't approve your own request").waitFor();
  });
  await step("supervisor sees no create button", async () => {
    await signOut();
    await signIn("sup@example.org", "supervisor");
    if (await page.getByRole("button", { name: "New requisition" }).count()) throw new Error("supervisor can create");
  });
  await step("admin approves on the Approvals page", async () => {
    await signOut();
    await signIn("admin@example.org", "admin");
    await page.goto(`${BASE}/#approvals`);
    await page.getByRole("button", { name: "Approve", exact: true }).first().click();
    await page.waitForTimeout(800);
  });
  await step("RA applies the approved change once", async () => {
    await signOut();
    await signIn("ra@example.org", "ra");
    await page.goto(reqUrl);
    await page.getByRole("tab", { name: /Edit requests/ }).click();
    await page.getByRole("button", { name: "Make the approved change" }).click();
    await page.getByRole("button", { name: "Save change" }).click();
    await toastWait("Change saved");
    await page.locator(".pill", { hasText: "Estimated requisition date" }).waitFor();
  });

  await step("admin user list shows people", async () => {
    await signOut();
    await signIn("admin@example.org", "admin");
    await page.goto(`${BASE}/#admin`);
    await page.getByRole("tab", { name: "Users & roles" }).click();
    await page.locator("text=ra@example.org").first().waitFor();
    await page.screenshot({ path: `${out}/06-users.png`, fullPage: true });
  });

  for (const [route, name] of [["dashboard", "07-dashboard"], ["analytics", "08-analytics"], ["facilities", "09-facilities"], ["approvals", "10-approvals"], ["audit", "11-audit"]]) {
    await step(`page ${route}`, async () => {
      await page.goto(`${BASE}/#${route}`);
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    });
  }
  await step("global audit log loads from the server", () => page.waitForFunction(() => document.body.innerText.includes("edit_request.used") || /Edit request used/i.test(document.body.innerText), null, { timeout: 8000 }));

  await step("phone width has no horizontal scroll", async () => {
    await page.setViewportSize({ width: 400, height: 860 });
    for (const r of ["dashboard", "requisitions", "admin"]) {
      await page.goto(`${BASE}/#${r}`);
      await page.waitForTimeout(400);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      if (w > 401) throw new Error(`#${r} scrollWidth ${w}`);
    }
    await page.screenshot({ path: `${out}/12-phone.png` });
  });
  await step("sign-in page at phone width", async () => {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await signOut();
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 401) throw new Error(`sign-in scrollWidth ${w}`);
    await page.screenshot({ path: `${out}/13-signin-phone.png` });
  });
} catch {
  /* reported by step() */
} finally {
  console.log(errors.length ? "ERRORS:\n" + [...new Set(errors)].join("\n") : "no page errors");
  if (failed) console.log("server log tail:\n" + serverLog.split("\n").slice(-25).join("\n"));
  await browser.close();
  stopServer();
  process.exit(failed ? 1 : 0);
}
