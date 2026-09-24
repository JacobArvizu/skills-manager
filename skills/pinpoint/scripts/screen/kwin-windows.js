// Pinpoint: KWin script (Plasma 6, with Plasma 5 fallbacks). Loaded for a moment by
// linux-kwin.py over D-Bus; reports on-screen windows (front → back) and screens
// in logical compositor coordinates, then calls back. Nothing stays installed.
(function () {
  function rect(g) { return g ? { x: g.x, y: g.y, width: g.width, height: g.height } : null; }
  var cur = workspace.currentDesktop;
  var act = workspace.currentActivity;
  var list = workspace.stackingOrder
    || (workspace.windowList ? workspace.windowList() : workspace.clientList());
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (!w || w.minimized || w.deleted || w.desktopWindow || w.dock || w.splash || w.notification || w.skipSwitcher && !w.normalWindow) continue;
    if (!(w.normalWindow || w.dialog || w.utility)) continue;
    var onDesk = w.onAllDesktops
      || (w.desktops ? w.desktops.some(function (d) { return d === cur; }) : w.desktop === cur);
    if (!onDesk) continue;
    if (w.activities && w.activities.length && act && w.activities.indexOf(act) < 0) continue;
    out.push({
      app: String(w.resourceClass || w.resourceName || ''), title: String(w.caption || ''), pid: w.pid,
      frame: rect(w.frameGeometry), client: rect(w.clientGeometry), active: !!w.active,
    });
  }
  out.reverse(); // stackingOrder is bottom → top
  var screens = [];
  if (workspace.screens) {
    for (var s = 0; s < workspace.screens.length; s++) screens.push(Object.assign(rect(workspace.screens[s].geometry), { scale: workspace.screens[s].devicePixelRatio || 1 }));
  }
  callDBus("__PP_SERVICE__", "/", "org.pinpoint.Receiver", "Result", JSON.stringify({ windows: out, screens: screens }));
})();
