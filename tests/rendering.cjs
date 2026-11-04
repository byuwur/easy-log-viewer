const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { chromium } = require("playwright");

// Caller-provided legacy stylesheets reuse the canonical palettes without distribution files.
const legacyThemeCSS = (theme) => {
  const css = require("node:fs").readFileSync(path.join(__dirname, "../log.css"), "utf8");
  const section = css.split(`/* --- ${theme.toUpperCase()} --- */`)[1];
  return `.byLOGdocument {${section.match(/\{([\s\S]*?)\}/)[1]}}`;
};

let bootstrapCSS;
const getBootstrapCSS = () =>
  (bootstrapCSS ??= (async () => {
    if (process.env.BOOTSTRAP_CSS_PATH) return require("node:fs/promises").readFile(process.env.BOOTSTRAP_CSS_PATH, "utf8");
    const response = await fetch("https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css");
    assert.ok(response.ok, "Unable to load pinned Bootstrap CSS");
    return response.text();
  })());

test("LOG standalone browser contracts", async (t) => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [],
      requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith("http://viewer.test/")) requests.push(request.url());
    });
    await page.route("http://viewer.test/**", (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      if (/^log\.(light|dark)\.css$/.test(filename)) return route.fulfill({ body: legacyThemeCSS(filename.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (!filename || filename === "index.html")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="log.css"><script src="log.js"></script><div id="viewer" data-theme="light"></div>'
        });
      return route.fulfill({ path: path.join(__dirname, "..", filename), contentType: filename.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    await page.goto("http://viewer.test/index.html");
    await page.evaluate(
      async ({ source, second, options }) => {
        await byLOGviewer(document.getElementById("viewer"), source, options).ready;
      },
      {
        source:
          '2026-10-30T09:00:00Z INFO Server started\n2026-10-30T09:00:01Z DEBUG Cache ready\n2026-10-30T09:00:02Z WARN Slow query\n{"timestamp":"2026-10-30T09:00:03Z","level":"ERROR","message":"Request failed","request":{"path":"/api","status":503}}',
        options: { fontSizeControls: true, search: true, autoScroll: false, batchSize: 200, maxEntries: 10000 }
      }
    );
    await page.waitForFunction(() => document.getElementById("viewer")?.getAttribute("aria-busy") !== "true" && typeof window.byLOGviewer === "function");
    await page.evaluate(() => {
      window.root = document.getElementById("viewer");
      window.copies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => copies.push(value) } });
    });
    await t.test("themes, copy, font size, and responsive controls", async () => {
      assert.equal(await page.locator("#viewer [role=alert]:visible").count(), 0);
      await page.locator(".byVIEWcopy").click();
      assert.equal(await page.evaluate(() => typeof copies.at(-1)), "string");
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await page.waitForFunction(() => getComputedStyle(root).backgroundColor === "rgb(39, 40, 34)");
      await page.getByRole("button", { name: "Increase text size" }).click();
      assert.equal(await page.evaluate(() => root.style.fontSize), "1.125rem");
      await page.setViewportSize({ width: 320, height: 640 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.getByRole("button", { name: "Reset text size" }).click();
    });
    await t.test("clipboard denial is reported", async () => {
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => {
          throw new Error("denied");
        };
      });
      await page.locator(".byVIEWcopy").click();
      assert.equal(await page.locator(".byVIEWcopy").textContent(), "Failed");
      await page.evaluate(() => {
        navigator.clipboard.writeText = async (value) => copies.push(value);
      });
    });

    await t.test("plain and structured parsing stays conservative", async () => {
      const result = await page.evaluate(() => [byLOGviewer.parse("2026-10-30T08:00:00Z [WARNING] slow"), byLOGviewer.parse("This ERROR is a message"), byLOGviewer.parse('{"level":"error","msg":"failed","time":0,"status":503}')]);
      assert.equal(result[0].level, "WARN");
      assert.equal(result[0].message, "slow");
      assert.equal(result[0].timestamp, "2026-10-30T08:00:00Z");
      assert.equal(result[1].level, "UNKNOWN");
      assert.equal(result[2].level, "ERROR");
      assert.equal(result[2].timestamp, 0);
      assert.deepEqual(result[2].details, { status: 503 });
    });
    await t.test("search, severity, expandable details, and entry copy", async () => {
      await page.evaluate(async () => {
        await byLOGviewer(
          root,
          [
            { level: "INFO", message: "ready" },
            { level: "ERROR", message: "failed", path: "/api" }
          ],
          { search: true, levelFilter: true, autoScrollControl: true, copyEntries: true }
        ).ready;
      });
      assert.equal(await page.locator(".byLOGentry").count(), 2);
      await page.getByRole("combobox", { name: "Filter severity" }).selectOption("ERROR");
      await page.waitForFunction(() => document.querySelectorAll(".byLOGentry").length === 1);
      await page.locator(".byLOGentry summary").click();
      assert.match(await page.locator(".byLOGdetails").textContent(), /\/api/);
      await page.getByRole("button", { name: "Copy log entry", exact: true }).click();
      assert.match(await page.evaluate(() => copies.at(-1)), /failed/);
      await page.getByRole("searchbox", { name: "Search logs" }).fill("no match");
      await page.waitForFunction(() => document.querySelectorAll(".byLOGentry").length === 0);
    });
    await t.test("append is ordered, bounded, atomic, and recovers after errors", async () => {
      const result = await page.evaluate(async () => {
        const logs = byLOGviewer(root, "INFO first", { maxEntries: 2 });
        await logs.ready;
        const a = logs.append("WARN second"),
          b = logs.append("ERROR third");
        await Promise.all([a, b]);
        const before = [...root.querySelectorAll(".byLOGmessage")].map((e) => e.textContent);
        const invalid = await logs.append(["INFO not committed", 42]);
        const same = [...root.querySelectorAll(".byLOGmessage")].map((e) => e.textContent);
        const recovered = await logs.append("DEBUG recovered");
        return { before, invalid, same, recovered, after: [...root.querySelectorAll(".byLOGmessage")].map((e) => e.textContent) };
      });
      assert.deepEqual(result, { before: ["second", "third"], invalid: false, same: ["second", "third"], recovered: true, after: ["third", "recovered"] });
    });
    await t.test("custom parser, empty input, cycles, malformed input, and injection", async () => {
      const result = await page.evaluate(async () => {
        const custom = byLOGviewer(root, ["skip", "oops"], { parser: (value) => (value === "skip" ? null : { message: value, level: "critical", timestamp: "custom" }) });
        await custom.ready;
        const level = root.querySelector(".byLOGlevel").textContent;
        const circular = { level: "info", message: "cycle" };
        circular.self = circular;
        await byLOGviewer(root, [circular, '<img src=x onerror="window.injected=1">', "{bad JSON"]).ready;
        const safe = root.querySelectorAll("img").length === 0 && !window.injected;
        const cycle = root.querySelector(".byLOGdetails").textContent.includes("[Circular]");
        const empty = await byLOGviewer(root, "").ready;
        const count = root.querySelectorAll(".byLOGentry").length;
        const invalid = await byLOGviewer(root, 42).ready;
        return { level, safe, cycle, empty, count, invalid };
      });
      assert.deepEqual(result, { level: "FATAL", safe: true, cycle: true, empty: true, count: 0, invalid: false });
    });
    await t.test("large history yields; load-more, follow, cancellation and disposal", async () => {
      const result = await page.evaluate(async () => {
        const input = Array.from({ length: 12000 }, (_, i) => `INFO entry ${i}`);
        let tick = false;
        setTimeout(() => {
          tick = true;
        }, 0);
        const view = byLOGviewer(root, input, { autoScroll: true, batchSize: 100 });
        await view.ready;
        const count = root.querySelectorAll(".byLOGentry").length;
        const last = root.querySelector(".byLOGentry:last-child .byLOGmessage").textContent;
        const old = byLOGviewer(root, input);
        const current = byLOGviewer(root, "INFO new");
        const cancelled = await old.ready;
        await current.ready;
        const text = root.querySelector(".byLOGmessage").textContent;
        old.destroy();
        const preserved = root.childNodes.length > 0;
        current.destroy();
        return { tick, count, last, cancelled, text, preserved, disposed: root.childNodes.length === 0, append: await old.append("INFO stale") };
      });
      assert.deepEqual(result, { tick: true, count: 100, last: "entry 11999", cancelled: false, text: "new", preserved: true, disposed: true, append: false });
    });

    await t.test("inline and stacked layouts preserve entries, details, and appends", async () => {
      try {
        for (const theme of ["light", "dark"]) {
          for (const layout of ["inline", "stacked"]) {
            await page.evaluate(
              async ({ theme, layout }) => {
                root.dataset.theme = theme;
                root.style.width = "40rem";
                window.layoutLogs = byLOGviewer(root, [{ timestamp: "09:00", level: "INFO", message: "Ready" }], { layout, copyEntries: true, search: true, loadMore: false, statusBar: true });
                await layoutLogs.ready;
                await layoutLogs.append({ timestamp: "09:01", level: "ERROR", message: "Failure\nSecond line", code: 503 });
              },
              { theme, layout }
            );
            assert.equal(await page.locator(".byLOGentries").getAttribute("data-layout"), layout);
            const geometry = await page
              .locator(".byLOGentry")
              .first()
              .evaluate((entry) => {
                const heading = entry.querySelector(".byLOGheading").getBoundingClientRect();
                const message = entry.querySelector(".byLOGmessage").getBoundingClientRect();
                return { below: message.top >= heading.bottom, overlap: message.top < heading.bottom };
              });
            assert.equal(layout === "stacked" ? geometry.below : geometry.overlap, true);
            assert.equal(await page.locator(".byLOGentry").count(), 2);
            await page.locator(".byLOGentry details summary").click();
            assert.match(await page.locator(".byLOGdetails").textContent(), /503/);
            await page.getByRole("button", { name: "Copy log entry", exact: true }).nth(1).click();
            assert.match(await page.evaluate(() => copies.at(-1)), /Failure/);
            await page.getByRole("searchbox", { name: "Search logs" }).fill("Failure");
            await page.waitForFunction(() => document.querySelectorAll(".byLOGentry").length === 1);
            assert.equal(await page.locator(".byLOGentries").getAttribute("data-layout"), layout);
            assert.equal(await page.locator(".byLOGmessage").textContent(), "Failure\nSecond line");
          }
        }
        for (const layout of [undefined, "invalid"]) {
          await page.evaluate(async (layout) => {
            await byLOGviewer(root, "INFO Default", { layout }).ready;
          }, layout);
          assert.equal(await page.locator(".byLOGentries").getAttribute("data-layout"), "inline");
        }
        await page.setViewportSize({ width: 320, height: 720 });
        await page.evaluate(async () => {
          root.style.width = "";
          await byLOGviewer(root, { timestamp: "2026-11-03T09:00:00Z", level: "ERROR", message: "long".repeat(100), detail: "value" }, { layout: "stacked", copyEntries: true }).ready;
        });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      } finally {
        await page.evaluate(() => {
          root.style.width = "";
        });
        await page.setViewportSize({ width: 1100, height: 800 });
      }
    });

    await t.test("duplicate loading and source independence", async () => {
      await page.evaluate(() => {
        window.original = byLOGviewer;
      });
      await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
      assert.equal(await page.evaluate(() => original === byLOGviewer), true);
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
});

test("suite playground, exports, and stylesheet controls", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedHTML = text;
          }
        }
      });
    });
    await page.route("**/*", async (route) => {
      if (route.request().url() === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      const url = new URL(route.request().url());
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname);
      if (/^log\.(light|dark)\.css$/.test(file)) return route.fulfill({ body: legacyThemeCSS(file.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    await page.waitForFunction(() => document.getElementById("render-status").textContent.startsWith("Rendered"));
    const preview = page.frames().find((frame) => frame.parentFrame());
    const source = await page.locator("#source").inputValue();
    const expectedCopy = source;
    assert.equal(await page.locator("#layout-inline").isChecked(), true);
    await page.locator("#layout-inline").focus();
    await page.keyboard.press("ArrowRight");
    await preview.waitForFunction(() => document.querySelector(".byLOGentries").dataset.layout === "stacked");
    assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).layout, "stacked");
    await page.locator("#reset-settings").evaluate((button) => button.click());
    await preview.waitForFunction(() => document.querySelector(".byLOGentries").dataset.layout === "inline");
    const release = await page
      .frameLocator("#preview-frame")
      .locator(".byVIEWtoolbar")
      .evaluate(() => byLOGviewer.VERSION);
    assert.ok((await page.frameLocator("#preview-frame").locator(".byVIEWinfo").textContent()).includes(` v${release} `), "Credits must match the runtime release");
    const cdnBase = "https://cdn.jsdelivr.net/gh/byuwur/easy-log-viewer@latest/";
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const extension of ["css", "js"]) assert.ok(readme.includes(`${cdnBase}log.${extension}`), "README assets must match the CDN starter");
    assert.equal(await page.locator("#install-note").textContent(), "CDN follows the latest release; updates may take time to reach caches.");
    assert.ok((await page.locator("#integration-code").inputValue()).includes(`href="${cdnBase}log.css"`));
    assert.equal(await page.locator('[data-install="cdn"]').getAttribute("aria-pressed"), "true");
    await page.locator('[data-install="local"]').click();
    const starter = await page.locator("#integration-code").inputValue();
    await page.evaluate(() => {
      window.successfulClipboardWrite = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async () => {
        throw new Error("Denied");
      };
    });
    await page.locator("#copy-html").click();
    await page.waitForFunction(() => document.querySelector("#copy-html span").textContent === "Failed");
    assert.equal(await page.locator("#integration-code").evaluate((element) => document.activeElement === element && element.selectionEnd === element.value.length), true);
    assert.match(await page.locator("#copy-html").getAttribute("title"), /Ctrl\+C/);
    await page.evaluate(() => {
      navigator.clipboard.writeText = window.successfulClipboardWrite;
    });

    assert.ok(starter.includes('href="log.css"'));
    assert.ok(starter.includes('data-theme="light"'));
    assert.ok(!starter.includes("byVIEWtheme"));
    assert.doesNotMatch(starter, /\.(light|dark)\.css/);
    assert.ok(starter.includes('src="log.js"'));
    await page.locator('[name="controlsCompact"]').check();
    await page.locator('label[for="controlsPosition-bottom"]').click();
    await page.locator('label[for="controlsSize-small"]').click();
    await preview.waitForFunction(() => document.getElementById("viewer").classList.contains("byVIEWbottom") && document.querySelector(".byVIEWtoolbar").dataset.size === "small");
    assert.equal(await preview.locator("#viewer").evaluate((element) => element.lastElementChild.classList.contains("byVIEWtoolbar")), true);
    await page.locator('label[for="preview-dark"]').click();
    await preview.waitForFunction(() => getComputedStyle(document.getElementById("viewer")).backgroundColor === "rgb(39, 40, 34)");
    await preview.locator(".byVIEWthemeToggle").click();
    await page.waitForFunction(() => document.getElementById("preview-light").checked);
    await page.locator("#source").fill("");
    await page.locator("#render").click();
    await page.waitForFunction(() => !document.getElementById("render-status").textContent.includes("Rendering"));
    assert.equal(await page.locator("#integration-code").inputValue(), starter);
    await page.locator("#copy-html").click();
    assert.equal(await page.evaluate(() => copiedHTML), starter);
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download-html").click()]);
    assert.equal(await require("node:fs/promises").readFile(await download.path(), "utf8"), starter);
    const exported = await browser.newPage();
    await exported.route("https://viewer.test/**", (route) => {
      const file = path.basename(new URL(route.request().url()).pathname);
      if (/^log\.(light|dark)\.css$/.test(file)) return route.fulfill({ body: legacyThemeCSS(file.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (file === "starter.html") return route.fulfill({ body: starter, contentType: "text/html" });
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await exported.goto("https://viewer.test/starter.html");
    await exported.waitForFunction(() => document.querySelector(".byVIEWtoolbar") && document.getElementById("viewer").getAttribute("aria-busy") !== "true");
    assert.equal(await exported.locator("[role=alert]:visible").count(), 0);
    await exported.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedSource = text;
          }
        }
      });
    });
    await exported.locator(".byVIEWcopy").click();
    assert.equal(await exported.evaluate(() => copiedSource), expectedCopy);
    await page.locator('[data-install="cdn"]').click();
    const cdnStarter = await page.locator("#integration-code").inputValue();
    assert.equal(cdnStarter.replaceAll(cdnBase, ""), starter, "Only asset paths change between modes");
    assert.ok(cdnStarter.includes('href="' + cdnBase + 'log.css"'));
    assert.ok(cdnStarter.includes('src="' + cdnBase + 'log.js"'));
    assert.equal(await page.locator('[data-install="cdn"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-install="local"]').getAttribute("aria-pressed"), "false");
    await page.locator("#copy-html").click();
    assert.equal(await page.evaluate(() => copiedHTML), cdnStarter);
    const [cdnDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#download-html").click()]);
    assert.equal(await require("node:fs/promises").readFile(await cdnDownload.path(), "utf8"), cdnStarter);
    const cdnPage = await browser.newPage();
    const cdnRequests = [];
    cdnPage.on("pageerror", (error) => errors.push(error.message));
    // Serve future CDN URLs from the maintained files without depending on publication.
    await cdnPage.route("**/*", (route) => {
      const url = route.request().url();
      if (url === "https://viewer.test/cdn-starter.html") return route.fulfill({ body: cdnStarter, contentType: "text/html" });
      if ([cdnBase + "log.css", cdnBase + "log.js"].includes(url)) {
        cdnRequests.push(url);
        return route.fulfill({ path: path.join(__dirname, "..", path.basename(new URL(url).pathname)), contentType: url.endsWith(".js") ? "text/javascript" : "text/css" });
      }
      return route.abort();
    });
    await cdnPage.goto("https://viewer.test/cdn-starter.html");
    await cdnPage.waitForFunction(() => document.querySelector(".byVIEWtoolbar") && document.getElementById("viewer").getAttribute("aria-busy") !== "true");
    assert.equal(await cdnPage.locator("[role=alert]:visible").count(), 0);
    assert.deepEqual(cdnRequests.sort(), [cdnBase + "log.css", cdnBase + "log.js"]);
    await cdnPage.close();
    await page.locator('[data-install="local"]').click();
    assert.equal(await page.locator("#integration-code").inputValue(), starter);
    assert.equal(await page.locator('[data-install="local"]').getAttribute("aria-pressed"), "true");
    // Caller-provided legacy stylesheets still synchronize unassigned viewers.
    await exported.evaluate(async () => {
      document.getElementById("viewer").removeAttribute("data-theme");
      const link = document.createElement("link");
      link.rel = "stylesheet";
      document.head.appendChild(link);
      link.setAttribute("href", "log.light.css?cache=1#theme");
      const other = document.createElement("div");
      other.id = "other";
      document.body.appendChild(other);
      await byLOGviewer(other, "", { fontSizeControls: true }).ready;
    });
    await exported.locator("#other .byVIEWthemeToggle").click();
    assert.equal(await exported.locator('link[href*="dark.css"]').getAttribute("href"), "log.dark.css?cache=1#theme");
    assert.equal(await exported.locator('[aria-label="Switch to light theme"]').count(), 2);
    await exported.evaluate(async () => {
      document.querySelector('link[href*=".dark.css"]').remove();
      await byLOGviewer(document.getElementById("other"), "", { fontSizeControls: true }).ready;
    });
    assert.equal(await exported.locator("#other .byVIEWthemeToggle").count(), 1);
    await exported.locator('#other [aria-label="Increase text size"]').evaluate((button) => {
      for (let i = 0; i < 30; i++) button.click();
    });
    assert.equal(await exported.locator('#other [aria-label="Increase text size"]').isDisabled(), true);
    assert.equal(await exported.locator("#other").evaluate((element) => element.style.fontSize), "3rem");
    await exported.close();
    await page.locator("#local-file").setInputFiles({ name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from(source) });
    await page.waitForFunction((expected) => document.getElementById("source").value === expected, source);
    await page.locator("#reset").click();
    assert.equal(await page.locator('[name="controlsCompact"]').isChecked(), true);
    assert.equal(await page.locator('[name="controlsPosition"]:checked').inputValue(), "top");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("family customization, navigation and monospace controls", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.lastCopy = text;
          }
        }
      })
    );
    await page.route("**/*", async (route) => {
      if (route.request().url() === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      const url = new URL(route.request().url());
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname);
      if (/^log\.(light|dark)\.css$/.test(file)) return route.fulfill({ body: legacyThemeCSS(file.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    const frame = page.frames().find((candidate) => candidate.parentFrame());
    await frame.waitForSelector(".byVIEWtoolbar");
    assert.equal(await page.locator("#controlsCompact").isChecked(), true);
    assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).controlsCompact, true);
    assert.equal(await frame.locator(".byLOGdocument").evaluate((root) => root.classList.contains("byVIEWcompact")), true);
    assert.deepEqual(
      await frame.evaluate(async (source) => {
        const host = document.createElement("div");
        document.body.append(host);
        const states = [];
        let controller;
        try {
          for (const options of [undefined, { controlsCompact: false }, { controlsCompact: true }, undefined]) {
            controller = byLOGviewer(host, source, options);
            await controller?.ready;
            states.push(host.classList.contains("byVIEWcompact"));
          }
          controller = byLOGviewer(host, source, { themeToggle: false, fontSizeControls: false, copyButton: false });
          await controller?.ready;
          states.push(host.querySelectorAll(".byVIEWinfo").length === 1 && !host.querySelector(".byVIEWcontrols"));
          return states;
        } finally {
          controller?.destroy?.();
          host.remove();
        }
      }, "Sample"),
      [true, false, true, true, true],
      "Compact defaults, opt-out, rerenders, and disabled controls agree"
    );
    assert.deepEqual(
      await page
        .locator(".form-switch .form-check-input")
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { width: style.width, height: style.height };
        }),
      { width: "44px", height: "24px" }
    );
    assert.equal(
      await page.locator(".form-switch .form-check-input").evaluateAll((inputs) =>
        inputs.every((input) => {
          const toggle = input.getBoundingClientRect();
          const row = input.closest(".form-switch").getBoundingClientRect();
          return Math.abs(toggle.right - row.right) < 1 && Math.abs(toggle.top + toggle.height / 2 - row.top - row.height / 2) < 1;
        })
      ),
      true,
      "Every switch lines up at the right edge and center of its row"
    );
    for (const width of [768, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(
        await page.locator("#controlsSize").evaluate((size) => {
          const a = size.querySelector(".btn-group").getBoundingClientRect();
          const b = document.querySelector("#controlsPosition .btn-group").getBoundingClientRect();
          return Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && a.right < b.left;
        }),
        true,
        "Size and position controls share one evenly divided row"
      );
    }
    assert.deepEqual(
      await page
        .locator(".accordion-button")
        .allTextContents()
        .then((labels) => labels.map((label) => label.trim()).slice(0, 3)),
      ["Preview appearance", "Viewer controls", "Rendering"]
    );
    assert.deepEqual(await page.locator("#options-json").evaluate((editor) => Object.keys(JSON.parse(editor.value)).slice(0, 18)), [
      "theme",
      "palette",
      "fontFamily",
      "fontSize",
      "lineHeight",
      "controlsFont",
      "backgroundColor",
      "containerBackgroundColor",
      "textColor",
      "customThemeCSS",
      "toolbar",
      "credits",
      "themeToggle",
      "fontSizeControls",
      "copyButton",
      "controlsCompact",
      "controlsSize",
      "controlsPosition"
    ]);
    assert.equal(await page.locator(".intro h1 + p").textContent(), "Plain JavaScript. No dependencies. Open source. Free. Forever.");
    assert.ok((await page.locator("header .brand-mark").textContent()).trim());

    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bs-body-bg").trim()), "#141618");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(20, 22, 24)");
    assert.equal(
      await page
        .locator(".source-editor")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(20, 22, 24)"
    );
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#141618");
    await page.locator("#site-theme").evaluate((button) => button.click());
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bs-body-bg").trim()), "#fff");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(255, 255, 255)");
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#fff");
    const root = frame.locator(".byLOGdocument");
    const initial = await root.evaluate((element) => ({ font: element.style.fontFamily, size: element.style.fontSize, bg: element.style.getPropertyValue("--by-view-bg") }));
    assert.match(await frame.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).fontFamily), /monospace/);
    assert.equal(await page.locator('[aria-label="Viewer suite"] a').count(), 9);
    assert.equal(await page.locator(".viewer-suite").getByRole("link", { name: "MD.edit", exact: true }).getAttribute("href"), "https://byuwur.github.io/easy-md-editor/");
    assert.equal(await page.locator('[aria-label="Viewer suite"]').getByRole("link", { name: "LOG", exact: true }).getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".site-footer .fa-heart").count(), 1);
    assert.equal(await page.locator("header .fa-github").count(), 1);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('[aria-label="Viewer suite"]').compareDocumentPosition(document.querySelector("footer")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await page.locator(".preview-appearance").evaluate((element) => {
      element.open = true;
    });
    await page.locator("#preview-controls-font-0").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#preview-controls-font-1").isChecked(), true);
    assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).controlsFont, "system-ui, sans-serif");
    await page.keyboard.press("ArrowLeft");
    await page.evaluate(() => {
      for (const [id, value] of [
        ["preview-font", "Georgia, serif"],
        ["preview-size", "1.5"],
        ["preview-leading", "1.8"],
        ["preview-controls-font", "system-ui, sans-serif"],
        ["preview-bg", "#123456"],
        ["preview-ink", "#fedcba"]
      ]) {
        const input = id === "preview-controls-font" ? document.querySelector(`[name="preview-controls-font"][value="${value}"]`) : document.getElementById(id);
        if (input.type === "radio") input.checked = true;
        else input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    assert.deepEqual(
      await root.evaluate((element) => {
        const style = getComputedStyle(element);
        return { font: style.fontFamily, size: style.fontSize, line: style.lineHeight, bg: style.backgroundColor, text: style.color };
      }),
      { font: "Georgia, serif", size: "24px", line: "43.2px", bg: "rgb(18, 52, 86)", text: "rgb(254, 220, 186)" }
    );
    assert.equal(
      await frame
        .locator(".byLOGmessage")
        .first()
        .evaluate((element) => getComputedStyle(element).fontFamily),
      "Georgia, serif"
    );
    assert.match(await frame.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).fontFamily), /system-ui/);
    await page.locator("#copy-appearance").evaluate((button) => button.click());
    await page.waitForFunction(() => window.lastCopy?.includes("--by-view-controls-font"));
    assert.match(await page.evaluate(() => lastCopy), /\.byLOGdocument/);
    assert.ok((await page.evaluate(() => lastCopy)).includes("--by-view-document-bg: #123456"));
    await page.locator('[data-options-view="json"]').evaluate((button) => button.click());
    const configuration = JSON.parse(await page.locator("#options-json").inputValue());
    for (const [name, value] of Object.entries({
      theme: "light",
      fontFamily: "Georgia, serif",
      fontSize: 1.5,
      lineHeight: 1.8,
      controlsFont: "system-ui, sans-serif",
      backgroundColor: "#123456",
      containerBackgroundColor: null,
      textColor: "#fedcba"
    })) {
      assert.deepEqual(configuration[name], value, name);
    }
    assert.ok(!["options", "appearance", "callbacks"].some((key) => key in configuration));
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const match of readme.matchAll(/^\|\s*`([a-zA-Z]+)`\s*\|/gm)) {
      assert.ok(match[1] in configuration, `Missing parameter: ${match[1]}`);
    }
    await page.locator("#copy-options").evaluate((button) => button.click());
    await page.waitForFunction(() => window.lastCopy?.startsWith("{"));
    assert.deepEqual(JSON.parse(await page.evaluate(() => lastCopy)), configuration);
    assert.ok(!Object.keys(configuration).some((key) => key.startsWith("preview")));
    await page.locator('[data-options-view="form"]').evaluate((button) => button.click());
    await page.locator("#reset-settings").evaluate((button) => button.click());
    assert.deepEqual(await root.evaluate((element) => ({ font: element.style.fontFamily, size: element.style.fontSize, bg: element.style.getPropertyValue("--by-view-bg") })), initial);
    assert.match(await frame.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).fontFamily), /monospace/);

    for (const button of await page.locator("[data-example]").all()) {
      await button.evaluate((element) => element.click());
      await page.waitForFunction(() => document.getElementById("render-status").textContent.startsWith("Rendered"));
      assert.equal(await frame.locator("[role=alert]:visible").count(), 0);
      assert.match(await page.locator("#metric-size").textContent(), /B$/);
    }
    const sourceEditor = page.locator("#source");
    const fileSource = await sourceEditor.inputValue();
    await page.evaluate(() => {
      window.originalFileText = File.prototype.text;
      File.prototype.text = function () {
        return new Promise((resolve) => {
          window.finishFileRead = resolve;
        });
      };
    });
    try {
      for (const action of ["edit", "restore", "sample"]) {
        await sourceEditor.fill(`${fileSource}\n`);
        await page.locator("#local-file").setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from(fileSource) });
        if (action === "edit") await sourceEditor.fill(`${fileSource}\n\n`);
        else if (action === "restore") await page.locator("#restore-source").click();
        else await page.locator("#reset").click();
        const expected = await sourceEditor.inputValue();
        await page.evaluate((text) => window.finishFileRead(text), "An obsolete file read");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(await sourceEditor.inputValue(), expected, "Late file reads preserve the newer source");
      }
    } finally {
      await page.evaluate(() => {
        File.prototype.text = window.originalFileText;
        delete window.finishFileRead;
        delete window.originalFileText;
      });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("container themes are scoped, independent, and compatible with legacy links", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent('<div id="outside" class="dark">Host</div><div id="first" data-theme="dark"></div><div id="second" class="light"></div><div id="third"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
    await page.evaluate(
      async (args) => {
        window.renderTheme = async (element) => {
          const controller = window.byLOGviewer(element, ...args);
          if (controller?.ready) await controller.ready;
        };
        for (const id of ["first", "second", "third"]) await renderTheme(document.getElementById(id));
      },
      ["INFO Local theme"]
    );
    const color = (id) => page.locator("#" + id).evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await color("first"), "rgb(39, 40, 34)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
    assert.equal(await page.locator("#first .byVIEWtoolbar").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted").trim()), "#75715e");
    await page.locator("#first .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#first").getAttribute("data-theme"), "light");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(
      await page
        .locator("#second")
        .getAttribute("class")
        .then((classes) => classes.split(/\s+/).includes("dark")),
      true
    );
    assert.equal(await page.locator("#second").getAttribute("data-theme"), null);
    assert.equal(await color("second"), "rgb(39, 40, 34)");
    await page.evaluate(async () => {
      const second = document.getElementById("second");
      second.dataset.theme = "light";
      await renderTheme(second);
    });
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.evaluate(() => {
      const first = document.getElementById("first");
      first.style.setProperty("--by-view-bg", "#123456");
    });
    assert.equal(await color("first"), "rgb(18, 52, 86)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.evaluate(() => document.getElementById("first").style.removeProperty("--by-view-bg"));
    assert.equal(requests.length, 0, "Container theme changes must not fetch stylesheets");

    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: legacyThemeCSS(route.request().url().includes(".dark.css") ? "dark" : "light"), contentType: "text/css" }));
    await page.evaluate(async () => {
      const second = document.getElementById("second");
      second.removeAttribute("data-theme");
      second.classList.remove("light", "dark");
      await new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.id = "byVIEWtheme";
        link.rel = "stylesheet";
        link.href = "https://legacy.test/log.light.css?cache=1#theme";
        link.onload = resolve;
        link.onerror = reject;
        document.head.appendChild(link);
      });
      await renderTheme(second);
      await renderTheme(document.getElementById("third"));
    });
    await page.locator("#second .byVIEWthemeToggle").click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("second")).backgroundColor === "rgb(39, 40, 34)");
    assert.equal(await color("third"), "rgb(39, 40, 34)");
    assert.equal(await color("first"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#first .byVIEWthemeToggle").getAttribute("aria-label"), "Switch to dark theme");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/log.dark.css?cache=1#theme");
    await page.evaluate(async () => {
      document.getElementById("byVIEWtheme").remove();
      await renderTheme(document.getElementById("second"));
    });
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#second").getAttribute("data-theme"), "dark");
    assert.equal(await color("third"), "rgb(250, 250, 245)");
  } finally {
    await browser.close();
  }
});

test("named palettes retain mode, isolate custom CSS, and meet High Contrast targets", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="outside">Host</div><div id="viewer"></div><div id="other" data-theme="dark"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
    await page.evaluate(
      async (args) => {
        window.renderPalette = async (id) => {
          const controller = window.byLOGviewer(document.getElementById(id), ...args);
          if (controller?.ready) await controller.ready;
        };
        await renderPalette("viewer");
        await renderPalette("other");
      },
      ["INFO Theme\nERROR Failed"]
    );
    const root = page.locator("#viewer");
    const background = () => root.evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await background(), "rgb(250, 250, 245)", "Default remains Monokai Light");
    for (const [palette, colors] of Object.entries({
      monokai: ["rgb(250, 250, 245)", "rgb(39, 40, 34)"],
      github: ["rgb(255, 255, 255)", "rgb(13, 17, 23)"],
      solarized: ["rgb(253, 246, 227)", "rgb(0, 43, 54)"],
      "high-contrast": ["rgb(255, 255, 255)", "rgb(0, 0, 0)"]
    })) {
      await root.evaluate((element, palette) => {
        element.dataset.theme = palette;
        element.classList.remove("light", "dark");
      }, palette);
      assert.equal(await background(), colors[0], palette);
      await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await root.getAttribute("data-theme"), palette);
      assert.equal(await background(), colors[1], palette);
      await page.evaluate(() => renderPalette("viewer"));
      assert.equal(await background(), colors[1], "Rendering preserves the palette and mode");
      await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await background(), colors[0]);
    }
    for (const mode of ["light", "dark"]) {
      await root.evaluate((element, mode) => {
        element.classList.toggle("dark", mode === "dark");
        element.classList.toggle("light", mode === "light");
      }, mode);
      await root.locator(".byVIEWcopy").focus();
      const measurements = await root.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color) => {
          const channels = color.startsWith("#")
            ? color
                .slice(1)
                .match(/../g)
                .map((part) => parseInt(part, 16))
            : color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number);
          const values = channels.map((channel) => channel / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
        const variables = [...style].filter((property) => property.startsWith("--by-")).map((property) => [property, style.getPropertyValue(property).trim()]);
        const backgrounds = [style.backgroundColor, ...variables.filter(([property]) => /-(?:alt|code-bg|add|remove)$/.test(property)).map(([, value]) => value)];
        const text = variables.filter(([property, value]) => /^#[0-9a-f]{6}$/i.test(value) && !/-(?:bg|border|alt|add|remove)$/.test(property));
        const button = getComputedStyle(element.querySelector(".byVIEWcopy"));
        return {
          text: text.flatMap(([property, value]) => backgrounds.map((bg) => ({ property, ratio: contrast(value, bg) }))),
          border: contrast(button.borderTopColor, style.backgroundColor),
          focus: contrast(button.outlineColor, style.backgroundColor),
          outline: parseFloat(button.outlineWidth)
        };
      });
      assert.ok(measurements.text.length >= 5);
      for (const { property, ratio } of measurements.text) assert.ok(ratio >= 7, mode + " " + property + ": " + ratio.toFixed(2));
      assert.ok(measurements.border >= 3);
      assert.ok(measurements.focus >= 3 && measurements.outline >= 2);
    }
    await root.evaluate((element) => {
      element.classList.add("light", "dark");
      element.dataset.theme = "github";
    });
    assert.equal(await background(), "rgb(13, 17, 23)", "Dark wins when both classes exist");
    await root.evaluate((element) => {
      element.dataset.theme = "light";
    });
    assert.equal(await background(), "rgb(250, 250, 245)", "Legacy mode aliases override classes");
    await page.addStyleTag({ content: '.byLOGdocument.light[data-theme="ocean"] { --by-view-bg: #f3f8fc; } .byLOGdocument.dark[data-theme="ocean"] { --by-view-bg: #102a43; }' });
    await root.evaluate((element) => {
      element.dataset.theme = "ocean";
      element.classList.remove("light", "dark");
    });
    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const link = document.createElement("link");
          link.id = "byVIEWtheme";
          link.rel = "stylesheet";
          link.href = "https://legacy.test/log.dark.css?cache=1#theme";
          link.onload = resolve;
          document.head.appendChild(link);
        })
    );
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(await background(), "rgb(250, 250, 245)", "An unclassified custom palette starts in Light");
    await root.locator(".byVIEWthemeToggle").click();
    assert.equal(await background(), "rgb(16, 42, 67)");
    assert.equal(await root.getAttribute("data-theme"), "ocean");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/log.dark.css?cache=1#theme");
    assert.equal(await page.locator("#other").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(39, 40, 34)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
  } finally {
    await browser.close();
  }
});

test("playground palettes and editable two-mode custom themes stay synchronized", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.lastCopy = text;
          }
        }
      })
    );
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname);
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    const frame = page.frames().find((candidate) => candidate.parentFrame());
    await frame.waitForSelector(".byVIEWtoolbar");
    const root = frame.locator(".byLOGdocument");
    const editor = page.locator("#custom-theme-css");
    const palette = page.locator("#preview-palette");
    const background = () => root.evaluate((element) => getComputedStyle(element).backgroundColor);
    const initialBackground = await background();
    const hostBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await palette.inputValue(), "monokai");
    await page.waitForFunction(() => document.getElementById("custom-theme-css").value.includes('.dark[data-theme="custom"]'));
    const defaults = await editor.inputValue();
    assert.ok(defaults.includes('.byLOGdocument.light[data-theme="custom"]'));
    await palette.selectOption("github");
    const setMode = (mode) =>
      page.evaluate((mode) => {
        const input = document.querySelector('#preview-theme, input[name="viewerTheme"][value="' + mode + '"], input[name="previewTheme"][value="' + mode + '"]');
        if (input.tagName === "SELECT") input.value = mode;
        else input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, mode);
    await setMode("dark");
    assert.equal(await background(), "rgb(13, 17, 23)");
    await root.locator(".byVIEWthemeToggle").click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("options-json").value).theme === "light");
    assert.equal(await palette.inputValue(), "github");
    assert.equal(await background(), "rgb(255, 255, 255)");
    for (const name of ["solarized", "high-contrast"]) {
      await palette.selectOption(name);
      assert.equal(await root.getAttribute("data-theme"), name);
      assert.ok((await editor.inputValue()).includes("--by-view-bg"));
      await setMode("dark");
      assert.equal(await background(), name === "solarized" ? "rgb(0, 43, 54)" : "rgb(0, 0, 0)");
    }
    await page.locator(".preview-appearance").evaluate((element) => {
      element.open = true;
    });
    const custom = '.byLOGdocument.light[data-theme="custom"] { --by-view-bg: #f3f8fc; }\n.byLOGdocument.dark[data-theme="custom"] { --by-view-bg: #102a43; }';
    await editor.fill(custom);
    await page.waitForFunction(() => document.getElementById("preview-palette").value === "custom");
    assert.equal(await background(), "rgb(16, 42, 67)");
    await setMode("light");
    assert.equal(await background(), "rgb(243, 248, 252)");
    await root.locator(".byVIEWthemeToggle").click();
    assert.equal(await root.getAttribute("data-theme"), "custom");
    assert.equal(await background(), "rgb(16, 42, 67)");
    await page.locator("#copy-theme").evaluate((button) => button.click());
    await page.waitForFunction(() => window.lastCopy?.includes('[data-theme="custom"]'));
    assert.equal(await page.evaluate(() => lastCopy), custom);
    const config = JSON.parse(await page.locator("#options-json").inputValue());
    assert.equal(config.theme, "dark");
    assert.equal(config.palette, "custom");
    assert.equal(config.customThemeCSS, custom);
    assert.ok(!("appearance" in config) && !("options" in config));
    await palette.selectOption("github");
    assert.equal(await background(), "rgb(13, 17, 23)");
    await palette.selectOption("custom");
    assert.equal(await editor.inputValue(), custom, "Preset changes retain the draft");
    assert.equal(await background(), "rgb(16, 42, 67)");
    await page.locator("#reset-settings, #reset-options").evaluate((button) => button.click());
    await page.waitForFunction(() => document.getElementById("preview-palette").value === "monokai");
    assert.equal(await editor.inputValue(), defaults);
    assert.equal(await background(), initialBackground);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), hostBackground);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("viewer defaults, optional tools, and copy feedback", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
    await page.setContent('<div id="viewer"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
    await page.evaluate(
      (args) => {
        window.renderUI = async (options = {}) => {
          const result = byLOGviewer(document.getElementById("viewer"), ...args, options);
          await result?.ready;
        };
      },
      [
        [
          { level: "INFO", message: "needle", extra: 1 },
          { level: "WARN", message: "other" }
        ]
      ]
    );
    await page.evaluate(() => renderUI());
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 1);
    assert.equal(await page.locator(".byVIEWactions :is(input, select, button):visible").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => renderUI({ fontSizeControls: false, statusBar: false }));
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    await page.evaluate(() => renderUI());
    for (const scale of [1, 1.5]) {
      for (const controlsSize of ["small", "regular", "large"]) {
        for (const font of ["ui-monospace, monospace", "Georgia, serif"]) {
          for (const mode of ["light", "dark"]) {
            const errors = await page.evaluate(
              async ({ scale, controlsSize, font, mode }) => {
                document.documentElement.style.fontSize = `${scale}rem`;
                const host = document.getElementById("viewer");
                host.dataset.theme = mode;
                host.style.setProperty("--by-view-controls-font", font);
                await renderUI({ controlsSize });
                const button = host.querySelector(".byVIEWthemeToggle");
                const rect = button.getBoundingClientRect();
                const style = getComputedStyle(button),
                  thumb = getComputedStyle(button, "::after");
                const innerWidth = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
                const innerHeight = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
                const position = (value, extent) => (value.endsWith("%") ? (parseFloat(value) * extent) / 100 : parseFloat(value));
                const centerX = rect.left + parseFloat(style.borderLeftWidth) + position(thumb.left, innerWidth);
                const centerY = rect.top + parseFloat(style.borderTopWidth) + position(thumb.top, innerHeight);
                const icons = [...button.querySelectorAll("svg")];
                const icon = icons[mode === "dark" ? 1 : 0].getBoundingClientRect();
                return [Math.abs(centerX - icon.x - icon.width / 2), Math.abs(centerY - icon.y - icon.height / 2), Math.abs(centerY - rect.y - rect.height / 2)];
              },
              { scale, controlsSize, font, mode }
            );
            assert.ok(
              errors.every((error) => error < 0.06),
              `${scale} ${controlsSize} ${font} ${mode}: ${errors}`
            );
          }
        }
      }
    }
    await page.evaluate(async () => {
      document.documentElement.style.fontSize = "";
      document.getElementById("viewer").style.removeProperty("--by-view-controls-font");
      await renderUI();
    });
    for (const mode of ["light", "dark"]) {
      await page.locator("#viewer").evaluate((element, mode) => {
        element.dataset.theme = mode;
      }, mode);
      await page.evaluate(() => renderUI({ toolbar: false, controlsPosition: "bottom", sorting: false, pagination: false, collapsible: false, details: false, lineNumbers: false, loadMore: false }));
      assert.equal(await page.locator("#viewer :is(button, input, select, summary):visible").count(), 0);
      assert.equal(await page.locator(".byVIEWtoolbar").count(), 0);
      assert.equal(await page.locator("#viewer").evaluate((element) => element.classList.contains("byVIEWbottom")), false);
      assert.match(await page.locator("#viewer").textContent(), /needle/);
    }
    await page.evaluate(() => renderUI({ batchSize: 1 }));
    assert.equal(await page.getByRole("button", { name: "Load more", exact: false }).isVisible(), true);
    await page.evaluate(() => renderUI({ batchSize: 1, loadMore: false }));
    assert.equal(await page.locator(".byLOGentry").count(), 2);
    assert.equal(await page.getByRole("button", { name: "Load more", exact: false }).isVisible(), false);
    await page.evaluate(() => renderUI({ credits: false }));
    assert.equal(await page.locator(".byVIEWinfo").count(), 0);
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    await page.evaluate(() => renderUI({ credits: false, themeToggle: false, fontSizeControls: false, copyButton: false }));
    assert.equal(await page.locator(".byVIEWtoolbar").count(), 0);
    await page.evaluate((options) => renderUI({ fontSizeControls: true, ...options }), { search: true, levelFilter: true, autoScrollControl: true, copyEntries: true, statusBar: true });
    assert.equal(await page.locator(".byVIEWfontSize").count(), 3);
    assert.equal(await page.locator(".byVIEWpanel > .byVIEWstatus:visible").count(), 1);
    assert.ok(await page.locator(".byVIEWpanel > .byVIEWstatus").evaluate((status) => parseFloat(getComputedStyle(status).borderBottomWidth) > 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Denied");
          }
        }
      });
    });
    await page.locator(".byVIEWcopy").click();
    await page.mouse.move(0, 0);
    await page.locator(".byVIEWcopy").evaluate((element) => element.blur());
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "error");
    assert.equal(await page.locator(".byVIEWcopy").textContent(), "Failed");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (value) => {
        window.copiedSource = value;
      };
    });
    await page.locator(".byVIEWcopy").click();
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "success");
    assert.match(await page.evaluate(() => copiedSource), /needle/);
  } finally {
    await browser.close();
  }
});

test("document and content backgrounds stay independent through theme and toolbar changes", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, channel: process.env.BROWSER_CHANNEL || "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
    await page.setContent('<div id="viewer" data-theme="light"></div><div id="neighbor" data-theme="light"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
    await page.evaluate(async () => {
      for (const id of ["viewer", "neighbor"]) {
        const result = byLOGviewer(document.getElementById(id), "INFO Ready");
        await result?.ready;
      }
    });
    const root = page.locator("#viewer");
    const neighbor = await page.locator("#neighbor").evaluate((element) => getComputedStyle(element).backgroundColor);
    await root.evaluate((element) => {
      element.style.setProperty("--by-view-document-bg", "transparent");
      element.style.setProperty("--by-view-container-bg", "#123456");
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#viewer .byVIEWcopy")).backgroundColor === "rgb(18, 52, 86)");
    for (const changeMode of [false, true]) {
      if (changeMode) await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await root.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
      assert.equal(await root.locator(".byVIEWpanel").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(18, 52, 86)");
      assert.equal(
        await root
          .locator(".byVIEWcopy")
          .first()
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(18, 52, 86)"
      );
      assert.equal(await root.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
    }
    assert.equal(await page.locator("#neighbor").evaluate((element) => getComputedStyle(element).backgroundColor), neighbor);
    await root.evaluate((element) => element.style.removeProperty("--by-view-container-bg"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#viewer .byVIEWcopy")).backgroundColor === "rgb(39, 40, 34)");
    assert.notEqual(
      await root
        .locator(".byVIEWcopy")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)"
    );
  } finally {
    await browser.close();
  }
});
