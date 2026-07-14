// ==UserScript==
// @name         Bionic Reading by Oxide (Apple Dark Mode)
// @namespace    https://github.com/bionic-reading-userscript
// @version      1.3.0
// @description  Bolds leading letters using saccadic rhythms with an Apple HIG Dark Mode control panel.
// @match        *://*/*
// @match        file:///*
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// ==/UserScript==

/*
 * OFFLINE / file:// NOTES
 * ------------------------
 * The file:///* match above only takes effect once Tampermonkey itself is
 * allowed to touch local files: chrome://extensions -> Tampermonkey ->
 * Details -> enable "Allow access to file URLs" (Chrome/Edge/Brave only -
 * Tampermonkey does not currently support this on Firefox). Also set
 * "Site access" to "On all sites" - Chrome has a known bug where scoping
 * it to specific sites silently breaks file:// injection.
 *
 * This will bold text on local .html files opened directly in the browser.
 * It will NOT reach text rendered inside the browser's own built-in PDF
 * viewer (Chrome's PDFium viewer or Firefox's built-in pdf.js): those
 * render the page as a privileged, isolated surface that no extension's
 * content/user scripts are permitted to inject into, regardless of @match.
 * A PDF opened through a normal web-hosted viewer (e.g. a pdf.js instance
 * served over http/https rather than the browser's native one) is just a
 * regular page and already works with the broad http(s) match above.
 */

(function () {
  'use strict';

  /* ============================== CONSTANTS ============================== */

  var SETTINGS_KEY = 'bnrd_settings_v1';
  var DISABLED_KEY = 'bnrd_disabled_sites_v1';

  var WRAP_CLASS = 'bnrd-wrap';
  var BOLD_CLASS = 'bnrd-b';
  var REST_CLASS = 'bnrd-r';
  var UI_ROOT_CLASS = 'bnrd-ui';

  var DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    ratio: 0.44,
    boldWeight: 700,
    dimUnbold: false,
    dimOpacity: 0.68,
    skipCode: true
  });

  var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'IFRAME', 'CANVAS', 'SVG', 'MATH', 'AUDIO', 'VIDEO', 'TITLE', 'HEAD', 'TEMPLATE'
  ]);
  var CODE_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'VAR']);

  var STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in',
    'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with',
    'or', 'but', 'if', 'we', 'you', 'they', 'this', 'not', 'can', 'do', 'so'
  ]);

  var WORD_RE = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;
  var ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var CHUNK_SIZE = 150;

  var FAB_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">' +
    '<rect x="2" y="4.5" width="9" height="3" rx="1.5" fill="currentColor"/>' +
    '<rect x="12.5" y="4.5" width="9.5" height="3" rx="1.5" fill="currentColor" opacity="0.42"/>' +
    '<rect x="2" y="10.5" width="7" height="3" rx="1.5" fill="currentColor"/>' +
    '<rect x="10.5" y="10.5" width="8" height="3" rx="1.5" fill="currentColor" opacity="0.42"/>' +
    '<rect x="2" y="16.5" width="8" height="3" rx="1.5" fill="currentColor"/>' +
    '<rect x="11.5" y="16.5" width="6.5" height="3" rx="1.5" fill="currentColor" opacity="0.42"/>' +
    '</svg>';

  var CLOSE_ICON_SVG =
    '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">' +
    '<path d="M4 4L16 16M16 4L4 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>';

  /* ============================== UTILITIES =============================== */

  function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, function (ch) { return ESCAPE_MAP[ch]; });
  }

  function hasLetter(str) { return /\p{L}/u.test(str); }

  function computeSmartBoldLength(word, ratio) {
    var len = word.length;
    if (len === 0) return 0;
    if (STOP_WORDS.has(word.toLowerCase())) return 0;
    if (len === 1 || len === 2 || len === 3) return 1;
    if (len === 4) return 2;
    var raw = Math.ceil(len * ratio);
    if (raw > len - 1) raw = len - 1;
    return raw;
  }

  function opacityToDimPercent(op) { return Math.round((1 - op) * 100); }
  function dimPercentToOpacity(pct) { return clamp(1 - (pct / 100), 0.4, 1); }

  var scheduleWork = (typeof requestIdleCallback === 'function')
    ? function (fn) { requestIdleCallback(fn, { timeout: 300 }); }
    : function (fn) { setTimeout(fn, 16); };

  /* ========================== SETTINGS STORAGE ============================ */

  function loadSettings() {
    var stored = {};
    try {
      var raw = GM_getValue(SETTINGS_KEY, null);
      if (raw) stored = JSON.parse(raw);
    } catch (err) { stored = {}; }
    var merged = Object.assign({}, DEFAULT_SETTINGS, stored);
    merged.ratio = clamp(Number(merged.ratio) || DEFAULT_SETTINGS.ratio, 0.25, 0.65);
    merged.dimOpacity = clamp(Number(merged.dimOpacity) || DEFAULT_SETTINGS.dimOpacity, 0.4, 1);
    merged.boldWeight = [500, 600, 700, 900].indexOf(Number(merged.boldWeight)) !== -1
      ? Number(merged.boldWeight) : DEFAULT_SETTINGS.boldWeight;
    merged.enabled = Boolean(merged.enabled);
    merged.dimUnbold = Boolean(merged.dimUnbold);
    merged.skipCode = Boolean(merged.skipCode);
    return merged;
  }

  function saveSettings(s) {
    try { GM_setValue(SETTINGS_KEY, JSON.stringify(s)); } catch (err) { }
  }

  function loadDisabledSites() {
    try {
      var raw = GM_getValue(DISABLED_KEY, null);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (err) { return []; }
  }

  function saveDisabledSites(arr) {
    try { GM_setValue(DISABLED_KEY, JSON.stringify(arr)); } catch (err) { }
  }

  function siteIsDisabled() { return disabledSites.indexOf(location.hostname) !== -1; }

  function toggleSiteDisabled() {
    var host = location.hostname;
    var idx = disabledSites.indexOf(host);
    if (idx === -1) disabledSites.push(host); else disabledSites.splice(idx, 1);
    saveDisabledSites(disabledSites);
  }

  /* ========================= BIONIC TEXT ENGINE ============================ */

  function buildWrapperHTML(text, ratio) {
    var html = '';
    var lastIndex = 0;
    WORD_RE.lastIndex = 0;
    var match;
    while ((match = WORD_RE.exec(text)) !== null) {
      var word = match[0];
      var start = match.index;
      if (start > lastIndex) html += escapeHtml(text.slice(lastIndex, start));
      if (hasLetter(word)) {
        var boldLen = computeSmartBoldLength(word, ratio);
        if (boldLen > 0) {
            var boldPart = word.slice(0, boldLen);
            var restPart = word.slice(boldLen);
            html += '<b class="' + BOLD_CLASS + '">' + escapeHtml(boldPart) + '</b>';
            if (restPart) html += '<span class="' + REST_CLASS + '">' + escapeHtml(restPart) + '</span>';
        } else {
            html += '<span class="' + REST_CLASS + '">' + escapeHtml(word) + '</span>';
        }
      } else {
        html += escapeHtml(word);
      }
      lastIndex = start + word.length;
      if (word.length === 0) WORD_RE.lastIndex++;
    }
    if (lastIndex < text.length) html += escapeHtml(text.slice(lastIndex));
    return html;
  }

  function processTextNode(node) {
    try {
      if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentNode) return;
      // Belt-and-suspenders: isContentEditable already reflects inherited
      // state, so checking just the immediate parent is enough to catch a
      // live caret-bearing node here too, however it got to this point.
      if (node.parentElement && node.parentElement.isContentEditable) return;
      var text = node.nodeValue;
      if (!text || !/\S/.test(text)) return;
      var html = buildWrapperHTML(text, settings.ratio);
      var wrapper = document.createElement('span');
      wrapper.className = WRAP_CLASS;
      wrapper.innerHTML = html;
      node.replaceWith(wrapper);
    } catch (err) { }
  }

  /* ============================ DOM TRAVERSAL =============================== */

  function elementShouldReject(el) {
    var tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return true;
    if (settings.skipCode && CODE_TAGS.has(tag)) return true;
    if (el.classList && (el.classList.contains(WRAP_CLASS) || el.classList.contains(UI_ROOT_CLASS))) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  }

  function nodeFilter(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return elementShouldReject(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue && /\S/.test(node.nodeValue)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_SKIP;
  }

  // A text node reached through collectTextNodes()'s TreeWalker has already
  // had every ancestor vetted by elementShouldReject (FILTER_REJECT skips
  // the whole subtree, so a rejected ancestor means we never see its
  // descendants at all). Text nodes reached through MutationObserver have
  // NOT had that check applied - the observer hands us the raw
  // mutated/added node directly, with no idea what container it lives in.
  // Without this check, typing into a contenteditable field (rich text
  // boxes, PDF annotation/comment fields, chat composers, etc.) fires a
  // characterData mutation on every keystroke; this script would then wrap
  // that live text node and node.replaceWith() it, detaching the exact
  // node the caret was anchored to - which is why the cursor kept jumping
  // to the start of the field. This walks up to catch that before any
  // wrapping happens.
  function textNodeEligible(node) {
    if (!node.nodeValue || !/\S/.test(node.nodeValue)) return false;
    var el = node.parentElement;
    while (el) {
      if (elementShouldReject(el)) return false;
      el = el.parentElement;
    }
    return true;
  }

  var knownShadowRoots = new Set();

  function collectTextNodes(root, list) {
    if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) knownShadowRoots.add(root);
    var walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, nodeFilter);
    } catch (err) { return; }
    var node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        list.push(node);
      } else if (node.shadowRoot) {
        collectTextNodes(node.shadowRoot, list);
      }
      node = walker.nextNode();
    }
  }

  function installShadowPatch() {
    if (typeof Element === 'undefined' || typeof Element.prototype.attachShadow !== 'function') return;
    var original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      var root = original.call(this, init);
      try {
        if (root && init && init.mode === 'open') {
          scheduleWork(function () { handleShadowRoot(root); });
        }
      } catch (err) { }
      return root;
    };
  }

  function handleShadowRoot(root) {
    if (knownShadowRoots.has(root)) return;
    knownShadowRoots.add(root);
    if (!active) return;
    var nodes = [];
    collectTextNodes(root, nodes);
    processInChunks(nodes);
    observeRoot(root);
  }

  /* ============================ BATCH SCHEDULER ============================= */

  function processInChunks(nodes) {
    var i = 0;
    function step() {
      var end = Math.min(i + CHUNK_SIZE, nodes.length);
      for (; i < end; i++) processTextNode(nodes[i]);
      if (i < nodes.length) scheduleWork(step);
    }
    step();
  }

  function applyBionicReading(root) {
    var nodes = [];
    collectTextNodes(root, nodes);
    processInChunks(nodes);
  }

  /* =========================== MUTATION OBSERVER ============================= */

  var observer = null;
  var observedRoots = new WeakSet();
  var mutationQueue = [];
  var mutationScheduled = false;

  function ensureObserver() {
    if (!observer) observer = new MutationObserver(handleMutations);
    return observer;
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    try {
      ensureObserver().observe(root, { childList: true, subtree: true, characterData: true });
    } catch (err) { }
  }

  function startAllObservers() {
    observeRoot(document.body);
    knownShadowRoots.forEach(observeRoot);
  }

  function stopObserver() {
    if (observer) { try { observer.disconnect(); } catch (err) { } }
    observedRoots = new WeakSet();
    mutationQueue = [];
    mutationScheduled = false;
  }

  function handleMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) mutationQueue.push(m.addedNodes[j]);
      } else if (m.type === 'characterData') {
        mutationQueue.push(m.target);
      }
    }
    if (!mutationScheduled) {
      mutationScheduled = true;
      scheduleWork(flushMutationQueue);
    }
  }

  function flushMutationQueue() {
    mutationScheduled = false;
    var batch = mutationQueue.splice(0);
    var nodes = [];
    for (var i = 0; i < batch.length; i++) {
      var n = batch[i];
      try {
        if (n.nodeType === Node.TEXT_NODE) {
          if (textNodeEligible(n)) nodes.push(n);
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          if (!elementShouldReject(n)) collectTextNodes(n, nodes);
        }
      } catch (err) { }
    }
    if (nodes.length) processInChunks(nodes);
  }

  /* ================================ REVERT ==================================== */

  function revertRoot(root) {
    try {
      var wraps = root.querySelectorAll('.' + WRAP_CLASS);
      for (var i = 0; i < wraps.length; i++) {
        try { wraps[i].replaceWith(document.createTextNode(wraps[i].textContent)); } catch (err) { }
      }
    } catch (err) { }
  }

  function revertAll() {
    revertRoot(document);
    knownShadowRoots.forEach(revertRoot);
  }

  /* ============================== STATE ENGINE ================================ */

  function startEngine() {
    if (!document.body) return;
    applyBionicReading(document.body);
    startAllObservers();
  }

  function stopEngine() {
    stopObserver();
    revertAll();
  }

  function syncActiveState(reprocessNeeded) {
    var wasActive = active;
    active = settings.enabled && !siteIsDisabled();
    if (active && !wasActive) {
      startEngine();
    } else if (!active && wasActive) {
      stopEngine();
    } else if (active && reprocessNeeded) {
      revertAll();
      applyBionicReading(document.body);
      knownShadowRoots.forEach(observeRoot);
    }
    updateFabState();
  }

  function applyCSSVariables() {
    var root = document.documentElement;
    root.style.setProperty('--bnrd-weight', String(settings.boldWeight));
    root.style.setProperty('--bnrd-dim-opacity', settings.dimUnbold ? String(settings.dimOpacity) : '1');
  }

  function onSettingsChanged(reprocessNeeded) {
    applyCSSVariables();
    syncPanelControls();
    refreshMenuCommands();
    syncActiveState(reprocessNeeded);
  }

  /* ================================ STYLES ===================================== */

  function buildCSS() {
    return '\n' +
      ':root{--bnrd-weight:700;--bnrd-dim-opacity:1;--bnrd-p-bg:rgba(28, 28, 30, 0.75);--bnrd-p-surface:rgba(44, 44, 46, 0.8);--bnrd-p-border:rgba(255, 255, 255, 0.15);--bnrd-p-text:#FFFFFF;--bnrd-p-text-muted:rgba(235, 235, 245, 0.6);--bnrd-p-accent:#0A84FF;--bnrd-p-track:rgba(120, 120, 128, 0.32)}\n' +
      '.bnrd-b{font-weight:var(--bnrd-weight) !important}\n' +
      '.bnrd-r{opacity:var(--bnrd-dim-opacity)}\n' +
      '.bnrd-ui,.bnrd-ui *{box-sizing:border-box}\n' +
      '.bnrd-ui{position:fixed;z-index:2147483647;right:22px;bottom:22px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;text-align:left;line-height:1.35;color-scheme:dark}\n' +
      '.bnrd-fab{width:46px;height:46px;border-radius:50%;border:1px solid var(--bnrd-p-border);background:var(--bnrd-p-bg);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);color:var(--bnrd-p-text);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 10px 24px rgba(0,0,0,0.4),0 2px 8px rgba(0,0,0,0.2);transition:transform 160ms cubic-bezier(.16,1,.3,1),box-shadow 160ms ease,background 160ms ease;padding:0}\n' +
      '.bnrd-fab:hover{transform:translateY(-1px) scale(1.03);background:var(--bnrd-p-surface)}\n' +
      '.bnrd-fab:active{transform:scale(.94)}\n' +
      '.bnrd-fab.bnrd-fab-inactive{color:var(--bnrd-p-text-muted)}\n' +
      '.bnrd-fab:focus-visible{outline:2px solid var(--bnrd-p-accent);outline-offset:3px}\n' +
      '.bnrd-panel{position:absolute;right:0;bottom:58px;width:min(320px,calc(100vw - 24px));border-radius:18px;border:1px solid var(--bnrd-p-border);background:var(--bnrd-p-bg);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:0 20px 48px rgba(0,0,0,0.5),0 4px 14px rgba(0,0,0,0.3);color:var(--bnrd-p-text);transform-origin:bottom right;transform:scale(.94) translateY(6px);opacity:0;pointer-events:none;transition:transform 180ms cubic-bezier(.16,1,.3,1),opacity 160ms ease;padding:18px;max-height:calc(100vh - 100px);overflow-y:auto}\n' +
      '.bnrd-panel[hidden]{display:none}\n' +
      '.bnrd-panel.bnrd-panel-open{transform:scale(1) translateY(0);opacity:1;pointer-events:auto}\n' +
      '.bnrd-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}\n' +
      '.bnrd-panel-title{font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0}\n' +
      '.bnrd-icon-btn{width:26px;height:26px;border-radius:13px;border:none;background:rgba(120, 120, 128, 0.16);color:var(--bnrd-p-text-muted);display:flex;align-items:center;justify-content:center;cursor:pointer}\n' +
      '.bnrd-icon-btn:hover{background:rgba(120, 120, 128, 0.32);color:var(--bnrd-p-text)}\n' +
      '.bnrd-icon-btn:focus-visible{outline:2px solid var(--bnrd-p-accent);outline-offset:2px}\n' +
      '.bnrd-row{padding:9px 0}\n' +
      '.bnrd-row-switch{display:flex;align-items:center;gap:10px}\n' +
      '.bnrd-row-text{flex:1;min-width:0}\n' +
      '.bnrd-row-label{font-size:14px;font-weight:400;letter-spacing:-0.01em}\n' +
      '.bnrd-hostname{font-weight:500;font-variant-numeric:tabular-nums;word-break:break-all}\n' +
      '.bnrd-row-disabled{opacity:.45;pointer-events:none}\n' +
      '.bnrd-divider{height:1px;background:var(--bnrd-p-border);margin:10px 0}\n' +
      '.bnrd-eyebrow{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--bnrd-p-text-muted);margin-bottom:6px}\n' +
      '.bnrd-row-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}\n' +
      '.bnrd-value{font-size:13px;font-variant-numeric:tabular-nums;color:var(--bnrd-p-text-muted);min-width:32px;text-align:right}\n' +
      '.bnrd-switch{position:relative;display:inline-flex;width:40px;height:24px;flex:none;cursor:pointer}\n' +
      '.bnrd-switch .bnrd-input{position:absolute;width:1px;height:1px;opacity:0;margin:0}\n' +
      '.bnrd-switch-track{position:absolute;inset:0;background:var(--bnrd-p-track);border-radius:999px;transition:background 200ms ease}\n' +
      '.bnrd-switch-thumb{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#ffffff;box-shadow:0 3px 8px rgba(0,0,0,.15),0 3px 1px rgba(0,0,0,.06);transition:transform 250ms cubic-bezier(.16,1,.3,1)}\n' +
      '.bnrd-input:checked + .bnrd-switch-track{background:var(--bnrd-p-accent)}\n' +
      '.bnrd-input:checked + .bnrd-switch-track .bnrd-switch-thumb{transform:translateX(16px)}\n' +
      '.bnrd-input:focus-visible + .bnrd-switch-track{outline:2px solid var(--bnrd-p-accent);outline-offset:2px}\n' +
      '.bnrd-range{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:999px;background:var(--bnrd-p-track);margin:0}\n' +
      '.bnrd-range::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#ffffff;box-shadow:0 2px 6px rgba(0,0,0,.3);cursor:pointer;margin-top:-6px}\n' +
      '.bnrd-range::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#ffffff;box-shadow:0 2px 6px rgba(0,0,0,.3);cursor:pointer;border:none}\n' +
      '.bnrd-range::-moz-range-track{height:6px;border-radius:999px;background:var(--bnrd-p-track)}\n' +
      '.bnrd-range:focus-visible{outline:2px solid var(--bnrd-p-accent);outline-offset:3px}\n' +
      '.bnrd-preview{margin-top:12px;padding:10px;border-radius:10px;background:rgba(120, 120, 128, 0.16);font-size:15px;text-align:center;border:1px solid rgba(255,255,255,0.05)}\n' +
      '.bnrd-segmented{display:flex;gap:2px;margin-top:8px;background:rgba(118, 118, 128, 0.24);padding:2px;border-radius:8px}\n' +
      '.bnrd-seg-btn{flex:1;border:0.5px solid transparent;background:transparent;padding:6px 4px;font-size:13px;font-weight:400;border-radius:6px;color:var(--bnrd-p-text);cursor:pointer;transition:background 150ms ease}\n' +
      '.bnrd-seg-btn.bnrd-seg-active{background:rgba(99, 99, 102, 0.8);color:#fff;box-shadow:0 3px 8px rgba(0,0,0,.12),0 3px 1px rgba(0,0,0,.04);border-color:rgba(0,0,0,0.04)}\n' +
      '.bnrd-seg-btn:focus-visible{outline:2px solid var(--bnrd-p-accent);outline-offset:2px}\n' +
      '.bnrd-panel-foot{margin-top:12px;padding-top:12px;border-top:1px solid var(--bnrd-p-border);display:flex;align-items:center;justify-content:space-between;gap:8px}\n' +
      '.bnrd-hint{font-size:12px;color:var(--bnrd-p-text-muted)}\n' +
      '.bnrd-text-btn{border:none;background:transparent;color:var(--bnrd-p-accent);font-size:13px;font-weight:500;cursor:pointer;padding:4px 6px;border-radius:6px;white-space:nowrap}\n' +
      '.bnrd-text-btn:hover{background:rgba(10, 132, 255, 0.15)}\n' +
      '.bnrd-text-btn:focus-visible{outline:2px solid var(--bnrd-p-accent);outline-offset:2px}\n' +
      '@media (prefers-reduced-motion:reduce){.bnrd-fab,.bnrd-panel,.bnrd-switch-thumb{transition:none !important}}\n' +
      '@media (max-width:420px){.bnrd-ui{right:14px;bottom:14px}}\n';
  }

  function injectStyles() {
    var css = buildCSS();
    if (typeof GM_addStyle === 'function') {
      try { GM_addStyle(css); return; } catch (err) { }
    }
    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ================================== UI ======================================= */

  var fabEl = null;
  var panelEl = null;
  var panelOpenState = false;

  function buildUI() {
    var container = document.createElement('div');
    container.className = UI_ROOT_CLASS;
    container.innerHTML =
      '<button type="button" class="bnrd-fab" aria-haspopup="dialog" aria-expanded="false" aria-label="Bionic Reading settings">' + FAB_ICON_SVG + '</button>' +
      '<div class="bnrd-panel" role="dialog" aria-label="Bionic Reading settings" aria-modal="false" hidden>' +
        '<div class="bnrd-panel-head">' +
          '<h2 class="bnrd-panel-title">Bionic Reading</h2>' +
          '<button type="button" class="bnrd-icon-btn" data-action="close" aria-label="Close settings">' + CLOSE_ICON_SVG + '</button>' +
        '</div>' +
        '<div class="bnrd-row bnrd-row-switch">' +
          '<label class="bnrd-switch"><input type="checkbox" class="bnrd-input" data-key="enabled"><span class="bnrd-switch-track"><span class="bnrd-switch-thumb"></span></span></label>' +
          '<div class="bnrd-row-text"><span class="bnrd-row-label">Active on this page</span></div>' +
        '</div>' +
        '<div class="bnrd-row bnrd-row-switch">' +
          '<label class="bnrd-switch"><input type="checkbox" class="bnrd-input" data-key="siteDisabled"><span class="bnrd-switch-track"><span class="bnrd-switch-thumb"></span></span></label>' +
          '<div class="bnrd-row-text"><span class="bnrd-row-label">Turn off on <span class="bnrd-hostname"></span></span></div>' +
        '</div>' +
        '<div class="bnrd-divider"></div>' +
        '<div class="bnrd-eyebrow">Fixation</div>' +
        '<div class="bnrd-row bnrd-row-slider">' +
          '<div class="bnrd-row-top"><span class="bnrd-row-label">Bold strength</span><span class="bnrd-value" data-value="ratio">44%</span></div>' +
          '<input type="range" class="bnrd-input bnrd-range" data-key="ratio" min="25" max="65" step="1">' +
          '<div class="bnrd-preview"><span class="bnrd-preview-word"></span></div>' +
        '</div>' +
        '<div class="bnrd-row">' +
          '<span class="bnrd-row-label">Bold weight</span>' +
          '<div class="bnrd-segmented">' +
            '<button type="button" class="bnrd-seg-btn" data-value="500">Medium</button>' +
            '<button type="button" class="bnrd-seg-btn" data-value="600">Semibold</button>' +
            '<button type="button" class="bnrd-seg-btn" data-value="700">Bold</button>' +
            '<button type="button" class="bnrd-seg-btn" data-value="900">Black</button>' +
          '</div>' +
        '</div>' +
        '<div class="bnrd-divider"></div>' +
        '<div class="bnrd-eyebrow">Contrast</div>' +
        '<div class="bnrd-row bnrd-row-switch">' +
          '<label class="bnrd-switch"><input type="checkbox" class="bnrd-input" data-key="dimUnbold"><span class="bnrd-switch-track"><span class="bnrd-switch-thumb"></span></span></label>' +
          '<div class="bnrd-row-text"><span class="bnrd-row-label">Dim remaining letters</span></div>' +
        '</div>' +
        '<div class="bnrd-row bnrd-row-slider" data-row="dimOpacity">' +
          '<div class="bnrd-row-top"><span class="bnrd-row-label">Dim amount</span><span class="bnrd-value" data-value="dimOpacity">32%</span></div>' +
          '<input type="range" class="bnrd-input bnrd-range" data-key="dimOpacity" min="0" max="60" step="1">' +
        '</div>' +
        '<div class="bnrd-divider"></div>' +
        '<div class="bnrd-row bnrd-row-switch">' +
          '<label class="bnrd-switch"><input type="checkbox" class="bnrd-input" data-key="skipCode"><span class="bnrd-switch-track"><span class="bnrd-switch-thumb"></span></span></label>' +
          '<div class="bnrd-row-text"><span class="bnrd-row-label">Skip code blocks</span></div>' +
        '</div>' +
        '<div class="bnrd-panel-foot"><span class="bnrd-hint">Alt+Shift+B to toggle</span><button type="button" class="bnrd-text-btn" data-action="reset">Reset defaults</button></div>' +
      '</div>';

    document.documentElement.appendChild(container);
    fabEl = container.querySelector('.bnrd-fab');
    panelEl = container.querySelector('.bnrd-panel');
    wireUI(container);
    syncPanelControls();
  }

  function wireUI(container) {
    var closeBtn = container.querySelector('[data-action="close"]');
    var resetBtn = container.querySelector('[data-action="reset"]');
    var fab = container.querySelector('.bnrd-fab');

    fab.addEventListener('click', function () { panelOpenState ? closePanel() : openPanel(); });
    closeBtn.addEventListener('click', closePanel);

    container.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelOpenState) { closePanel(); fab.focus(); return; }
      if (e.key === 'Tab' && panelOpenState) trapFocus(e, container);
    });

    document.addEventListener('click', function (e) {
      if (panelOpenState && !container.contains(e.target)) closePanel();
    }, true);

    ['enabled', 'dimUnbold', 'skipCode'].forEach(function (key) {
      var input = container.querySelector('.bnrd-input[data-key="' + key + '"]');
      if (!input) return;
      input.addEventListener('change', function () {
        settings[key] = input.checked;
        saveSettings(settings);
        onSettingsChanged(key === 'skipCode');
      });
    });

    var siteInput = container.querySelector('.bnrd-input[data-key="siteDisabled"]');
    if (siteInput) {
      siteInput.addEventListener('change', function () {
        toggleSiteDisabled();
        syncActiveState(false);
        refreshMenuCommands();
        updateFabState();
      });
    }

    var ratioInput = container.querySelector('.bnrd-input[data-key="ratio"]');
    var ratioValueEl = container.querySelector('.bnrd-value[data-value="ratio"]');
    if (ratioInput) {
      ratioInput.addEventListener('input', function () {
        var pct = Number(ratioInput.value);
        ratioValueEl.textContent = pct + '%';
        updateRatioPreview(pct / 100);
      });
      ratioInput.addEventListener('change', function () {
        settings.ratio = Number(ratioInput.value) / 100;
        saveSettings(settings);
        onSettingsChanged(true);
      });
    }

    var dimInput = container.querySelector('.bnrd-input[data-key="dimOpacity"]');
    var dimValueEl = container.querySelector('.bnrd-value[data-value="dimOpacity"]');
    if (dimInput) {
      dimInput.addEventListener('input', function () {
        var pct = Number(dimInput.value);
        dimValueEl.textContent = pct + '%';
        settings.dimOpacity = dimPercentToOpacity(pct);
        applyCSSVariables();
      });
      dimInput.addEventListener('change', function () { saveSettings(settings); });
    }

    var segButtons = container.querySelectorAll('.bnrd-seg-btn');
    segButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        settings.boldWeight = Number(btn.getAttribute('data-value'));
        saveSettings(settings);
        applyCSSVariables();
        syncPanelControls();
        refreshMenuCommands();
      });
    });

    resetBtn.addEventListener('click', function () {
      settings = Object.assign({}, DEFAULT_SETTINGS);
      saveSettings(settings);
      onSettingsChanged(true);
    });
  }

  function setChecked(key, val) {
    var el = panelEl.querySelector('.bnrd-input[data-key="' + key + '"]');
    if (el) el.checked = !!val;
  }
  function setRangeValue(key, val) {
    var el = panelEl.querySelector('.bnrd-input[data-key="' + key + '"]');
    if (el) el.value = String(val);
  }
  function setValueLabel(key, label) {
    var el = panelEl.querySelector('.bnrd-value[data-value="' + key + '"]');
    if (el) el.textContent = label;
  }

  function updateRatioPreview(ratio) {
    if (!panelEl) return;
    var el = panelEl.querySelector('.bnrd-preview-word');
    if (!el) return;
    var word = 'fixation';
    var boldLen = computeSmartBoldLength(word, ratio);
    el.innerHTML = '<b class="' + BOLD_CLASS + '">' + word.slice(0, boldLen) + '</b><span class="' + REST_CLASS + '">' + word.slice(boldLen) + '</span>';
  }

  function syncPanelControls() {
    if (!panelEl) return;
    setChecked('enabled', settings.enabled);
    setChecked('siteDisabled', siteIsDisabled());
    setChecked('dimUnbold', settings.dimUnbold);
    setChecked('skipCode', settings.skipCode);

    var ratioPct = Math.round(settings.ratio * 100);
    setRangeValue('ratio', ratioPct);
    setValueLabel('ratio', ratioPct + '%');
    updateRatioPreview(settings.ratio);

    var dimPct = opacityToDimPercent(settings.dimOpacity);
    setRangeValue('dimOpacity', dimPct);
    setValueLabel('dimOpacity', dimPct + '%');

    var dimRow = panelEl.querySelector('[data-row="dimOpacity"]');
    if (dimRow) dimRow.classList.toggle('bnrd-row-disabled', !settings.dimUnbold);

    var segButtons = panelEl.querySelectorAll('.bnrd-seg-btn');
    segButtons.forEach(function (b) {
      b.classList.toggle('bnrd-seg-active', Number(b.getAttribute('data-value')) === settings.boldWeight);
    });

    var hostnameEls = panelEl.querySelectorAll('.bnrd-hostname');
    hostnameEls.forEach(function (el) { el.textContent = location.hostname || location.href; });
  }

  function openPanel() {
    if (!panelEl || panelOpenState) return;
    panelOpenState = true;
    panelEl.hidden = false;
    fabEl.setAttribute('aria-expanded', 'true');
    syncPanelControls();
    requestAnimationFrame(function () {
      panelEl.classList.add('bnrd-panel-open');
      var focusTarget = panelEl.querySelector('.bnrd-input, .bnrd-seg-btn, button');
      if (focusTarget) focusTarget.focus();
    });
  }

  function closePanel() {
    if (!panelEl || !panelOpenState) return;
    panelOpenState = false;
    panelEl.classList.remove('bnrd-panel-open');
    fabEl.setAttribute('aria-expanded', 'false');
    setTimeout(function () { if (!panelOpenState && panelEl) panelEl.hidden = true; }, 220);
  }

  function trapFocus(e, container) {
    var focusables = container.querySelectorAll('button, input:not([type="hidden"])');
    var list = [];
    for (var i = 0; i < focusables.length; i++) {
      var el = focusables[i];
      if (!el.disabled && el.offsetParent !== null) list.push(el);
    }
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function updateFabState() {
    if (!fabEl) return;
    fabEl.classList.toggle('bnrd-fab-inactive', !active);
  }

  /* ============================= MENU COMMANDS ================================= */

  var menuIds = {};

  function registerOrUpdateCommand(key, label, handler) {
    var canUnregister = typeof GM_unregisterMenuCommand === 'function';
    if (canUnregister && menuIds[key] != null) {
      try { GM_unregisterMenuCommand(menuIds[key]); } catch (err) { }
    }
    try { menuIds[key] = GM_registerMenuCommand(label, handler); } catch (err) { }
  }

  function refreshMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    registerOrUpdateCommand(
      'toggleGlobal',
      settings.enabled ? '\u25CF Bionic Reading: On' : '\u25CB Bionic Reading: Off',
      function () {
        settings.enabled = !settings.enabled;
        saveSettings(settings);
        onSettingsChanged(false);
      }
    );
    var disabledHere = siteIsDisabled();
    registerOrUpdateCommand(
      'toggleSite',
      (disabledHere ? '\u25CF Enable on ' : '\u25CB Disable on ') + location.hostname,
      function () {
        toggleSiteDisabled();
        syncActiveState(false);
        refreshMenuCommands();
        updateFabState();
        syncPanelControls();
      }
    );
    registerOrUpdateCommand('openSettings', 'Open Settings Panel', function () {
      if (panelEl) openPanel();
    });
  }

  /* ========================= HOTKEY + CROSS-TAB SYNC ========================== */

  function installHotkey() {
    document.addEventListener('keydown', function (e) {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyB')) return;
      var activeEl = document.activeElement;
      var tag = activeEl ? activeEl.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (activeEl && activeEl.isContentEditable)) return;
      e.preventDefault();
      settings.enabled = !settings.enabled;
      saveSettings(settings);
      onSettingsChanged(false);
    }, true);
  }

  function installValueSync() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    try {
      GM_addValueChangeListener(SETTINGS_KEY, function (name, oldValue, newValue, remote) {
        if (!remote) return;
        try {
          settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(newValue));
          onSettingsChanged(true);
        } catch (err) { }
      });
      GM_addValueChangeListener(DISABLED_KEY, function (name, oldValue, newValue, remote) {
        if (!remote) return;
        try {
          disabledSites = JSON.parse(newValue) || [];
          syncActiveState(false);
          refreshMenuCommands();
          syncPanelControls();
        } catch (err) { }
      });
    } catch (err) { }
  }

  /* ================================== BOOT ====================================== */

  function boot() {
    injectStyles();
    buildUI();
    installHotkey();
    installValueSync();
    if (active) startEngine();
    updateFabState();
  }

  var settings = loadSettings();
  var disabledSites = loadDisabledSites();
  var active = settings.enabled && !siteIsDisabled();

  installShadowPatch();
  refreshMenuCommands();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();