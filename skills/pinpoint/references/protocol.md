# Pinpoint protocol reference

For skills, plugins, scripts and tools that integrate with Pinpoint programmatically. Normal use only needs the CLI described in SKILL.md.

## Contents
- [Files on disk](#files-on-disk)
- [Annotation schema](#annotation-schema)
- [Screen captures and `--snapshot`](#screen-captures-and---snapshot)
- [Events (`wait`)](#events-wait)
- [HTTP API](#http-api)
- [Browser API (`window.pinpoint`)](#browser-api-windowpinpoint)
- [CLI output conventions](#cli-output-conventions)

## Files on disk

```
$PINPOINT_HOME (default ~/.pinpoint)/sessions/<session>/
  state.json    annotations + event queue (source of truth; safe to read any time)
  server.json   {pid, port, url, adminToken, pageToken, target} — mode 600, exists while running
  server.log    helper server stdout/stderr
  shots/<id>.png
  captures/<n>/   snapshot.json + display-*.png for each screen capture / image
```

Reading `state.json` directly is fine. Write through the CLI or HTTP API so open browsers get live updates.

## Annotation schema

```jsonc
{
  "id": "3", "n": 3,                          // per-session counter, stable
  "status": "draft" | "sent" | "resolved" | "wontfix",
  "kind": "change" | "bug" | "question" | "note",
  "comment": "string",
  "page": { "url": "target-origin URL (not the proxy URL)", "path": "/pricing", "title": "…" },
  "targets": [{                              // 0..n elements; 0 only for page-level notes
    "selector": "unique CSS selector at capture time",
    "xpath": "/html[1]/body[1]/…",
    "tag": "button", "id": "…", "classes": ["…"],
    "text": "visible text (≤300 chars)",
    "attrs": { "role", "aria-label", "href", "src", "alt", "name", "type", "placeholder", "data-testid", … },
    "rect": { "x", "y", "width", "height" },  // document coordinates, CSS px
    "styles": { "font-size": "…", … },         // non-default computed styles, curated list
    "html": "outerHTML snippet (≤1200 chars)",
    "source": { "file", "line", "column", "framework", "components": ["Inner", "Outer"] }
  }],
  "quote": "selected text" | null,
  "strokes": [{ "color": "#ff3b6b", "points": [[x, y], …] }],   // document coordinates
  "viewport": { "width", "height", "dpr", "scrollX", "scrollY" },
  "region": { "x", "y", "width", "height" } | absent,   // dragged box, document coordinates
  "capture": { "id", "platform", "capturedAt", "screenRegion"? } | absent,  // screen-mode annotations
  "screenshot": "shots/3.png" | null,         // relative to the session dir; CLI output makes it absolute
  "replies": [{ "from": "agent" | "user", "text": "…", "at": "ISO date" }],
  "createdAt", "updatedAt", "sentAt"
}
```

Source hints are best effort. They come from `data-astro-source-file/loc`, `data-insp-path` (code-inspector), `data-inspector-*` (react-dev-inspector), `data-source-file`/`data-source`, React fibers (component names; `_debugSource` on React ≤18 dev), Vue (`__vueParentComponent.type.__file`), and Svelte dev (`__svelte_meta.loc`).

The CLI's `wait` and `list` output a compact form: `xpath`, `classes`, `n`, `viewport` and `strokes` are dropped, the sketch becomes `{"strokes": N}`, `html` is capped at 800 chars, and the screenshot path is absolute. Use `list --full` or `show <id>` for everything.

On screen captures, each target also carries `native` (`kind` window|element|desktop, `app`, `pid`, `role`, `name`, `description`, `value`, `identifier`, `className`, `window`, `path`) and `screen` (its rectangle in screen coordinates). `selector` is then only the board's internal id (`#n42`). The compact form flattens `native` into the target.

## Screen captures and `--snapshot`

`pinpoint screen` writes `captures/<n>/snapshot.json`:

```jsonc
{ "version": 1, "platform": "darwin" | "win32" | "linux" | "image", "capturedAt": "…",
  "bounds": { "x", "y", "width", "height" },                  // virtual desktop, logical units
  "displays": [{ "id", "x", "y", "width", "height", "file": "display-1.png", "scale": 2 }],
  "nodes": [{ "id", "parent": null | id, "kind": "window" | "element", "app", "pid", "role",
              "name", "description", "value", "identifier", "className", "x", "y", "width", "height" }],
  "warnings": ["…"] }
```

Windows come first, front to back; elements follow their window, breadth-first. `scale` is image pixels per logical unit (2 on Retina).

To bring your own capture (a phone, a remote host, a canvas app), pass `--image shot.png --snapshot tree.json`, where `tree.json` is the raw form:

```jsonc
{ "tree": [ { "parent": null, "app": "MyApp", "role": "Window", "name": "Home", "x": 0, "y": 0, "width": 390, "height": 844 },
            { "parent": 0, "role": "Button", "name": "Sign out", "identifier": "signout", "x": 16, "y": 760, "width": 358, "height": 50 } ],
  "windows": [],        // optional: { app, pid, title, x, y, width, height }, front to back, matched to tree roots by overlap
  "displays": [] }      // optional: multi-image layouts; defaults to one display the size of --image
```

`parent` is an index into `tree`, and roots are windows. Coordinates are in the image's own space (same units as `displays`; with no displays, image pixels). Children inherit `app`/`pid` from their window.

## Events (`wait`)

Events queue in `state.json` and are delivered once, oldest first, to whichever `wait` is pending. A `wait` started later still gets events sent while nobody was listening.

```jsonc
{ "type": "submit", "seq": 7, "session": "default", "at": "…",
  "message": "optional note for the whole batch", "count": 3,
  "annotations": [ /* compact annotations */ ], "next": "instructions" }
{ "type": "timeout", "session": "default", "next": "…" }   // nothing arrived in time
{ "type": "end", "seq": 8, "session": "default", "next": "…" }   // user clicked End session
{ "type": "stopped", "session": "default" }                 // server shut down while waiting
```

`wait --format md` returns the same submit as Markdown instead of JSON.

## HTTP API

Base: `http://127.0.0.1:<port>/__pinpoint`. Token header: `x-pinpoint-token` (or `?token=` for EventSource/img). CORS is open, so any local page can call it with the right token.

**Admin token** (`server.json → adminToken`) is for tools and the CLI:

| Method & path | Body / query | Result |
|---|---|---|
| `GET /api/wait?timeout=600&format=md` | | one event (see above) |
| `POST /api/reply` | `{id \| ids, text?, status?}` (`status`: resolved, wontfix, open, sent, draft) | `{ok, updated}` |
| `POST /api/target` | `{target: {kind: "url", url, origin, entry} \| {kind: "static", root, entry} \| {kind: "none"}}` | re-point the proxy |
| `POST /api/clear` | `{which: "all" \| "resolved" \| "sent"}` | `{removed}` |
| `POST /api/stop` | | shuts the server down |

**Page token** (`server.json → pageToken`, also embedded in the served overlay) is for the overlay and dashboard. The admin token works here too:

| Method & path | Body / query | Result |
|---|---|---|
| `GET /api/annotations?status=all` | | `{annotations, listening}` |
| `POST /api/annotations` | annotation fields (no id) | `{annotation}` (status `draft`) |
| `PUT /api/annotations/:id` | any of `kind, comment, targets, quote, strokes, status, page, viewport`, plus `reply` (appends a user reply) | `{annotation}` |
| `DELETE /api/annotations/:id` | | `{ok}` |
| `POST /api/shot/:id` | `{dataUrl: "data:image/png;base64,…"}` | `{path}` |
| `POST /api/submit` | `{ids?, message?}` (default: all drafts) | `{seq, count, delivered}` |
| `POST /api/end` | | queues an `end` event |
| `POST /api/capture` | `{delay?, elements?}` | new screen capture → `{id, url, warnings}` |
| `GET /api/captures` | | `{captures: [{id, url, capturedAt, platform, windows}]}` |
| `GET /captures/<n>/snapshot.json`, `/captures/<n>/display-1.png` | | capture data |
| `GET /api/stream` | SSE | `snapshot`, `upsert`, `delete`, `listening`, `target` messages |
| `GET /api/export?format=md\|json&status=all` | | Markdown or JSON download |
| `GET /shots/<id>.png` | | the screenshot |

Unauthenticated: `GET /api/health`, `GET /overlay.js` (the browser script, with its config prepended), `GET /` (the dashboard) and `GET /screen/<n>` (a capture's annotation board).

## Browser API (`window.pinpoint`)

Available on any page with the overlay loaded, for page scripts, devtools, or browser-automation tools:

```js
pinpoint.pick()          // enter pick mode      pinpoint.draw()  // draw mode
pinpoint.stop()          // back to idle
await pinpoint.annotate('#checkout', 'Button label is unclear', 'question')  // seed an annotation
pinpoint.list()          // current annotations
pinpoint.open('3')       // scroll to #3 and open it
await pinpoint.send('optional message')   // same as clicking Send
```

Pages can also load the overlay themselves in development:

```html
<script src="http://127.0.0.1:4747/__pinpoint/overlay.js" defer></script>
```

## CLI output conventions

- When stdout isn't a TTY (agents, pipes), every command prints JSON. Failures print `{"ok": false, "error": "<code>", "message": "…"}` and exit with status 1.
- On a TTY, `list`, `export`, `status` and `open` print human-friendly text. Force either with `--format json|md`.
- Error codes: `capture_failed`, `missing_image`, `not_running`, `not_found`, `missing_id`, `missing_text`, `bad_status`, `target_not_found`, `server_start_failed`, `already_running`, `connection_lost`, `node_not_found`, `node_too_old`.
