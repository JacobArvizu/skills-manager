// Pinpoint (macOS, JXA): displays + on-screen windows, front to back.
// Run: osascript -l JavaScript mac-windows.js   → JSON on stdout.
// Window titles need Screen Recording permission for the calling terminal.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function run() {
  const out = { displays: [], windows: [] };
  const screens = $.NSScreen.screens;
  const n = screens.count;
  const primaryH = n ? screens.objectAtIndex(0).frame.size.height : 0;
  for (let i = 0; i < n; i++) {
    const s = screens.objectAtIndex(i);
    const f = s.frame;
    out.displays.push({
      id: i + 1,                                     // `screencapture -D` numbering (1 = main)
      x: f.origin.x,
      y: primaryH - f.origin.y - f.size.height,      // flip to top-left origin
      width: f.size.width,
      height: f.size.height,
      scale: s.backingScaleFactor,
      name: s.localizedName ? ObjC.unwrap(s.localizedName) : undefined,
    });
  }
  const opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID))) || [];
  for (const w of list) {
    const b = w.kCGWindowBounds || {};
    const layer = w.kCGWindowLayer || 0;
    if (layer < 0 || layer > 25 || !b.Width || !b.Height) continue;            // normal windows, menubar, status items
    if ((w.kCGWindowAlpha ?? 1) === 0) continue;
    if (w.kCGWindowOwnerName === 'Window Server' && !w.kCGWindowName) continue;
    out.windows.push({
      app: w.kCGWindowOwnerName, pid: w.kCGWindowOwnerPID, title: w.kCGWindowName || '',
      x: b.X, y: b.Y, width: b.Width, height: b.Height, layer, windowId: w.kCGWindowNumber,
    });
  }
  return JSON.stringify(out);
}
