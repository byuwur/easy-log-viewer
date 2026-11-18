/*
 * File: __tests__/playground.cjs
 * Desc: One smoke check for the real playground's preview and copied starter.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { chromium, firefox, webkit } = require("playwright");
const engine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine), "Unsupported BROWSER_ENGINE");
const root = path.join(__dirname, "..");

test("LOG playground loads, updates, and copies a starter", { timeout: 30000 }, async (t) => {
  const browser = await { chromium, firefox, webkit }[engine].launch({ timeout: 10000, ...(engine === "chromium" ? { channel: process.env.BROWSER_CHANNEL, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedHTML = value;
        }
      }
    });
  });
  // Use real local companions behind the page's declared URLs, without contacting the CDN.
  const projects = {
    "spa.js": process.env.SPA_ASSETS_ROOT || path.join(root, "../spa.js"),
    "code.view": path.join(root, "../code.view"),
    "md.view": path.join(root, "../md.view"),
    "log.view": root
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const remote = url.origin === "https://cdn.jsdelivr.net" && url.pathname.match(/^\/gh\/byuwur\/([^@/]+)@[^/]+\/(.+)$/);
    const directory = url.origin === "https://playground.test" ? root : remote && projects[remote[1]];
    if (!directory) return route.abort();
    const file = remote ? remote[2] : url.pathname.slice(1) || "index.html";
    const target = path.resolve(directory, file);
    if (!target.startsWith(path.resolve(directory) + path.sep)) return route.abort();
    let body;
    try {
      body = await fs.readFile(target);
    } catch (error) {
      // Project distributions are generated; test their authored counterparts locally.
      if (error.code !== "ENOENT") throw error;
      body = await fs.readFile(target.replace(/\.min(?=\.(?:css|js)$)/, ""));
    }
    const contentType = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    return route.fulfill({ body, contentType: `${contentType}; charset=UTF-8` });
  });
  await page.goto("https://playground.test/index.html");
  assert.equal(await page.locator("#latest-release").getAttribute("href"), "https://github.com/byuwur/log.view/releases/latest");
  assert.equal(await page.locator("#download-release").getAttribute("href"), "https://github.com/byuwur/log.view/releases/latest/download/log.view.zip");
  assert.equal(await page.locator("#download-minified").getAttribute("href"), "https://github.com/byuwur/log.view/releases/latest/download/log.view.minified.zip");
  const preview = page.frameLocator("#preview-frame").locator(".byLOGdocument");
  await preview.waitFor();
  await page.locator("#source").fill("INFO PLAYGROUND_CORE");
  await page.locator("#render").click();
  await preview.filter({ hasText: "PLAYGROUND_CORE" }).waitFor();
  await page.locator("#copy-html").click();
  await page.waitForFunction(() => typeof window.copiedHTML === "string");
  assert.match(await page.evaluate(() => window.copiedHTML), /log(?:\.min)?\.js/);
  assert.deepEqual(errors, [], "No uncaught playground errors");
});
