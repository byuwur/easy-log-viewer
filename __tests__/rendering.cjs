/*
 * File: __tests__/rendering.cjs
 * Desc: Bounded, offline checks for the public LOG renderer contract.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium, firefox, webkit } = require("playwright");
const engine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine), "Unsupported BROWSER_ENGINE");

test("LOG library", { timeout: 30000 }, async (t) => {
  const browser = await { chromium, firefox, webkit }[engine].launch({
    timeout: 10000,
    ...(engine === "chromium" ? { channel: process.env.BROWSER_CHANNEL, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {})
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Load authored files directly; CDN availability is not part of this contract.
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<!doctype html><meta charset="UTF-8"><div id="viewer"></div>');
  await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
  await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
  await page.evaluate(() => {
    window.root = document.getElementById("viewer");
  });

  await t.test("parses severity and appends entries in order within its limit", async () => {
    const result = await page.evaluate(async () => {
      const parsed = byLOGviewer.parse("2026-10-30T08:00:00Z [WARNING] slow");
      const logs = byLOGviewer(root, "INFO first", { maxEntries: 2, animations: false });
      await logs.ready;
      await logs.append("WARN second");
      await logs.append("ERROR third");
      return { level: parsed.level, message: parsed.message, entries: [...root.querySelectorAll(".byLOGmessage")].map((node) => node.textContent) };
    });
    assert.deepEqual(result, { level: "WARN", message: "slow", entries: ["second", "third"] });
  });

  await t.test("live appends retain disclosures only for their own entries", async () => {
    const result = await page.evaluate(async () => {
      const logs = byLOGviewer(
        root,
        [
          { message: "old", extra: 1 },
          { message: "keep", extra: 2 }
        ],
        { maxEntries: 2 }
      );
      await logs.ready;
      root.querySelectorAll("details")[1].open = true;
      await logs.append({ message: "new", extra: 3 });
      return [...root.querySelectorAll("details")].map((details) => details.open);
    });
    assert.deepEqual(result, [true, false]);
  });

  await t.test("rejects invalid input and keeps log markup inert", async () => {
    assert.equal(await page.evaluate(() => byLOGviewer(root, 42).ready), false);
    await page.evaluate(() => byLOGviewer(root, '<img src=x onerror="window.injected=1">').ready);
    assert.equal(await page.locator("#viewer img").count(), 0);
    assert.match(await page.locator(".byLOGmessage").textContent(), /<img/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
  });

  await t.test("replacement and disposal respect the current instance", async () => {
    const result = await page.evaluate(async () => {
      const old = byLOGviewer(root, "INFO old");
      await old.ready;
      const current = byLOGviewer(root, "INFO current");
      const ready = await current.ready;
      old.destroy();
      const preserved = root.textContent.includes("current");
      current.destroy();
      return { ready, preserved, empty: root.childNodes.length === 0 };
    });
    assert.deepEqual(result, { ready: true, preserved: true, empty: true });
  });

  assert.deepEqual(errors, [], "No uncaught browser errors");
});
