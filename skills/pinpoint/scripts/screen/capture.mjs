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

/** First Python 3 that can load the GObject bindings (+ optional typelib). pyenv/conda
 *  interpreters often shadow the system one that python3-gi was built for. */
let pyCache = new Map();
export async function findGiPython(ns = 'Atspi') {
  if (pyCache.has(ns)) return pyCache.get(ns);
  const cands = ['python3', '/usr/bin/python3', '/usr/local/bin/python3'];
  try {
    for (const f of fs.readdirSync('/usr/bin').filter((f) => /^python3\.\d+$/.test(f)).sort((a, b) => +b.split('.')[1] - +a.split('.')[1])) cands.push(`/usr/bin/${f}`);
  } catch { /* no /usr/bin */ }
  const probe = ns === 'Gio' ? 'from gi.repository import Gio' : `gi.require_version('${ns}', '2.0'); from gi.repository import ${ns}`;
  let found = null;
  for (const c of [...new Set(cands)]) {
    const r = await run(c, ['-c', `import gi; ${probe}`], { timeout: 8000 });
    if (r.ok) { found = c; break; }
  }
  pyCache.set(ns, found);
  return found;
}

function linuxSession() {
  const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
  const desk = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
  const compositor = process.env.HYPRLAND_INSTANCE_SIGNATURE ? 'hyprland' : process.env.SWAYSOCK ? 'sway'
    : desk.includes('gnome') ? 'gnome' : desk.includes('kde') || desk.includes('plasma') ? 'kde' : desk || 'unknown';
  return { wayland, compositor };
}

async function linuxScreenshot(file, sess) {
  const tries = [];
  if (sess.wayland) {
    if (sess.compositor === 'hyprland' || sess.compositor === 'sway' || !['gnome', 'kde'].includes(sess.compositor)) tries.push(['grim', [file]]);
    if (sess.compositor === 'kde') tries.push(['spectacle', ['-b', '-n', '-f', '-o', file]]);
    tries.push(['gnome-screenshot', ['-f', file]], ['spectacle', ['-b', '-n', '-f', '-o', file]], ['grim', [file]], ['portal', null]);
  }
  tries.push(['import', ['-window', 'root', file]], ['scrot', ['-o', file]], ['maim', [file]], ['gnome-screenshot', ['-f', file]], ['spectacle', ['-b', '-n', '-f', '-o', file]], ['xwd', null], ['portal', null]);
  const seen = new Set();
  const errors = [];
  for (const [cmd, args] of tries) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    if (cmd === 'portal') {
      const py = await findGiPython('Gio');
      if (!py) continue;
      const r = await run(py, [path.join(HERE, 'linux-portal-shot.py'), file], { timeout: 60000 });
      if (r.ok && fs.existsSync(file) && fs.statSync(file).size > 0) return 'xdg-desktop-portal';
      errors.push(`portal: ${(r.stdout + r.stderr).trim().slice(0, 120)}`);
      continue;
    }
    if (cmd === 'xwd') {
      if (sess.wayland || !(await has('xwd')) || !(await has('convert'))) continue;
      const r = await run('sh', ['-c', `xwd -root -silent | convert xwd:- png:"${file}"`]);
      if (r.ok && fs.existsSync(file)) return 'xwd';
      continue;
    }
    if (sess.wayland && ['import', 'scrot', 'maim'].includes(cmd)) continue; // X11-only: would grab a black XWayland root
    if (!(await has(cmd))) continue;
    const r = await run(cmd, args, { timeout: 20000 });
    if (r.ok && fs.existsSync(file) && fs.statSync(file).size > 0) return cmd;
    errors.push(`${cmd}: ${(r.stderr || '').trim().slice(0, 120)}`);
  }
  const hint = sess.wayland
    ? { gnome: 'gnome-screenshot', kde: 'spectacle', hyprland: 'grim', sway: 'grim' }[sess.compositor] || 'grim or xdg-desktop-portal'
    : 'imagemagick (for `import`), scrot or maim';
  throw new Error(`No screenshot tool worked. Install ${hint}.${errors.length ? ` (${errors.join('; ')})` : ''} Run \`pinpoint doctor\` for exact commands.`);
}

const procName = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; } };

/** Windows front → back, in screen coordinates, from whatever this session exposes. */
async function linuxWindows(sess, warnings) {
  // Hyprland
  if (sess.compositor === 'hyprland' && (await has('hyprctl'))) {
    const mons = parseJSON((await run('hyprctl', ['monitors', '-j'])).stdout, []);
    const active = new Set(mons.map((m) => m.activeWorkspace?.id));
    const clients = parseJSON((await run('hyprctl', ['clients', '-j'])).stdout, []);
    return clients.filter((c) => c.mapped !== false && !c.hidden && active.has(c.workspace?.id))
      .sort((a, b) => (a.focusHistoryID ?? 99) - (b.focusHistoryID ?? 99))
      .map((c) => ({ app: c.class || c.initialClass || procName(c.pid), pid: c.pid, title: c.title, x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1] }));
  }
  // Sway / i3-compatible
  if (sess.compositor === 'sway' && (await has('swaymsg'))) {
    const tree = parseJSON((await run('swaymsg', ['-t', 'get_tree', '-r'])).stdout, null);
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.pid && n.visible !== false && (n.type === 'con' || n.type === 'floating_con')) {
        const r = n.rect, d = n.deco_rect || { height: 0 };
        out.push({ app: n.app_id || n.window_properties?.class || procName(n.pid), pid: n.pid, title: n.name, focused: n.focused, floating: n.type === 'floating_con',
          x: r.x, y: r.y - d.height, width: r.width, height: r.height + d.height });
      }
      for (const c of [...(n.nodes || []), ...(n.floating_nodes || [])]) walk(c);
    };
    walk(tree);
    return out.sort((a, b) => (b.focused - a.focused) || (b.floating - a.floating));
  }
  // GNOME Wayland with the "Window Calls" extension (extensions.gnome.org/extension/4724)
  if (sess.wayland && sess.compositor === 'gnome' && (await has('gdbus'))) {
    const call = (method, ...args) => run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/Windows',
      '--method', `org.gnome.Shell.Extensions.Windows.${method}`, ...args], { timeout: 5000 });
    const unwrap = (txt) => { const m = txt.match(/^\('([\s\S]*)',\)\s*$/); return m ? parseJSON(m[1].replace(/\\'/g, "'"), null) : null; };
    const list = unwrap((await call('List')).stdout);
    if (Array.isArray(list)) {
      const wins = [];
      for (const w of list.filter((x) => x.in_current_workspace !== false && x.window_type !== 1)) {
        let g = w;
        if (w.x === undefined) g = { ...w, ...(unwrap((await call('Details', String(w.id))).stdout) || {}) };
        if (g.x === undefined || g.minimized) continue;
        wins.push({ app: g.wm_class || procName(g.pid), pid: g.pid, title: g.title, focus: !!g.focus, x: g.x, y: g.y, width: g.width, height: g.height });
      }
      return wins.sort((a, b) => b.focus - a.focus);
    }
    warnings.push('GNOME on Wayland hides window positions. Install the "Window Calls" GNOME extension (extensions.gnome.org/extension/4724) to pick windows and native UI elements, or log in with "GNOME on Xorg". Dragged regions and drawing work either way.');
    return [];
  }
  if (sess.wayland && !process.env.DISPLAY) {
    warnings.push(`${sess.compositor === 'kde' ? 'KDE Plasma' : 'This Wayland compositor'} does not expose window positions to other apps, so native elements can't be placed. Dragged regions and drawing work; for window/element picking use an X11 session, Sway or Hyprland.`);
    return [];
  }
  // X11 (or XWayland windows under Wayland)
  if (!(await has('wmctrl'))) {
    warnings.push('Install wmctrl and x11-utils (xprop, xwininfo) to pick whole windows. Run `pinpoint doctor` for the command.');
    return [];
  }
  const windows = [];
  const list = await run('wmctrl', ['-lGp']);
  let stacking = [];
  if (await has('xprop')) {
    const st = await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']);
    stacking = (st.stdout.match(/0x[0-9a-f]+/gi) || []).map((h) => parseInt(h, 16));
  }
  const desk = (await run('wmctrl', ['-d'])).stdout.split('\n').find((l) => /^\d+\s+\*/.test(l));
  const curDesk = desk ? Number(desk.split(/\s+/)[0]) : null;
  for (const line of list.stdout.split('\n')) {
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/i);
    if (!m) continue;
    const d = Number(m[2]);
    if (curDesk !== null && d !== -1 && d !== curDesk) continue; // other workspaces aren't on screen
    const pid = Number(m[3]);
    windows.push({ xid: parseInt(m[1], 16), pid, app: procName(pid), title: m[8], x: +m[4], y: +m[5], width: +m[6], height: +m[7] });
  }
  if (stacking.length) windows.sort((a, b) => stacking.indexOf(b.xid) - stacking.indexOf(a.xid));
  // wmctrl geometry is unreliable across WMs; use the client's absolute position
  // plus _NET_FRAME_EXTENTS so boxes include title bars and borders. Skip minimized.
  if (await has('xwininfo')) {
    await Promise.all(windows.map(async (w) => {
      const wi = await run('xwininfo', ['-id', String(w.xid)], { timeout: 5000 });
      const g = (k) => { const m = wi.stdout.match(new RegExp(k + ':\\s*(-?\\d+)')); return m ? +m[1] : null; };
      const [ax, ay, cw, ch] = [g('Absolute upper-left X'), g('Absolute upper-left Y'), g('Width'), g('Height')];
      if (/Map State:\s*IsUnMapped|IsUnviewable/.test(wi.stdout)) { w.hidden = true; return; }
      if (ax === null || cw === null) return;
      let [l, r, t, b] = [0, 0, 0, 0];
      if (await has('xprop')) {
        const fx = await run('xprop', ['-id', String(w.xid), '_NET_FRAME_EXTENTS', 'WM_CLASS', '_NET_WM_STATE'], { timeout: 5000 });
        const m = fx.stdout.match(/_NET_FRAME_EXTENTS\(CARDINAL\)\s*=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (m) [l, r, t, b] = m.slice(1).map(Number);
        if (/_NET_WM_STATE_HIDDEN/.test(fx.stdout)) w.hidden = true;
        const wc = fx.stdout.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)",\s*"([^"]*)"/);
        if (!w.app && wc) w.app = wc[2] || wc[1];
      }
      Object.assign(w, { x: ax - l, y: ay - t, width: cw + l + r, height: ch + t + b });
    }));
  }
  return windows.filter((w) => !w.hidden);
}

async function captureLinux(dir, opts) {
  const warnings = [];
  const sess = linuxSession();
  const file = path.join(dir, 'display-1.png');
  const shotBy = await linuxScreenshot(file, sess);
  const px = pngSize(file) || {};
  // Logical monitor layout: the screenshot covers its bounding box, in physical pixels
  // on scaled (HiDPI) outputs, while window/element coordinates are logical.
  let mons = [];
  if (sess.compositor === 'hyprland' && (await has('hyprctl'))) {
    mons = parseJSON((await run('hyprctl', ['monitors', '-j'])).stdout, []).map((m) => {
      const k = m.scale || 1, rot = m.transform % 2 === 1;
      return { x: m.x, y: m.y, width: (rot ? m.height : m.width) / k, height: (rot ? m.width : m.height) / k };
    });
  } else if (sess.compositor === 'sway' && (await has('swaymsg'))) {
    mons = parseJSON((await run('swaymsg', ['-t', 'get_outputs', '-r'])).stdout, []).filter((o) => o.active).map((o) => o.rect);
  } else {
    const py = await findGiPython('Gio');
    if (py) { const r = parseJSON((await run(py, ['-W', 'ignore', path.join(HERE, 'linux-monitors.py')], { timeout: 8000 })).stdout, []); if (Array.isArray(r)) mons = r; }
  }
  let ox = 0, oy = 0, lw = px.width, lh = px.height;
  if (mons.length) {
    ox = Math.min(...mons.map((m) => m.x)); oy = Math.min(...mons.map((m) => m.y));
    const bw = Math.max(...mons.map((m) => m.x + m.width)) - ox, bh = Math.max(...mons.map((m) => m.y + m.height)) - oy;
    // Only trust the layout when its aspect matches the image (guards against partial info).
    if (bw > 0 && bh > 0 && Math.abs(px.width / bw - px.height / bh) < 0.05) { lw = bw; lh = bh; }
  }
  const windows = await linuxWindows(sess, warnings);
  const displays = [{ id: 1, x: ox, y: oy, width: lw, height: lh, file: 'display-1.png', scale: px.width && lw ? px.width / lw : 1, capturedWith: shotBy }];

  let tree = [];
  if (opts.elements !== false) {
    const py = await findGiPython('Atspi');
    if (!py) warnings.push('UI elements unavailable: install python3-gi and gir1.2-atspi-2.0 (AT-SPI). Run `pinpoint doctor` for the exact command.');
    else {
      const r = await run(py, ['-W', 'ignore', path.join(HERE, 'linux-ax.py'), String(opts.budgetMs), String(opts.maxNodes), String(opts.maxDepth)], { timeout: opts.budgetMs + 20000 });
      const res = parseJSON(r.stdout, null);
      if (res?.tree) tree = res.tree;
      if (res?.error || !r.ok) warnings.push(`AT-SPI walk failed: ${(res?.error || r.stderr).trim().slice(0, 160)}`);
      else if (!tree.length) warnings.push('No accessible apps found. Turn on accessibility (GNOME: `gsettings set org.gnome.desktop.interface toolkit-accessibility true`), then restart the apps. Qt apps need QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1; Chrome/Electron need --force-renderer-accessibility.');
      if (res?.truncated) warnings.push('Element snapshot hit its time/size budget; raise --budget for deeper trees.');
    }
    // Native Wayland clients report element positions relative to their own window.
    // Without window positions from the compositor they can't be placed; drop them.
    if (sess.wayland && !windows.length && tree.length) tree = [];
  }
  return { displays, windows, tree, warnings, relative: sess.wayland };
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
    let shift = null;
    if (best < 0) {
      // Same process + similar size: a Wayland client reporting window-relative coordinates.
      for (const r of roots) {
        if (used.has(r)) continue;
        const t = tree[r];
        if (!w.pid || t.pid !== w.pid) continue;
        if (Math.abs(t.width - w.width) <= 80 && Math.abs(t.height - w.height) <= 80) {
          best = r;
          if (raw.relative || (Math.abs(t.x) < 4 && Math.abs(t.y) < 4)) shift = { dx: w.x + Math.max(0, (w.width - t.width) / 2) - t.x, dy: w.y + Math.max(0, w.height - t.height) - t.y };
          break;
        }
      }
    }
    if (best >= 0) used.add(best);
    order.push({ w, root: best >= 0 ? best : null, shift });
  }
  for (const r of roots) if (!used.has(r) && !(raw.relative && windows.length)) order.push({ w: null, root: r });

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
  let shift = null;
  const walk = (ti, parent) => {
    for (const ci of children.get(ti) || []) {
      const c = shift ? { ...tree[ci], x: tree[ci].x + shift.dx, y: tree[ci].y + shift.dy } : tree[ci];
      if (c.width <= 0 || c.height <= 0 || budget-- <= 0) continue;
      const up = nodes[parent];
      walk(ci, add({ ...c, app: c.app || up.app, pid: c.pid || up.pid }, parent, 'element'));
    }
  };
  order.forEach(({ w, root, shift: sh }) => {
    shift = sh;
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

// ---------------------------------------------------------------------------
// Diagnostics (`pinpoint doctor`)
// ---------------------------------------------------------------------------

function linuxPkgManager() {
  let id = '';
  try {
    const osr = fs.readFileSync('/etc/os-release', 'utf8');
    id = `${(osr.match(/^ID=(.*)$/m) || [])[1] || ''} ${(osr.match(/^ID_LIKE=(.*)$/m) || [])[1] || ''}`.replace(/"/g, '').toLowerCase();
  } catch { /* unknown */ }
  if (/debian|ubuntu|mint|pop/.test(id)) return 'apt';
  if (/fedora|rhel|centos|rocky|alma/.test(id)) return 'dnf';
  if (/arch|manjaro|endeavour/.test(id)) return 'pacman';
  if (/suse/.test(id)) return 'zypper';
  return null;
}
const PKGS = {
  //            apt                      dnf                    pacman              zypper
  import:     ['imagemagick',           'ImageMagick',         'imagemagick',      'ImageMagick'],
  grim:       ['grim',                  'grim',                'grim',             'grim'],
  gnomeShot:  ['gnome-screenshot',      'gnome-screenshot',    'gnome-screenshot', 'gnome-screenshot'],
  spectacle:  ['kde-spectacle',         'spectacle',           'spectacle',        'spectacle'],
  wmctrl:     ['wmctrl',                'wmctrl',              'wmctrl',           'wmctrl'],
  xprop:      ['x11-utils',             'xprop xwininfo',      'xorg-xprop xorg-xwininfo', 'xprop xwininfo'],
  gi:         ['python3-gi',            'python3-gobject',     'python-gobject',   'python3-gobject'],
  atspi:      ['gir1.2-atspi-2.0 at-spi2-core', 'at-spi2-core', 'at-spi2-core',  'typelib-1_0-Atspi-2_0 at-spi2-core'],
};
const PM = { apt: [0, 'sudo apt install'], dnf: [1, 'sudo dnf install'], pacman: [2, 'sudo pacman -S --needed'], zypper: [3, 'sudo zypper install'] };

export async function diagnose() {
  const checks = [];
  const add = (name, ok, detail, pkg) => checks.push({ name, ok: !!ok, detail, pkg });
  if (process.platform === 'darwin') {
    add('screencapture', await has('screencapture'), 'built in');
    add('osascript (JXA)', await has('osascript'), 'built in');
    return { platform: 'darwin', checks, notes: ['Grant your terminal Screen Recording and Accessibility in System Settings → Privacy & Security, then restart it.'] };
  }
  if (process.platform === 'win32') {
    add('PowerShell', (await has('powershell')) || (await has('pwsh')), 'built in');
    return { platform: 'win32', checks, notes: [] };
  }
  const sess = linuxSession();
  const pm = linuxPkgManager();
  add('Session', true, `${sess.wayland ? 'Wayland' : 'X11'} · ${sess.compositor}${process.env.DISPLAY ? ` · DISPLAY=${process.env.DISPLAY}` : ''}`);
  // Screenshots
  if (sess.wayland) {
    const want = { gnome: ['gnome-screenshot', 'gnomeShot'], kde: ['spectacle', 'spectacle'] }[sess.compositor] || ['grim', 'grim'];
    const tool = await has(want[0]);
    const portal = !tool && (await findGiPython('Gio'));
    add('Screenshot tool', tool || portal, tool ? want[0] : portal ? 'xdg-desktop-portal (may ask permission once)' : `missing: ${want[0]}`, tool ? null : want[1]);
  } else {
    const found = [];
    for (const t of ['import', 'scrot', 'maim', 'gnome-screenshot', 'spectacle']) if (await has(t)) found.push(t);
    add('Screenshot tool', found.length, found.length ? found[0] : 'missing (ImageMagick import, scrot or maim)', found.length ? null : 'import');
  }
  // Windows
  if (sess.compositor === 'hyprland') add('Window positions', await has('hyprctl'), 'hyprctl');
  else if (sess.compositor === 'sway') add('Window positions', await has('swaymsg'), 'swaymsg');
  else if (sess.wayland && sess.compositor === 'gnome') {
    const r = await run('gdbus', ['introspect', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/Windows'], { timeout: 5000 });
    add('Window positions', r.ok && /Windows/.test(r.stdout), r.ok ? '"Window Calls" extension' : 'GNOME Wayland hides them: install the "Window Calls" extension (extensions.gnome.org/extension/4724) or use "GNOME on Xorg"');
  } else if (sess.wayland && !process.env.DISPLAY) add('Window positions', false, `${sess.compositor} on Wayland doesn't expose them (regions and drawing still work)`);
  else {
    const wm = await has('wmctrl'), xp = (await has('xprop')) && (await has('xwininfo'));
    add('wmctrl', wm, wm ? 'ok' : 'missing', wm ? null : 'wmctrl');
    add('xprop + xwininfo', xp, xp ? 'ok' : 'missing', xp ? null : 'xprop');
  }
  // Elements
  const py = await findGiPython('Atspi');
  const gi = py || (await findGiPython('Gio'));
  add('Python GObject (python3-gi)', gi, gi ? (py || gi) : 'missing', gi ? null : 'gi');
  add('AT-SPI bindings', py, py ? `ok (${py})` : 'missing', py ? null : 'atspi');
  if (py) {
    const r = await run(py, ['-W', 'ignore', path.join(HERE, 'linux-ax.py'), '3000', '400', '3'], { timeout: 20000 });
    const res = parseJSON(r.stdout, {});
    const apps = new Set((res.tree || []).map((n) => n.app)).size;
    add('Accessible apps on screen', apps > 0, apps ? `${apps} app(s), ${(res.tree || []).length} nodes sampled` : (res.error || 'none: enable accessibility and restart apps (see notes)'));
  }
  const missing = checks.filter((c) => !c.ok && c.pkg).map((c) => c.pkg);
  const install = pm && missing.length ? `${PM[pm][1]} ${[...new Set(missing.map((k) => PKGS[k][PM[pm][0]]))].join(' ')}` : null;
  const notes = [
    'GNOME: `gsettings set org.gnome.desktop.interface toolkit-accessibility true`, then restart apps, to expose UI elements.',
    'Qt/KDE apps: set QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1. Chrome/Electron/VS Code: launch with --force-renderer-accessibility.',
  ];
  return { platform: 'linux', session: sess, packageManager: pm, checks, install, notes };
}
