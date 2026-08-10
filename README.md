<div align="center">

<img src="extension/icons/icon128.png" width="96" height="96" alt="OpenBrowser">

# OpenBrowser

**Browser automation for AI agents — in your real Chrome, with your real logins.**

A Chrome extension with a side-panel UI, plus a zero-dependency MCP server, so any
MCP client can drive an actual browser instead of a headless copy of one.

[![Website](https://img.shields.io/badge/site-openbrowser.pulse--core.com-38bdf8?style=flat-square)](https://openbrowser.pulse-core.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-64748b?style=flat-square)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-5b8c5a?style=flat-square)](package.json)
[![Chrome](https://img.shields.io/badge/chrome-%E2%89%A5116-5b8c5a?style=flat-square)](#install)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#zero-dependencies)

### [🌐 openbrowser.pulse-core.com](https://openbrowser.pulse-core.com)

[Install](#install) · [Tools](#the-tools) · [Token cost](#keeping-token-cost-down) · [Difficult sites](#difficult-sites) · [Security](#security) · [Docs](#development)

</div>

---

## Why this exists

Most browser automation hands your agent a fresh headless browser: signed out of
everything, fingerprinted as a bot, and reading pages as either raw DOM or
screenshots. OpenBrowser takes the opposite position on all three.

|  | What it means |
|---|---|
| 🔓 **Real browser, real session** | Runs in your actual Chrome, with your logins, cookies, and extensions. Nothing to keep signed in. |
| ⌨️ **Trusted input events** | Clicks and keystrokes go through the Chrome debugger, so they are indistinguishable from a real user's. Payment forms, login pages, and drag-and-drop all work. |
| 🪶 **Built for token cost** | Pages are read as a compact accessibility tree, not screenshots or raw DOM. A full login page costs ~350 characters. |
| ⚡ **Parallel by default** | Every tool takes a `tabId`. Read twenty tabs at once. |
| 📦 **Zero dependencies** | No `npm install`. Node 18+ and Chrome 116+ is the whole requirement. |
| 🏠 **Entirely local** | Loopback only. No telemetry, no analytics, no outbound calls. |

<a id="zero-dependencies"></a>

> **Zero dependencies is a feature, not a boast.** `npm install` failing is the
> most common reason a local MCP server doesn't work, and it fails silently from
> the user's point of view. The WebSocket and MCP protocol implementations are
> hand-written for exactly this reason.

---

## Install

### 1. Load the extension

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**,
and select the `extension/` folder.

### 2. Point your MCP client at the server

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add openbrowser -- node /absolute/path/to/openbrowser/mcp-server/src/index.js
```
</details>

<details>
<summary><b>opencode</b> — <code>~/.config/opencode/opencode.json</code></summary>

```json
{
  "mcp": {
    "openbrowser": {
      "type": "local",
      "enabled": true,
      "command": ["node", "/absolute/path/to/openbrowser/mcp-server/src/index.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Anything else</b> (Cursor, Windsurf, Zed, custom clients)</summary>

Standard MCP stdio server:

```json
{
  "mcpServers": {
    "openbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/openbrowser/mcp-server/src/index.js"]
    }
  }
}
```
</details>

### 3. Check it

```bash
node mcp-server/src/index.js --health
```

The toolbar badge clears when Chrome is connected. If it doesn't, see
[Troubleshooting](#troubleshooting).

---

## How it fits together

```
  Claude Code ─┐
               ├─ stdio ─> mcp-server ─ ws://127.0.0.1:8848 ─> Chrome extension ─> your tabs
  opencode ────┘
```

The first server to start binds the hub port; later ones join it. So several
agents can share one browser — an editor agent and a CLI agent can work in the
same session without fighting over it.

Everything is local. Nothing leaves your machine except the pages you ask it to
visit.

### Browsers on other machines

A hub can attach to hubs elsewhere, so one agent with **one** MCP config drives
browsers on any number of boxes:

```
  your agent ──> hub (laptop) ──┬──> Chrome, here
                                ├──ws──> hub (10.0.0.5) ──> Chrome, there
                                └──ws──> hub (10.0.0.6) ──> Chrome, there
```

On each remote machine, let the hub listen off-loopback:

```bash
node mcp-server/src/index.js --hub --host 0.0.0.0
```

Then, from an agent:

```
browser_window action:"connect" hub:"10.0.0.5"
```

Its browsers appear as `10.0.0.5/<name>` and are used exactly like local ones.
`action:"remotes"` lists what is attached; `action:"disconnect"` detaches.
`--connect 10.0.0.5,10.0.0.6` attaches them at startup instead.

> ⚠️ **The hub has no authentication.** Anything that can reach it can run
> JavaScript in a logged-in browser. `--host` defaults to `127.0.0.1` for that
> reason — keep federated hubs on a private network or a VPN mesh, never on a
> public IP.

---

## The tools

Fourteen tools, grouped by `action` enums rather than split into forty
single-purpose ones — models pick an enum value far more reliably.

| Tool | What it does |
|---|---|
| `browser_tabs` | list / new / close / select / reload / duplicate |
| `browser_navigate` | go to a URL, back, forward, reload |
| `browser_snapshot` | read the page as an accessibility tree with `[ref=eN]` handles |
| `browser_find` | find elements by description, ranked |
| `browser_act` | click, hover, drag, select, check, answer native dialogs — trusted input events |
| `browser_input` | type text, fill many fields at once, press keys |
| `browser_screenshot` | viewport / full page / element / region, or record a GIF |
| `browser_wait` | block on text, selector, URL, network idle, load |
| `browser_eval` | run JavaScript in the page |
| `browser_inspect` | console, network, cookies, storage, downloads, frames |
| `browser_batch` | run many calls as one request, optionally across many tabs |
| `browser_upload` | attach local files to a file input |
| `browser_window` | pick the window/browser, attach a hub on another machine, resize, emulate a device, throttle network |
| `browser_macro` | save and replay step sequences |

Full parameter reference: **[docs/TOOLS.md](docs/TOOLS.md)**.

### What a page looks like

`browser_snapshot` renders this:

```
app.example.com/login · "Sign in · Example" · tab 481 · 1280x800
banner
  link "Example" [e1] /
main
  heading "Sign in" h1
  form
    textbox "Email" [e2] required
    password "Password" [e3] required
    checkbox "Remember me" [e4] unchecked
    button "Sign in" [e5]
  link "Forgot your password?" [e6] /reset
```

356 characters — roughly 90 tokens. The same page is ~4,000 tokens as raw
accessibility JSON and ~1,500 as a screenshot.

### A whole login in one call

```json
{
  "tool": "browser_batch",
  "args": {
    "steps": [
      { "tool": "browser_navigate", "args": { "url": "app.example.com/login" } },
      { "tool": "browser_input", "args": {
          "fields": [
            { "ref": "e2", "value": "ada@example.com" },
            { "ref": "e3", "value": "correct horse battery staple" }
          ]}},
      { "tool": "browser_act", "args": { "action": "click", "ref": "e5" } },
      { "tool": "browser_wait", "args": { "for": "text", "value": "Dashboard" } }
    ]
  }
}
```

One round-trip instead of eight.

---

## Keeping token cost down

The design assumes tokens are the scarce resource:

1. **Snapshots, not screenshots.** ~20x cheaper, and refs are directly
   actionable. Screenshot only to verify something visual.
2. **`mode: "diff"` in loops.** After the first snapshot, ask only what changed.
3. **Actions return their own delta.** After a click you usually already know
   what changed, so no follow-up snapshot is needed.
4. **`selector` to scope.** On a dense page, read the one region you care about.
5. **`browser_batch` for known flows.** Collapses N round-trips into one.
6. **`browser_macro` for repeated flows.** Derive the flow once, replay for the
   cost of a single call.

---

## Difficult sites

The cases that usually break browser automation, and what handles them here:

| Problem | How it is handled |
|---|---|
| Site ignores synthetic clicks | Trusted events via the Chrome debugger |
| Content inside iframes | All frames are read; refs carry their frame (`f2e5`) |
| Cross-origin iframe coordinates | Offsets cascade via `postMessage` so clicks land correctly |
| Element under a cookie banner | Detected before clicking, and reported with what is covering it |
| Shadow DOM / web components | Open shadow roots are pierced when reading and hit-testing |
| React ignores a typed value | Native setter + the event pair frameworks actually listen for |
| Hidden file inputs behind "Browse" | The real `input[type=file]` is located from the visible control |
| Drag-and-drop libraries | Interpolated, eased movement above the drag threshold |
| SPA re-render invalidates a ref | Refs re-resolve through a stored selector before failing |
| Element is off screen | Auto-scrolled into view, then waited until it stops moving |
| CAPTCHA | Detected and reported. **Not bypassed** — that needs a human |
| Click opens a new tab or popup | Reported with the new tab's id, rather than looking like nothing happened |
| Tab is in the background | Foregrounded before input; Chrome silently discards clicks aimed at hidden tabs |
| Click seems to do nothing | Distinguishes "the app has not reacted yet" from "the click missed" |
| Native JS dialog (alert/confirm/beforeunload) | Reported with the dialog's text; answered with `browser_act action:"dialog" accept:true/false` |

Every row above is a bug that was found by driving the extension against a real
site, not a hypothetical. The write-ups are in
[docs/SESSION-2026-08-02.md](docs/SESSION-2026-08-02.md) and
[docs/SESSION-2026-08-03.md](docs/SESSION-2026-08-03.md).

---

## Side panel

Click the toolbar icon or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>.

- **Control** — tabs, quick actions, element search
- **Tools** — run any tool by hand and see exactly what an agent would get
- **Macros** — inspect, run, and delete saved sequences
- **Activity** — every call with timing and errors

The panel calls the same dispatcher the MCP server does, so it is the fastest
way to debug a flow: try it by hand, then hand it to the model.

---

## Configuration

Extension options (`chrome://extensions` → Details → Extension options):

| Setting | Default | Notes |
|---|---|---|
| Hub port | `8848` | Must match the server's `--port` |
| Connect automatically | on | Reconnects on browser start |
| Trusted input events | on | Turning this off makes many sites ignore the agent |
| Highlight elements | on | Outlines elements as they are used |
| Capture bodies | off | Request/response bodies; large, often sensitive |
| Snapshot budget | 20,000 chars | Truncation limit |
| Blocklist | identity providers | Never automated |
| Allowlist | empty | If non-empty, *only* these sites are automated |

---

## Security

- Binds **loopback only** (`127.0.0.1`). Nothing is exposed to your network.
- No telemetry, no analytics, no outbound calls of any kind.
- The blocklist ships with identity providers on it, because an automation
  mistake against an SSO flow is expensive and hard to undo.
- CAPTCHAs are reported, never solved or bypassed.
- The `debugger` permission is what makes trusted input possible. It is broad —
  read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#permissions) for exactly what
  it is used for, and turn it off in options if you would rather not grant it.

> ⚠️ **Treat an agent with browser access as having your logged-in privileges.**
> Use the allowlist when running unattended.

---

## Troubleshooting

<details>
<summary><b>Badge shows <code>○</code>, health says not connected</b></summary>

```bash
node mcp-server/src/index.js --health
```

The hub only exists while an MCP client has the server running. To test
standalone: `npm run hub`.
</details>

<details>
<summary><b>"Cannot attach to this page"</b></summary>

Chrome blocks extensions on `chrome://` pages, the Web Store, and other
extensions' pages. Navigate somewhere else.
</details>

<details>
<summary><b>"DevTools is open on this tab"</b></summary>

DevTools and the extension cannot both own the debugger. Close DevTools, or use
another tab.
</details>

<details>
<summary><b>Refs keep going stale</b></summary>

The page re-renders aggressively. Use `browser_find` immediately before acting,
or `browser_batch` so the whole sequence runs before the page can change under
you.
</details>

<details>
<summary><b>Service worker went idle</b></summary>

Expected under MV3. It respawns and reconnects on its own; the first call
afterwards may take a moment.
</details>

<details>
<summary><b>A change to <code>extension/</code> did nothing</b></summary>

Chrome caches extension files. Anything under `extension/` needs
`chrome://extensions` → **reload** before it takes effect. Anything under
`mcp-server/` is picked up when the MCP client next starts the server.
</details>

---

## Development

```bash
npm test          # 75 tests: WebSocket framing, MCP protocol, round trip, formatting
npm run preview   # UI preview + 68 browser tests at :8850
npm run hub       # hub only, verbose
npm run icons     # regenerate icon PNGs
```

`npm run preview` serves two things that need a DOM: the side-panel UI at `/`,
and the accessibility-tree assertions at `/test/a11y-browser.html`.

Layout:

```
extension/
  background/   service worker: bridge, router, CDP, recorder, frames, formatting
  content/      injected: accessibility tree, actions, frame offsets
  sidepanel/    the UI
  options/      settings
mcp-server/src/ ws.js (hand-rolled RFC 6455), hub.js, mcp.js, tools.js
docs/           capabilities, tools reference, architecture, test checklist
site/           the source of openbrowser.pulse-core.com (static, no build step)
```

The site is three files — `index.html`, `styles.css`, `app.js` — with no build
step, and `site/` is deployed as the web root (assets resolve at `/styles.css`,
not `/site/styles.css`). Preview it locally with `npm run preview` and open
<http://localhost:8850/site/index.html> — the dev server has no directory
index, so the filename is required.

It is hosted on **Cloudflare Pages**, project `openbrowser`, at
<https://openbrowser.pulse-core.com>. Nothing in this repo deploys it — there is
no CI and no `wrangler.toml`, so editing `site/` does not change what is live.
Publish with:

```
npx wrangler login    # once — opens a browser to authorise
npm run deploy        # wrangler pages deploy site --project-name=openbrowser --branch=main
```

`--branch=main` pins it to the production deployment; without it wrangler
infers the branch from git and a detached HEAD lands on a preview URL instead.

Two things the markup depends on, worth keeping if you edit it:

- **Content is visible by default.** The scroll-reveal effect only engages
  under the `js-reveal` class that the inline script in `<head>` sets, and
  `app.js` removes it again if the IntersectionObserver never reports anything
  (background tab, prerender, some webviews). Hiding first and un-hiding with
  JS means one observer that never fires renders the whole page blank.
- **Links point at `github.com/dylansantwani/openbrowser`.** They used to point
  into the private `dylansantwani/claude` monorepo path, which 404s.

| Doc | What it is for |
|---|---|
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | What the fourteen tools can do in combination — parallel tabs, macros, retroactive network capture, trusted input, iframe reach |
| [docs/TOOLS.md](docs/TOOLS.md) | Full parameter reference |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why the pieces are split this way |
| [docs/TESTING.md](docs/TESTING.md) | Manual checklist for the parts that need a real browser |
| [docs/SESSION-2026-08-02.md](docs/SESSION-2026-08-02.md) | First real-site hardening pass: what broke, what was fixed, what is still unproven |
| [docs/SESSION-2026-08-03.md](docs/SESSION-2026-08-03.md) | Second pass — OAuth, popups, checkout forms, and the backgrounded-tab input bug |

`CLAUDE.md` carries the hard rules and the platform behaviours that each cost a
real bug to discover. `TODO.md` has the open work with reproduction details.

---

## License

MIT — see [LICENSE](LICENSE).

<div align="center">
<br>

**[openbrowser.pulse-core.com](https://openbrowser.pulse-core.com)**

</div>
