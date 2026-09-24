---
name: pinpoint
description: Point-and-click visual feedback on anything on screen. On web pages, a browser overlay lets the user pick elements, quote text, drag regions or draw, then comment. For the whole desktop (native apps, terminals, simulators, design tools, any window), it captures every display plus the OS accessibility tree so the user can pick real windows, buttons and fields the same way. It also annotates images and mockups. Feedback comes back as structured data (selectors or accessibility paths, source hints, screen coordinates, cropped screenshots). Use this whenever the user wants to show rather than describe what to change ("let me point at it", "I'll mark it up", "that button", "look at my screen"), wants to review, QA or critique a web app, desktop app, mobile screen or mockup, or wants to leave UI comments for you or a teammate. Also use it when another skill or plugin needs element-level feedback from a human. It works without AI too, and exports Markdown or JSON.
license: MIT
compatibility: Needs Node.js 18+ and a browser. No npm install, no build step, no dev-server config. Screen mode uses built-in OS tools (macOS screencapture + System Events, Windows PowerShell + UI Automation, Linux grim/gnome-screenshot/import + wmctrl + AT-SPI).
---

# Pinpoint

Pinpoint turns vague visual feedback into precise, actionable items. The user clicks elements (on a live web page, or on a capture of the whole screen) and types what should change. You get back each element's selector, text, HTML snippet, key computed styles, source-file hints (Astro, Vue, Svelte, React component chain, code-inspector attributes) and a screenshot with the user's sketch drawn on it.

Everything is driven by one launcher: `scripts/pinpoint` (macOS/Linux) or `scripts/pinpoint.cmd` (Windows). Below, `pinpoint` means `<this-skill-dir>/scripts/pinpoint`. Always call it by its full path unless `pinpoint link` has put it on PATH. It needs no installation.

## The loop

```bash
P="<this-skill-dir>/scripts/pinpoint"

"$P" open <target>        # 1. start + open the page with the overlay
"$P" wait                 # 2. blocks until the user clicks Send → JSON batch
#    ... make the changes ...
"$P" reply <id> "what you did" --status resolved   # 3. answer each item
"$P" wait                 # 4. listen for the next batch; repeat until type=end
```

**1. Open.** `<target>` can be:
- a port (`5173`) or URL (`http://localhost:3000/settings`, `https://example.com`): **proxy mode**. The page is served through `http://127.0.0.1:4747` with the overlay injected. Nothing in the project changes. HMR websockets pass through, so the dev server keeps hot-reloading.
- a `.html` file or a folder (`./dist`, `index.html`): **static mode**, with the overlay injected into every HTML file.
- **Anything else on screen:** use `screen` instead of `open` (see [Screen mode](#screen-mode-any-app-any-window)).
- `start` (no target): **inject mode**, only the helper runs. Add the printed `<script>` snippet or the dashboard's bookmarklet to any page.

If the app isn't running yet, start its dev server first; when the default port is busy, the app is probably already up. `open` returns JSON with the `url` to show the user. It opens the system browser automatically when there's a display; pass `--no-open` if you're driving your own browser tool, then navigate that tool to `url`. Tell the user in one short line: open the link, press **Alt+P** to pick elements (or **Alt+D** to draw, or select text and click **Comment**), then click **Send**.

**2. Wait.** `wait` long-polls (default 600 s) and prints one event:
- `{"type":"submit", "annotations":[…], "message": "...", "next": "..."}`: the user sent feedback. Act on it.
- `{"type":"timeout"}`: nothing yet. Run `wait` again; don't pester the user.
- `{"type":"end"}`: the user clicked *End session*. Stop listening.

Run `wait` so it doesn't freeze the conversation:
- **Claude Code:** run it as a background Bash task (`run_in_background`). You're notified when it returns, and the user can keep chatting meanwhile.
- **Harnesses without background tasks:** run it in the foreground with `--timeout 300` and loop.
- The toolbar dot turns green while a `wait` is pending. If nobody is waiting, sends queue up safely and the next `wait` gets them.

**3. Act on each annotation.** Each item looks like:

```json
{
  "id": "3", "kind": "change|bug|question|note", "comment": "Make this bigger",
  "page": {"url": "http://localhost:5173/pricing", "path": "/pricing", "title": "Pricing"},
  "quote": "optional selected text",
  "targets": [{
    "selector": "main > section.plans > button[data-testid=\"upgrade\"]",
    "tag": "button", "text": "Upgrade",
    "source": {"file": "src/pages/pricing.astro", "line": 42, "components": ["PlanCard", "Pricing"]},
    "styles": {"font-size": "14px", "padding": "8px 12px", "background-color": "rgb(…)"},
    "rect": {"x": 812, "y": 1204, "width": 96, "height": 36},
    "html": "<button class=\"btn\" …>Upgrade</button>"
  }],
  "sketch": {"strokes": 2},
  "screenshot": "/Users/me/.pinpoint/sessions/default/shots/3.png"
}
```

How to use it well:
- **Find the code.** Start with `source.file`/`line` when present. Otherwise grep for the `text`, distinctive classes, `data-testid`, or component names. The selector describes the rendered DOM, not the source, so use it to confirm, not to search.
- **Look at the screenshot** (Read the PNG) when there's a sketch, when the comment is spatial ("too much space here"), or when the comment is ambiguous. Circles mean "this thing", arrows mean "move", and cross-outs mean "remove". Small elements are captured with surrounding context and outlined in violet.
- `quote` means the comment is about that exact text: usually copy edits.
- Multiple `targets` mean the comment applies to all of them together ("make these match").
- `kind: question` wants an answer, not necessarily a code change. Answer it via `reply`.
- Apply all the changes, then reply. The user watches the page; with HMR they see changes land live.

**4. Reply to every item.** This closes the loop in the user's browser: pins turn green and your note appears on the element.

```bash
"$P" reply 3 "Raised to 16px/600 and matched the primary button padding." --status resolved
"$P" reply 4 "Left as is: the grid is shared with /blog, changing it there breaks cards." --status wontfix
"$P" reply 5 "Do you want this on mobile too?"          # no status → stays open, user can answer in the page
"$P" resolve 6 7 8 --note "Fixed typo in all three."
```

When the user answers a question in the page, that item goes back to draft and arrives in a later `submit`, with the full thread in `replies`.

## Screen mode (any app, any window)

When the thing to review isn't a web page you can proxy (a desktop or Electron app, a terminal, an iOS/Android simulator, Figma, a game, OS settings, several apps at once), capture the display:

```bash
"$P" screen --delay 5          # countdown, so the user can bring the right app to the front
"$P" screen --image mock.png   # annotate an existing image: phone screenshot, mockup, bug report
```

`screen` screenshots every display and records every visible window (app, title, z-order) plus each window's accessibility tree (buttons, fields, rows, labels and their text). It then opens that frozen capture in the browser with the same toolbar. The user picks real windows and controls (hover highlights them, ↑/↓ walks the tree), drags a box around any area, or draws. Tell the user to use fullscreen and browser zoom to fit. **Recapture** in the capture's info bar (or **Capture screen in 5s** on the dashboard) takes a fresh capture without the terminal.

Screen annotations arrive through the same `wait`, but their targets describe native UI instead of DOM:

```json
{
  "id": "4", "comment": "Make Sign out red", "page": {"url": "screen://capture/2"},
  "targets": [{ "kind": "element", "app": "Settings", "window": "Settings", "role": "AXButton",
                "name": "Sign out", "identifier": "signout.button",
                "path": "Settings — Settings › group › button \"Sign out\"",
                "screen": {"x": 16, "y": 760, "width": 358, "height": 50} }],
  "region": null,
  "capture": { "id": "2", "platform": "darwin", "images": ["…/captures/2/display-1.png"] },
  "screenshot": "…/shots/4.png"
}
```

- Find the code from `app` plus visible strings (`name`, `value`) and `identifier` (accessibility ids often match source, e.g. `accessibilityIdentifier`, `AutomationId`, `testID`). `path` gives the containment chain.
- `kind` is `window`, `element`, or `desktop` (nothing specific under the pointer). A dragged box sets `region`, with `capture.screenRegion` in screen coordinates.
- Always look at `screenshot` (a crop with the target outlined) for screen annotations. Native trees are coarser than the DOM, and the image carries the intent.
- If a capture reports warnings (no accessibility permission, AT-SPI missing, Wayland), picking still works on whole windows and dragged regions. Relay the fix in one line if the user wants element-level picking.

Permissions: on **macOS**, the terminal needs *Screen Recording* (for pixels and window titles) and *Accessibility* (for UI elements) under System Settings → Privacy & Security. **Windows** needs nothing extra. **Linux** needs a screenshot tool (`grim` on wlroots Wayland, `gnome-screenshot`/`spectacle` elsewhere, or ImageMagick `import` on X11), `wmctrl` + `xprop` for window boxes on X11, and `python3-gi` + `gir1.2-atspi-2.0` for UI elements.

## Other commands

| Command | Purpose |
|---|---|
| `list [--status open\|draft\|sent\|resolved\|all] [--format json\|md]` | Annotations without waiting (works when the server is stopped). |
| `export [--format md\|json]` | Whole session, Markdown by default. Good for pasting into issues or PRs. |
| `show <id>` | One annotation with full detail (all attributes and styles). |
| `status` · `sessions` · `stop [--all]` | Inspect and stop servers. |
| `clear [--resolved]` | Remove annotations. |
| `open <other-target>` | Re-point a running session at a new URL or file. |
| `screen [--delay N] [--image f] [--snapshot tree.json] [--no-elements] [--budget secs]` | Capture the display or annotate an image (see Screen mode). |

Options: `--session NAME` keeps separate workspaces (e.g. one per project or per skill). `--port N` picks the port (default 4747, then the next free one). `--no-screenshots` skips captures. State lives in `~/.pinpoint/sessions/<session>/` (override with `PINPOINT_HOME`).

## Using Pinpoint from another skill or plugin

Pinpoint is a general-purpose "ask a human to point at things" primitive. Another skill (a design reviewer, a copy editor, an accessibility auditor, a QA flow) can:

1. Call the launcher by absolute path with its own session: `pinpoint open 3000 --session a11y-review`.
2. Optionally seed annotations for the human to confirm, from the page (`window.pinpoint.annotate(selector, comment)`) or via the HTTP API.
3. `wait --session a11y-review`, then process the batch with its own logic.

A skill that drives something Pinpoint can't capture natively (a phone over adb/`xcrun simctl`, a remote machine, a canvas app with its own scene graph) can hand over its own screenshot and element tree: `pinpoint screen --image shot.png --snapshot tree.json`. The user then picks those elements like any other.

The HTTP API, the event and annotation schemas, the `--snapshot` tree format, and the browser-side `window.pinpoint` API are in [references/protocol.md](references/protocol.md). Read it only when integrating programmatically; the CLI covers normal use.

## Using it without AI

Humans can run it directly. It's a standalone review tool:

```bash
skills/pinpoint/scripts/pinpoint link      # optional: puts `pinpoint` on PATH (~/.local/bin)
pinpoint open 5173                          # or a URL, file or folder
pinpoint screen --delay 5                   # or the whole screen, any app
```

Annotate in the browser, then use **⋯ → Copy all as Markdown** (or the dashboard at `/__pinpoint/`) to paste the feedback into an issue, a chat or any AI tool. `pinpoint serve <target>` keeps it in the foreground; Ctrl+C stops it.

## Troubleshooting

- **Page is blank or "Can't reach …":** the target isn't running. Start the dev server, then reload.
- **Overlay missing in inject mode:** the site's Content-Security-Policy blocks the snippet or bookmarklet. Use proxy mode (`pinpoint open <url>`), which strips CSP for the local view only.
- **Login or OAuth redirects leave the proxy:** cross-origin redirects can't be proxied. Log in on the proxied origin, or add the snippet to the app in dev and use `start`.
- **Selector no longer matches after edits:** expected once the DOM changes. Pins re-find elements by selector and XPath, and unmatched items still appear in the list.
- **Screen capture is black or shows only the wallpaper (macOS):** grant Screen Recording to the terminal app, then restart it.
- **Only windows, no UI elements:** see the permission and package notes under Screen mode; `--budget 20` allows deeper walks of huge apps.
- **`node_not_found`:** install Node 18+ or set `PINPOINT_NODE=/path/to/node`.
- **`Permission denied` running the launcher** (some installers drop the executable bit): use `sh <dir>/scripts/pinpoint …` or `node <dir>/scripts/pinpoint.mjs …`. They're equivalent.
