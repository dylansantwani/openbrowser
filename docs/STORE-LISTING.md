# Chrome Web Store listing — OpenBrowser

Everything below is copy-paste ready for the Chrome Web Store developer
dashboard. The upload zip is `openbrowser-1.0.0.zip` at the repo root.

## Basics

| Field | Value |
|---|---|
| **Name** | OpenBrowser |
| **Version** | 1.0.0 (`manifest.json`; bump `version` for every upload — CWS rejects a same-version re-upload) |
| **Category** | Developer Tools |
| **Single purpose** | Browser automation for AI agents: an accessibility-tree view of pages plus trusted input, exposed through a side panel and a local MCP server |
| **Language** | English |

## Short description (132 chars max)

> AI agents drive your real Chrome with your real logins. Side panel plus a local MCP server for Claude Code, opencode, and more. Open source, zero dependencies, no telemetry.

## Detailed description

> **OpenBrowser** gives AI agents a real Chrome with real logins — not a headless copy that is signed out of everything.
>
> - **Real browser, real session** — agents use your existing Chrome tabs, cookies, and extensions. Nothing extra to sign in to.
> - **Read pages as a compact accessibility tree** — a login page renders in ~350 characters, so agent context is spent on decisions, not page dumps.
> - **Trusted input events** — clicks and keystrokes go through the Chrome debugger, so payment forms, login pages, and drag-and-drop all work.
> - **Fourteen tools** — tabs, navigate, snapshot, find, act, input, screenshot, wait, eval, inspect, batch, upload, window, macro.
> - **Parallel by default** — every tool takes a `tabId`; read twenty tabs at once.
> - **Zero dependencies** — no `npm install`. Node 18+ and Chrome 116+ is the whole requirement.
> - **Entirely local** — binds loopback only. No telemetry, no analytics, no outbound calls.
>
> The extension ships a side panel UI (Ctrl+Shift+U) and connects to the included open-source MCP server so Claude Code, opencode, Cursor, or any MCP client can drive it.
>
> ⚠️ Treat an agent with browser access as having your logged-in privileges. Use the allowlist in options when running unattended.
>
> Open source (MIT): https://github.com/your-org/openbrowser — MCP server and install docs in the README.

## Permission justifications

The store requires one to three sentences per sensitive permission. These are
the answers to give under "Justification" in the dashboard.

| Permission | Justification |
|---|---|
| `debugger` | Required for trusted input events (indistinguishable from a real user, so payment forms and login pages accept them), screenshots of background tabs, network/console capture, and file uploads. Attached lazily per tab, only when a tab needs input; detachable in options. |
| `<all_urls>` host permissions | Automation is not useful against a fixed site list. The allowlist in options can restrict it to specific sites. Content scripts build the accessibility tree on every page. |
| `tabs` | Enumerate, create, close, and address tabs by id — the core of the tab tools. |
| `scripting` | Inject the accessibility-tree content scripts into tabs that predate the extension. |
| `webNavigation` | Frame enumeration and load events for iframe support. |
| `cookies` | `browser_inspect cookies` — reading cookies on pages the agent is asked to inspect. |
| `downloads` | `browser_inspect downloads` — listing the browser's downloads on request. |
| `clipboardWrite` | The side panel's "copy output" button (user-initiated). |
| `storage` | Persist settings and saved macros locally. |
| `sidePanel` | The side-panel UI. |
| `tabGroups` | Group an agent's tabs under a workstream label so they are visibly separate from the user's. |
| `activeTab` | Act on the user's active tab when an agent call targets it. |
| `alarms` | Keep the service worker reconnecting to the local hub after MV3 idle suspension. |

## Privacy

CWS questionnaire answers:

| Question | Answer |
|---|---|
| Does your product collect or transmit data? | **No.** The extension connects only to `ws://127.0.0.1` (loopback) and transmits nothing off the machine. No telemetry, no analytics, no third-party requests. |
| Privacy policy URL | Not required (no data collection). If the review requests one anyway, host the repo's SECURITY/README privacy section. |
| Remote code | None. No remotely hosted code, no `eval`/`new Function`, no external resources. MV3 default CSP. |
| Single purpose | Confirmed: browser automation for AI agents. |

## Screenshots (upload in the dashboard)

1. The side panel (open a page, `Ctrl+Shift+U`) showing a snapshot and tab list.
2. The options page.
3. An example accessibility-tree output next to the page it describes.

## Publish checklist

- [ ] `extension/manifest.json` version bumped for this upload (1.0.0 = first upload)
- [ ] Zip is `openbrowser-1.0.0.zip` (repo root) — contents are exactly `extension/`, `manifest.json` at zip root
- [ ] Icons present: 16/32/48/128 PNG (already shipped)
- [ ] No `npm install` needed anywhere; MCP server is `node mcp-server/src/index.js`
- [ ] Listed under the developer account that owns the project (publish, then "Load unpacked" remains available for dev)
- [ ] After the first publish, `npm test` still passes (75 tests) before each new version
