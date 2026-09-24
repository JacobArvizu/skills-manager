/**
 * Pinpoint overlay — runs inside the page being reviewed.
 *
 * Loaded from the helper server (proxy/static injection, a <script> snippet, or
 * the bookmarklet). The server prepends window.__PINPOINT__ = {token, base, ...}.
 * All UI lives in one closed-off shadow root so page CSS can't touch it and it
 * can't touch the page.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__PINPOINT_LOADED__) return;
  const CFG = window.__PINPOINT__;
  if (!CFG || !CFG.base) return;
  window.__PINPOINT_LOADED__ = true;

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  const COLORS = {
    draft: '#6d5dfc',
    sent: '#e8900c',
    resolved: '#16a34a',
    wontfix: '#71717a',
    hover: '#6d5dfc',
    ink: '#ff3b6b',
  };
  const KINDS = [
    { id: 'change', label: 'Change' },
    { id: 'bug', label: 'Bug' },
    { id: 'question', label: 'Question' },
    { id: 'note', label: 'Note' },
  ];
  const STYLE_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'gap',
    'color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'opacity',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
    'flex-direction', 'justify-content', 'align-items', 'grid-template-columns', 'z-index',
  ];
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'start', 'visible', '1', 'stretch', 'row', '0px none rgb(0, 0, 0)']);
  const SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  const LS_KEY = 'pinpoint:ui';

  const ICONS = {
    pick: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    draw: '<path d="M4 20c2-1 3.5-1 5 0s3 1 5 0"/><path d="M14.5 4.5l5 5L10 19l-5.5.5L5 14z"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
    send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    min: '<path d="M6 15l6-6 6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    comment: '<path d="M4 5h16v11H9l-5 4z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    mark: '<circle cx="12" cy="10" r="6.5"/><circle cx="12" cy="10" r="2" fill="currentColor"/><path d="M12 16.5V21"/>',
  };
  const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const S = {
    mode: 'idle',            // idle | pick | draw
    annotations: new Map(),  // id -> annotation
    elCache: new Map(),      // id -> Element[]
    hoverEl: null,
    childTrail: [],
    multi: [],               // shift+click selection while picking
    composer: null,          // { id?, targets: Element[], quote, range, strokes, kind }
    draftStrokes: [],
    liveStroke: null,
    panelOpen: false,
    panelFilter: 'open',
    menuOpen: false,
    pinsVisible: true,
    collapsed: false,
    listening: 0,
    connected: false,
    pendingShots: new Set(),
    path: location.pathname,
    toolbarPos: null,
  };
  try { Object.assign(S, pickKeys(JSON.parse(localStorage.getItem(LS_KEY) || '{}'), ['pinsVisible', 'collapsed', 'toolbarPos'])); } catch { /* storage blocked */ }
  function pickKeys(o, keys) { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; }
  function persistUi() { try { localStorage.setItem(LS_KEY, JSON.stringify({ pinsVisible: S.pinsVisible, collapsed: S.collapsed, toolbarPos: S.toolbarPos })); } catch { /* ignore */ } }

  // -------------------------------------------------------------------------
  // Server API
  // -------------------------------------------------------------------------

  async function api(method, p, body) {
    const res = await fetch(CFG.base + '/api' + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-pinpoint-token': CFG.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function connect() {
    let es;
    try { es = new EventSource(`${CFG.base}/api/stream?token=${encodeURIComponent(CFG.token)}`); } catch { return; }
    es.onopen = () => { S.connected = true; renderToolbar(); };
    es.onerror = () => { S.connected = false; renderToolbar(); };
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'snapshot') {
        S.annotations = new Map(msg.annotations.map((a) => [a.id, a]));
        S.elCache.clear();
        S.listening = msg.listening || 0;
      } else if (msg.type === 'upsert') {
        const prev = S.annotations.get(msg.annotation.id);
        S.annotations.set(msg.annotation.id, msg.annotation);
        S.elCache.delete(msg.annotation.id);
        if (msg.reply) {
          const last = msg.annotation.replies[msg.annotation.replies.length - 1];
          toast(`#${msg.annotation.id} · ${last ? truncate(last.text, 90) : 'updated'}`, { action: 'Open', onAction: () => focusAnnotation(msg.annotation.id) });
        } else if (prev && prev.status !== msg.annotation.status && msg.annotation.status === 'resolved') {
          toast(`#${msg.annotation.id} resolved`);
        }
        if (S.composer && S.composer.id === msg.annotation.id) renderComposer();
      } else if (msg.type === 'delete') {
        S.annotations.delete(msg.id);
        S.elCache.delete(msg.id);
      } else if (msg.type === 'listening') {
        S.listening = msg.count;
      } else if (msg.type === 'target') {
        CFG.targetOrigin = msg.targetOrigin;
      }
      refreshHighlights();
      renderToolbar();
      renderPanel();
      schedule();
    };
  }

  // -------------------------------------------------------------------------
  // Page helpers
  // -------------------------------------------------------------------------

  function pageInfo() {
    let url = location.href;
    if (CFG.targetOrigin && location.origin === CFG.serverOrigin) url = CFG.targetOrigin + url.slice(location.origin.length);
    return { url, path: location.pathname, title: document.title };
  }
  // localhost / 127.0.0.1 / [::1] / 0.0.0.0 on the same port are the same app.
  function sameTargetOrigin(origin) {
    if (!CFG.targetOrigin) return false;
    if (origin === CFG.targetOrigin) return true;
    const loop = /^(https?:)\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/;
    const a = loop.exec(origin), b = loop.exec(CFG.targetOrigin);
    return !!(a && b && a[1] === b[1] && (a[3] || '') === (b[3] || ''));
  }
  const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function isOurs(el) { return el === host || (el && el.getRootNode && el.getRootNode() === root); }
  function pickableAt(x, y) {
    const list = document.elementsFromPoint(x, y);
    for (const el of list) {
      if (isOurs(el)) continue;
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el === document.body && list.length > 2) continue;
      return el;
    }
    return null;
  }

  const stableClass = (c) => c.length < 40 && !/[:[\]/@!%.]/.test(c) && !/^(css|sc|jsx|emotion|svelte|astro|tw|chakra|mui|Mui)[-_]/.test(c) && !/[a-z][0-9a-f]{5,}$/i.test(c) && !/__[\w-]{5}$/.test(c);
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } }

  function cssPath(el) {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-cy');
      if (node.id && node !== el) {
        part = '#' + CSS.escape(node.id);
      } else if (testId) {
        part += `[data-testid="${CSS.escape(testId)}"]`;
        if (!node.hasAttribute('data-testid')) part = part.replace('data-testid', node.hasAttribute('data-test') ? 'data-test' : 'data-cy');
      } else {
        const classes = [...node.classList].filter(stableClass).slice(0, 2);
        if (classes.length) part += '.' + classes.map((c) => CSS.escape(c)).join('.');
        const parent = node.parentElement;
        if (parent) {
          let siblingsMatching = 2;
          try { siblingsMatching = parent.querySelectorAll(':scope > ' + part).length; } catch { /* keep nth */ }
          if (siblingsMatching > 1) {
            const same = [...parent.children].filter((c) => c.tagName === node.tagName);
            part += `:nth-of-type(${same.indexOf(node) + 1})`;
          }
        }
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function xPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
    }
    return '/' + parts.join('/');
  }

  function label(el) {
    if (!el) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else {
      const cls = [...el.classList].filter(stableClass).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
    }
    return s;
  }

  function sourceHints(el) {
    const out = {};
    // Attributes written by dev tooling (Astro, code-inspector, react-dev-inspector, locator, etc.)
    for (let n = el, d = 0; n && n.nodeType === 1 && d < 8 && !out.file; n = n.parentElement, d++) {
      const a = (k) => n.getAttribute(k);
      if (a('data-astro-source-file')) { out.file = a('data-astro-source-file'); const loc = (a('data-astro-source-loc') || '').split(':'); out.line = +loc[0] || undefined; out.column = +loc[1] || undefined; }
      else if (a('data-insp-path')) { const [f, l, c] = a('data-insp-path').split(':'); Object.assign(out, { file: f, line: +l || undefined, column: +c || undefined }); }
      else if (a('data-inspector-relative-path')) Object.assign(out, { file: a('data-inspector-relative-path'), line: +a('data-inspector-line') || undefined, column: +a('data-inspector-column') || undefined });
      else if (a('data-source-file')) Object.assign(out, { file: a('data-source-file'), line: +a('data-source-line') || undefined });
      else if (a('data-source') && /\.\w+:\d+/.test(a('data-source'))) { const m = a('data-source').match(/^(.*?):(\d+)(?::(\d+))?$/); if (m) Object.assign(out, { file: m[1], line: +m[2], column: m[3] ? +m[3] : undefined }); }
      else if (a('data-locatorjs-id')) out.file = a('data-locatorjs-id');
    }
    try {
      // React: component chain (+ _debugSource on React ≤18 dev builds)
      const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey) {
        const names = [];
        for (let f = el[fiberKey]; f && names.length < 6; f = f.return) {
          const t = f.type;
          if (t && typeof t !== 'string') {
            const name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
            if (name && !names.includes(name) && !/^(Anonymous|Fragment|Provider|Consumer)$/.test(name)) names.push(name);
          }
          if (!out.file && f._debugSource) Object.assign(out, { file: f._debugSource.fileName, line: f._debugSource.lineNumber, column: f._debugSource.columnNumber });
        }
        if (names.length) { out.framework = 'react'; out.components = names; }
      }
      // Vue 3 / Vue 2
      let vc = null;
      for (let n = el; n && !vc; n = n.parentElement) vc = n.__vueParentComponent || null;
      if (vc) {
        const names = [];
        for (let c = vc; c && names.length < 6; c = c.parent) {
          const nm = c.type && (c.type.name || c.type.__name || (c.type.__file && c.type.__file.split('/').pop().replace(/\.vue$/, '')));
          if (nm && !names.includes(nm)) names.push(nm);
          if (!out.file && c.type && c.type.__file) out.file = c.type.__file;
        }
        out.framework = 'vue'; if (names.length) out.components = names;
      } else if (el.__vue__) {
        out.framework = 'vue';
        if (!out.file && el.__vue__.$options.__file) out.file = el.__vue__.$options.__file;
      }
      // Svelte dev builds
      for (let n = el, d = 0; n && d < 6 && !out.file; n = n.parentElement, d++) {
        if (n.__svelte_meta && n.__svelte_meta.loc) { const l = n.__svelte_meta.loc; Object.assign(out, { framework: 'svelte', file: l.file, line: l.line + 1, column: l.column }); }
      }
    } catch { /* framework internals are best effort */ }
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  function attrsOf(el) {
    const out = {};
    for (const k of ['role', 'aria-label', 'title', 'href', 'src', 'alt', 'name', 'type', 'placeholder', 'value', 'for', 'data-testid']) {
      const v = el.getAttribute(k);
      if (v) out[k] = truncate(v, 200);
    }
    return out;
  }

  function stylesOf(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && !BORING.has(v)) out[p] = truncate(v, 160);
    }
    return out;
  }

  function htmlSnippet(el) {
    const html = el.outerHTML;
    if (html.length <= 1200) return html;
    const open = html.slice(0, html.indexOf('>') + 1);
    return truncate(open + el.innerHTML.slice(0, 1000).replace(/\s+/g, ' '), 1150) + `</${el.tagName.toLowerCase()}>`;
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const d = {
      selector: cssPath(el),
      xpath: xPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: el.classList.length ? [...el.classList].slice(0, 12) : undefined,
      text: truncate(norm(el.innerText || el.textContent), 300) || undefined,
      attrs: attrsOf(el),
      rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
      styles: stylesOf(el),
      html: htmlSnippet(el),
      source: sourceHints(el),
    };
    return d;
  }

  function resolveEls(a) {
    const cached = S.elCache.get(a.id);
    if (cached && cached.every((e) => e && e.isConnected)) return cached;
    const els = (a.targets || []).map((t) => {
      let el = null;
      try { el = document.querySelector(t.selector); } catch { /* bad selector */ }
      if (!el && t.xpath) {
        try { el = document.evaluate(t.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { /* ignore */ }
      }
      return el;
    }).filter(Boolean);
    S.elCache.set(a.id, els);
    return els;
  }

  function onThisPage(a) { return !a.page || a.page.path === location.pathname; }

  function findTextRange(el, quote) {
    if (!el || !quote) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, text.length]); text += n.data; }
    const idx = text.indexOf(quote);
    if (idx < 0) return null;
    const at = (pos) => { for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i][1] <= pos) return [nodes[i][0], pos - nodes[i][1]]; return null; };
    const s = at(idx), e = at(idx + quote.length);
    if (!s || !e) return null;
    const r = document.createRange();
    try { r.setStart(s[0], s[1]); r.setEnd(e[0], e[1]); } catch { return null; }
    return r;
  }

  // -------------------------------------------------------------------------
  // DOM: host + shadow root
  // -------------------------------------------------------------------------

  const host = document.createElement('pinpoint-overlay');
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;display:block;');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${css()}</style>
    <div class="layer">
      <svg class="ink" xmlns="http://www.w3.org/2000/svg"><g class="ink-g"></g></svg>
      <div class="outlines"></div>
      <div class="hover"><div class="hover-label"></div></div>
      <div class="pins"></div>
    </div>
    <div class="draw-capture"></div>
    <button class="sel-chip" type="button">${icon('comment', 14)}<span>Comment</span></button>
    <div class="composer" role="dialog" aria-label="Annotation"></div>
    <aside class="panel" aria-label="Annotations"></aside>
    <div class="toolbar" role="toolbar" aria-label="Pinpoint"></div>
    <div class="menu" role="menu"></div>
    <div class="toasts" aria-live="polite"></div>`;
  const $ = (sel) => root.querySelector(sel);
  const el = {
    ink: $('.ink'), inkG: $('.ink-g'), outlines: $('.outlines'), hover: $('.hover'), hoverLabel: $('.hover-label'),
    pins: $('.pins'), capture: $('.draw-capture'), chip: $('.sel-chip'), composer: $('.composer'),
    panel: $('.panel'), toolbar: $('.toolbar'), menu: $('.menu'), toasts: $('.toasts'),
  };
  (document.documentElement || document.body).appendChild(host);
  // Keep keystrokes typed into our UI from reaching page shortcuts.
  for (const t of ['keydown', 'keyup', 'keypress']) root.addEventListener(t, (e) => { if (e.target !== host) e.stopPropagation(); });

  // Page-level stylesheet for CSS Custom Highlights (quoted text).
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `::highlight(pinpoint-quote){background-color:rgba(109,93,252,.22);text-decoration:underline 2px rgba(109,93,252,.9);}`;
  (document.head || document.documentElement).appendChild(pageStyle);

  function css() {
    return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .ink { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
    .ink path { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
    .hover { position: fixed; display: none; border: 2px solid ${COLORS.hover}; background: rgba(109,93,252,.08); border-radius: 3px; transition: all 60ms linear; }
    .hover-label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis;
      background: #16161d; color: #fff; font: 500 11.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 5px 7px; border-radius: 5px; }
    .hover-label em { font-style: normal; color: #a5a1ff; margin-left: 6px; }
    .hover.below .hover-label { bottom: auto; top: 100%; margin: 4px 0 0; }
    .outline { position: fixed; border: 1.5px dashed; border-radius: 3px; pointer-events: none; }
    .outline.multi { border-style: solid; border-width: 2px; background: rgba(109,93,252,.1); }
    .outline.focus { border-style: solid; border-width: 2px; }
    .pin { position: fixed; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 12px 12px 12px 3px; color: #fff; border: 2px solid #fff;
      font: 700 11px/20px system-ui, sans-serif; text-align: center; cursor: pointer; pointer-events: auto; box-shadow: 0 2px 8px rgba(0,0,0,.28);
      transition: transform 120ms ease; padding: 0; }
    .pin:hover, .pin:focus-visible { transform: scale(1.15); outline: none; }
    .pin.resolved::after { content: ''; position: absolute; right: -5px; top: -5px; width: 10px; height: 10px; border-radius: 50%; background: ${COLORS.resolved}; border: 2px solid #fff; }
    .draw-capture { position: fixed; inset: 0; pointer-events: none; cursor: crosshair; }
    .draw-capture.on { pointer-events: auto; }

    button { font: inherit; color: inherit; }
    .sel-chip { position: fixed; display: none; align-items: center; gap: 6px; pointer-events: auto; cursor: pointer; border: 0; border-radius: 999px;
      background: #16161d; color: #fff; padding: 6px 11px 6px 9px; font: 600 12.5px/1 system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    .sel-chip:hover { background: ${COLORS.draft}; }

    .toolbar { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 5px;
      background: #16161d; color: #e8e8ef; border-radius: 14px; pointer-events: auto; box-shadow: 0 12px 32px -8px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06);
      font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none; }
    .toolbar.placed { transform: none; }
    .tb-handle { display: flex; align-items: center; gap: 7px; padding: 0 9px 0 7px; height: 34px; cursor: grab; color: #fff; font-weight: 650; letter-spacing: -.01em; }
    .tb-handle:active { cursor: grabbing; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #71717a; flex: none; }
    .dot.live { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.2); }
    .dot.off { background: #ef4444; }
    .sep { width: 1px; height: 20px; background: rgba(255,255,255,.12); margin: 0 3px; }
    .tb-btn { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 34px; min-width: 34px; padding: 0 8px; border: 0; border-radius: 9px;
      background: transparent; color: inherit; cursor: pointer; justify-content: center; }
    .tb-btn:hover { background: rgba(255,255,255,.09); }
    .tb-btn:focus-visible { outline: 2px solid ${COLORS.draft}; outline-offset: 1px; }
    .tb-btn.on { background: ${COLORS.draft}; color: #fff; }
    .tb-btn.primary { background: #fff; color: #16161d; font-weight: 650; padding: 0 12px 0 10px; }
    .tb-btn.primary:hover { background: #e4e2ff; }
    .tb-btn.primary[disabled] { background: rgba(255,255,255,.12); color: rgba(255,255,255,.45); cursor: default; }
    .count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: rgba(255,255,255,.14); font: 650 11px/18px system-ui, sans-serif; text-align: center; }
    .tb-btn.primary .count { background: ${COLORS.draft}; color: #fff; }
    .tip { position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); white-space: nowrap; background: #16161d; color: #fff; padding: 6px 8px; border-radius: 6px;
      font: 500 11.5px/1.2 system-ui, sans-serif; pointer-events: none; opacity: 0; transition: opacity 120ms; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
    .tip kbd { font: 600 10.5px/1 ui-monospace, Menlo, monospace; background: rgba(255,255,255,.14); padding: 2px 4px; border-radius: 4px; margin-left: 5px; }
    .tb-btn:hover .tip, .tb-handle:hover .tip { opacity: 1; transition-delay: 350ms; }
    .toolbar.collapsed { padding: 4px; border-radius: 22px; }
    .hint { padding: 0 10px; color: #a1a1aa; font-weight: 450; white-space: nowrap; }
    .hint b { color: #fff; font-weight: 600; }

    .menu { position: fixed; display: none; min-width: 230px; padding: 5px; background: #16161d; color: #e8e8ef; border-radius: 12px; pointer-events: auto;
      box-shadow: 0 16px 40px -10px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.06); font: 500 13px/1.3 system-ui, sans-serif; }
    .menu.open { display: block; }
    .menu button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 16px; border: 0; background: none; padding: 8px 10px; border-radius: 7px; cursor: pointer; text-align: left; }
    .menu button:hover, .menu button:focus-visible { background: rgba(255,255,255,.09); outline: none; }
    .menu kbd { font: 500 11px/1 ui-monospace, Menlo, monospace; color: #a1a1aa; }
    .menu hr { border: 0; height: 1px; background: rgba(255,255,255,.1); margin: 5px 4px; }
    .menu .danger { color: #fca5a5; }

    .composer { position: fixed; display: none; width: 340px; max-width: calc(100vw - 24px); pointer-events: auto; background: #fff; color: #18181b; border-radius: 14px;
      box-shadow: 0 24px 60px -12px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08); font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
    .composer.open { display: block; }
    .c-head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 0 12px; }
    .c-target { flex: 1; min-width: 0; font: 500 11.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: #52525b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .c-num { flex: none; font: 700 11px/20px system-ui; color: #fff; min-width: 22px; height: 20px; border-radius: 10px 10px 10px 3px; text-align: center; padding: 0 5px; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 0; border-radius: 7px; background: transparent; color: #52525b; cursor: pointer; flex: none; }
    .icon-btn:hover { background: #f4f4f5; color: #18181b; }
    .icon-btn:focus-visible { outline: 2px solid ${COLORS.draft}; }
    .c-body { padding: 8px 12px 12px; }
    .kinds { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
    .kind { border: 1px solid #e4e4e7; background: #fff; border-radius: 999px; padding: 3px 10px; font: 550 12px/1.4 system-ui, sans-serif; color: #52525b; cursor: pointer; }
    .kind:hover { border-color: #a1a1aa; }
    .kind.on { background: #18181b; border-color: #18181b; color: #fff; }
    .quote { margin: 0 0 8px; padding: 6px 9px; border-left: 3px solid ${COLORS.draft}; background: #f5f4ff; border-radius: 0 6px 6px 0; color: #3f3f46; font-size: 12.5px; max-height: 72px; overflow: auto; }
    .sketch-note { margin: 0 0 8px; font-size: 12px; color: #71717a; display: flex; align-items: center; gap: 6px; }
    .sketch-note i { width: 14px; height: 3px; border-radius: 2px; background: ${COLORS.ink}; display: inline-block; }
    textarea { display: block; width: 100%; min-height: 76px; max-height: 40vh; resize: vertical; border: 1px solid #e4e4e7; border-radius: 9px; padding: 8px 10px;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #18181b; background: #fff; outline: none; }
    textarea:focus { border-color: ${COLORS.draft}; box-shadow: 0 0 0 3px rgba(109,93,252,.18); }
    textarea::placeholder { color: #a1a1aa; }
    .thread { margin: 0 0 8px; display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow: auto; }
    .msg { padding: 7px 9px; border-radius: 9px; background: #f4f4f5; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
    .msg.agent { background: #effaf2; border: 1px solid #cdeed6; }
    .msg .who { display: block; font: 650 10.5px/1.2 system-ui; text-transform: uppercase; letter-spacing: .04em; color: #71717a; margin-bottom: 2px; }
    .c-foot { display: flex; align-items: center; gap: 6px; padding: 0 12px 12px; }
    .c-foot .grow { flex: 1; }
    .btn { border: 1px solid #e4e4e7; background: #fff; color: #18181b; border-radius: 8px; padding: 6px 11px; font: 600 12.5px/1.3 system-ui, sans-serif; cursor: pointer; }
    .btn:hover { background: #f4f4f5; }
    .btn:focus-visible { outline: 2px solid ${COLORS.draft}; outline-offset: 1px; }
    .btn.primary { background: #18181b; border-color: #18181b; color: #fff; }
    .btn.primary:hover { background: ${COLORS.draft}; border-color: ${COLORS.draft}; }
    .btn.ghost { border-color: transparent; color: #71717a; }
    .btn.ghost:hover { color: #b91c1c; background: #fef2f2; }
    .status-pill { font: 650 10.5px/1 system-ui; text-transform: uppercase; letter-spacing: .05em; padding: 4px 6px; border-radius: 5px; color: #fff; }
    .kbd-hint { font: 500 11px/1 system-ui; color: #a1a1aa; }

    .panel { position: fixed; top: 12px; right: 12px; bottom: 76px; width: 360px; max-width: calc(100vw - 24px); display: none; flex-direction: column; pointer-events: auto;
      background: #fff; color: #18181b; border-radius: 16px; box-shadow: 0 24px 60px -12px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08);
      font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
    .panel.open { display: flex; }
    .p-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 10px 16px; }
    .p-head h2 { flex: 1; margin: 0; font: 700 15px/1.2 system-ui, sans-serif; letter-spacing: -.01em; }
    .tabs { display: flex; gap: 2px; padding: 0 12px 10px; border-bottom: 1px solid #f0f0f2; }
    .tab { border: 0; background: none; border-radius: 7px; padding: 5px 9px; font: 550 12.5px/1.2 system-ui; color: #71717a; cursor: pointer; }
    .tab:hover { background: #f4f4f5; }
    .tab.on { background: #18181b; color: #fff; }
    .p-list { flex: 1; overflow: auto; padding: 6px; }
    .item { display: grid; grid-template-columns: 26px 1fr; gap: 10px; width: 100%; text-align: left; border: 0; background: none; padding: 10px; border-radius: 10px; cursor: pointer; }
    .item:hover, .item:focus-visible { background: #f6f6f8; outline: none; }
    .item .c-num { margin-top: 1px; }
    .i-top { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; font: 550 11px/1.3 system-ui; color: #71717a; text-transform: uppercase; letter-spacing: .04em; }
    .i-comment { color: #18181b; font-size: 13.5px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
    .i-meta { margin-top: 3px; font: 500 11.5px/1.3 ui-monospace, Menlo, monospace; color: #a1a1aa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .i-reply { margin-top: 5px; font-size: 12.5px; color: #166534; background: #effaf2; border-radius: 7px; padding: 4px 7px; }
    .empty { padding: 36px 20px; text-align: center; color: #71717a; }
    .empty b { display: block; color: #18181b; font-size: 14px; margin-bottom: 4px; }
    .p-foot { border-top: 1px solid #f0f0f2; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
    .p-foot textarea { min-height: 40px; font-size: 13px; }
    .p-foot .row { display: flex; gap: 6px; align-items: center; }
    .p-foot .row .grow { flex: 1; font-size: 12px; color: #71717a; }

    .toasts { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
    .toast { display: flex; align-items: center; gap: 10px; background: #16161d; color: #fff; padding: 9px 12px; border-radius: 10px; font: 500 13px/1.35 system-ui, sans-serif;
      box-shadow: 0 10px 28px -8px rgba(0,0,0,.45); pointer-events: auto; max-width: min(520px, calc(100vw - 24px)); animation: pp-in 160ms ease-out; }
    .toast button { border: 0; background: rgba(255,255,255,.14); color: #fff; border-radius: 6px; padding: 4px 8px; font: 600 12px/1 system-ui; cursor: pointer; }
    @keyframes pp-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @media (max-width: 760px) { .hint { display: none; } .toolbar { bottom: 12px; max-width: calc(100vw - 16px); }
      .tb-handle .name { display: none; } .tb-handle { padding: 0 6px; } .tb-btn { min-width: 32px; padding: 0 6px; } .tb-btn.primary { padding: 0 9px 0 8px; } .panel { top: auto; height: min(70vh, 560px); right: 8px; left: 8px; width: auto; } }
    @media (prefers-reduced-motion: reduce) { .toast, .hover, .pin { animation: none; transition: none; } }
    `;
  }

  // -------------------------------------------------------------------------
  // Rendering (positions follow the page on scroll/resize/mutation)
  // -------------------------------------------------------------------------

  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  function statusColor(a) { return COLORS[a.status] || COLORS.draft; }

  function render() {
    // hover box
    if (S.mode === 'pick' && S.hoverEl && !S.composer) {
      const r = S.hoverEl.getBoundingClientRect();
      Object.assign(el.hover.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      el.hover.classList.toggle('below', r.top < 30);
      el.hoverLabel.innerHTML = `${escHtml(label(S.hoverEl))}<em>${Math.round(r.width)}×${Math.round(r.height)}</em>`;
    } else el.hover.style.display = 'none';

    // outlines + pins
    const outlines = [];
    const pins = [];
    const vis = S.pinsVisible;
    for (const a of S.annotations.values()) {
      if (!onThisPage(a)) continue;
      const focused = S.composer && S.composer.id === a.id;
      if (!vis && !focused) continue;
      const els = resolveEls(a);
      if (!els.length) continue;
      const color = statusColor(a);
      els.forEach((e, i) => {
        const r = e.getBoundingClientRect();
        if (r.bottom < -50 || r.top > innerHeight + 50) return;
        if (!a.quote || focused) outlines.push(`<div class="outline${focused ? ' focus' : ''}" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-color:${color};opacity:${a.status === 'resolved' || a.status === 'wontfix' ? 0.45 : 0.9}"></div>`);
        if (i === 0) {
          let x = r.left, y = r.top;
          if (a.quote) { const rg = findTextRange(e, a.quote); if (rg) { const rr = rg.getClientRects()[0]; if (rr) { x = rr.left; y = rr.top; } } }
          x = Math.max(14, Math.min(innerWidth - 14, x));
          y = Math.max(14, Math.min(innerHeight - 14, y));
          pins.push(`<button class="pin${a.status === 'resolved' ? ' resolved' : ''}" data-id="${a.id}" style="left:${x}px;top:${y}px;background:${color}" title="#${a.id} ${escHtml(truncate(a.comment, 80))}" aria-label="Annotation ${a.id}">${a.id}</button>`);
        }
      });
    }
    // current selection (multi + composer targets for new annotations)
    const sel = S.composer && !S.composer.id ? S.composer.targets : S.multi;
    for (const e of sel) {
      const r = e.getBoundingClientRect();
      outlines.push(`<div class="outline multi" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-color:${COLORS.draft}"></div>`);
    }
    el.outlines.innerHTML = outlines.join('');
    el.pins.innerHTML = pins.join('');

    // ink (saved strokes on this page + in-progress sketch), in document coords
    el.inkG.setAttribute('transform', `translate(${-scrollX} ${-scrollY})`);
    const paths = [];
    for (const a of S.annotations.values()) {
      if (!onThisPage(a) || !a.strokes || !a.strokes.length) continue;
      if (!vis && !(S.composer && S.composer.id === a.id)) continue;
      const op = a.status === 'resolved' || a.status === 'wontfix' ? 0.35 : 0.85;
      for (const s of a.strokes) paths.push(`<path d="${pathD(s.points)}" stroke="${s.color || COLORS.ink}" opacity="${op}"/>`);
    }
    for (const s of S.draftStrokes) paths.push(`<path d="${pathD(s.points)}" stroke="${s.color}"/>`);
    if (S.liveStroke) paths.push(`<path d="${pathD(S.liveStroke.points)}" stroke="${S.liveStroke.color}"/>`);
    el.inkG.innerHTML = paths.join('');

    if (S.composer) positionComposer();
  }

  function pathD(pts) {
    if (!pts || !pts.length) return '';
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    if (pts.length === 1) return d + ` l0.1 0`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      d += ` Q${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last[0]} ${last[1]}`;
  }

  let highlightsSupported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  function refreshHighlights() {
    if (!highlightsSupported) return;
    const ranges = [];
    for (const a of S.annotations.values()) {
      if (!a.quote || !onThisPage(a)) continue;
      if (!S.pinsVisible && !(S.composer && S.composer.id === a.id)) continue;
      const [e] = resolveEls(a);
      const r = e && findTextRange(e, a.quote);
      if (r) ranges.push(r);
    }
    if (S.composer && S.composer.range) ranges.push(S.composer.range);
    try { CSS.highlights.set('pinpoint-quote', new Highlight(...ranges)); } catch { highlightsSupported = false; }
  }

  // -------------------------------------------------------------------------
  // Toolbar, menu, toasts
  // -------------------------------------------------------------------------

  function counts() {
    let drafts = 0, open = 0;
    for (const a of S.annotations.values()) {
      if (a.status === 'draft') drafts++;
      if (a.status === 'draft' || a.status === 'sent') open++;
    }
    return { drafts, open, total: S.annotations.size };
  }

  function listeningText() {
    if (!S.connected) return 'Disconnected from the Pinpoint server';
    return S.listening ? 'An agent is listening — Send delivers right away' : 'No agent listening — sent feedback queues until one runs `pinpoint wait`';
  }

  function renderToolbar() {
    const c = counts();
    const dot = `<span class="dot ${!S.connected ? 'off' : S.listening ? 'live' : ''}"></span>`;
    if (S.collapsed) {
      el.toolbar.className = 'toolbar collapsed' + (S.toolbarPos ? ' placed' : '');
      el.toolbar.innerHTML = `<button class="tb-btn" data-act="expand" aria-label="Open Pinpoint">${icon('mark')}${c.open ? `<span class="count">${c.open}</span>` : ''}<span class="tip">Pinpoint · ${escHtml(listeningText())}</span></button>`;
    } else {
      el.toolbar.className = 'toolbar' + (S.toolbarPos ? ' placed' : '');
      const hint = S.mode === 'pick' ? `<span class="hint"><b>Click</b> an element · Shift+click multi · ↑↓ parent/child · Esc</span><span class="sep"></span>`
        : S.mode === 'draw' ? `<span class="hint"><b>Draw</b> on the page, then describe it · Esc</span><span class="sep"></span>` : '';
      el.toolbar.innerHTML = `
        <div class="tb-handle" data-drag>${dot}<span class="name">Pinpoint</span><span class="tip">${escHtml(listeningText())}</span></div>
        <span class="sep"></span>
        ${hint}
        <button class="tb-btn ${S.mode === 'pick' ? 'on' : ''}" data-act="pick" aria-pressed="${S.mode === 'pick'}" aria-label="Pick elements">${icon('pick')}<span class="tip">Pick elements<kbd>Alt P</kbd></span></button>
        <button class="tb-btn ${S.mode === 'draw' ? 'on' : ''}" data-act="draw" aria-pressed="${S.mode === 'draw'}" aria-label="Draw">${icon('draw')}<span class="tip">Draw on page<kbd>Alt D</kbd></span></button>
        <button class="tb-btn ${S.panelOpen ? 'on' : ''}" data-act="list" aria-label="Annotations">${icon('list')}${c.total ? `<span class="count">${c.total}</span>` : ''}<span class="tip">All annotations<kbd>Alt L</kbd></span></button>
        <span class="sep"></span>
        <button class="tb-btn primary" data-act="send" ${c.drafts ? '' : 'disabled'} aria-label="Send drafts">${icon('send', 16)}Send${c.drafts ? `<span class="count">${c.drafts}</span>` : ''}<span class="tip">${c.drafts ? 'Send drafts' : 'Nothing new to send'}<kbd>Alt ↵</kbd></span></button>
        <button class="tb-btn" data-act="menu" aria-label="More" aria-haspopup="menu">${icon('more')}</button>
        <button class="tb-btn" data-act="collapse" aria-label="Minimize">${icon('min', 16)}<span class="tip">Minimize</span></button>`;
    }
    placeToolbar();
  }

  function placeToolbar() {
    if (!S.toolbarPos) { el.toolbar.style.left = ''; el.toolbar.style.top = ''; el.toolbar.style.bottom = ''; return; }
    const w = el.toolbar.offsetWidth, h = el.toolbar.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, S.toolbarPos.x));
    const y = Math.max(8, Math.min(innerHeight - h - 8, S.toolbarPos.y));
    Object.assign(el.toolbar.style, { left: x + 'px', top: y + 'px', bottom: 'auto' });
  }

  el.toolbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'pick') setMode(S.mode === 'pick' ? 'idle' : 'pick');
    else if (act === 'draw') setMode(S.mode === 'draw' ? 'idle' : 'draw');
    else if (act === 'list') togglePanel();
    else if (act === 'send') sendDrafts();
    else if (act === 'menu') toggleMenu(b);
    else if (act === 'collapse') { S.collapsed = true; setMode('idle'); closeMenu(); persistUi(); renderToolbar(); }
    else if (act === 'expand') { S.collapsed = false; persistUi(); renderToolbar(); }
  });

  // Drag the toolbar by its handle.
  el.toolbar.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-drag]')) return;
    e.preventDefault();
    const r = el.toolbar.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    let moved = false;
    const move = (ev) => {
      moved = true;
      S.toolbarPos = { x: ev.clientX - dx, y: ev.clientY - dy };
      el.toolbar.classList.add('placed');
      placeToolbar();
    };
    const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); if (moved) persistUi(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  });
  el.toolbar.addEventListener('dblclick', (e) => { if (e.target.closest('[data-drag]')) { S.toolbarPos = null; persistUi(); renderToolbar(); } });

  function toggleMenu(anchor) {
    if (S.menuOpen) return closeMenu();
    S.menuOpen = true;
    el.menu.innerHTML = `
      <button data-m="copy">Copy all as Markdown</button>
      <button data-m="json">Download JSON</button>
      <button data-m="dashboard">Open dashboard</button>
      <hr>
      <button data-m="pins">${S.pinsVisible ? 'Hide' : 'Show'} pins <kbd>Alt H</kbd></button>
      <button data-m="clearResolved">Remove resolved</button>
      <hr>
      <button data-m="end" class="danger">End session <kbd>tells the agent to stop</kbd></button>`;
    el.menu.classList.add('open');
    const r = anchor.getBoundingClientRect();
    const mw = el.menu.offsetWidth, mh = el.menu.offsetHeight;
    el.menu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
    el.menu.style.top = (r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8) + 'px';
    el.menu.querySelector('button').focus();
  }
  function closeMenu() { S.menuOpen = false; el.menu.classList.remove('open'); }
  el.menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    closeMenu();
    const m = b.dataset.m;
    if (m === 'copy') copyMarkdown();
    else if (m === 'json') window.open(`${CFG.base}/api/export?format=json&token=${encodeURIComponent(CFG.token)}`, '_blank');
    else if (m === 'dashboard') window.open(`${CFG.base}/`, '_blank');
    else if (m === 'pins') togglePins();
    else if (m === 'clearResolved') {
      const done = [...S.annotations.values()].filter((a) => a.status === 'resolved' || a.status === 'wontfix');
      await Promise.all(done.map((a) => api('DELETE', `/annotations/${a.id}`).catch(() => {})));
      toast(`Removed ${done.length} resolved`);
    } else if (m === 'end') {
      await api('POST', '/end').catch(() => {});
      toast('Session ended — the agent was told to stop listening.');
    }
  });

  async function copyMarkdown(status = 'all') {
    try {
      const res = await fetch(`${CFG.base}/api/export?format=md&status=${status}&token=${encodeURIComponent(CFG.token)}`);
      const md = await res.text();
      await navigator.clipboard.writeText(md);
      toast('Copied as Markdown — paste it into any chat, issue or doc.');
    } catch (err) {
      toast('Could not copy: ' + err.message);
    }
  }

  function togglePins() { S.pinsVisible = !S.pinsVisible; persistUi(); refreshHighlights(); schedule(); toast(S.pinsVisible ? 'Pins shown' : 'Pins hidden'); }

  function toast(text, { action, onAction, ms = 3800 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span>${escHtml(text)}</span>${action ? `<button type="button">${escHtml(action)}</button>` : ''}`;
    if (action) t.querySelector('button').addEventListener('click', () => { onAction(); t.remove(); });
    el.toasts.appendChild(t);
    setTimeout(() => t.remove(), action ? ms + 3000 : ms);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  }

  // -------------------------------------------------------------------------
  // Modes: pick / draw
  // -------------------------------------------------------------------------

  function setMode(mode) {
    if (S.composer && mode !== 'idle' && mode !== S.mode) closeComposer();
    S.mode = mode;
    S.hoverEl = null;
    S.childTrail = [];
    if (mode !== 'pick') S.multi = [];
    el.capture.classList.toggle('on', mode === 'draw');
    hideChip();
    renderToolbar();
    schedule();
  }

  function ownEvent(e) { return e.composedPath().includes(host); }

  // Swallow page interaction while picking so clicks don't navigate or trigger handlers.
  const BLOCK = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick', 'touchstart'];
  for (const type of BLOCK) {
    window.addEventListener(type, (e) => {
      if (S.mode !== 'pick' || ownEvent(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type === 'click' && !S.composer) onPickClick(e);
    }, { capture: true, passive: false });
  }

  window.addEventListener('pointermove', (e) => {
    if (S.mode !== 'pick' || S.composer || ownEvent(e)) return;
    const t = pickableAt(e.clientX, e.clientY);
    if (t && t !== S.hoverEl && !S.childTrail.includes(t)) { S.hoverEl = t; S.childTrail = []; schedule(); }
  }, { capture: true, passive: true });

  function onPickClick(e) {
    const t = S.hoverEl || pickableAt(e.clientX, e.clientY);
    if (!t) return;
    if (e.shiftKey) {
      const i = S.multi.indexOf(t);
      if (i >= 0) S.multi.splice(i, 1); else S.multi.push(t);
      schedule();
      return;
    }
    const targets = S.multi.length ? (S.multi.includes(t) ? S.multi.slice() : [...S.multi, t]) : [t];
    S.multi = [];
    openComposer({ targets });
  }

  // Draw mode: strokes captured in document coordinates.
  el.capture.addEventListener('pointerdown', (e) => {
    if (S.mode !== 'draw' || e.button !== 0) return;
    e.preventDefault();
    el.capture.setPointerCapture(e.pointerId);
    S.liveStroke = { color: COLORS.ink, points: [[Math.round(e.clientX + scrollX), Math.round(e.clientY + scrollY)]] };
    schedule();
  });
  el.capture.addEventListener('pointermove', (e) => {
    if (!S.liveStroke) return;
    const p = [Math.round(e.clientX + scrollX), Math.round(e.clientY + scrollY)];
    const last = S.liveStroke.points[S.liveStroke.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2.5) { S.liveStroke.points.push(p); schedule(); }
  });
  const endStroke = () => {
    if (!S.liveStroke) return;
    const s = S.liveStroke;
    S.liveStroke = null;
    S.draftStrokes.push(s);
    const anchor = anchorForStrokes(S.draftStrokes);
    if (S.composer && !S.composer.id) {
      S.composer.strokes = S.draftStrokes;
      S.composer.targets = anchor ? [anchor] : [];
      renderComposer();
    } else openComposer({ targets: anchor ? [anchor] : [], strokes: S.draftStrokes });
    schedule();
  };
  el.capture.addEventListener('pointerup', endStroke);
  el.capture.addEventListener('pointercancel', endStroke);
  el.capture.addEventListener('wheel', (e) => { window.scrollBy(e.deltaX, e.deltaY); }, { passive: true });

  function strokesBox(strokes) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of strokes) for (const [x, y] of s.points) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    return { x1, y1, x2, y2 };
  }
  function anchorForStrokes(strokes) {
    const b = strokesBox(strokes);
    const cx = (b.x1 + b.x2) / 2 - scrollX, cy = (b.y1 + b.y2) / 2 - scrollY;
    el.capture.style.pointerEvents = 'none';
    let t = pickableAt(cx, cy);
    el.capture.style.pointerEvents = '';
    const tol = 12;
    while (t && t.parentElement && t !== document.body) {
      const r = t.getBoundingClientRect();
      const L = r.left + scrollX, T = r.top + scrollY;
      if (L - tol <= b.x1 && T - tol <= b.y1 && L + r.width + tol >= b.x2 && T + r.height + tol >= b.y2) break;
      t = t.parentElement;
    }
    return t || document.body;
  }

  // Text selection → "Comment" chip.
  let chipRange = null;
  document.addEventListener('selectionchange', () => {
    if (S.collapsed || S.mode === 'pick' || S.mode === 'draw' || S.composer) return hideChip();
    clearTimeout(chipTimer);
    chipTimer = setTimeout(updateChip, 180);
  });
  let chipTimer = 0;
  function updateChip() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideChip();
    const range = sel.getRangeAt(0);
    const text = norm(sel.toString());
    const node = range.commonAncestorContainer;
    const anc = node.nodeType === 1 ? node : node.parentElement;
    if (!text || !anc || isOurs(anc) || anc.closest('input,textarea,[contenteditable=""],[contenteditable="true"]')) return hideChip();
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] || range.getBoundingClientRect();
    chipRange = range.cloneRange();
    el.chip.style.display = 'inline-flex';
    const cw = el.chip.offsetWidth;
    el.chip.style.left = Math.max(8, Math.min(innerWidth - cw - 8, r.right - cw / 2)) + 'px';
    el.chip.style.top = Math.min(innerHeight - 40, r.bottom + 8) + 'px';
  }
  function hideChip() { el.chip.style.display = 'none'; chipRange = null; }
  el.chip.addEventListener('pointerdown', (e) => e.preventDefault());
  el.chip.addEventListener('click', () => {
    if (!chipRange) return;
    const range = chipRange;
    const node = range.commonAncestorContainer;
    let anc = node.nodeType === 1 ? node : node.parentElement;
    while (anc && ['SPAN', 'EM', 'STRONG', 'B', 'I', 'A', 'CODE', 'MARK', 'SMALL'].includes(anc.tagName) && anc.parentElement && norm(anc.textContent).length < 80) anc = anc.parentElement;
    const quote = range.toString().replace(/\s+/g, ' ').trim();
    hideChip();
    document.getSelection().removeAllRanges();
    openComposer({ targets: [anc], quote, range });
  });

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------

  function openComposer({ id, targets = [], quote = null, range = null, strokes = [] }) {
    const a = id ? S.annotations.get(id) : null;
    S.composer = {
      id: id || null,
      targets: a ? resolveEls(a) : targets,
      quote: a ? a.quote : quote,
      range: a ? null : range,
      strokes: a ? a.strokes : strokes,
      kind: a ? a.kind : 'change',
      text: a ? a.comment : '',
      reply: '',
    };
    closeMenu();
    hideChip();
    renderComposer();
    refreshHighlights();
    schedule();
    const ta = el.composer.querySelector('textarea');
    if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function closeComposer() {
    S.composer = null;
    S.draftStrokes = [];
    el.composer.classList.remove('open');
    el.composer.innerHTML = '';
    refreshHighlights();
    schedule();
  }

  function renderComposer() {
    const c = S.composer;
    if (!c) return;
    const a = c.id ? S.annotations.get(c.id) : null;
    const ta = el.composer.querySelector('textarea[data-f="text"]');
    if (ta) c.text = ta.value;
    const ra = el.composer.querySelector('textarea[data-f="reply"]');
    if (ra) c.reply = ra.value;
    const focusedField = root.activeElement && root.activeElement.dataset ? root.activeElement.dataset.f : null;
    const t0 = c.targets[0];
    const tLabel = c.targets.length > 1 ? `${c.targets.length} elements · ${c.targets.map(label).slice(0, 3).join(', ')}` : t0 ? label(t0) : c.strokes.length ? 'sketch' : 'page';
    const color = a ? statusColor(a) : COLORS.draft;
    const canNav = !a && c.targets.length === 1 && !c.quote && !c.strokes.length;
    const thread = a && a.replies.length ? `<div class="thread">${a.replies.map((r) => `<div class="msg ${r.from}"><span class="who">${r.from === 'agent' ? 'Agent' : 'You'}</span>${escHtml(r.text)}</div>`).join('')}</div>` : '';
    el.composer.innerHTML = `
      <div class="c-head">
        <span class="c-num" style="background:${color}">${a ? a.id : 'New'}</span>
        <span class="c-target" title="${escHtml(t0 ? cssPath(t0) : '')}">${escHtml(tLabel)}</span>
        ${a ? `<span class="status-pill" style="background:${color}">${a.status}</span>` : ''}
        ${canNav ? `<button class="icon-btn" data-c="parent" title="Select parent (↑)" aria-label="Select parent">${icon('up', 15)}</button><button class="icon-btn" data-c="child" title="Select child (↓)" aria-label="Select child">${icon('down', 15)}</button>` : ''}
        <button class="icon-btn" data-c="cancel" title="Close (Esc)" aria-label="Close">${icon('close', 15)}</button>
      </div>
      <div class="c-body">
        <div class="kinds" role="radiogroup" aria-label="Type">${KINDS.map((k) => `<button class="kind ${c.kind === k.id ? 'on' : ''}" data-kind="${k.id}" role="radio" aria-checked="${c.kind === k.id}">${k.label}</button>`).join('')}</div>
        ${c.quote ? `<blockquote class="quote">“${escHtml(truncate(c.quote, 400))}”</blockquote>` : ''}
        ${c.strokes.length ? `<p class="sketch-note"><i></i>${c.strokes.length} stroke${c.strokes.length > 1 ? 's' : ''}${!a ? ' · keep drawing to add more' : ''}</p>` : ''}
        <textarea data-f="text" placeholder="${placeholderFor(c.kind)}" aria-label="Comment">${escHtml(c.text)}</textarea>
        ${thread ? `<div style="height:8px"></div>${thread}` : ''}
        ${a && a.replies.some((r) => r.from === 'agent') ? `<textarea data-f="reply" style="min-height:44px" placeholder="Reply to the agent…" aria-label="Reply">${escHtml(c.reply)}</textarea>` : ''}
      </div>
      <div class="c-foot">
        ${a ? `<button class="btn ghost" data-c="delete">Delete</button>` : ''}
        ${a && (a.status === 'sent' || a.status === 'draft') ? `<button class="btn" data-c="resolve">${icon('check', 13)} Resolve</button>` : ''}
        ${a && (a.status === 'resolved' || a.status === 'wontfix') ? `<button class="btn" data-c="reopen">Reopen</button>` : ''}
        <span class="grow"></span>
        <span class="kbd-hint">${/Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl'}↵</span>
        <button class="btn primary" data-c="save">${a ? 'Save' : 'Add'}</button>
      </div>`;
    el.composer.classList.add('open');
    positionComposer();
    if (focusedField) { const f = el.composer.querySelector(`[data-f="${focusedField}"]`); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  }

  function placeholderFor(kind) {
    return { change: 'What should change here?', bug: "What's wrong? What did you expect?", question: 'What do you want to know?', note: 'Add a note…' }[kind];
  }

  function positionComposer() {
    const c = S.composer;
    if (!c) return;
    const w = el.composer.offsetWidth || 340, h = el.composer.offsetHeight || 220;
    let r;
    if (c.range) r = c.range.getBoundingClientRect();
    else if (c.targets.length) {
      const rs = c.targets.map((t) => t.getBoundingClientRect());
      r = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)), right: Math.max(...rs.map((x) => x.right)), bottom: Math.max(...rs.map((x) => x.bottom)) };
    } else if (c.strokes.length) {
      const b = strokesBox(c.strokes);
      r = { left: b.x1 - scrollX, top: b.y1 - scrollY, right: b.x2 - scrollX, bottom: b.y2 - scrollY };
    } else r = { left: innerWidth / 2 - w / 2, top: innerHeight / 3, right: innerWidth / 2 + w / 2, bottom: innerHeight / 3 };
    const gap = 10, pad = 12;
    let top, left;
    if (innerHeight - r.bottom >= h + gap + pad) top = r.bottom + gap;
    else if (r.top >= h + gap + pad) top = r.top - h - gap;
    else if (innerWidth - r.right >= w + gap + pad) { left = r.right + gap; top = Math.max(pad, Math.min(innerHeight - h - pad, r.top)); }
    else if (r.left >= w + gap + pad) { left = r.left - w - gap; top = Math.max(pad, Math.min(innerHeight - h - pad, r.top)); }
    else top = innerHeight - h - 80;
    if (left === undefined) left = Math.max(pad, Math.min(innerWidth - w - pad, r.left));
    top = Math.max(pad, Math.min(innerHeight - h - pad, top));
    el.composer.style.left = left + 'px';
    el.composer.style.top = top + 'px';
  }

  el.composer.addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) { S.composer.kind = k.dataset.kind; renderComposer(); return; }
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const act = b.dataset.c;
    if (act === 'cancel') closeComposer();
    else if (act === 'save') saveComposer();
    else if (act === 'delete') deleteAnnotation(S.composer.id);
    else if (act === 'resolve') setStatus(S.composer.id, 'resolved');
    else if (act === 'reopen') setStatus(S.composer.id, 'draft');
    else if (act === 'parent') navTarget(1);
    else if (act === 'child') navTarget(-1);
  });
  el.composer.addEventListener('input', (e) => {
    if (e.target.dataset.f === 'text') S.composer.text = e.target.value;
    if (e.target.dataset.f === 'reply') S.composer.reply = e.target.value;
  });
  el.composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveComposer(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeComposer(); }
  });

  function navTarget(dir) {
    const c = S.composer;
    const cur = c.targets[0];
    if (!cur) return;
    let next = null;
    if (dir > 0) { if (cur.parentElement && cur.parentElement !== document.documentElement) { S.childTrail.push(cur); next = cur.parentElement; } }
    else next = S.childTrail.pop() || [...cur.children].find((ch) => ch.getBoundingClientRect().width > 0) || null;
    if (next) { c.targets = [next]; renderComposer(); schedule(); }
  }

  async function saveComposer() {
    const c = S.composer;
    if (!c) return;
    const text = (el.composer.querySelector('textarea[data-f="text"]')?.value ?? c.text).trim();
    const reply = (el.composer.querySelector('textarea[data-f="reply"]')?.value ?? '').trim();
    if (!text && !c.strokes.length && !c.quote && !reply) {
      el.composer.querySelector('textarea')?.focus();
      toast('Add a comment first.');
      return;
    }
    const vp = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
    try {
      if (c.id) {
        const cur = S.annotations.get(c.id);
        const body = { comment: text, kind: c.kind };
        if (reply) { body.reply = reply; body.status = 'draft'; }
        else if (cur && cur.status === 'sent' && (text !== cur.comment || c.kind !== cur.kind)) body.status = 'draft';
        const { annotation } = await api('PUT', `/annotations/${c.id}`, body);
        S.annotations.set(annotation.id, annotation);
        closeComposer();
        toast(body.status === 'draft' ? `#${annotation.id} updated — it'll go out with the next Send` : `#${annotation.id} saved`);
      } else {
        const targets = c.targets.map(describe);
        const payload = { kind: c.kind, comment: text, targets, quote: c.quote, strokes: c.strokes.map((s) => ({ color: s.color, points: s.points })), page: pageInfo(), viewport: vp };
        const els = c.targets.slice();
        const strokes = payload.strokes;
        const { annotation } = await api('POST', '/annotations', payload);
        S.annotations.set(annotation.id, annotation);
        S.elCache.set(annotation.id, els);
        closeComposer();
        if (CFG.screenshots !== false && els[0]) queueShot(annotation, els, strokes, c.quote);
      }
    } catch (err) {
      toast('Save failed: ' + err.message);
    }
    renderToolbar(); renderPanel(); refreshHighlights(); schedule();
  }

  async function deleteAnnotation(id) {
    try { await api('DELETE', `/annotations/${id}`); S.annotations.delete(id); } catch (err) { toast('Delete failed: ' + err.message); }
    closeComposer(); renderToolbar(); renderPanel(); refreshHighlights(); schedule();
  }
  async function setStatus(id, status) {
    try { const { annotation } = await api('PUT', `/annotations/${id}`, { status }); S.annotations.set(id, annotation); } catch (err) { toast(err.message); }
    closeComposer(); renderToolbar(); renderPanel(); schedule();
  }

  function focusAnnotation(id) {
    const a = S.annotations.get(id);
    if (!a) return;
    if (!onThisPage(a)) { toast(`#${id} is on ${a.page.path}`, { action: 'Go', onAction: () => { location.href = a.page.path; } }); return; }
    const [t] = resolveEls(a);
    if (!t) { toast(`Can't find #${id}'s element on this page anymore.`); openComposer({ id }); return; }
    const r = t.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 100) t.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    openComposer({ id });
    setTimeout(schedule, 350);
  }

  el.pins.addEventListener('click', (e) => {
    const p = e.target.closest('.pin');
    if (p) { e.stopPropagation(); if (S.mode === 'pick') setMode('idle'); openComposer({ id: p.dataset.id }); }
  });

  // -------------------------------------------------------------------------
  // Screenshots (element PNG with the sketch composited on top)
  // -------------------------------------------------------------------------

  let msLoad = null;
  function loadScreenshotLib() {
    if (window.modernScreenshot) return Promise.resolve(window.modernScreenshot);
    return msLoad || (msLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CFG.base + '/vendor/modern-screenshot.js';
      s.onload = () => (window.modernScreenshot ? resolve(window.modernScreenshot) : reject(new Error('screenshot lib unavailable')));
      s.onerror = () => reject(new Error('screenshot lib blocked'));
      (document.head || document.documentElement).appendChild(s);
    }));
  }

  function queueShot(annotation, els, strokes, quote) {
    const p = (async () => {
      const ms = await loadScreenshotLib();
      const target = shotRootFor(els.length > 1 ? commonAncestor(els) : els[0]);
      const r = target.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      const scale = Math.max(0.35, Math.min(devicePixelRatio || 1, 2, Math.sqrt(6e6 / area)));
      const canvas = await withTimeout(ms.domToCanvas(target, { scale, filter: (n) => n !== host && n !== pageStyle, backgroundColor: getBg(target) }), 15000);
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.scale(canvas.width / r.width, canvas.height / r.height);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // Box the picked element(s) when the shot includes surrounding context.
      if (target !== els[0] || els.length > 1) {
        ctx.strokeStyle = COLORS.draft; ctx.lineWidth = 2.5;
        for (const e of els) {
          const er = e.getBoundingClientRect();
          ctx.strokeRect(er.left - r.left - 2, er.top - r.top - 2, er.width + 4, er.height + 4);
        }
      }
      const qr = quote && findTextRange(els[0], quote);
      if (qr) {
        ctx.fillStyle = 'rgba(109,93,252,.25)';
        for (const q of qr.getClientRects()) ctx.fillRect(q.left - r.left, q.top - r.top, q.width, q.height);
      }
      if (strokes.length) {
        const ox = r.left + scrollX, oy = r.top + scrollY;
        ctx.lineWidth = 3.5;
        for (const s of strokes) {
          ctx.strokeStyle = s.color || COLORS.ink;
          ctx.beginPath();
          s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x - ox, y - oy) : ctx.moveTo(x - ox, y - oy)));
          ctx.stroke();
        }
      }
      ctx.restore();
      await api('POST', `/shot/${annotation.id}`, { dataUrl: canvas.toDataURL('image/png') });
    })().catch((err) => { console.warn('[pinpoint] screenshot skipped:', err && err.message); });
    S.pendingShots.add(p);
    p.finally(() => S.pendingShots.delete(p));
  }
  // Small elements are captured with some surrounding context so the image reads on its own.
  function shotRootFor(node) {
    let n = node;
    const min = Math.min(180, innerHeight / 3);
    while (n.parentElement && n !== document.body) {
      const r = n.getBoundingClientRect();
      if (r.height >= min && r.width >= 240) break;
      const pr = n.parentElement.getBoundingClientRect();
      if (pr.width * pr.height > innerWidth * innerHeight * 1.5) break;
      n = n.parentElement;
    }
    return n;
  }
  function commonAncestor(els) {
    let a = els[0];
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a || document.body;
  }
  function getBg(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return '#ffffff';
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async function sendDrafts(message) {
    const { drafts } = counts();
    if (!drafts && !message) { toast('Nothing new to send.'); return; }
    if (S.composer) await saveComposer();
    if (S.pendingShots.size) { toast('Finishing screenshots…', { ms: 1500 }); await Promise.race([Promise.allSettled([...S.pendingShots]), new Promise((r) => setTimeout(r, 8000))]); }
    try {
      const res = await api('POST', '/submit', { message: message || undefined });
      toast(res.delivered ? `Sent ${res.count} to the agent.` : `Queued ${res.count} — an agent picks them up with \`pinpoint wait\`. Or copy them as Markdown.`, res.delivered ? {} : { action: 'Copy', onAction: () => copyMarkdown('open') });
      const note = el.panel.querySelector('textarea[data-f="note"]');
      if (note) note.value = '';
    } catch (err) {
      toast('Send failed: ' + err.message);
    }
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  function togglePanel(force) {
    S.panelOpen = typeof force === 'boolean' ? force : !S.panelOpen;
    el.panel.classList.toggle('open', S.panelOpen);
    renderPanel();
    renderToolbar();
  }

  function renderPanel() {
    if (!S.panelOpen) return;
    const note = el.panel.querySelector('textarea[data-f="note"]');
    const noteVal = note ? note.value : '';
    const all = [...S.annotations.values()].sort((a, b) => b.n - a.n);
    const filters = { open: (a) => a.status === 'draft' || a.status === 'sent', draft: (a) => a.status === 'draft', done: (a) => a.status === 'resolved' || a.status === 'wontfix', all: () => true };
    const list = all.filter(filters[S.panelFilter]);
    const tab = (id, text) => `<button class="tab ${S.panelFilter === id ? 'on' : ''}" data-tab="${id}">${text} ${all.filter(filters[id]).length}</button>`;
    const { drafts } = counts();
    el.panel.innerHTML = `
      <div class="p-head"><h2>Annotations</h2><button class="icon-btn" data-p="close" aria-label="Close">${icon('close', 16)}</button></div>
      <div class="tabs">${tab('open', 'Open')}${tab('draft', 'Drafts')}${tab('done', 'Done')}${tab('all', 'All')}</div>
      <div class="p-list">${list.length ? list.map(itemHtml).join('') : `<div class="empty"><b>Nothing here yet</b>Press <b>Alt P</b> and click an element, <b>Alt D</b> to draw, or select text to quote it.</div>`}</div>
      <div class="p-foot">
        <textarea data-f="note" placeholder="Optional message for the whole batch…" aria-label="Message">${escHtml(noteVal)}</textarea>
        <div class="row"><span class="grow">${escHtml(S.listening ? 'Agent listening' : 'No agent listening — will queue')}</span>
          <button class="btn" data-p="copy">Copy Markdown</button>
          <button class="btn primary" data-p="send" ${drafts ? '' : 'disabled'}>Send ${drafts || ''}</button></div>
      </div>`;
  }

  function itemHtml(a) {
    const t = a.targets[0];
    const last = [...a.replies].reverse().find((r) => r.from === 'agent');
    const where = a.page && a.page.path !== location.pathname ? `${a.page.path} · ` : '';
    return `<button class="item" data-id="${a.id}">
      <span class="c-num" style="background:${statusColor(a)}">${a.id}</span>
      <span>
        <span class="i-top">${a.kind} · ${a.status}${a.quote ? ' · quote' : ''}${a.strokes.length ? ' · sketch' : ''}</span>
        <span class="i-comment">${escHtml(a.comment || (a.quote ? `“${truncate(a.quote, 120)}”` : '(no comment)'))}</span>
        <span class="i-meta">${escHtml(where + (t ? t.selector : 'page'))}</span>
        ${last ? `<span class="i-reply" style="display:block">${escHtml(truncate(last.text, 160))}</span>` : ''}
      </span></button>`;
  }

  el.panel.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { S.panelFilter = tab.dataset.tab; renderPanel(); return; }
    const item = e.target.closest('.item');
    if (item) { focusAnnotation(item.dataset.id); return; }
    const b = e.target.closest('[data-p]');
    if (!b) return;
    if (b.dataset.p === 'close') togglePanel(false);
    else if (b.dataset.p === 'copy') copyMarkdown();
    else if (b.dataset.p === 'send') sendDrafts(el.panel.querySelector('textarea[data-f="note"]').value.trim());
  });

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const map = { KeyP: () => setMode(S.mode === 'pick' ? 'idle' : 'pick'), KeyD: () => setMode(S.mode === 'draw' ? 'idle' : 'draw'), KeyL: () => togglePanel(), KeyH: () => togglePins(), Enter: () => sendDrafts() };
      const fn = map[e.code];
      if (fn) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (S.collapsed) { S.collapsed = false; persistUi(); renderToolbar(); }
        fn();
        return;
      }
    }
    if (ownEvent(e)) return;
    if (e.key === 'Escape') {
      if (S.menuOpen) { closeMenu(); return; }
      if (S.composer) { closeComposer(); e.preventDefault(); return; }
      if (S.multi.length) { S.multi = []; schedule(); return; }
      if (S.mode !== 'idle') { setMode('idle'); e.preventDefault(); return; }
      if (S.panelOpen) togglePanel(false);
      return;
    }
    if (S.mode === 'pick' && !S.composer && S.hoverEl) {
      if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        const p = S.hoverEl.parentElement;
        if (p && p !== document.documentElement) { S.childTrail.push(S.hoverEl); S.hoverEl = p; schedule(); }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation();
        const c = S.childTrail.pop() || [...S.hoverEl.children].find((ch) => ch.getBoundingClientRect().width > 0);
        if (c) { S.hoverEl = c; schedule(); }
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation();
        openComposer({ targets: S.multi.length ? [...S.multi] : [S.hoverEl] });
        S.multi = [];
      }
    }
  }, true);

  document.addEventListener('pointerdown', (e) => { if (S.menuOpen && !ownEvent(e)) closeMenu(); }, true);
  root.addEventListener('pointerdown', (e) => { if (S.menuOpen && !e.target.closest('.menu') && !e.target.closest('[data-act="menu"]')) closeMenu(); });

  // -------------------------------------------------------------------------
  // Follow the page
  // -------------------------------------------------------------------------

  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', () => { placeToolbar(); schedule(); }, { passive: true });
  let mutTimer = 0;
  new MutationObserver((muts) => {
    if (muts.every((m) => isOurs(m.target) || m.target === host)) return;
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      for (const [id, els] of S.elCache) if (!els.length || els.some((e) => !e.isConnected)) S.elCache.delete(id);
      refreshHighlights();
      schedule();
    }, 120);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    if (location.pathname !== S.path) {
      S.path = location.pathname;
      S.elCache.clear();
      if (S.composer && !S.composer.id) closeComposer();
      refreshHighlights();
      renderPanel();
      schedule();
    }
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }, 700);

  // Keep proxied navigation inside the proxy for absolute links to the target origin.
  document.addEventListener('click', (e) => {
    if (!CFG.targetOrigin || location.origin !== CFG.serverOrigin || e.defaultPrevented) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
    let u;
    try { u = new URL(a.href); } catch { return; }
    if (sameTargetOrigin(u.origin)) {
      e.preventDefault();
      location.href = location.origin + u.pathname + u.search + u.hash;
    }
  });

  // Public hooks for other scripts/tools on the page.
  window.pinpoint = {
    version: CFG.version,
    pick: () => setMode('pick'),
    draw: () => setMode('draw'),
    stop: () => setMode('idle'),
    send: (message) => sendDrafts(message),
    list: () => [...S.annotations.values()],
    open: (id) => focusAnnotation(String(id)),
    annotate: async (selectorOrElement, comment, kind = 'change') => {
      const t = typeof selectorOrElement === 'string' ? document.querySelector(selectorOrElement) : selectorOrElement;
      if (!t) throw new Error('element not found');
      const { annotation } = await api('POST', '/annotations', { kind, comment, targets: [describe(t)], page: pageInfo(), strokes: [], viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY } });
      S.annotations.set(annotation.id, annotation);
      renderToolbar(); renderPanel(); schedule();
      return annotation;
    },
  };

  renderToolbar();
  connect();
  schedule();
})();
