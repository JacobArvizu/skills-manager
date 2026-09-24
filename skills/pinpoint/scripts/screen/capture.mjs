/**
 * Screen capture for Pinpoint: screenshot every display, list on-screen windows
 * (with z-order), and snapshot each window's accessibility tree, so any app on
 * the desktop can be annotated like a web page.
 *
 * Each platform backend returns the same raw shape:
 *   { displays: [{ id, x, y, width, height, file, scale? }],
 *     windows:  [{ app, pid, title, x, y, width, height }]      // front → back
 *     tree:     [{ parent, app, pid, role, name, description, value, identifier, x, y, width, height }],
 *     warnings: [string] }
 * `tree` roots (parent == null) are windows; merge() pairs them with `windows`.
 * All coordinates are logical screen coordinates (top-left origin, virtual desktop).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args, { timeout = 30000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '', error: err });
    });
    if (input) { child.stdin.write(input); child.stdin.end(); }
  });
}
async function has(cmd) {
  if (process.platform === 'win32') return (await run('where', [cmd], { timeout: 5000 })).ok;
  return (await run('sh', ['-c', `command -v ${cmd}`], { timeout: 5000 })).ok;
}
function parseJSON(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

/** Width/height from a PNG header (enough for our own captures and --image PNGs). */
export function pngSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    if (b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// macOS: screencapture + CoreGraphics window list (JXA) + System Events AX tree
// ---------------------------------------------------------------------------

async function captureMac(dir, opts) {
  const warnings = [];
  const info = parseJSON((await run('osascript', ['-l', 'JavaScript', path.join(HERE, 'mac-windows.js')], { timeout: 15000 })).stdout, null);
  const screens = info?.displays?.length ? info.displays : [{ id: 1, x: 0, y: 0, width: null, height: null }];
  const displays = [];
  for (const s of screens) {
    const file = `display-${s.id}.png`;
    const r = await run('screencapture', ['-x', '-t', 'png', '-D', String(s.id), path.join(dir, file)], { timeout: 20000 });
    if (!r.ok || !fs.existsSync(path.join(dir, file))) { warnings.push(`screencapture failed for display ${s.id}: ${r.stderr.trim()}`); continue; }
    const px = pngSize(path.join(dir, file));
    displays.push({ ...s, file, width: s.width || px?.width, height: s.height || px?.height, scale: px && s.width ? px.width / s.width : 1 });
  }
  if (info && info.windows && info.windows.every((w) => !w.title)) warnings.push('Window titles are hidden: grant Screen Recording permission to your terminal (System Settings → Privacy & Security → Screen Recording).');
  let tree = [];
  if (opts.elements !== false) {
    const ax = await run('osascript', ['-l', 'JavaScript', path.join(HERE, 'mac-ax.js'), String(opts.budgetMs), String(opts.maxNodes), String(opts.maxDepth)], { timeout: opts.budgetMs + 20000 });
    const res = parseJSON(ax.stdout, null);
    if (res && Array.isArray(res.tree)) tree = res.tree;
    if (res?.error || !ax.ok) warnings.push(`UI elements unavailable (${(res?.error || ax.stderr || 'osascript failed').trim().slice(0, 160)}). Grant Accessibility permission to your terminal (System Settings → Privacy & Security → Accessibility).`);
    if (res?.truncated) warnings.push('Element snapshot hit its time/size budget; raise --budget for deeper trees.');
  }
  return { displays, windows: info?.windows || [], tree, warnings };
}

// ---------------------------------------------------------------------------
// Windows: one PowerShell script (DPI-aware GDI capture + UI Automation walk)
// ---------------------------------------------------------------------------

async function captureWindows(dir, opts) {
  const ps = (await has('powershell')) ? 'powershell' : (await has('pwsh')) ? 'pwsh' : null;
  if (!ps) throw new Error('PowerShell not found');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'win-capture.ps1'),
    '-Out', dir, '-BudgetMs', String(opts.budgetMs), '-MaxNodes', String(opts.maxNodes), '-MaxDepth', String(opts.maxDepth)];
  if (opts.elements === false) args.push('-NoElements');
  const r = await run(ps, args, { timeout: opts.budgetMs + 40000 });
  const raw = parseJSON(fs.existsSync(path.join(dir, 'raw.json')) ? fs.readFileSync(path.join(dir, 'raw.json'), 'utf8').replace(/^﻿/, '') : '', null);
  if (!raw) throw new Error(`capture script failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return { displays: [].concat(raw.displays || []), windows: [], tree: [].concat(raw.tree || []), warnings: [].concat(raw.warnings || []) };
}

// ---------------------------------------------------------------------------
// Linux: grim / gnome-screenshot / spectacle / import / scrot / maim,
// wmctrl + xprop for windows, AT-SPI (python3-gi) for elements
// ---------------------------------------------------------------------------

async function captureLinux(dir, opts) {
  const warnings = [];
  const file = path.join(dir, 'display-1.png');
  const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
  const tools = [
    ...(wayland ? [['grim', [file]], ['gnome-screenshot', ['-f', file]], ['spectacle', ['-b', '-n', '-f', '-o', file]]] : []),
    ['import', ['-window', 'root', file]],
    ['scrot', ['-o', file]],
    ['maim', [file]],
    ['gnome-screenshot', ['-f', file]],
    ['spectacle', ['-b', '-n', '-f', '-o', file]],
    ['xwd', null],
  ];
  let shotBy = null;
  for (const [cmd, args] of tools) {
    if (!(await has(cmd))) continue;
    if (cmd === 'xwd') {
      if (!(await has('convert'))) continue;
      const r = await run('sh', ['-c', `xwd -root -silent | convert xwd:- png:"${file}"`]);
      if (r.ok && fs.existsSync(file)) { shotBy = cmd; break; }
      continue;
    }
    const r = await run(cmd, args, { timeout: 20000 });
    if (r.ok && fs.existsSync(file) && fs.statSync(file).size > 0) { shotBy = cmd; break; }
  }
  if (!shotBy) throw new Error(`No screenshot tool worked. Install one of: ${wayland ? 'grim (wlroots), gnome-screenshot, spectacle' : 'imagemagick (import), scrot, maim'}.`);
  const px = pngSize(file) || {};
  const displays = [{ id: 1, x: 0, y: 0, width: px.width, height: px.height, file, scale: 1 }];
  displays[0].file = 'display-1.png';

  // Windows (X11 / XWayland only).
  const windows = [];
  if (process.env.DISPLAY && (await has('wmctrl'))) {
    const list = await run('wmctrl', ['-lGp']);
    let stacking = [];
    if (await has('xprop')) {
      const st = await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']);
      stacking = (st.stdout.match(/0x[0-9a-f]+/gi) || []).map((h) => parseInt(h, 16));
    }
    for (const line of list.stdout.split('\n')) {
      const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/i);
      if (!m) continue;
      const pid = Number(m[3]);
      let app = '';
      try { app = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* not local */ }
      windows.push({ xid: parseInt(m[1], 16), pid, app, title: m[8], x: +m[4], y: +m[5], width: +m[6], height: +m[7] });
    }
    if (stacking.length) windows.sort((a, b) => stacking.indexOf(b.xid) - stacking.indexOf(a.xid));
    // wmctrl geometry is unreliable across WMs; use the client's absolute position
    // plus _NET_FRAME_EXTENTS so boxes include title bars and borders.
    if (await has('xwininfo')) {
      await Promise.all(windows.map(async (w) => {
        const wi = await run('xwininfo', ['-id', String(w.xid)], { timeout: 5000 });
        const g = (k) => { const m = wi.stdout.match(new RegExp(k + ':\\s*(-?\\d+)')); return m ? +m[1] : null; };
        const [ax, ay, cw, ch] = [g('Absolute upper-left X'), g('Absolute upper-left Y'), g('Width'), g('Height')];
        if (ax === null || cw === null) return;
        let [l, r, t, b] = [0, 0, 0, 0];
        if (await has('xprop')) {
          const fx = await run('xprop', ['-id', String(w.xid), '_NET_FRAME_EXTENTS'], { timeout: 5000 });
          const m = fx.stdout.match(/=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
          if (m) [l, r, t, b] = m.slice(1).map(Number);
        }
        Object.assign(w, { x: ax - l, y: ay - t, width: cw + l + r, height: ch + t + b });
        if (!w.app && (await has('xprop'))) {
          const wc = await run('xprop', ['-id', String(w.xid), 'WM_CLASS'], { timeout: 5000 });
          const m = wc.stdout.match(/"([^"]*)",\s*"([^"]*)"/);
          if (m) w.app = m[2] || m[1];
        }
      }));
    }
  } else if (wayland) {
    warnings.push('Wayland does not expose window positions to other apps; picking works on UI elements (AT-SPI) and dragged regions.');
  } else {
    warnings.push('Install wmctrl and x11-utils (xprop) to pick whole windows.');
  }

  let tree = [];
  if (opts.elements !== false) {
    let py = null;
    for (const c of ['/usr/bin/python3', 'python3']) {
      const probe = await run(c, ['-c', "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi"], { timeout: 8000 });
      if (probe.ok) { py = c; break; }
    }
    if (!py) warnings.push('UI elements unavailable: install python3-gi and gir1.2-atspi-2.0 (AT-SPI) and enable accessibility.');
    else {
      const r = await run(py, [path.join(HERE, 'linux-ax.py'), String(opts.budgetMs), String(opts.maxNodes), String(opts.maxDepth)], { timeout: opts.budgetMs + 20000 });
      const res = parseJSON(r.stdout, null);
      if (res?.tree) tree = res.tree;
      if (res?.error || !r.ok) warnings.push(`AT-SPI walk failed: ${(res?.error || r.stderr).trim().slice(0, 160)}`);
      if (res?.truncated) warnings.push('Element snapshot hit its time/size budget; raise --budget for deeper trees.');
    }
  }
  return { displays, windows, tree, warnings };
}

// ---------------------------------------------------------------------------
// Merge windows + accessibility roots into one ordered node list
// ---------------------------------------------------------------------------

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
const str = (v, n = 300) => (v === null || v === undefined || v === '' ? undefined : String(v).slice(0, n));
const num = (v) => (Number.isFinite(+v) ? Math.round(+v) : 0);

export function merge(raw) {
  const tree = (raw.tree || []).map((n) => ({ ...n, x: num(n.x), y: num(n.y), width: num(n.width), height: num(n.height) }));
  const windows = (raw.windows || []).map((w) => ({ ...w, x: num(w.x), y: num(w.y), width: num(w.width), height: num(w.height) }))
    .filter((w) => w.width > 2 && w.height > 2);
  const roots = tree.map((n, i) => i).filter((i) => tree[i].parent === null || tree[i].parent === undefined);
  const children = new Map();
  tree.forEach((n, i) => {
    if (n.parent === null || n.parent === undefined) return;
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(i);
  });

  const used = new Set();
  const order = [];
  for (const w of windows) {
    let best = -1, bestScore = 0.6;
    for (const r of roots) {
      if (used.has(r)) continue;
      const t = tree[r];
      if (w.pid && t.pid && w.pid !== t.pid) continue;
      const s = iou(w, t);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best >= 0) used.add(best);
    order.push({ w, root: best >= 0 ? best : null });
  }
  for (const r of roots) if (!used.has(r)) order.push({ w: null, root: r });

  const nodes = [];
  const add = (n, parent, kind) => {
    const id = nodes.length;
    nodes.push({
      id, parent, kind,
      app: str(n.app, 120), pid: n.pid ? Number(n.pid) : undefined,
      role: str(n.role, 80), name: str(n.name ?? n.title), description: str(n.description), value: str(n.value, 500),
      identifier: str(n.identifier, 200), className: str(n.className, 120),
      x: n.x, y: n.y, width: n.width, height: n.height,
    });
    return id;
  };
  let budget = 20000;
  const walk = (ti, parent) => {
    for (const ci of children.get(ti) || []) {
      const c = tree[ci];
      if (c.width <= 0 || c.height <= 0 || budget-- <= 0) continue;
      const up = nodes[parent];
      walk(ci, add({ ...c, app: c.app || up.app, pid: c.pid || up.pid }, parent, 'element'));
    }
  };
  order.forEach(({ w, root }) => {
    const t = root !== null ? tree[root] : null;
    const base = w || t;
    const win = add({
      ...base,
      app: w?.app || t?.app, pid: w?.pid || t?.pid,
      role: t?.role || 'window', name: w?.title || t?.name,
      x: base.x, y: base.y, width: base.width, height: base.height,
    }, null, 'window');
    if (root !== null) walk(root, win);
  });
  return nodes;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Capture into `dir`. Options: { elements, budgetMs, maxNodes, maxDepth, image, snapshot }.
 * `image` annotates an existing image instead; `snapshot` supplies a raw JSON
 * (same shape as a backend returns) from any other tool — a mobile simulator,
 * a remote machine, a design tool — to pair with `image`.
 */
export async function capture(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const o = { elements: true, budgetMs: 8000, maxNodes: 4000, maxDepth: 12 };
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null) o[k] = v;
  let raw;
  const fixture = process.env.PINPOINT_CAPTURE_FIXTURE;
  if (o.image || fixture) {
    raw = { displays: [], windows: [], tree: [], warnings: [] };
    if (fixture && !o.image) {
      raw = { ...raw, ...parseJSON(fs.readFileSync(path.join(fixture, 'raw.json'), 'utf8'), {}) };
      for (const d of raw.displays) fs.copyFileSync(path.join(fixture, d.file), path.join(dir, d.file));
    } else {
      const ext = (path.extname(o.image).toLowerCase() || '.png');
      const file = `display-1${ext}`;
      fs.copyFileSync(o.image, path.join(dir, file));
      const px = ext === '.png' ? pngSize(path.join(dir, file)) : null;
      const extra = o.snapshot ? parseJSON(fs.readFileSync(o.snapshot, 'utf8'), null) : null;
      if (o.snapshot && !extra) throw new Error(`Could not parse ${o.snapshot}`);
      raw = {
        displays: extra?.displays?.length ? extra.displays.map((d, i) => ({ ...d, file: i === 0 ? file : d.file })) : [{ id: 1, x: 0, y: 0, width: px?.width ?? null, height: px?.height ?? null, file }],
        windows: extra?.windows || [], tree: extra?.tree || [], warnings: [],
      };
    }
  } else if (process.platform === 'darwin') raw = await captureMac(dir, o);
  else if (process.platform === 'win32') raw = await captureWindows(dir, o);
  else raw = await captureLinux(dir, o);

  if (!raw.displays.length) throw new Error(`Screenshot failed. ${raw.warnings.join(' ')}`);
  const xs = raw.displays.filter((d) => d.width);
  const bounds = xs.length ? {
    x: Math.min(...xs.map((d) => d.x)), y: Math.min(...xs.map((d) => d.y)),
    width: Math.max(...xs.map((d) => d.x + d.width)) - Math.min(...xs.map((d) => d.x)),
    height: Math.max(...xs.map((d) => d.y + d.height)) - Math.min(...xs.map((d) => d.y)),
  } : { x: 0, y: 0, width: null, height: null };
  const nodes = merge(raw);
  const snapshot = {
    version: 1, platform: o.image ? 'image' : process.platform, capturedAt: new Date().toISOString(),
    source: o.image ? path.resolve(o.image) : undefined,
    bounds, displays: raw.displays, nodes, warnings: raw.warnings || [],
  };
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot));
  try { fs.rmSync(path.join(dir, 'raw.json'), { force: true }); } catch { /* ignore */ }
  return snapshot;
}
