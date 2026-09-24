#!/usr/bin/env node
/**
 * Pinpoint — pick, highlight, sketch on and comment on elements of any web page,
 * then hand the feedback to an AI agent, another tool, or a human.
 *
 * Zero dependencies (Node 18+). One file is the CLI, the local helper server,
 * the reverse proxy that injects the overlay, and the static file server.
 *
 * State lives in $PINPOINT_HOME (default ~/.pinpoint)/sessions/<session>/.
 * Run `pinpoint help` for usage.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capture as captureScreen } from './screen/capture.mjs';

const VERSION = '1.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PINPOINT_HOME || path.join(os.homedir(), '.pinpoint');
const BASE = '/__pinpoint';
const DEFAULT_PORT = 4747;
const KINDS = ['change', 'bug', 'question', 'note'];
const STATUSES = ['draft', 'sent', 'resolved', 'wontfix'];

if (Number(process.versions.node.split('.')[0]) < 18 && !process.versions.bun) {
  fail('node_too_old', `Pinpoint needs Node.js 18+ (found ${process.version}).`);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      if (key.startsWith('no-')) { flags[key.slice(3)] = false; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && VALUE_FLAGS.has(key)) { flags[key] = next; i++; }
      else flags[key] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      const map = { s: 'session', p: 'port', f: 'format', t: 'timeout', h: 'help', d: 'delay' };
      const key = map[a[1]] || a[1];
      if (VALUE_FLAGS.has(key) && argv[i + 1] !== undefined) { flags[key] = argv[++i]; } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const VALUE_FLAGS = new Set(['session', 'port', 'format', 'timeout', 'status', 'page', 'note', 'message', 'host', 'dir', 'target', 'delay', 'image', 'snapshot', 'budget']);

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2) + '\n');
  process.exit(1);
}
function isTTY() { return !!process.stdout.isTTY; }
function sessionName(flags) {
  const s = String(flags.session || process.env.PINPOINT_SESSION || 'default');
  if (!/^[\w.-]{1,64}$/.test(s)) fail('bad_session', 'Session names may use letters, digits, ".", "_" and "-".');
  return s;
}
function sessionDir(session) { return path.join(HOME, 'sessions', session); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, data, mode) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function now() { return new Date().toISOString(); }
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------------------------------------------------------------------------
// Store: annotations + event queue, persisted as one JSON file per session
// ---------------------------------------------------------------------------

class Store {
  constructor(session) {
    this.session = session;
    this.dir = ensureDir(sessionDir(session));
    this.file = path.join(this.dir, 'state.json');
    this.shots = path.join(this.dir, 'shots');
    this.data = readJSON(this.file, null) || { version: 1, session, nextId: 1, nextSeq: 1, annotations: [], events: [] };
  }
  save() { writeJSON(this.file, this.data); }
  get(id) { return this.data.annotations.find((a) => a.id === String(id)); }
  list({ status, page } = {}) {
    let list = this.data.annotations;
    if (status && status !== 'all') {
      const want = status === 'open' ? ['draft', 'sent'] : String(status).split(',');
      list = list.filter((a) => want.includes(a.status));
    }
    if (page) list = list.filter((a) => (a.page?.url || '').includes(page));
    return list;
  }
  create(input) {
    const id = String(this.data.nextId++);
    const a = sanitizeAnnotation({ ...input, id, n: Number(id), status: 'draft', replies: [], createdAt: now() });
    a.updatedAt = a.createdAt;
    this.data.annotations.push(a);
    this.save();
    return a;
  }
  update(id, patch) {
    const a = this.get(id);
    if (!a) return null;
    const next = sanitizeAnnotation({ ...a, ...patch, id: a.id, n: a.n, createdAt: a.createdAt });
    next.updatedAt = now();
    Object.assign(a, next);
    this.save();
    return a;
  }
  remove(id) {
    const i = this.data.annotations.findIndex((a) => a.id === String(id));
    if (i < 0) return false;
    const [a] = this.data.annotations.splice(i, 1);
    if (a.screenshot) fs.rm(path.join(this.dir, a.screenshot), { force: true }, () => {});
    this.save();
    return true;
  }
  pushEvent(ev) {
    const e = { seq: this.data.nextSeq++, at: now(), delivered: false, ...ev };
    this.data.events.push(e);
    if (this.data.events.length > 200) this.data.events = this.data.events.slice(-200);
    this.save();
    return e;
  }
  nextUndelivered() { return this.data.events.find((e) => !e.delivered); }
  shotPath(a) { return a?.screenshot ? path.join(this.dir, a.screenshot) : null; }
}

function sanitizeAnnotation(a) {
  const clean = {
    id: String(a.id),
    n: a.n,
    status: STATUSES.includes(a.status) ? a.status : 'draft',
    kind: KINDS.includes(a.kind) ? a.kind : 'change',
    comment: truncate(a.comment || '', 8000),
    page: a.page ? {
      url: truncate(a.page.url, 2000),
      path: truncate(a.page.path, 1000),
      title: truncate(a.page.title, 300),
    } : null,
    targets: Array.isArray(a.targets) ? a.targets.slice(0, 20) : [],
    quote: a.quote ? truncate(a.quote, 2000) : null,
    strokes: Array.isArray(a.strokes) ? a.strokes.slice(0, 50).map((s) => ({
      color: typeof s.color === 'string' ? s.color.slice(0, 32) : undefined,
      points: Array.isArray(s.points) ? s.points.slice(0, 2000) : [],
    })) : [],
    viewport: a.viewport || null,
    screenshot: typeof a.screenshot === 'string' && /^shots\/[\w.-]+\.png$/.test(a.screenshot) ? a.screenshot : null,
    replies: Array.isArray(a.replies) ? a.replies.slice(-100).map((r) => ({
      from: r.from === 'agent' ? 'agent' : 'user', text: truncate(r.text, 8000), at: r.at || now(),
    })) : [],
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (a.sentAt) clean.sentAt = a.sentAt;
  const rect = (r) => (r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(+r[k])) ? { x: Math.round(+r.x), y: Math.round(+r.y), width: Math.round(+r.width), height: Math.round(+r.height) } : null);
  if (rect(a.region)) clean.region = rect(a.region);
  if (a.capture && /^\d+$/.test(String(a.capture.id))) {
    clean.capture = { id: String(a.capture.id), platform: truncate(a.capture.platform, 20), capturedAt: truncate(a.capture.capturedAt, 40) };
    if (rect(a.capture.screenRegion)) clean.capture.screenRegion = rect(a.capture.screenRegion);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Formatting: Markdown + compact agent JSON
// ---------------------------------------------------------------------------

function targetLabel(t) {
  if (!t) return '(page)';
  if (t.native) {
    const n = t.native;
    if (n.kind === 'desktop') return `desktop (${n.platform})`;
    const what = n.kind === 'window' ? `window of ${n.app || 'app'}` : `${t.tag || 'element'}`;
    const name = n.name || n.description || n.value;
    return `${what}${name ? ` "${truncate(String(name).replace(/\s+/g, ' '), 60)}"` : ''}${n.kind !== 'window' && n.app ? ` in ${n.app}${n.window && n.window !== n.app ? ` — ${truncate(n.window, 50)}` : ''}` : ''}`;
  }
  let s = `<${t.tag || 'element'}>`;
  if (t.text) s += ` "${truncate(t.text.replace(/\s+/g, ' ').trim(), 60)}"`;
  return s;
}
function captureImages(store, id) {
  const dir = path.join(store.dir, 'captures', String(id));
  try { return fs.readdirSync(dir).filter((f) => /^display-/.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; }
}
function nextCaptureId(store) {
  const dir = ensureDir(path.join(store.dir, 'captures'));
  const ids = fs.readdirSync(dir).map(Number).filter(Number.isFinite);
  return String(ids.length ? Math.max(...ids) + 1 : 1);
}
async function doCapture(store, opts) {
  const id = nextCaptureId(store);
  const dir = path.join(store.dir, 'captures', id);
  try {
    const snap = await captureScreen(dir, opts);
    return { id, dir, snap };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

function sourceLabel(src) {
  if (!src) return '';
  const parts = [];
  if (src.file) parts.push(`${src.file}${src.line ? ':' + src.line : ''}${src.column ? ':' + src.column : ''}`);
  if (src.components?.length) parts.push(src.components.map((c) => `<${c}>`).join(' ‹ '));
  return parts.join(' · ');
}

function toMarkdown(store, list, { title } = {}) {
  const lines = [];
  const open = list.filter((a) => a.status === 'draft' || a.status === 'sent').length;
  lines.push(`# ${title || 'Pinpoint feedback'} (${list.length} annotation${list.length === 1 ? '' : 's'}, ${open} open)`);
  lines.push('');
  const byPage = new Map();
  for (const a of list) {
    const key = a.page?.url || '(unknown page)';
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(a);
  }
  for (const [url, items] of byPage) {
    const t = items[0].page?.title;
    lines.push(`## ${url}${t ? ` — ${t}` : ''}`);
    lines.push('');
    for (const a of items) {
      lines.push(`### #${a.id} · ${a.kind} · ${a.status}`);
      if (a.comment) lines.push(...a.comment.split('\n').map((l) => `> ${l}`));
      else lines.push('> (no comment)');
      lines.push('');
      a.targets.forEach((tg, i) => {
        const prefix = a.targets.length > 1 ? `Element ${i + 1}` : 'Element';
        if (tg.native) {
          lines.push(`- **${prefix}:** ${targetLabel(tg)}`);
          if (tg.native.path) lines.push(`  - Path: ${tg.native.path}`);
          if (tg.screen) lines.push(`  - Screen rect: ${tg.screen.x},${tg.screen.y} ${tg.screen.width}×${tg.screen.height}`);
          if (tg.native.identifier) lines.push(`  - Identifier: \`${tg.native.identifier}\``);
        } else {
          lines.push(`- **${prefix}:** ${targetLabel(tg)} — \`${tg.selector}\``);
          const src = sourceLabel(tg.source);
          if (src) lines.push(`  - Source: ${src}`);
        }
      });
      if (a.region) lines.push(`- **Region:** ${a.capture?.screenRegion ? `screen ${a.capture.screenRegion.x},${a.capture.screenRegion.y} ${a.capture.screenRegion.width}×${a.capture.screenRegion.height}` : `${a.region.width}×${a.region.height} at ${a.region.x},${a.region.y} (page)`}`);
      if (a.capture) {
        const full = captureImages(store, a.capture.id);
        if (full.length) lines.push(`- **Full capture:** ${full.join(', ')}`);
      }
      if (a.quote) lines.push(`- **Quoted text:** "${a.quote.replace(/\s+/g, ' ').trim()}"`);
      if (a.strokes?.length) lines.push(`- **Sketch:** ${a.strokes.length} stroke${a.strokes.length === 1 ? '' : 's'} drawn on the page (see screenshot)`);
      const shot = store.shotPath(a);
      if (shot && fs.existsSync(shot)) lines.push(`- **Screenshot:** ${shot}`);
      if (a.replies?.length) {
        lines.push('- **Thread:**');
        for (const r of a.replies) lines.push(`  - _${r.from}:_ ${r.text.replace(/\n/g, ' ')}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** Compact form for agents: everything useful, nothing huge. */
function forAgent(store, a) {
  const shot = store.shotPath(a);
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    comment: a.comment,
    page: a.page,
    quote: a.quote || undefined,
    region: a.region || undefined,
    capture: a.capture ? { ...a.capture, images: captureImages(store, a.capture.id) } : undefined,
    targets: a.targets.map((t) => t.native ? ({
      kind: t.native.kind, app: t.native.app, window: t.native.window, role: t.native.role, name: t.native.name,
      description: t.native.description, value: t.native.value, identifier: t.native.identifier, className: t.native.className,
      pid: t.native.pid, path: t.native.path, screen: t.screen,
    }) : ({
      selector: t.selector,
      tag: t.tag,
      text: t.text ? truncate(t.text, 200) : undefined,
      source: t.source && Object.keys(t.source).length ? t.source : undefined,
      attrs: t.attrs && Object.keys(t.attrs).length ? t.attrs : undefined,
      rect: t.rect,
      styles: t.styles,
      html: t.html ? truncate(t.html, 800) : undefined,
    })),
    sketch: a.strokes?.length ? { strokes: a.strokes.length } : undefined,
    screenshot: shot && fs.existsSync(shot) ? shot : undefined,
    replies: a.replies?.length ? a.replies : undefined,
  };
}

// ---------------------------------------------------------------------------
// Targets: URL (proxy), local file/dir (static), or none (inject/bookmarklet)
// ---------------------------------------------------------------------------

function resolveTarget(raw) {
  if (!raw) return { kind: 'none' };
  let s = String(raw).trim();
  if (/^\d+$/.test(s)) s = `http://localhost:${s}`;
  else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(s)) s = `http://${s}`;
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return { kind: 'url', url: u.href, origin: u.origin, entry: u.pathname + u.search + u.hash };
  }
  const abs = path.resolve(s);
  if (!fs.existsSync(abs)) fail('target_not_found', `No such file, directory or URL: ${raw}`);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return { kind: 'static', root: abs, entry: '/' };
  return { kind: 'static', root: path.dirname(abs), entry: '/' + encodeURIComponent(path.basename(abs)) };
}

function describeTarget(t) {
  if (t.kind === 'url') return t.url;
  if (t.kind === 'static') return path.join(t.root, decodeURIComponent(t.entry));
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.xml': 'application/xml', '.map': 'application/json',
};

function injectTag() { return `<script src="${BASE}/overlay.js" data-pinpoint defer></script>`; }
function injectHtml(html, { stripCspMeta } = {}) {
  if (html.includes(`${BASE}/overlay.js`)) return html;
  if (stripCspMeta) html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  const tag = injectTag();
  const body = html.toLowerCase().lastIndexOf('</body>');
  if (body >= 0) return html.slice(0, body) + tag + html.slice(body);
  const head = html.toLowerCase().indexOf('</head>');
  if (head >= 0) return html.slice(0, head) + tag + html.slice(head);
  return html + tag;
}

function serve(opts) {
  const session = opts.session;
  const store = new Store(session);
  const pageToken = crypto.randomBytes(16).toString('hex');
  const adminToken = crypto.randomBytes(16).toString('hex');
  let target = opts.target;
  const screenshots = opts.screenshots !== false;
  const sse = new Set();
  const waiters = [];
  const serverFile = path.join(store.dir, 'server.json');
  let port = 0;

  const broadcast = (msg) => {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of sse) res.write(data);
  };
  const broadcastListening = () => broadcast({ type: 'listening', count: waiters.length });

  function buildEvent(e) {
    if (e.type === 'submit') {
      const list = e.ids.map((id) => store.get(id)).filter(Boolean);
      return {
        type: 'submit', seq: e.seq, session, at: e.at, message: e.message || undefined, count: list.length,
        annotations: list.map((a) => forAgent(store, a)),
        next: `Act on each annotation, then report back per item with: pinpoint reply <id> "<what you did>" --status resolved (or --status wontfix / leave open with a question). Then run \`pinpoint wait\` again${session !== 'default' ? ` --session ${session}` : ''}.`,
      };
    }
    if (e.type === 'end') return { type: 'end', seq: e.seq, session, at: e.at, next: 'The user ended the feedback session. Stop polling; optionally run `pinpoint stop`.' };
    return { ...e };
  }

  function deliver() {
    while (waiters.length) {
      const ev = store.nextUndelivered();
      if (!ev) break;
      const w = waiters.shift();
      clearTimeout(w.timer);
      ev.delivered = true;
      store.save();
      const payload = buildEvent(ev);
      if (w.format === 'md' && payload.type === 'submit') {
        const list = ev.ids.map((id) => store.get(id)).filter(Boolean);
        sendText(w.res, 200, toMarkdown(store, list, { title: `Pinpoint submit #${ev.seq}` }) + (ev.message ? `\n**Message from user:** ${ev.message}\n` : '') + `\n_${payload.next}_\n`);
      } else sendJSON(w.res, 200, payload);
    }
    broadcastListening();
  }

  function cors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,x-pinpoint-token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  }
  function tokenOf(req, url) { return req.headers['x-pinpoint-token'] || url.searchParams.get('token'); }
  function isPage(tok) { return tok === pageToken || tok === adminToken; }

  async function readBody(req, limit = 25 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  function overlayConfig(req) {
    const host = req.headers.host || `127.0.0.1:${port}`;
    return {
      version: VERSION, session, token: pageToken,
      base: `http://${host}${BASE}`,
      serverOrigin: `http://${host}`,
      targetOrigin: target.kind === 'url' ? target.origin : null,
      screenshots,
    };
  }

  async function handleApi(req, res, url) {
    const p = url.pathname.slice(BASE.length);
    const tok = tokenOf(req, url);
    const m = req.method;

    if (p === '/api/health') return sendJSON(res, 200, { ok: true, app: 'pinpoint', version: VERSION, session, pid: process.pid, port });

    // Admin-only endpoints (CLI, other tools). Token lives in server.json (mode 600).
    if (p === '/api/wait' && m === 'GET') {
      if (tok !== adminToken) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      const timeout = Math.max(1, Math.min(Number(url.searchParams.get('timeout')) || 600, 86400));
      const w = { res, format: url.searchParams.get('format') };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        broadcastListening();
        sendJSON(res, 200, { type: 'timeout', session, next: 'Nothing was sent yet. Run `pinpoint wait` again to keep listening.' });
      }, timeout * 1000);
      req.on('close', () => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.timer); broadcastListening(); }
      });
      waiters.push(w);
      deliver();
      return;
    }
    if (p === '/api/reply' && m === 'POST') {
      if (tok !== adminToken) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      const body = await readBody(req);
      const ids = [].concat(body.id ?? body.ids ?? []).map(String);
      if (!ids.length) return sendJSON(res, 400, { ok: false, error: 'missing_id' });
      const updated = [];
      for (const id of ids) {
        const a = store.get(id);
        if (!a) return sendJSON(res, 404, { ok: false, error: 'not_found', id });
        const patch = {};
        if (body.text) patch.replies = [...a.replies, { from: 'agent', text: String(body.text), at: now() }];
        if (body.status) {
          const st = body.status === 'open' ? 'draft' : body.status;
          if (!STATUSES.includes(st)) return sendJSON(res, 400, { ok: false, error: 'bad_status', allowed: [...STATUSES, 'open'] });
          patch.status = st;
        }
        const u = store.update(id, patch);
        updated.push(u);
        broadcast({ type: 'upsert', annotation: u, reply: !!body.text });
      }
      return sendJSON(res, 200, { ok: true, updated: updated.map((a) => ({ id: a.id, status: a.status })) });
    }
    if (p === '/api/target' && m === 'POST') {
      if (tok !== adminToken) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      const body = await readBody(req);
      target = body.target;
      writeServerFile();
      broadcast({ type: 'target', targetOrigin: target.kind === 'url' ? target.origin : null });
      return sendJSON(res, 200, { ok: true, target: describeTarget(target) });
    }
    if (p === '/api/stop' && m === 'POST') {
      if (tok !== adminToken) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      sendJSON(res, 200, { ok: true });
      setTimeout(shutdown, 50);
      return;
    }
    if (p === '/api/clear' && m === 'POST') {
      if (tok !== adminToken) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      const body = await readBody(req);
      const removed = clearAnnotations(store, body.which || 'all');
      broadcast({ type: 'snapshot', annotations: store.data.annotations, listening: waiters.length });
      return sendJSON(res, 200, { ok: true, removed });
    }

    // Page-level endpoints (overlay, dashboard).
    if (!isPage(tok)) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/stream' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', annotations: store.data.annotations, listening: waiters.length })}\n\n`);
      sse.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); sse.delete(res); });
      return;
    }
    if (p === '/api/annotations' && m === 'GET') {
      return sendJSON(res, 200, { ok: true, annotations: store.list({ status: url.searchParams.get('status') || 'all' }), listening: waiters.length });
    }
    if (p === '/api/annotations' && m === 'POST') {
      const body = await readBody(req);
      const a = store.create(body);
      broadcast({ type: 'upsert', annotation: a });
      return sendJSON(res, 200, { ok: true, annotation: a });
    }
    let mm = p.match(/^\/api\/annotations\/([\w-]+)$/);
    if (mm && m === 'PUT') {
      const body = await readBody(req);
      const cur = store.get(mm[1]);
      if (!cur) return sendJSON(res, 404, { ok: false, error: 'not_found' });
      const patch = {};
      for (const k of ['kind', 'comment', 'targets', 'quote', 'strokes', 'status', 'page', 'viewport']) if (k in body) patch[k] = body[k];
      if (body.reply) patch.replies = [...cur.replies, { from: 'user', text: String(body.reply), at: now() }];
      const a = store.update(mm[1], patch);
      broadcast({ type: 'upsert', annotation: a });
      return sendJSON(res, 200, { ok: true, annotation: a });
    }
    if (mm && m === 'DELETE') {
      const ok = store.remove(mm[1]);
      if (ok) broadcast({ type: 'delete', id: mm[1] });
      return sendJSON(res, ok ? 200 : 404, { ok });
    }
    mm = p.match(/^\/api\/shot\/([\w-]+)$/);
    if (mm && m === 'POST') {
      const body = await readBody(req);
      const a = store.get(mm[1]);
      if (!a) return sendJSON(res, 404, { ok: false, error: 'not_found' });
      const match = /^data:image\/png;base64,(.+)$/.exec(body.dataUrl || '');
      if (!match) return sendJSON(res, 400, { ok: false, error: 'expected_png_data_url' });
      ensureDir(store.shots);
      const rel = `shots/${a.id}.png`;
      fs.writeFileSync(path.join(store.dir, rel), Buffer.from(match[1], 'base64'));
      const u = store.update(a.id, { screenshot: rel });
      broadcast({ type: 'upsert', annotation: u });
      return sendJSON(res, 200, { ok: true, path: path.join(store.dir, rel) });
    }
    mm = p.match(/^\/captures\/(\d+)\/(snapshot\.json|display-[\w-]+\.(?:png|jpe?g|webp|gif))$/);
    if (mm && m === 'GET') {
      const file = path.join(store.dir, 'captures', mm[1], mm[2]);
      if (!fs.existsSync(file)) return sendJSON(res, 404, { ok: false, error: 'not_found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/captures' && m === 'GET') {
      const dir = path.join(store.dir, 'captures');
      const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a) : [];
      const host = req.headers.host || `127.0.0.1:${port}`;
      return sendJSON(res, 200, { ok: true, captures: ids.map((id) => {
        const snap = readJSON(path.join(dir, id, 'snapshot.json'), {});
        return { id, url: `http://${host}${BASE}/screen/${id}`, capturedAt: snap.capturedAt, platform: snap.platform, windows: (snap.nodes || []).filter((n) => n.kind === 'window').length };
      }) });
    }
    if (p === '/api/capture' && m === 'POST') {
      const body = await readBody(req);
      const delay = Math.max(0, Math.min(Number(body.delay) || 0, 30));
      if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
      try {
        const { id, snap } = await doCapture(store, { elements: body.elements !== false });
        const host = req.headers.host || `127.0.0.1:${port}`;
        const url = `http://${host}${BASE}/screen/${id}`;
        broadcast({ type: 'capture', id, url });
        return sendJSON(res, 200, { ok: true, id, url, warnings: snap.warnings });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: 'capture_failed', message: e.message });
      }
    }
    mm = p.match(/^\/shots\/([\w-]+\.png)$/);
    if (mm && m === 'GET') {
      const file = path.join(store.shots, mm[1]);
      if (!fs.existsSync(file)) return sendJSON(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/submit' && m === 'POST') {
      const body = await readBody(req);
      let ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : store.list({ status: 'draft' }).map((a) => a.id);
      ids = ids.filter((id) => store.get(id));
      if (!ids.length && !body.message) return sendJSON(res, 400, { ok: false, error: 'nothing_to_send' });
      const at = now();
      for (const id of ids) {
        const a = store.update(id, { status: 'sent' });
        a.sentAt = at;
        broadcast({ type: 'upsert', annotation: a });
      }
      store.save();
      const ev = store.pushEvent({ type: 'submit', ids, message: body.message ? truncate(body.message, 8000) : undefined });
      const hadListener = waiters.length > 0;
      deliver();
      return sendJSON(res, 200, { ok: true, seq: ev.seq, count: ids.length, delivered: hadListener });
    }
    if (p === '/api/end' && m === 'POST') {
      store.pushEvent({ type: 'end' });
      deliver();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/export' && m === 'GET') {
      const list = store.list({ status: url.searchParams.get('status') || 'all' });
      if (url.searchParams.get('format') === 'json') {
        res.setHeader('content-disposition', `attachment; filename="pinpoint-${session}.json"`);
        return sendJSON(res, 200, { session, exportedAt: now(), annotations: list.map((a) => ({ ...a, screenshot: store.shotPath(a) || undefined })) });
      }
      return sendText(res, 200, toMarkdown(store, list), 'text/markdown; charset=utf-8');
    }
    return sendJSON(res, 404, { ok: false, error: 'unknown_endpoint' });
  }

  function handlePinpoint(req, res, url) {
    const p = url.pathname.slice(BASE.length);
    if (p === '/overlay.js') {
      const src = fs.readFileSync(path.join(HERE, 'overlay.js'), 'utf8');
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(`window.__PINPOINT__=${JSON.stringify(overlayConfig(req))};\n${src}`);
    }
    if (p === '/vendor/modern-screenshot.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'max-age=3600' });
      return fs.createReadStream(path.join(HERE, 'vendor', 'modern-screenshot.umd.js')).pipe(res);
    }
    const sm = p.match(/^\/screen\/(\d+)$/);
    if (sm) {
      const host = req.headers.host || `127.0.0.1:${port}`;
      const cfg = { token: pageToken, base: `http://${host}${BASE}`, captureId: sm[1], session };
      return sendText(res, 200, fs.readFileSync(path.join(HERE, 'board.html'), 'utf8').replace('__PP_BOARD__', JSON.stringify(cfg).replace(/</g, '\\u003c')), MIME['.html'], { 'cache-control': 'no-store' });
    }
    if (p === '' || p === '/') {
      const host = req.headers.host || `127.0.0.1:${port}`;
      return sendText(res, 200, dashboardHtml({ session, pageToken, host, target }), MIME['.html']);
    }
    return handleApi(req, res, url).catch((e) => sendJSON(res, e.status || 500, { ok: false, error: e.message }));
  }

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return sendText(res, 400, 'Bad path'); }
    let file = path.join(target.root, rel);
    if (!file.startsWith(target.root)) return sendText(res, 403, 'Forbidden');
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch { /* handled below */ }
    if (!fs.existsSync(file)) {
      if (rel === '/' ) return sendText(res, 200, dirListing(target.root), MIME['.html']);
      return sendText(res, 404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      return sendText(res, 200, injectHtml(fs.readFileSync(file, 'utf8')), type, { 'cache-control': 'no-store' });
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  function proxy(req, res, url) {
    const t = new URL(target.url);
    const upstream = new URL(url.pathname + url.search, t.origin);
    const mod = upstream.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: upstream.host, 'accept-encoding': 'gzip, deflate, br' };
    const myOrigin = `http://${req.headers.host}`;
    if (headers.origin) headers.origin = t.origin;
    if (headers.referer) headers.referer = headers.referer.replace(myOrigin, t.origin);
    delete headers['if-none-match']; // always get a body we can inject into
    delete headers['if-modified-since'];
    const up = mod.request(upstream, { method: req.method, headers }, (ur) => {
      const h = { ...ur.headers };
      delete h['content-security-policy'];
      delete h['content-security-policy-report-only'];
      delete h['strict-transport-security'];
      if (h.location) {
        try {
          const loc = new URL(h.location, upstream);
          if (loc.origin === t.origin) h.location = loc.pathname + loc.search + loc.hash;
        } catch { /* leave as is */ }
      }
      if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
      const type = String(h['content-type'] || '');
      if (!type.includes('text/html') || req.method === 'HEAD' || ur.statusCode === 204 || ur.statusCode === 304) {
        res.writeHead(ur.statusCode, ur.statusMessage, h);
        return ur.pipe(res);
      }
      const enc = String(h['content-encoding'] || '').toLowerCase();
      let stream = ur;
      if (enc === 'gzip' || enc === 'x-gzip') stream = ur.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = ur.pipe(zlib.createInflate());
      else if (enc === 'br') stream = ur.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', () => { if (!res.headersSent) sendText(res, 502, 'Pinpoint: failed to decode upstream response'); });
      stream.on('end', () => {
        const html = injectHtml(Buffer.concat(chunks).toString('utf8'), { stripCspMeta: true });
        delete h['content-encoding'];
        delete h['content-length'];
        delete h['transfer-encoding'];
        delete h.etag;
        h['cache-control'] = 'no-store';
        const body = Buffer.from(html, 'utf8');
        h['content-length'] = String(body.length);
        res.writeHead(ur.statusCode, ur.statusMessage, h);
        res.end(body);
      });
    });
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      sendText(res, 502, upstreamErrorHtml(target.url, e), MIME['.html']);
    });
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendText(res, 400, 'Bad request'); }
    if (url.pathname === BASE || url.pathname.startsWith(BASE + '/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return handlePinpoint(req, res, url);
    }
    if (target.kind === 'url') return proxy(req, res, url);
    if (target.kind === 'static') return serveStatic(req, res, url);
    res.writeHead(302, { location: `${BASE}/` });
    res.end();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

  // WebSocket passthrough so dev-server HMR keeps working through the proxy.
  server.on('upgrade', (req, socket, head) => {
    if (target.kind !== 'url') return socket.destroy();
    const t = new URL(target.url);
    const secure = t.protocol === 'https:';
    const upPort = Number(t.port) || (secure ? 443 : 80);
    const up = secure ? tls.connect({ host: t.hostname, port: upPort, servername: t.hostname }) : net.connect(upPort, t.hostname);
    up.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        let [k, v] = [req.rawHeaders[i], req.rawHeaders[i + 1]];
        if (/^host$/i.test(k)) v = t.host;
        else if (/^origin$/i.test(k)) v = t.origin;
        lines.push(`${k}: ${v}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const kill = () => { socket.destroy(); up.destroy(); };
    up.on('error', kill);
    socket.on('error', kill);
  });

  function writeServerFile() {
    writeJSON(serverFile, {
      pid: process.pid, port, session, version: VERSION, adminToken, pageToken,
      host: opts.host, url: `http://${opts.host}:${port}`, target, startedAt: now(),
    }, 0o600);
  }

  function shutdown() {
    try {
      const cur = readJSON(serverFile, null);
      if (cur?.pid === process.pid) fs.rmSync(serverFile, { force: true });
    } catch { /* ignore */ }
    for (const w of waiters) sendJSON(w.res, 200, { type: 'stopped', session });
    for (const r of sse) r.end();
    server.close();
    setTimeout(() => process.exit(0), 100).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise((resolve, reject) => {
    let tryPort = opts.port || DEFAULT_PORT;
    const fixed = !!opts.port;
    const attempt = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && !fixed && tryPort < (opts.port || DEFAULT_PORT) + 50) { tryPort++; attempt(); }
        else reject(e);
      });
      server.listen(tryPort, opts.host, () => {
        port = server.address().port;
        writeServerFile();
        resolve({ port, server });
      });
    };
    attempt();
  });
}

function clearAnnotations(store, which) {
  const before = store.data.annotations.length;
  const keep = (a) => {
    if (which === 'all') return false;
    if (which === 'resolved') return !['resolved', 'wontfix'].includes(a.status);
    if (which === 'sent') return a.status !== 'sent';
    return true;
  };
  const removed = store.data.annotations.filter((a) => !keep(a));
  for (const a of removed) if (a.screenshot) fs.rmSync(path.join(store.dir, a.screenshot), { force: true });
  store.data.annotations = store.data.annotations.filter(keep);
  if (which === 'all') store.data.events = [];
  store.save();
  return before - store.data.annotations.length;
}

function sendJSON(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, ...extra });
  res.end(text);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function upstreamErrorHtml(url, e) {
  return `<!doctype html><meta charset="utf-8"><title>Pinpoint: target unreachable</title>
<body style="font:15px/1.5 system-ui;max-width:560px;margin:15vh auto;padding:0 16px;color:#222">
<h1 style="font-size:20px">Can't reach ${esc(url)}</h1>
<p>${esc(e.code || e.message)}. Start the app (or dev server) and reload this page.</p>
${injectTag()}</body>`;
}

function dirListing(root) {
  const files = fs.readdirSync(root).filter((f) => /\.html?$/i.test(f)).sort();
  return `<!doctype html><meta charset="utf-8"><title>Pinpoint</title><body style="font:15px/1.6 system-ui;max-width:560px;margin:10vh auto;padding:0 16px">
<h1 style="font-size:20px">Pick a page to annotate</h1><ul>${files.map((f) => `<li><a href="/${encodeURIComponent(f)}">${esc(f)}</a></li>`).join('') || '<li>No .html files in this folder.</li>'}</ul></body>`;
}

function dashboardHtml({ session, pageToken, host, target }) {
  const base = `http://${host}${BASE}`;
  const bookmarklet = `javascript:(()=>{if(window.__PINPOINT_LOADED__)return;const s=document.createElement('script');s.src='${base}/overlay.js';document.documentElement.appendChild(s)})()`;
  const openUrl = target.kind === 'none' ? null : `http://${host}${target.entry || '/'}`;
  return fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8')
    .replaceAll('__PP_CONFIG__', JSON.stringify({ session, token: pageToken, base, openUrl, target: describeTarget(target), bookmarklet, snippet: `<script src="${base}/overlay.js" defer></script>`, version: VERSION }).replace(/</g, '\\u003c'))
    .replaceAll('__PP_SESSION__', esc(session));
}

// ---------------------------------------------------------------------------
// Client helpers (CLI → running server)
// ---------------------------------------------------------------------------

function serverInfo(session) {
  const info = readJSON(path.join(sessionDir(session), 'server.json'), null);
  if (!info || !pidAlive(info.pid)) return null;
  return info;
}

function call(info, method, p, body, { timeoutMs = 10000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: info.host || '127.0.0.1', port: info.port, method, path: BASE + p,
      headers: { 'x-pinpoint-token': info.adminToken, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (raw) return resolve({ status: res.statusCode, text });
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`Bad response: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function health(info) {
  try { const h = await call(info, 'GET', '/api/health', null, { timeoutMs: 1500 }); return h?.ok ? h : null; } catch { return null; }
}

function openBrowser(url) {
  if (process.env.PINPOINT_NO_OPEN) return false;
  let cmd, args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdOpen(pos, flags, { injectOnly = false } = {}) {
  const session = sessionName(flags);
  const target = injectOnly ? { kind: 'none' } : resolveTarget(pos[0] || flags.target);
  const host = flags.host || '127.0.0.1';
  let info = serverInfo(session);
  if (info && !(await health(info))) info = null;

  if (flags.foreground) {
    if (info) fail('already_running', `Session "${session}" is already running on port ${info.port}. Use --session to start another, or \`pinpoint stop\`.`);
    const { port } = await serve({ session, target, host, port: flags.port ? Number(flags.port) : 0, screenshots: flags.screenshots });
    const res = openResult(session, host, port, target);
    printOpen(res);
    if (flags.open !== false) openBrowser(res.url);
    return; // keep running
  }

  if (!info) {
    info = await startDaemon(session, host, target, flags);
  } else if (!injectOnly && JSON.stringify(info.target) !== JSON.stringify(target) && target.kind !== 'none') {
    await call(info, 'POST', '/api/target', { target });
    info = serverInfo(session);
  }

  const res = openResult(session, info.host, info.port, info.target);
  if (flags.open !== false && !injectOnly) res.browserOpened = openBrowser(res.url);
  if (injectOnly) {
    res.snippet = `<script src="http://${info.host}:${info.port}${BASE}/overlay.js" defer></script>`;
    res.bookmarklet = `javascript:(()=>{if(window.__PINPOINT_LOADED__)return;const s=document.createElement('script');s.src='http://${info.host}:${info.port}${BASE}/overlay.js';document.documentElement.appendChild(s)})()`;
  }
  printOpen(res);
}

async function startDaemon(session, host, target, flags) {
    let info = null;
    const dir = ensureDir(sessionDir(session));
    const log = fs.openSync(path.join(dir, 'server.log'), 'a');
    const args = [fileURLToPath(import.meta.url), '__serve', '--session', session, '--host', host,
      '--target', JSON.stringify(target)];
    if (flags.port) args.push('--port', String(flags.port));
    if (flags.screenshots === false) args.push('--no-screenshots');
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const i = serverInfo(session);
      if (i && i.pid === child.pid && (await health(i))) { info = i; break; }
    }
    if (!info) fail('server_start_failed', `Server did not start. See ${path.join(dir, 'server.log')}`);
    return info;
}

async function cmdScreen(pos, flags) {
  const session = sessionName(flags);
  const host = flags.host || '127.0.0.1';
  const image = flags.image || (pos[0] && fs.existsSync(pos[0]) ? pos[0] : null);
  if (image && !fs.existsSync(image)) fail('target_not_found', `No such image: ${image}`);
  if (flags.snapshot && !image) fail('missing_image', '--snapshot needs --image <file> to go with it.');
  let info = serverInfo(session);
  if (info && !(await health(info))) info = null;
  if (!info) info = await startDaemon(session, host, { kind: 'none' }, flags);
  const delay = Math.max(0, Number(flags.delay) || 0);
  if (delay && !image) {
    for (let i = delay; i > 0; i--) {
      if (process.stderr.isTTY) process.stderr.write(`\rCapturing the screen in ${i}s… `);
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  }
  const store = new Store(session);
  let result;
  try {
    result = await doCapture(store, {
      image, snapshot: flags.snapshot, elements: flags.elements !== false,
      budgetMs: flags.budget ? Math.round(Number(flags.budget) * 1000) : undefined,
    });
  } catch (e) {
    fail('capture_failed', e.message);
  }
  const { id, dir, snap } = result;
  const url = `http://${info.host}:${info.port}${BASE}/screen/${id}`;
  const windows = snap.nodes.filter((n) => n.kind === 'window').length;
  const res = {
    ok: true, session, capture: id, url, mode: image ? 'image' : 'screen', platform: snap.platform,
    displays: snap.displays.length, windows, elements: snap.nodes.length - windows,
    images: snap.displays.map((d) => path.join(dir, d.file)), warnings: snap.warnings,
    next: `Open the url (fullscreen works best; browser zoom to fit). The user picks windows/elements, drags regions or draws, then clicks Send. Listen with: pinpoint wait${session !== 'default' ? ` --session ${session}` : ''}`,
  };
  if (flags.open !== false) res.browserOpened = openBrowser(url);
  if (!isTTY()) return out(res);
  process.stdout.write([
    '', `  Pinpoint ${image ? 'image' : 'screen capture'} #${id}  (session "${session}")`, '',
    `  Annotate:  ${url}`,
    image ? '' : `  Captured:  ${res.displays} display(s), ${windows} windows, ${res.elements} UI elements`,
    ...snap.warnings.map((w) => `  Note:      ${w}`),
    '', '  Alt+P pick (click a window/element, drag a region) · Alt+D draw · Alt+Enter send', '',
  ].filter((l) => l !== null).join('\n') + '\n');
}

function openResult(session, host, port, target) {
  const origin = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    ok: true, session, port,
    url: target.kind === 'none' ? `${origin}${BASE}/` : origin + (target.entry || '/'),
    dashboard: `${origin}${BASE}/`,
    target: describeTarget(target),
    mode: target.kind === 'url' ? 'proxy' : target.kind === 'static' ? 'static' : 'inject',
    state: path.join(sessionDir(session), 'state.json'),
    next: `Open the url in a browser. Listen for feedback with: pinpoint wait${session !== 'default' ? ` --session ${session}` : ''} (run it in the background; it returns when the user clicks Send).`,
  };
}

function printOpen(res) {
  if (!isTTY()) return out(res);
  const lines = [
    '',
    `  Pinpoint is running  (session "${res.session}", ${res.mode} mode)`,
    '',
    `  Annotate:   ${res.url}`,
    `  Dashboard:  ${res.dashboard}`,
  ];
  if (res.target) lines.push(`  Target:     ${res.target}`);
  if (res.snippet) lines.push('', '  Add to any page:', `    ${res.snippet}`, '  or use the bookmarklet from the dashboard.');
  lines.push('', '  In the page: Alt+P pick · Alt+D draw · select text to quote · Alt+L list · Alt+Enter send', '');
  process.stdout.write(lines.join('\n') + '\n');
}

async function requireServer(session) {
  const info = serverInfo(session);
  if (!info || !(await health(info))) {
    fail('not_running', `No Pinpoint server for session "${session}". Start one with: pinpoint open <url|file|dir>${session !== 'default' ? ` --session ${session}` : ''}`);
  }
  return info;
}

async function cmdWait(pos, flags) {
  const session = sessionName(flags);
  const info = await requireServer(session);
  const timeout = Number(flags.timeout) || 600;
  const format = flags.format === 'md' || flags.format === 'markdown' ? 'md' : 'json';
  try {
    const res = await call(info, 'GET', `/api/wait?timeout=${timeout}${format === 'md' ? '&format=md' : ''}`, null, { timeoutMs: 0, raw: true });
    process.stdout.write(res.text.endsWith('\n') ? res.text : res.text + '\n');
    if (format === 'json') {
      try { const j = JSON.parse(res.text); if (j.ok === false) process.exit(1); } catch { /* ignore */ }
    }
  } catch (e) {
    fail('connection_lost', `Lost connection to the Pinpoint server: ${e.message}. Check \`pinpoint status\`.`);
  }
}

function listFormat(flags) {
  if (flags.format) return flags.format === 'markdown' ? 'md' : flags.format;
  return isTTY() ? 'md' : 'json';
}

async function cmdList(pos, flags, { defaultStatus = 'open' } = {}) {
  const session = sessionName(flags);
  const store = new Store(session);
  const list = store.list({ status: flags.status || defaultStatus, page: flags.page });
  const format = listFormat(flags);
  if (format === 'md') return process.stdout.write(toMarkdown(store, list) + '\n');
  if (flags.full) return out({ ok: true, session, count: list.length, annotations: list.map((a) => ({ ...a, screenshot: store.shotPath(a) || undefined })) });
  out({ ok: true, session, count: list.length, annotations: list.map((a) => forAgent(store, a)) });
}

async function cmdShow(pos, flags) {
  const session = sessionName(flags);
  const store = new Store(session);
  const a = store.get(pos[0]);
  if (!a) fail('not_found', `No annotation #${pos[0]} in session "${session}".`);
  if (listFormat(flags) === 'md') return process.stdout.write(toMarkdown(store, [a]) + '\n');
  out({ ok: true, annotation: { ...a, screenshot: store.shotPath(a) || undefined } });
}

async function cmdReply(pos, flags, { forceStatus } = {}) {
  const session = sessionName(flags);
  const ids = forceStatus ? pos.filter((x) => /^\d+$/.test(x)) : [pos[0]];
  const text = forceStatus ? (flags.note || flags.message || '') : (pos.slice(1).join(' ') || flags.message || '');
  const status = forceStatus || flags.status || undefined;
  if (!ids.length || !ids[0]) fail('missing_id', forceStatus ? 'Usage: pinpoint resolve <id...> [--note "..."]' : 'Usage: pinpoint reply <id> "message" [--status resolved|wontfix|open]');
  if (!text && !status) fail('missing_text', 'Give a message and/or --status.');
  const info = serverInfo(session);
  if (info && (await health(info))) {
    const r = await call(info, 'POST', '/api/reply', { ids, text, status });
    if (!r.ok) fail(r.error, r.error === 'not_found' ? `No annotation #${r.id} in session "${session}".` : r.error === 'bad_status' ? `Status must be one of: ${r.allowed.join(', ')}` : 'Reply failed', r);
    return out(r);
  }
  // Server not running: write straight to the state file.
  const store = new Store(session);
  const updated = [];
  for (const id of ids) {
    const a = store.get(id);
    if (!a) fail('not_found', `No annotation #${id}`);
    const patch = {};
    if (text) patch.replies = [...a.replies, { from: 'agent', text, at: now() }];
    if (status) patch.status = status === 'open' ? 'draft' : status;
    updated.push(store.update(id, patch));
  }
  out({ ok: true, offline: true, updated: updated.map((a) => ({ id: a.id, status: a.status })) });
}

async function cmdStatus(pos, flags) {
  const session = sessionName(flags);
  const info = serverInfo(session);
  const alive = info && (await health(info));
  const store = new Store(session);
  const counts = {};
  for (const a of store.data.annotations) counts[a.status] = (counts[a.status] || 0) + 1;
  const pending = store.data.events.filter((e) => !e.delivered).length;
  const res = {
    ok: true, session, running: !!alive,
    ...(alive ? { url: info.url, dashboard: `${info.url}${BASE}/`, target: describeTarget(info.target), pid: info.pid } : {}),
    annotations: counts, undeliveredEvents: pending, state: store.file,
  };
  if (isTTY() && !flags.format) {
    process.stdout.write(`Session "${session}": ${alive ? `running at ${info.url} → ${describeTarget(info.target) || 'inject mode'}` : 'not running'}\n`
      + `Annotations: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}; waiting batches: ${pending}\n`);
  } else out(res);
}

async function cmdStop(pos, flags) {
  const sessions = flags.all ? listSessions() : [sessionName(flags)];
  const stopped = [];
  for (const s of sessions) {
    const info = serverInfo(s);
    if (!info) continue;
    try { await call(info, 'POST', '/api/stop', {}, { timeoutMs: 2000 }); } catch { try { process.kill(info.pid); } catch { /* gone */ } }
    stopped.push(s);
  }
  out({ ok: true, stopped });
}

async function cmdClear(pos, flags) {
  const session = sessionName(flags);
  const which = flags.resolved ? 'resolved' : flags.sent ? 'sent' : 'all';
  const info = serverInfo(session);
  if (info && (await health(info))) return out(await call(info, 'POST', '/api/clear', { which }));
  out({ ok: true, offline: true, removed: clearAnnotations(new Store(session), which) });
}

function listSessions() {
  const has = (d, f) => fs.existsSync(path.join(HOME, 'sessions', d, f));
  try { return fs.readdirSync(path.join(HOME, 'sessions')).filter((d) => has(d, 'state.json') || has(d, 'server.json')); } catch { return []; }
}

async function cmdSessions() {
  const res = [];
  for (const s of listSessions()) {
    const info = serverInfo(s);
    const store = new Store(s);
    res.push({ session: s, running: !!(info && (await health(info))), url: info?.url, target: info ? describeTarget(info.target) : undefined, annotations: store.data.annotations.length });
  }
  out({ ok: true, home: HOME, sessions: res });
}

function cmdLink(pos) {
  const binDir = pos[0] ? path.resolve(pos[0]) : process.platform === 'win32' ? null : path.join(os.homedir(), '.local', 'bin');
  if (!binDir) fail('unsupported', `On Windows add ${HERE} to PATH to use pinpoint.cmd from anywhere.`);
  ensureDir(binDir);
  const dest = path.join(binDir, 'pinpoint');
  try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
  fs.symlinkSync(path.join(HERE, 'pinpoint'), dest);
  const onPath = (process.env.PATH || '').split(path.delimiter).includes(binDir);
  out({ ok: true, linked: dest, onPath, hint: onPath ? 'Run `pinpoint help` from anywhere.' : `Add ${binDir} to your PATH.` });
}

const HELP = `Pinpoint ${VERSION} — pick, highlight, sketch and comment on any web page.

Usage: pinpoint <command> [options]

Start
  open <url|port|file|dir>   Proxy a site/dev server (or serve local files) with the
                             overlay injected, and open it in the browser.
                             e.g. pinpoint open 5173 · pinpoint open https://example.com
                                  pinpoint open ./index.html · pinpoint open ./dist
  start                      Server only; add the overlay to any page yourself via the
                             printed <script> snippet or the bookmarklet (dashboard).
  serve <target>             Same as open, but stays in the foreground (Ctrl+C stops).
  screen [--delay 3]         Capture the whole display (every app, window and UI element
                             via the OS accessibility APIs) and open it for annotation.
         [--image shot.png]  Annotate any existing image instead (mockups, phone screenshots).
         [--snapshot t.json] Pair --image with an element tree from another tool.
         [--no-elements] [--budget 8]   Skip / time-limit the accessibility walk.

Collect
  wait [--timeout 600] [--format json|md]
                             Block until the user clicks Send; print the batch.
  list [--status open|draft|sent|resolved|all] [--page text] [--format json|md] [--full]
  export [--format md|json]  Everything in the session (default Markdown).
  show <id>                  One annotation in full.

Respond
  reply <id> "message" [--status resolved|wontfix|open]
  resolve <id...> [--note "message"]
  clear [--resolved|--sent]  Delete annotations (default: all).

Manage
  status · sessions · stop [--all] · link [bin-dir] · help · version

Options
  --session, -s NAME   Separate workspaces (default "default", or $PINPOINT_SESSION)
  --port, -p N         Port for the helper (default ${DEFAULT_PORT}, next free)
  --host ADDR          Bind address (default 127.0.0.1)
  --no-open            Don't open a browser
  --no-screenshots     Don't capture element screenshots

In the page
  Alt+P pick elements (click; Shift+click multi-select; ↑/↓ parent/child; Esc stop)
  Alt+D draw on the page · select text → "Comment" to quote it
  Alt+L list · Alt+Enter send drafts · Alt+H hide/show pins

State: ${HOME}/sessions/<session>/ (override with PINPOINT_HOME)
`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (flags.help && cmd !== 'help') { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'open': return cmdOpen(pos, flags);
    case 'start': return cmdOpen(pos, flags, { injectOnly: true });
    case 'serve': return cmdOpen(pos, { ...flags, foreground: true });
    case 'screen': case 'capture': return cmdScreen(pos, flags);
    case '__serve': {
      const target = JSON.parse(flags.target);
      await serve({ session: sessionName(flags), target, host: flags.host || '127.0.0.1', port: flags.port ? Number(flags.port) : 0, screenshots: flags.screenshots });
      return;
    }
    case 'wait': case 'poll': return cmdWait(pos, flags);
    case 'list': case 'ls': return cmdList(pos, flags);
    case 'export': return cmdList(pos, { format: 'md', ...flags }, { defaultStatus: 'all' });
    case 'show': return cmdShow(pos, flags);
    case 'reply': return cmdReply(pos, flags);
    case 'resolve': return cmdReply(pos, flags, { forceStatus: 'resolved' });
    case 'clear': return cmdClear(pos, flags);
    case 'status': return cmdStatus(pos, flags);
    case 'sessions': return cmdSessions();
    case 'stop': return cmdStop(pos, flags);
    case 'link': return cmdLink(pos);
    case 'version': case '--version': case '-v': return out({ ok: true, version: VERSION, node: process.version, home: HOME });
    case 'help': case '--help': case '-h': process.stdout.write(HELP); return;
    default: fail('unknown_command', `Unknown command "${cmd}". Run \`pinpoint help\`.`);
  }
}

main().catch((e) => fail('error', e.message || String(e)));
