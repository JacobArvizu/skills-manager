#!/usr/bin/env python3
"""Pinpoint (KDE Plasma, Wayland or X11): ask KWin for window geometry.

KWin doesn't expose window positions directly, but it runs user scripts. This
loads kwin-windows.js through org.kde.KWin /Scripting, receives its result via a
D-Bus call back to this process, and unloads the script. Same approach as
kdotool. Prints {"windows": [...], "screens": [...]} or {"error": ...}.
"""
import json
import os
import sys
import tempfile

try:
    from gi.repository import Gio, GLib
except Exception as e:  # noqa: BLE001
    print(json.dumps({"error": "python3-gi not available: %s" % e}))
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
IFACE = """<node><interface name="org.pinpoint.Receiver">
  <method name="Result"><arg type="s" name="json" direction="in"/></method>
</interface></node>"""


def main():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "no D-Bus session bus: %s" % e}))
        return
    loop = GLib.MainLoop()
    result = {}

    def on_call(_conn, _sender, _path, _iface, method, params, invocation):
        if method == "Result":
            result["data"] = params.unpack()[0]
            invocation.return_value(None)
            loop.quit()

    node = Gio.DBusNodeInfo.new_for_xml(IFACE)
    reg = bus.register_object("/", node.interfaces[0], on_call, None, None)

    with open(os.path.join(HERE, "kwin-windows.js"), encoding="utf-8") as f:
        src = f.read().replace("__PP_SERVICE__", bus.get_unique_name())
    fd, script = tempfile.mkstemp(prefix="pinpoint-kwin-", suffix=".js")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(src)
    plugin = "pinpoint_%d" % os.getpid()

    def call(path, iface, method, args, reply):
        return bus.call_sync("org.kde.KWin", path, iface, method, args,
                             GLib.VariantType(reply) if reply else None, Gio.DBusCallFlags.NONE, 5000, None)

    try:
        sid = call("/Scripting", "org.kde.kwin.Scripting", "loadScript",
                   GLib.Variant("(ss)", (script, plugin)), "(i)").unpack()[0]
        if sid < 0:
            raise RuntimeError("KWin refused to load the script")
        ran = False
        for path in ("/Scripting/Script%d" % sid, "/%d" % sid):  # Plasma 6, Plasma 5
            try:
                call(path, "org.kde.kwin.Script", "run", None, None)
                ran = True
                break
            except Exception:  # noqa: BLE001
                continue
        if not ran:
            raise RuntimeError("could not start the KWin script")
        GLib.timeout_add(4000, loop.quit)
        loop.run()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "KWin scripting unavailable: %s" % e}))
        return
    finally:
        try:
            call("/Scripting", "org.kde.kwin.Scripting", "unloadScript", GLib.Variant("(s)", (plugin,)), "(b)")
        except Exception:  # noqa: BLE001
            pass
        os.unlink(script)
        bus.unregister_object(reg)
    if "data" not in result:
        print(json.dumps({"error": "KWin script did not report back (timed out)"}))
        return
    print(result["data"])


main()
