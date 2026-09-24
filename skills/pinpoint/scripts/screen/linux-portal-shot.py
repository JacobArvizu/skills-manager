#!/usr/bin/env python3
"""Pinpoint (Linux): full-screen screenshot through xdg-desktop-portal.

Works on any Wayland desktop with a portal backend (GNOME, KDE, wlroots with
xdg-desktop-portal-wlr, Hyprland). The first call may show a one-time
permission prompt. Usage: linux-portal-shot.py <output.png>
"""
import os
import shutil
import sys
from urllib.parse import unquote, urlparse

try:
    from gi.repository import Gio, GLib
except Exception as e:  # noqa: BLE001
    print("python3-gi not available: %s" % e)
    sys.exit(2)

out = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
token = "pinpoint%d" % os.getpid()
sender = bus.get_unique_name()[1:].replace(".", "_")
handle = "/org/freedesktop/portal/desktop/request/%s/%s" % (sender, token)
loop = GLib.MainLoop()
result = {}


def on_response(_conn, _sender, _path, _iface, _signal, params):
    code, results = params.unpack()
    result["code"] = code
    result["uri"] = results.get("uri")
    loop.quit()


bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response",
                     handle, None, Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
try:
    bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                  "org.freedesktop.portal.Screenshot", "Screenshot",
                  GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token),
                                                  "interactive": GLib.Variant("b", False)})),
                  GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 10000, None)
except Exception as e:  # noqa: BLE001
    print("portal call failed: %s" % e)
    sys.exit(3)

GLib.timeout_add_seconds(45, loop.quit)
loop.run()
if result.get("code") != 0 or not result.get("uri"):
    print("portal screenshot %s" % ("denied" if result.get("code") == 1 else "failed or timed out"))
    sys.exit(4)
src = unquote(urlparse(result["uri"]).path)
shutil.copyfile(src, out)
try:
    os.remove(src)  # the portal saves into ~/Pictures; don't leave a copy behind
except OSError:
    pass
