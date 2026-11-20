"use strict";
/*
 * File: log.js
 * Desc: Standalone LOG.view. No runtime dependencies.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 * https://github.com/byuwur/log.view
 * MIT License (see LICENSE).
 */
(function (global) {
  // ===== INITIALIZATION =====
  if (global.byLOGviewer?.initialized) return;

  // ===== METADATA =====
  byLOGviewer.VERSION = "2.3"; // 2026-11-20
  // Mirrored helpers are checked by code.view/.github/scripts/check-family.mjs.
  const componentName = "LOG.view";
  const themeFile = "log";
  const documentClass = "byLOGdocument";
  const contentSelector = ":scope > .byVIEWcontent";

  // ===== CONSTANTS =====
  const levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL", "UNKNOWN"];

  // ===== STATE =====
  const instances = new WeakMap();
  // ===== HELPERS =====
  const node = (tag, className = "", text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const button = (parent, text, label, action) => {
    const control = node("button", "", text);
    control.type = "button";
    control.title = label;
    control.setAttribute("aria-label", label);
    control.addEventListener("click", action);
    parent.appendChild(control);
    return control;
  };
  const copyButton = (parent, getText, label = "Copy source", text = "Copy") => {
    const control = button(parent, text, label, async () => {
      control.disabled = true;
      try {
        await navigator.clipboard.writeText(getText());
        control.textContent = "Copied!";
        control.dataset.state = "success";
      } catch {
        control.textContent = "Failed";
        control.dataset.state = "error";
        control.title = "Copy failed. Check clipboard access.";
      } finally {
        control.disabled = false;
      }
    });
    control.setAttribute("aria-live", "polite");
    const reset = () => {
      if (control.dataset.state === "error") return;
      delete control.dataset.state;
      control.textContent = text;
      control.title = label;
    };
    control.addEventListener("mouseleave", reset);
    control.addEventListener("focusout", reset);
    return control;
  };
  // Yield at a chunk boundary so input events and replacement renders can run.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const positive = (value, fallback, maximum) => (Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback);
  // ===== APPEARANCE =====
  const extraPalettes = new Set([
    "dracula",
    "darcula",
    "nord",
    "catppuccin",
    "catppuccin-frappe",
    "catppuccin-macchiato",
    "rose-pine",
    "rose-pine-moon",
    "gruvbox",
    "gruvbox-material",
    "tokyo-night",
    "tokyo-storm",
    "tokyo-moon",
    "one",
    "material",
    "material-ocean",
    "night-owl",
    "synthwave",
    "ayu",
    "everforest",
    "kanagawa",
    "selenized",
    "vscode",
    "monokai-dimmed",
    "discord",
    "slack",
    "bonyur",
    "sakura",
    "bubblegum",
    "candy",
    "rose-gold",
    "lavender",
    "cyberpunk",
    "sunset",
    "volcano",
    "amber",
    "terminal",
    "paper",
    "ink",
    "ocean",
    "forest",
    "mint",
    "ice",
    "sepia"
  ]);
  const warnedPalettes = new Set();
  const warnMissingThemes = (element, palette = element.dataset.theme) => {
    if (!extraPalettes.has(palette) || warnedPalettes.has(palette)) return;
    const document = element.ownerDocument;
    if (document.defaultView.getComputedStyle(document.documentElement).getPropertyValue(`--by-${themeFile}-themes-loaded`).trim() === "1") return;
    warnedPalettes.add(palette);
    console.warn(`${componentName}: Palette "${palette}" requires ${themeFile}.themes.css. Import it after ${themeFile}.css. https://${themeFile}.byuwur.co/`);
  };

  const getLocalTheme = (target) => {
    if (["light", "dark"].includes(target.dataset.theme)) return target.dataset.theme;
    if (target.classList.contains("dark")) return "dark";
    if (target.classList.contains("light")) return "light";
    return target.dataset.theme ? "light" : null;
  };

  const setLocalTheme = (element, mode, palette) => {
    element.classList.toggle("light", mode === "light");
    element.classList.toggle("dark", mode === "dark");
    if (palette != null) element.dataset.theme = palette;
    else if (["light", "dark"].includes(element.dataset.theme)) element.dataset.theme = mode;
  };

  // Explicit appearance options override markup; omitted values preserve the container's state.
  const applyAppearance = (element, options) => {
    const { theme, palette, fontSize } = options;
    if (theme != null && !["light", "dark"].includes(theme)) throw new RangeError("Theme must be light or dark.");
    if (palette != null && (typeof palette !== "string" || !/^[a-z][\w-]*$/i.test(palette) || ["light", "dark"].includes(palette))) throw new RangeError("Palette must be a CSS theme name; use theme for light or dark.");
    warnMissingThemes(element, palette ?? element.dataset.theme);
    const size = typeof fontSize === "number" ? `${Math.max(0.5, Math.min(3, fontSize))}rem` : typeof fontSize === "string" ? `clamp(0.5rem, ${fontSize}, 3rem)` : "";
    if (fontSize != null && (typeof fontSize === "number" ? !Number.isFinite(fontSize) : typeof fontSize !== "string" || !CSS.supports("font-size", size))) throw new RangeError("Font size must be a finite multiplier or a CSS size.");
    // Keep palette identity in data-theme while light/dark classes select its mode.
    if (theme != null || palette != null) setLocalTheme(element, theme ?? getLocalTheme(element) ?? "light", palette);
    return size;
  };

  const applyContentAppearance = (element, options, content) => {
    const size = applyAppearance(element, options);
    const previous = element.querySelector(contentSelector);
    content.style.fontSize = size || previous?.style.fontSize || "";
    content.dataset.byViewDefaultFontSize = size || previous?.dataset.byViewDefaultFontSize || "";
  };

  const syncMotion = (element, options) => {
    const enabled = options.animations !== false;
    const appear = enabled && Boolean(options.appearAnimation);
    element.classList.toggle("byVIEWmotion", enabled);
    element.classList.toggle("byVIEWappear", appear);
    return appear;
  };

  // ===== CONTROLS =====
  // Mirrored across the family so each viewer can run without a shared runtime.
  const createThemeButton = () => {
    const button = node("button", "byVIEWthemeToggle");
    button.type = "button";
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z"/></svg><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>';
    return button;
  };

  /**
   * Adds container light/dark controls, retaining legacy stylesheet links as a fallback.
   * @param {HTMLElement} element Viewer container and theme owner.
   * @param {HTMLElement} controls Toolbar control group.
   * @returns {{button: HTMLButtonElement, sync: Function}} Mounted theme control.
   */
  const appendThemeToggle = (element, controls) => {
    const themePattern = new RegExp(`^([^?#]*/)?${themeFile}\\.(light|dark)\\.css([?#].*)?$`, "i");
    const stylesheet = [document.getElementById("byVIEWtheme"), ...document.querySelectorAll('link[rel~="stylesheet"]')].find((link) => link && themePattern.test(link.getAttribute("href") || ""));
    const legacyTheme = () => (stylesheet?.isConnected ? (stylesheet.getAttribute("href") || "").match(themePattern) : null);
    const getTheme = () => getLocalTheme(element) || legacyTheme()?.[2].toLowerCase() || "light";
    const button = createThemeButton();
    const sync = () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      const toggles = !getLocalTheme(element) && legacyTheme() ? [button, ...document.querySelectorAll(`.${documentClass} > .byVIEWtoolbar > .byVIEWcontrols > .byVIEWthemeToggle`)] : [button];
      for (const toggle of toggles) {
        // A legacy link must not change the controls of independently themed viewers.
        if (toggle !== button && getLocalTheme(toggle.closest(`.${documentClass}`))) continue;
        toggle.title = `Switch to ${next} theme`;
        toggle.setAttribute("aria-label", toggle.title);
      }
    };
    button.addEventListener("click", () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      if (!getLocalTheme(element) && legacyTheme()) {
        const href = stylesheet.getAttribute("href");
        stylesheet.setAttribute(
          "href",
          href.replace(themePattern, (_, path = "", theme, suffix = "") => `${path}${themeFile}.${next}.css${suffix}`)
        );
      } else {
        // Preserve attribute-only themes and keep existing mode classes in sync.
        const palette = element.dataset.theme;
        if (!element.matches(".light, .dark") && (!palette || ["light", "dark"].includes(palette))) element.dataset.theme = next;
        else setLocalTheme(element, next, palette === "" ? next : undefined);
      }
      sync();
    });
    button.addEventListener("focus", sync);
    button.addEventListener("pointerenter", sync);
    sync();
    controls.appendChild(button);
    return { button, sync };
  };

  /**
   * Adds text size controls for a renderer.
   * @param {HTMLElement} element - Renderer whose font size is changed.
   * @param {HTMLElement} controls - Toolbar that receives the controls.
   * @return {{group: HTMLElement, sync: Function}} Mounted text size controls.
   */
  const appendFontSizeControls = (element, controls) => {
    const sizes = document.createElement("div");
    sizes.className = "byVIEWfontSizes";
    controls.appendChild(sizes);
    const getSize = () => (parseFloat(getComputedStyle(element).fontSize) || 16) / (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const decrease = document.createElement("button");
    const increase = document.createElement("button");
    const reset = document.createElement("button");
    reset.textContent = "A";
    decrease.textContent = "A-";
    increase.textContent = "A+";
    for (const [button, title] of [
      [decrease, "Decrease text size"],
      [reset, "Reset text size"],
      [increase, "Increase text size"]
    ]) {
      button.type = "button";
      button.className = "byVIEWfontSize";
      button.title = title;
      button.setAttribute("aria-label", title);
      sizes.appendChild(button);
    }
    const sync = () => {
      const size = getSize();
      decrease.disabled = size <= 0.5;
      increase.disabled = size >= 3;
    };
    for (const [button, step] of [
      [decrease, -0.125],
      [increase, 0.125]
    ]) {
      button.addEventListener("click", () => {
        const size = Math.max(0.5, Math.min(3, getSize() + step));
        element.style.fontSize = `${size}rem`;
        sync();
      });
    }
    reset.addEventListener("click", () => {
      element.style.fontSize = element.dataset.byViewDefaultFontSize;
      sync();
    });
    sync();
    return { group: sizes, sync };
  };

  /**
   * Add a copy action for the complete source, including content outside the visible rendered chunk.
   * @param {HTMLElement} controls Toolbar control group.
   * @param {Function} getText Callback that returns the text to copy.
   * @param {string} label Human-readable label.
   * @returns {void}
   */
  const appendCopyButton = (controls, getText, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "byVIEWcopy";
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" aria-hidden="true" focusable="false"><!--!Font Awesome Free 7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M288 64C252.7 64 224 92.7 224 128L224 384C224 419.3 252.7 448 288 448L480 448C515.3 448 544 419.3 544 384L544 183.4C544 166 536.9 149.3 524.3 137.2L466.6 81.8C454.7 70.4 438.8 64 422.3 64L288 64zM160 192C124.7 192 96 220.7 96 256L96 512C96 547.3 124.7 576 160 576L352 576C387.3 576 416 547.3 416 512L416 496L352 496L352 512L160 512L160 256L176 256L176 192L160 192z"/></svg>`;
    const caption = document.createElement("span");
    caption.setAttribute("aria-live", "polite");
    button.appendChild(caption);
    const reset = () => {
      if (button.dataset.state === "error") return;
      delete button.dataset.state;
      caption.textContent = "Copy";
      button.title = label;
      button.setAttribute("aria-label", label);
    };
    reset();
    button.addEventListener("mouseleave", reset);
    button.addEventListener("focusout", reset);
    controls.appendChild(button);
    button.addEventListener("click", async (event) => {
      button.disabled = true;
      let message = "Copied!";
      try {
        await navigator.clipboard.writeText(getText(event));
        caption.textContent = message;
        button.dataset.state = "success";
      } catch {
        caption.textContent = "Failed";
        button.dataset.state = "error";
        message = "Copy failed. Check clipboard access.";
      } finally {
        button.disabled = false;
        button.title = `${message} ${label}`;
        button.setAttribute("aria-label", button.title);
      }
    });
    return button;
  };

  // Keep the toolbar mounted while the current renderer applies option changes.
  const mountControls = (element, content, initialOptions, getText, version, copyLabel = "Copy source") => {
    const toolbar = node("div", "byVIEWtoolbar");
    const controls = node("div", "byVIEWcontrols");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Viewer controls");
    const info = node("small", "byVIEWinfo");
    for (const [text, href] of [
      [componentName, `https://github.com/byuwur/${themeFile}.view`],
      ["@byUwUr", "https://byuwur.co"]
    ]) {
      const link = node("a", "", text);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (info.childNodes.length) info.append(` · v${version} · `);
      info.appendChild(link);
    }
    const theme = appendThemeToggle(element, controls);
    const sizes = appendFontSizeControls(content, controls);
    const copy = appendCopyButton(controls, getText, copyLabel);
    const update = (options, changes = {}) => {
      if ("fontSize" in changes || "theme" in changes || "palette" in changes) {
        applyContentAppearance(element, changes, content);
        theme.sync();
        sizes.sync();
      }
      Object.assign(options, changes);
      if ("animations" in changes || "appearAnimation" in changes) syncMotion(element, options);
      element.classList.toggle("byVIEWcompact", options.controlsCompact !== false);
      const bottom = options.controlsPosition === "bottom";
      toolbar.dataset.size = ["xs", "small", "regular", "large", "xl"].includes(options.controlsSize) ? options.controlsSize : "regular";
      if (!toolbar.childElementCount || ["credits", "themeToggle", "fontSizeControls", "copyButton"].some((key) => key in changes)) {
        controls.replaceChildren();
        if (options.themeToggle !== false) controls.appendChild(theme.button);
        if (options.fontSizeControls !== false) controls.appendChild(sizes.group);
        if (options.copyButton !== false) controls.appendChild(copy);
        toolbar.replaceChildren();
        if (options.credits !== false) toolbar.appendChild(info);
        if (controls.childElementCount) toolbar.appendChild(controls);
      }
      const visible = options.toolbar !== false && toolbar.childElementCount > 0;
      element.classList.toggle("byVIEWbottom", visible && bottom);
      if (!visible) toolbar.remove();
      else if (bottom && toolbar !== element.lastElementChild) element.appendChild(toolbar);
      else if (!bottom && toolbar !== element.firstElementChild) element.prepend(toolbar);
    };
    update(initialOptions);
    return update;
  };

  // ===== PARSING =====
  // Map recognized severity aliases; unknown formats remain explicitly UNKNOWN.
  const normalizeLevel = (value) => {
    const level = String(value ?? "").toUpperCase();
    if (level === "WARNING") return "WARN";
    if (level === "CRITICAL") return "FATAL";
    return levels.includes(level) ? level : "UNKNOWN";
  };
  // Serialize log details safely; distinguish ancestor cycles from repeated sibling references.
  const stringify = (value) => {
    const ancestors = [];
    return (
      JSON.stringify(
        value,
        function (key, entry) {
          if (typeof entry === "bigint") return entry.toString();
          if (!entry || typeof entry !== "object") return entry;
          // Drop finished branches so reusing an object in a sibling does not falsely report a cycle.
          while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
          if (ancestors.includes(entry)) return "[Circular]";
          ancestors.push(entry);
          return entry;
        },
        2
      ) ?? String(value)
    );
  };
  // Recognize structured records or leading metadata; malformed JSON remains an ordinary message.
  const defaultParse = (input) => {
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (trimmed.startsWith("{")) {
        try {
          const object = JSON.parse(input);
          if (object && typeof object === "object" && !Array.isArray(object)) return defaultParse(object);
        } catch {
          // Non-JSON logs remain ordinary text.
        }
      }
      const timestamp = input.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/);
      const rest = timestamp ? input.slice(timestamp[0].length) : input;
      // Only leading metadata changes severity; words such as ERROR inside the message remain ordinary text.
      const severity = rest.match(/^\s*\[?(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\]?(?=\s|:|$)[:\s]*/i);
      return {
        level: severity?.[1],
        timestamp: timestamp?.[1] ?? "",
        message: severity ? rest.slice(severity[0].length) : rest
      };
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Log entries must be strings or records.");
    const { level, severity, timestamp, time, message, msg, ...details } = input;
    return {
      level: level ?? severity,
      timestamp: timestamp ?? time ?? "",
      message: message ?? msg ?? "(structured entry)",
      details: Object.keys(details).length ? details : undefined
    };
  };
  // Split complete text batches into entries; array strings preserve multiline events as one entry.
  const logInputs = (input) => {
    if (typeof input === "string") {
      if (input.length > 10000000) throw new RangeError("Log text exceeds 10 million characters.");
      if (!input) return [];
      const lines = input.replace(/\r\n?/g, "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length > 100000) throw new RangeError("A batch exceeds 100,000 log entries.");
      return lines;
    }
    // Array entries are complete events, so embedded newlines must not split stack traces.
    if (Array.isArray(input)) {
      if (input.length > 100000) throw new RangeError("A batch exceeds 100,000 log entries.");
      return input;
    }
    if (input && typeof input === "object") return [input];
    throw new TypeError("Log input must be text, a record, or an array of entries.");
  };

  // ===== LIFECYCLE =====
  // Replace the previous owner and return its cancellable state. Only the current owner may clear the host.
  const mount = (element, options, getText) => {
    if (!(element instanceof HTMLElement)) throw new TypeError("byLOGviewer: element must be an HTMLElement.");
    // Validate appearance before disposing the current instance, so invalid options leave it usable.
    const content = node("div", "byVIEWcontent");
    applyContentAppearance(element, options, content);
    const painted = element.classList.contains("byVIEWready");
    instances.get(element)?.destroy();
    const state = { active: true, getText, content, api: {} };
    state.destroy = () => {
      if (!state.active) return;
      state.active = false;
      cancelAnimationFrame(state.motionFrame);
      // An old controller must not clear a replacement mounted on the same element.
      if (instances.get(element) === state) {
        instances.delete(element);
        element.replaceChildren();
        element.classList.remove(documentClass, "byVIEWplain", "byVIEWcompact", "byVIEWbottom", "byVIEWmotion", "byVIEWappear", "byVIEWready");
        element.removeAttribute("aria-busy");
      }
    };
    instances.set(element, state);
    state.error = (error) => {
      if (!state.active) return;
      element.setAttribute("aria-busy", "false");
      const message = node("p", "byVIEWerror", error.message);
      message.setAttribute("role", "alert");
      content.replaceChildren(message);
    };
    element.replaceChildren();
    element.classList.add(documentClass);
    element.classList.toggle("byVIEWplain", options.displayContainer === false);
    const appear = syncMotion(element, options);
    if (painted && !appear) element.classList.add("byVIEWready");
    else {
      // Paint opacity 0 before starting each requested fade.
      element.classList.remove("byVIEWready");
      state.motionFrame = requestAnimationFrame(() => {
        state.motionFrame = requestAnimationFrame(() => {
          if (state.active) element.classList.add("byVIEWready");
        });
      });
    }
    element.appendChild(content);
    state.updateControls = mountControls(element, content, options, (event) => instances.get(element).getText(event), byLOGviewer.VERSION);
    return state;
  };

  // ===== PUBLIC API =====
  // Render log text/records. append() queues batches in order; disposal cancels unfinished batches.
  function byLOGviewer(element, input, options = {}) {
    options = { layout: "inline", batchSize: 200, maxEntries: 10000, ...options };
    options.batchSize = positive(options.batchSize, 200, 1000);
    options.maxEntries = positive(options.maxEntries, 10000, 100000);
    if (options.parser !== undefined && typeof options.parser !== "function") throw new TypeError("parser must be a function.");
    if (input === undefined) input = element?.textContent ?? "";
    let entries = [],
      filtered = [],
      shown = options.batchSize,
      generation = 0,
      nextIndex = 0;
    const state = mount(element, options, () => entries.map((entry) => entry.raw).join("\n"));
    const actions = node("div", "byVIEWactions");
    const search = node("input");
    search.type = "search";
    search.placeholder = "Search logs";
    search.setAttribute("aria-label", "Search logs");

    const severity = node("select");
    severity.setAttribute("aria-label", "Filter severity");
    for (const value of ["ALL", ...levels]) {
      const option = node("option", "", value);
      option.value = value;
      severity.appendChild(option);
    }

    const followLabel = node("label");
    const follow = node("input");
    follow.type = "checkbox";
    follow.checked = Boolean(options.autoScroll);
    followLabel.append(follow, " Auto-scroll");
    const updateActions = () => {
      actions.replaceChildren();
      if (options.search) actions.appendChild(search);
      if (options.levelFilter) actions.appendChild(severity);
      if (options.autoScrollControl) actions.appendChild(followLabel);
    };
    updateActions();
    const status = node("p", "byVIEWstatus", "Loading...");
    status.setAttribute("role", "status");
    const list = node("div", "byLOGentries");
    list.dataset.layout = options.layout === "stacked" ? "stacked" : "inline";
    list.tabIndex = 0;
    list.setAttribute("role", "region");
    list.setAttribute("aria-label", "Log entries");
    const more = button(state.content, "Load more", "Load more entries", () => {
      shown += options.batchSize;
      render();
    });
    const panel = node("div", "byVIEWpanel");
    panel.append(status, list);
    state.content.replaceChildren(actions, panel, more);
    // ===== RENDERING =====
    const render = () => {
      if (!state.active) return;
      const fragment = document.createDocumentFragment();
      const openDetails = new Set(Array.from(list.querySelectorAll("details[open]"), (details) => details.dataset.entry));
      const selected = options.loadMore === false ? filtered : follow.checked ? filtered.slice(-shown) : filtered.slice(0, shown);
      for (const entry of selected) {
        const article = node("article", `byLOGentry byLOG${entry.level}`);
        const heading = node("div", "byLOGheading");
        if (entry.timestamp !== "") heading.appendChild(node("span", "byLOGtime", entry.timestamp));
        heading.appendChild(node("strong", "byLOGlevel", entry.level));
        if (options.copyEntries) copyButton(heading, () => entry.raw, "Copy log entry");
        article.append(heading, node("pre", "byLOGmessage", entry.message));
        if (entry.details !== undefined && options.details !== false) {
          const details = node("details");
          details.dataset.entry = String(entry.index);
          details.open = openDetails.has(details.dataset.entry);
          details.append(node("summary", "", "Details"), node("pre", "byLOGdetails", entry.details));
          article.appendChild(details);
        }
        fragment.appendChild(article);
      }
      list.replaceChildren(fragment);
      more.hidden = options.loadMore === false || shown >= filtered.length;
      state.syncStatus = () => {
        status.hidden = options.statusBar === false && filtered.length > 0;
      };
      state.syncStatus();
      status.textContent = !filtered.length ? "No matching entries." : `${selected.length} displayed · ${filtered.length} matching · ${entries.length} retained`;
      element.setAttribute("aria-busy", "false");
      if (follow.checked) list.scrollTop = list.scrollHeight;
    };
    // Filter the retained history cooperatively; a newer query owns the eventual DOM update.
    const refresh = async () => {
      // Append and search can overlap while yielding; only the newest filter result may publish.
      const version = ++generation;
      const query = search.value.toLowerCase();
      const matches = [];
      element.setAttribute("aria-busy", "true");
      for (let i = 0; i < entries.length; i++) {
        if ((severity.value === "ALL" || entries[i].level === severity.value) && (!query || entries[i].search.includes(query))) matches.push(entries[i]);
        if (i % 2000 === 0) {
          await pause();
          if (!state.active || generation !== version) return;
        }
      }
      if (!state.active || generation !== version) return;
      filtered = matches;
      render();
    };
    search.addEventListener("input", () => {
      shown = options.batchSize;
      refresh();
    });
    severity.addEventListener("change", () => {
      shown = options.batchSize;
      refresh();
    });
    follow.addEventListener("change", render);
    const error = node("p", "byVIEWerror");
    error.setAttribute("role", "alert");
    error.hidden = true;
    state.content.appendChild(error);
    // Serialize appends so parser indices and retained history follow the caller's batch order.
    let queue = Promise.resolve(true);
    // Queue one atomic batch. Parsing must finish before retained entries and parser indices advance.
    const append = (batch) => {
      queue = queue.then(async () => {
        if (!state.active) return false;
        try {
          const source = logInputs(batch),
            parsed = [];
          for (let i = 0; i < source.length; i++) {
            const value = (options.parser || defaultParse)(source[i], nextIndex + i);
            // A parser may discard an entry with null, while its input position still counts toward later parser indices.
            if (value !== null) {
              if (!value || typeof value !== "object" || typeof value.then === "function") throw new TypeError("parser must return a record or null synchronously.");
              const raw = typeof source[i] === "string" ? source[i] : stringify(source[i]);
              const message = typeof value.message === "string" ? value.message : stringify(value.message ?? "");
              const details = value.details === undefined ? undefined : typeof value.details === "string" ? value.details : stringify(value.details);
              const timestamp = String(value.timestamp ?? "");
              const level = normalizeLevel(value.level);
              parsed.push({
                index: nextIndex + i,
                raw,
                message,
                details,
                timestamp,
                level,
                search: `${raw}\n${message}\n${timestamp}\n${level}\n${details ?? ""}`.toLowerCase()
              });
            }
            if (i % 500 === 0) {
              await pause();
              if (!state.active) return false;
            }
          }
          // Advance history and parser indices only after the complete batch parses successfully.
          nextIndex += source.length;
          // Retain only the newest entries; the monotonic parser index remains independent of this window.
          entries = entries.concat(parsed).slice(-options.maxEntries);
          error.hidden = true;
          await refresh();
          return state.active;
        } catch (failure) {
          if (state.active) {
            error.textContent = failure.message;
            error.hidden = false;
            element.setAttribute("aria-busy", "false");
          }
          return false;
        }
      });
      return queue;
    };
    state.ready = append(input);
    Object.assign(state.api, {
      ready: state.ready,
      destroy: state.destroy,
      append,
      setOptions(changes) {
        if (!state.active) return;
        const next = { ...changes };
        if ("batchSize" in next) next.batchSize = positive(next.batchSize, 200, 1000);
        if ("maxEntries" in next) next.maxEntries = positive(next.maxEntries, 10000, 100000);
        if (next.parser !== undefined && typeof next.parser !== "function") throw new TypeError("parser must be a function.");
        state.updateControls(options, next);
        if ("displayContainer" in next) element.classList.toggle("byVIEWplain", next.displayContainer === false);
        if ("statusBar" in next) state.syncStatus?.();
        if ("layout" in next) list.dataset.layout = next.layout === "stacked" ? "stacked" : "inline";
        if ("autoScroll" in next) follow.checked = next.autoScroll;
        if ("batchSize" in next) shown = options.batchSize;
        if ("maxEntries" in next) entries = entries.slice(-options.maxEntries);
        if ("search" in next || "levelFilter" in next || "autoScrollControl" in next) {
          if (!options.search) search.value = "";
          if (!options.levelFilter) severity.value = "ALL";
          updateActions();
        }
        if (["search", "levelFilter", "maxEntries"].some((key) => key in next)) return refresh();
        if (["copyEntries", "details", "loadMore", "batchSize", "autoScroll"].some((key) => key in next)) render();
      }
    });
    return state.api;
  }

  byLOGviewer.parse = (input) => {
    const entry = defaultParse(input);
    return { ...entry, level: normalizeLevel(entry.level) };
  };
  // ===== EXPORT =====
  global.byLOGviewer = byLOGviewer;
  byLOGviewer.initialized = true;
})(typeof window !== "undefined" ? window : this);
