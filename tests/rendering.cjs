/*
 * File: tests/rendering.cjs
 * Desc: LOG library contracts using local renderer assets; playground checks live in playground.cjs.
 */

/* --- DEPENDENCIES --- */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

/* --- THEME FIXTURES --- */
// Caller-provided legacy stylesheets reuse the canonical palettes without distribution files.
const legacyThemeCSS = (theme) => {
  const css = require("node:fs").readFileSync(path.join(__dirname, "../log.css"), "utf8");
  const section = css.split(`/* --- ${theme.toUpperCase()} --- */`)[1];
  return `.byLOGdocument {${section.match(/\{([\s\S]*?)\}/)[1]}}`;
};

/* --- STANDALONE RENDERER --- */
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
    // This generated host exercises the library without reading the playground's index.html.
    await page.route("http://viewer.test/**", (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      if (/^log\.(light|dark)\.css$/.test(filename)) return route.fulfill({ body: legacyThemeCSS(filename.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (!filename || filename === "fixture.html")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="log.css"><script src="log.js"></script><div id="viewer" data-theme="light"></div>'
        });
      return route.fulfill({ path: path.join(__dirname, "..", filename), contentType: filename.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    await page.goto("http://viewer.test/fixture.html");
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

/* --- CONTAINER THEMES --- */
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

/* --- PALETTES AND CONTRAST --- */
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

/* --- CONTROLS AND CLIPBOARD FEEDBACK --- */
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
    await page.evaluate(() => renderUI({ controlsSize: "invalid" }));
    assert.equal(await page.locator(".byVIEWtoolbar").getAttribute("data-size"), "regular");
    for (const scale of [1, 1.5]) {
      for (const controlsSize of ["xs", "small", "regular", "large", "xl"]) {
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
                const transform = new DOMMatrixReadOnly(thumb.transform);
                const centerX = rect.left + parseFloat(style.borderLeftWidth) + position(thumb.left, innerWidth) + transform.m41 + parseFloat(thumb.width) / 2;
                const centerY = rect.top + parseFloat(style.borderTopWidth) + position(thumb.top, innerHeight) + transform.m42 + parseFloat(thumb.height) / 2;
                const icons = [...button.querySelectorAll("svg")];
                const icon = icons[mode === "dark" ? 1 : 0].getBoundingClientRect();
                const toolbarSize = parseFloat(getComputedStyle(host.querySelector(".byVIEWtoolbar")).fontSize);
                const expectedSize = { xs: 0.5, small: 0.7, regular: 0.875, large: 1, xl: 1.25 }[controlsSize] * parseFloat(getComputedStyle(document.documentElement).fontSize);
                return [Math.abs(centerX - icon.x - icon.width / 2), Math.abs(centerY - icon.y - icon.height / 2), Math.abs(centerY - rect.y - rect.height / 2), Math.abs(toolbarSize - expectedSize)];
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

/* --- DOCUMENT AND CONTENT SURFACES --- */
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

/* --- INTERACTION MOTION --- */
test("animation options preserve initial visibility and override system motion preferences", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.route("https://cdn.jsdelivr.net/**", (route) => (route.request().url().endsWith("fontawesome.min.css") ? route.fulfill({ body: "", contentType: "text/css" }) : route.abort()));
    await page.setContent('<div id="motion-viewer" data-theme="light"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
    await page.evaluate(() => {
      window.renderMotion = async (animations) => {
        window.motionController = byLOGviewer(document.getElementById("motion-viewer"), "INFO Ready", { animations });
        await motionController?.ready;
      };
    });
    await page.evaluate(() => renderMotion());
    const root = page.locator("#motion-viewer");
    assert.equal(await root.evaluate((element) => element.classList.contains("byVIEWmotion")), true);
    assert.equal(await root.evaluate((element) => getComputedStyle(element).opacity), "1");
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0, "Initial content does not animate");
    assert.equal(
      await root
        .locator("button")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration.split(",")[0]),
      "0.18s"
    );
    const disclosure = await root.evaluateHandle((element) => {
      const details = document.createElement("details");
      details.id = "motion-disclosure";
      details.innerHTML = "<summary>Details</summary><p>Already available content</p>";
      element.append(details);
      getComputedStyle(details, "::details-content").blockSize;
      return details;
    });
    await disclosure.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "0");
    const opening = await disclosure.evaluate(async (details) => {
      details.open = true;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Number(getComputedStyle(details, "::details-content").opacity);
    });
    assert.ok(opening > 0 && opening < 1, "A deliberate disclosure eases in even with reduced motion requested");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "1");
    await disclosure.evaluate((details) => {
      details.open = false;
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "0");
    assert.equal(await disclosure.evaluate((details) => details.open), false);
    await page.evaluate(() => renderMotion(false));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await root.evaluate((element) => element.classList.contains("byVIEWmotion")), false);
    assert.equal(
      await root
        .locator("button")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s"
    );
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0);
  } finally {
    await browser.close();
  }
});

/* --- INITIAL APPEARANCE --- */
test("appearance options override markup and preserve independent viewer state", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.setContent('<style>html{font-size:20px}</style><div id="appearance" class="host light" data-theme="light"></div><div id="neighbor" class="dark" data-theme="monokai" style="font-size:2rem">Neighbor</div>');

    await page.addStyleTag({ path: path.join(__dirname, "../log.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../log.js") });
    await page.evaluate(() => {
      window.appearanceTarget = document.getElementById("appearance");
      window.renderAppearance = async (options = {}) => {
        window.appearanceInstance = byLOGviewer(appearanceTarget, "INFO Ready", options);
        await appearanceInstance?.ready;
      };
    });
    const neighbor = await page.locator("#neighbor").evaluate((element) => element.outerHTML);
    await page.evaluate(() => renderAppearance({ theme: "dark", palette: "github", fontSize: 1.5, animations: false }));
    assert.deepEqual(
      await page
        .locator("#appearance")
        .evaluate((element) => [element.classList.contains("host"), element.classList.contains("dark"), element.classList.contains("light"), element.dataset.theme, element.style.fontSize, getComputedStyle(element).fontSize]),
      [true, true, false, "github", "1.5rem", "30px"]
    );
    const controls = page.locator("#appearance .byVIEWthemeToggle");
    assert.equal(await controls.getAttribute("aria-label"), "Switch to light theme");
    await controls.click();
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.classList.contains("light"), element.dataset.theme, element.style.fontSize]), [true, "github", "1.5rem"]);
    const buttonSize = await controls.evaluate((element) => getComputedStyle(element).fontSize);
    await page.getByRole("button", { name: "Increase text size", exact: true }).click();
    await page.evaluate(() => renderAppearance());
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.625rem");
    await page.getByRole("button", { name: "Reset text size", exact: true }).click();
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.5rem");
    assert.equal(await controls.evaluate((element) => getComputedStyle(element).fontSize), buttonSize);
    await page.evaluate(() => renderAppearance({ fontSize: 1.25 }));
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "25px");
    await page.getByRole("button", { name: "Increase text size", exact: true }).click();
    await page.getByRole("button", { name: "Reset text size", exact: true }).click();
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.25rem");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "30px", "The multiplier follows root text-size changes");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    for (const [fontSize, expected] of [
      ["1.25rem", 25],
      ["1.25em", 25],
      ["20px", 20],
      ["125%", 25],
      ["1px", 10],
      ["100px", 60],
      ["4em", 60]
    ]) {
      await page.evaluate((fontSize) => renderAppearance({ fontSize }), fontSize);
      assert.equal(await page.locator("#appearance").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)), expected, fontSize);
      const preset = await page.locator("#appearance").evaluate((element) => [element.style.fontSize, element.dataset.byViewDefaultFontSize]);
      assert.equal(preset[0], preset[1]);
      await page.getByRole("button", { name: expected === 60 ? "Decrease text size" : "Increase text size", exact: true }).click();
      await page.getByRole("button", { name: "Reset text size", exact: true }).click();
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), preset[0]);
    }
    await page.evaluate(() => {
      document.body.style.fontSize = "1.5rem";
      return renderAppearance({ fontSize: "1em" });
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "30px", "em remains relative to the parent");
    await page.evaluate(() => {
      document.body.style.fontSize = "";
      document.documentElement.style.fontSize = "24px";
      return renderAppearance({ fontSize: "100px" });
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "72px", "CSS values retain the rem limit when the root size changes");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    for (const [requested, expected] of [
      [-1, 0.5],
      [0, 0.5],
      [0.25, 0.5],
      [0.5, 0.5],
      [3, 3],
      [4, 3]
    ]) {
      await page.evaluate((fontSize) => renderAppearance({ fontSize }), requested);
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), `${expected}rem`);
      assert.equal(await page.locator("#appearance").evaluate((element) => element.dataset.byViewDefaultFontSize), `${expected}rem`);
      assert.equal(await page.getByRole("button", { name: "Decrease text size", exact: true }).isDisabled(), expected === 0.5);
      assert.equal(await page.getByRole("button", { name: "Increase text size", exact: true }).isDisabled(), expected === 3);
      await page.getByRole("button", { name: expected === 3 ? "Decrease text size" : "Increase text size", exact: true }).click();
      await page.getByRole("button", { name: "Reset text size", exact: true }).click();
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), `${expected}rem`);
    }
    await page.evaluate(() => {
      appearanceTarget.dataset.theme = "dark";
      appearanceTarget.classList.remove("dark");
      appearanceTarget.classList.add("light");
      return renderAppearance({ palette: "high-contrast", toolbar: false });
    });
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), getComputedStyle(element).colorScheme]), ["high-contrast", true, "dark"]);
    await page.evaluate(() => {
      appearanceTarget.dataset.theme = "dark";
      return renderAppearance({ theme: "light", toolbar: false });
    });
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), element.classList.contains("light")]), ["light", false, true]);
    await page.evaluate(() => renderAppearance({ theme: "dark", palette: "ocean", fontSize: 1.125, toolbar: false }));
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), element.style.fontSize]), ["ocean", true, "1.125rem"]);
    const preserved = await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]);
    await page.evaluate(() => renderAppearance());
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]), preserved);
    await page.evaluate(() => renderAppearance({ theme: null, palette: null, fontSize: null }));
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]), preserved, "Blank exported appearance fields retain the container settings");
    for (const options of [
      { theme: "sepia" },
      { palette: "dark" },
      { palette: "bad name" },
      { fontSize: NaN },
      { fontSize: Infinity },
      { fontSize: "wrong" },
      { fontSize: "inherit" },
      { fontSize: true },
      { theme: "light", palette: "github", fontSize: "1.25" }
    ]) {
      const before = await page.locator("#appearance").evaluate((element) => element.outerHTML);
      const name = await page.evaluate(async (options) => {
        try {
          await renderAppearance(options);
        } catch (error) {
          return error.name;
        }
      }, options);
      assert.equal(name, "RangeError");
      assert.equal(await page.locator("#appearance").evaluate((element) => element.outerHTML), before, "Invalid appearance must not replace the current document");
    }

    assert.equal(await page.locator("#neighbor").evaluate((element) => element.outerHTML), neighbor);
  } finally {
    await browser.close();
  }
});
