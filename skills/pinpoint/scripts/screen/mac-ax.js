// Pinpoint (macOS, JXA): accessibility tree of every visible app's windows via
// System Events. Breadth-first with a time/node budget so huge trees (browsers,
// IDEs) can't stall the capture. Needs Accessibility permission for the terminal.
// Run: osascript -l JavaScript mac-ax.js <budgetMs> <maxNodes> <maxDepth>
function run(argv) {
  const budget = Number(argv[0]) || 8000;
  const maxNodes = Number(argv[1]) || 4000;
  const maxDepth = Number(argv[2]) || 12;
  const t0 = Date.now();
  const tree = [];
  let truncated = false;
  const over = () => Date.now() - t0 > budget || tree.length >= maxNodes;
  const txt = (v) => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string') return v.slice(0, 500);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  };
  // Fetch one property for every element of a collection in a single Apple event.
  const all = (coll, prop, len) => { try { const r = coll[prop](); return Array.isArray(r) ? r : new Array(len).fill(null); } catch (e) { return new Array(len).fill(null); } };

  let se;
  try {
    se = Application('System Events');
    se.includeStandardAdditions = false;
  } catch (e) { return JSON.stringify({ error: String(e), tree }); }

  const queue = []; // [collectionSpecifier, parentIndex, depth, app, pid]
  try {
    const procs = se.applicationProcesses.whose({ visible: true });
    const names = procs.name();
    const pids = procs.unixId();
    // Frontmost app first so its elements win the budget.
    const idx = names.map((_, i) => i);
    let front = -1;
    try { front = procs.frontmost().indexOf(true); } catch (e) { /* ignore */ }
    if (front > 0) { idx.splice(front, 1); idx.unshift(front); }
    for (const i of idx) {
      const p = procs[i];
      const wins = p.windows;
      let n = 0;
      try { n = wins.length; } catch (e) { continue; }
      if (!n) continue;
      const pos = all(wins, 'position', n), size = all(wins, 'size', n), title = all(wins, 'name', n), role = all(wins, 'role', n);
      for (let j = 0; j < n; j++) {
        if (!pos[j] || !size[j]) continue;
        const id = tree.push({ parent: null, app: names[i], pid: pids[i], role: txt(role[j]) || 'AXWindow', name: txt(title[j]),
          x: pos[j][0], y: pos[j][1], width: size[j][0], height: size[j][1] }) - 1;
        queue.push([wins[j].uiElements, id, 1, names[i], pids[i]]);
      }
    }
  } catch (e) {
    return JSON.stringify({ error: String(e), tree });
  }

  while (queue.length) {
    if (over()) { truncated = true; break; }
    const [coll, parent, depth, app, pid] = queue.shift();
    let n = 0;
    try { n = coll.length; } catch (e) { continue; }
    if (!n) continue;
    const role = all(coll, 'role', n);
    const pos = all(coll, 'position', n);
    const size = all(coll, 'size', n);
    const name = all(coll, 'name', n);
    const desc = all(coll, 'description', n);
    const value = all(coll, 'value', n);
    for (let k = 0; k < n; k++) {
      if (!pos[k] || !size[k] || size[k][0] <= 0 || size[k][1] <= 0) continue;
      if (tree.length >= maxNodes) { truncated = true; break; }
      const id = tree.push({ parent, app, pid, role: txt(role[k]), name: txt(name[k]), description: txt(desc[k]), value: txt(value[k]),
        x: pos[k][0], y: pos[k][1], width: size[k][0], height: size[k][1] }) - 1;
      if (depth < maxDepth) queue.push([coll[k].uiElements, id, depth + 1, app, pid]);
    }
  }
  return JSON.stringify({ tree, truncated });
}
