#!/usr/bin/env python3
"""Pinpoint (Linux): logical monitor layout via GDK, for scaling screenshots on any desktop.
Prints JSON [{x, y, width, height, scale}] (logical pixels)."""
import json
import sys

try:
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    display = Gdk.Display.get_default()
    if display is None:
        raise RuntimeError("no display")
    out = []
    for i in range(display.get_n_monitors()):
        m = display.get_monitor(i)
        g = m.get_geometry()
        out.append({"x": g.x, "y": g.y, "width": g.width, "height": g.height, "scale": m.get_scale_factor()})
    print(json.dumps(out))
except Exception as e:  # noqa: BLE001
    print(json.dumps({"error": str(e)}))
    sys.exit(0)
