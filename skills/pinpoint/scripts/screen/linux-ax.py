#!/usr/bin/env python3
"""Pinpoint (Linux): AT-SPI accessibility tree of every showing window.

Breadth-first under a time/node budget; prints JSON {tree, truncated} on stdout.
Needs python3-gi + gir1.2-atspi-2.0 and the desktop's accessibility bus
(GNOME, KDE, and most GTK/Qt apps expose it).
Usage: linux-ax.py <budgetMs> <maxNodes> <maxDepth>
"""
import json
import sys
import time

budget = (int(sys.argv[1]) if len(sys.argv) > 1 else 8000) / 1000.0
max_nodes = int(sys.argv[2]) if len(sys.argv) > 2 else 4000
max_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 12

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as e:  # noqa: BLE001
    print(json.dumps({"error": "AT-SPI not available: %s" % e, "tree": []}))
    sys.exit(0)

t0 = time.time()
tree = []
truncated = False
WINDOW_ROLES = {Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG, Atspi.Role.ALERT, Atspi.Role.FILE_CHOOSER}


def text(v, n=500):
    if v is None:
        return None
    v = str(v)
    return v[:n] if v else None


def extents(acc):
    try:
        r = acc.get_extents(Atspi.CoordType.SCREEN)
        return r.x, r.y, r.width, r.height
    except Exception:  # noqa: BLE001
        return None


def showing(acc):
    try:
        s = acc.get_state_set()
        return s.contains(Atspi.StateType.SHOWING) and s.contains(Atspi.StateType.VISIBLE)
    except Exception:  # noqa: BLE001
        return False


def value_of(acc):
    try:
        t = acc.get_text_iface() if hasattr(acc, "get_text_iface") else None
        if t is not None:
            return text(Atspi.Text.get_text(t, 0, min(500, Atspi.Text.get_character_count(t))))
    except Exception:  # noqa: BLE001
        pass
    try:
        v = acc.get_value_iface() if hasattr(acc, "get_value_iface") else None
        if v is not None:
            return text(Atspi.Value.get_current_value(v))
    except Exception:  # noqa: BLE001
        pass
    return None


def add(acc, parent, app, pid):
    ext = extents(acc)
    if not ext or ext[2] <= 0 or ext[3] <= 0:
        return -1
    try:
        role = acc.get_role_name()
    except Exception:  # noqa: BLE001
        role = None
    try:
        ident = acc.get_accessible_id() if hasattr(acc, "get_accessible_id") else None
    except Exception:  # noqa: BLE001
        ident = None
    tree.append({
        "parent": parent, "app": app, "pid": pid, "role": role,
        "name": text(acc.get_name()), "description": text(acc.get_description()),
        "value": value_of(acc), "identifier": text(ident),
        "x": ext[0], "y": ext[1], "width": ext[2], "height": ext[3],
    })
    return len(tree) - 1


try:
    desktop = Atspi.get_desktop(0)
    queue = []
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            app_name, pid = app.get_name(), app.get_process_id()
        except Exception:  # noqa: BLE001
            continue
        for j in range(app.get_child_count()):
            win = app.get_child_at_index(j)
            if win is None or not showing(win):
                continue
            try:
                if win.get_role() not in WINDOW_ROLES:
                    continue
            except Exception:  # noqa: BLE001
                continue
            wid = add(win, None, app_name, pid)
            if wid >= 0:
                queue.append((win, wid, 1, app_name, pid))
    while queue:
        if time.time() - t0 > budget or len(tree) >= max_nodes:
            truncated = True
            break
        acc, parent, depth, app_name, pid = queue.pop(0)
        try:
            n = acc.get_child_count()
        except Exception:  # noqa: BLE001
            continue
        for k in range(min(n, 500)):
            try:
                child = acc.get_child_at_index(k)
            except Exception:  # noqa: BLE001
                continue
            if child is None or not showing(child):
                continue
            cid = add(child, parent, app_name, pid)
            if cid >= 0 and depth < max_depth:
                queue.append((child, cid, depth + 1, app_name, pid))
            if len(tree) >= max_nodes:
                truncated = True
                break
except Exception as e:  # noqa: BLE001
    print(json.dumps({"error": str(e), "tree": tree, "truncated": truncated}))
    sys.exit(0)

print(json.dumps({"tree": tree, "truncated": truncated}))
