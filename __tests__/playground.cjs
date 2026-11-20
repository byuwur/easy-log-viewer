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
  const browser = await { chromium, firefox, webkit }[engine].launch({
    timeout: 10000,
    ...(engine === "chromium"
      ? {
          channel: process.env.BROWSER_CHANNEL,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH
        }
      : {})
  });
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
  // ===== PROJECT ASSETS =====
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
    const contentType =
      {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml"
      }[path.extname(file)] || "application/octet-stream";
    return route.fulfill({ body, contentType: `${contentType}; charset=UTF-8` });
  });
  // ===== BROWSER INTERACTIONS =====
  await page.goto("https://playground.test/index.html");
  assert.equal(await page.locator("#latest-release").getAttribute("href"), "https://github.com/byuwur/log.view/releases/latest");
  assert.equal(await page.locator("#download-release").getAttribute("href"), "https://github.com/byuwur/log.view/releases/latest/download/log.view.zip");
  assert.equal(await page.locator("#download-minified").getAttribute("href"), "https://github.com/byuwur/log.view/releases/latest/download/log.view.minified.zip");
  const preview = page.frameLocator("#preview-frame").locator(".byLOGdocument");
  await preview.locator(".byLOGmessage").first().waitFor();
  const sizes = await preview.evaluate((viewer) => {
    const [decrease, reset, increase] = viewer.querySelectorAll(".byVIEWfontSize");
    const text = viewer.querySelector(".byLOGmessage");
    const layout = viewer.querySelector(".byLOGentry");
    const inset = viewer.querySelector(".byLOGentries");
    const rem = parseFloat(getComputedStyle(viewer.ownerDocument.documentElement).fontSize);
    const size = () => parseFloat(getComputedStyle(text).fontSize) / rem;
    const padding = (node) => {
      const style = getComputedStyle(node);
      return [parseFloat(style.paddingTop) / rem, parseFloat(style.paddingLeft) / rem];
    };
    const frameMetrics = () =>
      [viewer, viewer.querySelector(".byVIEWtoolbar"), viewer.querySelector(".byVIEWstatus")]
        .filter(Boolean)
        .map((node) => {
          const style = getComputedStyle(node);
          return [style.fontSize, style.paddingLeft, style.paddingTop].join("/");
        })
        .join(" ");
    const initialFrame = frameMetrics();
    const initial = size();
    for (let i = 0; i < 20; i++) decrease.click();
    const minimumFrame = frameMetrics();
    const minimumDisabled = decrease.disabled && getComputedStyle(decrease).outlineStyle === "dashed";
    const steps = [];
    for (let i = 0; i <= 20; i++) {
      steps.push([size(), ...padding(inset), ...padding(layout)]);
      increase.click();
    }
    const maximumDisabled = increase.disabled && getComputedStyle(increase).outlineStyle === "dashed";
    const maximumFrame = frameMetrics();
    reset.click();
    return { steps, minimumDisabled, maximumDisabled, restored: size() === initial, stableFrame: initialFrame === minimumFrame && minimumFrame === maximumFrame };
  });
  assert.deepEqual(
    sizes.steps,
    Array.from({ length: 21 }, (_, i) => {
      const size = 0.5 + i * 0.125;
      return [size, 0.375, 0.5, 0.5, 0.75];
    })
  );
  assert.ok(sizes.minimumDisabled && sizes.maximumDisabled && sizes.restored && sizes.stableFrame);

  await page.evaluate(() => spaReady);
  const originalText = await preview.locator(".byLOGmessage").first().elementHandle();
  const toolbar = await preview.locator(".byVIEWtoolbar").elementHandle();
  const content = await preview.locator(":scope > .byVIEWcontent").elementHandle();
  const palette = page.locator("#preview-palette");
  const originalPalette = await palette.inputValue();
  await palette.selectOption("bonyur");
  assert.equal(await preview.getAttribute("data-theme"), "bonyur");
  assert.equal(await originalText.evaluate((node) => node.isConnected), true);
  await palette.selectOption(originalPalette);
  const option = page.locator("#details");
  await option.evaluate((input) => input.click());
  await preview.locator(".byLOGentry details").first().waitFor({ state: "hidden" });
  assert.equal(await toolbar.evaluate((node) => node.isConnected), true);
  assert.equal(await content.evaluate((node) => node.isConnected), true);
  await option.evaluate((input) => input.click());
  await page.locator(".preview-appearance > summary").click();
  const sizeField = page.locator("#preview-size");
  await sizeField.click();
  await sizeField.press("3");
  await sizeField.press("Tab");
  const increase = preview.getByRole("button", { name: "Increase text size" });
  await preview.locator(".byVIEWfontSize:disabled").filter({ hasText: "A+" }).waitFor();
  await preview.getByRole("button", { name: "Decrease text size" }).click();
  await page.locator("#preview-leading").click();
  await page.locator("#preview-leading").pressSequentially("1.7");
  await page.locator("#preview-leading").press("Tab");
  assert.equal(await increase.isEnabled(), true);
  await preview.getByRole("button", { name: "Reset text size" }).click();
  await preview.locator(".byVIEWfontSize:disabled").filter({ hasText: "A+" }).waitFor();
  await sizeField.click();
  await sizeField.press("ControlOrMeta+a");
  await sizeField.press("Backspace");
  await sizeField.press("Tab");
  assert.equal(await increase.isEnabled(), true);

  const colors = await preview.evaluate((viewer) => {
    const surface = viewer;
    const background = () => getComputedStyle(surface).backgroundColor;
    const toggle = viewer.querySelector(".byVIEWthemeToggle");
    const light = background();
    toggle.click();
    const fades = viewer.getAnimations();
    for (const fade of fades) {
      fade.pause();
      fade.currentTime = fade.effect.getTiming().duration / 2;
    }
    const middle = background();
    for (const fade of fades) fade.finish();
    const dark = background();
    toggle.click();
    for (const fade of viewer.getAnimations()) fade.finish();
    return { light, middle, dark, restored: background() };
  });
  assert.notEqual(colors.light, colors.dark);
  assert.notEqual(colors.middle, colors.light);
  assert.notEqual(colors.middle, colors.dark);
  assert.equal(colors.restored, colors.light);
  await page.locator("#source").fill("INFO PLAYGROUND_CORE");
  await page.locator("#render").click();
  await preview.filter({ hasText: "PLAYGROUND_CORE" }).waitFor();
  await page.locator("#copy-html").click();
  await page.waitForFunction(() => typeof window.copiedHTML === "string");
  assert.match(await page.evaluate(() => window.copiedHTML), /log(?:\.min)?\.js/);
  assert.deepEqual(errors, [], "No uncaught playground errors");
});
