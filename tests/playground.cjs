/*
 * File: tests/playground.cjs
 * Desc: LOG playground configuration, previews, and exports; library checks live in rendering.cjs.
 */

// --- DEPENDENCIES ---
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

// Read the displayed source without line numbers or status text.
const readStarter = async (page) => {
  await page.locator('#integration-code[aria-busy="false"]').waitFor();
  return (await page.locator("#integration-code .byCODEtext").allTextContents()).join("\n");
};

// --- THEME FIXTURES ---
// Caller-provided legacy stylesheets reuse the canonical palettes without distribution files.
const legacyThemeCSS = (theme) => {
  const css = require("node:fs").readFileSync(path.join(__dirname, "../log.css"), "utf8");
  const section = css.split(`/* --- ${theme.toUpperCase()} --- */`)[1];
  return `.byLOGdocument {${section.match(/\{([\s\S]*?)\}/)[1]}}`;
};

// --- PLAYGROUND ASSETS ---
let bootstrapCSS;
const getBootstrapCSS = () =>
  (bootstrapCSS ??= (async () => {
    if (process.env.BOOTSTRAP_CSS_PATH) return require("node:fs/promises").readFile(process.env.BOOTSTRAP_CSS_PATH, "utf8");
    const response = await fetch("https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.7/css/bootstrap.min.css");
    assert.ok(response.ok, "Unable to load pinned Bootstrap CSS");
    return response.text();
  })());

// --- PLAYGROUND AND STARTER EXPORTS ---
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
      if (route.request().url() === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.7/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      const url = new URL(route.request().url());
      if (["https://cdn.jsdelivr.net/gh/byuwur/easy-code-viewer@v1.7/code.min.css", "https://cdn.jsdelivr.net/gh/byuwur/easy-code-viewer@v1.7/code.min.js"].includes(url.href)) {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        assert.ok(response.ok, "Unable to load pinned CODE asset");
        return route.fulfill({ body: await response.text(), contentType: url.pathname.endsWith(".js") ? "text/javascript" : "text/css" });
      }
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname).replace(/\.min(?=\.(?:css|js)$)/, "");
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
    const starterViewer = page.locator("#integration-code.byCODEdocument");
    assert.equal(await page.evaluate(() => byCODEviewer.VERSION), "1.7");
    assert.equal(await starterViewer.getAttribute("data-theme"), "dark");
    await starterViewer.locator(".byCODEtext").first().waitFor();
    assert.ok((await starterViewer.locator(".byCODElineNumber").count()) > 0);
    assert.equal(await starterViewer.locator(".byVIEWtoolbar, button, input, select").count(), 0);
    assert.equal(await starterViewer.locator(".byVIEWstatus:visible").count(), 0);
    assert.deepEqual(await starterViewer.evaluate((element) => [element, element.querySelector(".byVIEWpanel"), element.querySelector(".byCODElineNumber")].map((node) => getComputedStyle(node).backgroundColor)), [
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)"
    ]);
    assert.ok((await starterViewer.locator(".byCODEtag").count()) > 0);
    assert.equal(await page.locator("#integration-code script").count(), 0);
    const starterTagColor = await starterViewer
      .locator(".byCODEtag")
      .first()
      .evaluate((token) => getComputedStyle(token).color);
    await page.locator("#site-theme").click();
    assert.equal(await starterViewer.getAttribute("data-theme"), "light");
    assert.notEqual(
      await starterViewer
        .locator(".byCODEtag")
        .first()
        .evaluate((token) => getComputedStyle(token).color),
      starterTagColor
    );
    await page.locator("#site-theme").click();
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const extension of ["css", "js"]) assert.ok(readme.includes(`${cdnBase}log.min.${extension}`), "README assets must match the CDN starter");
    assert.equal(await page.locator("#install-note").textContent(), "CDN follows the latest release; updates may take time to reach caches.");
    assert.ok((await readStarter(page)).includes(`href="${cdnBase}log.min.css"`));
    assert.equal(await page.locator('[data-install="cdn"]').getAttribute("aria-pressed"), "true");
    await page.locator('[data-install="local"]').click();
    const starter = await readStarter(page);
    assert.match(starter, /^ {2}<head>$/m);
    assert.match(starter, /^ {4}<script>$/m);
    assert.match(starter, /^ {6}document\.addEventListener\("DOMContentLoaded", \(\) => \{$/m);
    assert.match(starter, /^ {12}"toolbar": true,/m);
    await page.evaluate(() => {
      window.successfulClipboardWrite = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async () => {
        throw new Error("Denied");
      };
    });
    await page.locator("#copy-html").click();
    await page.waitForFunction(() => document.querySelector("#copy-html span").textContent === "Failed");
    assert.equal(
      await page.locator("#integration-code").evaluate((element) => document.activeElement === element && document.getSelection().toString() === [...element.querySelectorAll(".byCODEtext")].map((line) => line.textContent).join("\n")),
      true
    );
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
    assert.equal(await readStarter(page), starter);
    await page.locator("#copy-html").click();
    assert.equal(await page.evaluate(() => copiedHTML), starter);
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download-html").click()]);
    assert.equal(await require("node:fs/promises").readFile(await download.path(), "utf8"), starter);
    const exported = await browser.newPage();
    await exported.route("https://viewer.test/**", (route) => {
      const file = path.basename(new URL(route.request().url()).pathname).replace(/\.min(?=\.(?:css|js)$)/, "");
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
    const cdnStarter = await readStarter(page);
    assert.equal(cdnStarter.replaceAll(cdnBase, "").replace(/\.min(?=\.(?:css|js)")/g, ""), starter, "Only asset paths change between modes");
    assert.ok(cdnStarter.includes('href="' + cdnBase + 'log.min.css"'));
    assert.ok(cdnStarter.includes('src="' + cdnBase + 'log.min.js"'));
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
      if ([cdnBase + "log.min.css", cdnBase + "log.min.js"].includes(url)) {
        cdnRequests.push(url);
        return route.fulfill({ path: path.join(__dirname, "..", path.basename(new URL(url).pathname).replace(/\.min(?=\.(?:css|js)$)/, "")), contentType: url.endsWith(".js") ? "text/javascript" : "text/css" });
      }
      return route.abort();
    });
    await cdnPage.goto("https://viewer.test/cdn-starter.html");
    await cdnPage.waitForFunction(() => document.querySelector(".byVIEWtoolbar") && document.getElementById("viewer").getAttribute("aria-busy") !== "true");
    assert.equal(await cdnPage.locator("[role=alert]:visible").count(), 0);
    assert.deepEqual(cdnRequests.sort(), [cdnBase + "log.min.css", cdnBase + "log.min.js"]);
    await cdnPage.close();
    await page.locator('[data-install="local"]').click();
    assert.equal(await readStarter(page), starter);
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

// --- CONFIGURATION AND FAMILY NAVIGATION ---
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
      if (route.request().url() === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.7/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      const url = new URL(route.request().url());
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname).replace(/\.min(?=\.(?:css|js)$)/, "");
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
    await page.locator("#config-panel").evaluate((panel) => panel.classList.add("active"));
    for (const width of [360, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(
        await page.locator("#controlsSize").evaluate((size) => {
          const a = size.querySelector(".btn-group").getBoundingClientRect();
          const position = document.getElementById("controlsPosition");
          const b = position.querySelector(".btn-group").getBoundingClientRect();
          const legend = position.querySelector("legend");
          return (
            Math.abs(a.top - b.top) < 1 &&
            Math.abs(size.getBoundingClientRect().width - 2 * position.getBoundingClientRect().width) < 1 &&
            a.right < b.left &&
            legend.textContent === "Position" &&
            legend.getBoundingClientRect().height <= parseFloat(getComputedStyle(legend).lineHeight) + 1 &&
            [...size.querySelectorAll("label")].every((label) => label.scrollWidth <= label.clientWidth + 1 && label.getBoundingClientRect().right <= a.right + 1)
          );
        }),
        true,
        "Size and position controls share a 2:1 row without wrapping"
      );
    }
    assert.deepEqual(
      await page
        .locator(".accordion-button")
        .allTextContents()
        .then((labels) => labels.map((label) => label.trim()).slice(0, 3)),
      ["Preview appearance", "Viewer controls", "Rendering"]
    );
    assert.deepEqual(await page.locator("#options-json").evaluate((editor) => Object.keys(JSON.parse(editor.value)).slice(0, 20)), [
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
      "animations",
      "appearAnimation",
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
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".preview-appearance"), "::details-content").opacity === "1");
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
    await frame.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).backgroundColor === "rgb(18, 52, 86)", ".byLOGdocument");
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
    for (const [size, rem] of [
      ["xs", 0.5],
      ["xl", 1.25]
    ]) {
      await page.locator(`label[for="controlsSize-${size}"]`).click();
      await frame.waitForFunction((size) => document.querySelector(".byVIEWtoolbar").dataset.size === size, size);
      assert.equal(await frame.locator(".byVIEWtoolbar").evaluate((toolbar) => parseFloat(getComputedStyle(toolbar).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize)), rem);
      await page.locator('[data-options-view="json"]').evaluate((button) => button.click());
      assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).controlsSize, size);
      await page.locator("#copy-options").evaluate((button) => button.click());
      await page.waitForFunction((size) => JSON.parse(window.lastCopy).controlsSize === size, size);
      await page.locator('[data-options-view="form"]').evaluate((button) => button.click());
    }
    await page.locator("#displayContainer").uncheck();
    await frame.waitForFunction(() => document.querySelector(".byVIEWplain"));
    assert.equal(await page.locator("#statusBar").isDisabled(), true);
    assert.equal(await page.locator("#statusBar").isChecked(), true);
    assert.equal(await frame.locator(".byVIEWstatus:visible").count(), 0);
    assert.equal(await frame.locator(".byVIEWpanel").evaluate((panel) => parseFloat(getComputedStyle(panel).borderTopWidth)), 0);
    assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).displayContainer, false);
    await page.locator("#copy-options").evaluate((button) => button.click());
    await page.waitForFunction(() => JSON.parse(window.lastCopy).displayContainer === false);
    await page.locator("#displayContainer").check();
    await frame.waitForFunction(() => !document.querySelector(".byVIEWplain"));
    assert.equal(await page.locator("#statusBar").isDisabled(), false);
    await frame.locator(".byVIEWpanel > .byVIEWstatus").waitFor({ state: "visible" });
    assert.equal(await frame.locator(".byVIEWpanel > .byVIEWstatus:visible").count(), 1);
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

// --- PALETTES AND CUSTOM THEME EDITING ---
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
      if (url.href === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.7/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname).replace(/\.min(?=\.(?:css|js)$)/, "");
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    const frame = page.frames().find((candidate) => candidate.parentFrame());
    await frame.waitForSelector(".byVIEWtoolbar");
    const root = frame.locator(".byLOGdocument");
    const editor = page.locator("#custom-theme-css");
    const palette = page.locator("#preview-palette");
    const background = () =>
      root.evaluate((element) => {
        for (const animation of element.getAnimations()) if (animation.transitionProperty === "background-color") animation.finish();
        return getComputedStyle(element).backgroundColor;
      });
    const headerSettings = page.locator('#credits, #themeToggle, #fontSizeControls, #copyButton, #controlsCompact, [name="controlsSize"], [name="controlsPosition"]');
    const selectedSettings = await headerSettings.evaluateAll((controls) => controls.map((control) => [control.value, control.checked]));
    await page.locator("#toolbar").uncheck();
    await page.waitForFunction(() => document.getElementById("credits").disabled);
    assert.equal(await headerSettings.evaluateAll((controls) => controls.every((control) => control.disabled)), true);
    assert.equal(await page.locator("#animations").isEnabled(), true, "Content motion is independent of the viewer header");
    if (await page.locator("#displayContainer").count()) assert.equal(await page.locator("#displayContainer").isEnabled(), true);
    assert.deepEqual(await headerSettings.evaluateAll((controls) => controls.map((control) => [control.value, control.checked])), selectedSettings);
    await page.locator("#toolbar").check();
    await page.waitForFunction(() => !document.getElementById("credits").disabled);
    assert.equal(await headerSettings.evaluateAll((controls) => controls.every((control) => !control.disabled)), true);
    assert.equal(await page.locator("#appearAnimation").isChecked(), false);
    await page.locator("#appearAnimation").check();
    await page.locator("#animations").uncheck();
    await page.waitForFunction(() => document.getElementById("appearAnimation").disabled);
    assert.equal(await page.locator("#appearAnimation").isChecked(), true, "Disabling motion preserves the entrance preference");
    await page.locator("#animations").check();
    await page.waitForFunction(() => !document.getElementById("appearAnimation").disabled);
    await page.locator("#appearAnimation").uncheck();
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
    assert.equal(await palette.locator("optgroup").count(), 5);
    assert.equal(await palette.locator("option").count(), 49);
    for (const [name, expected] of Object.entries({
      solarized: "rgb(0, 43, 54)",
      dracula: "rgb(40, 42, 54)",
      darcula: "rgb(43, 43, 43)",
      discord: "rgb(49, 51, 56)",
      sakura: "rgb(48, 28, 44)",
      bubblegum: "rgb(59, 11, 45)",
      terminal: "rgb(13, 26, 17)",
      "high-contrast": "rgb(0, 0, 0)"
    })) {
      await palette.selectOption(name);
      assert.equal(await root.getAttribute("data-theme"), name);
      assert.ok((await editor.inputValue()).includes("--by-view-bg"));
      await setMode("dark");
      assert.equal(await background(), expected);
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
