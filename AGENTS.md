# AGENTS.md

Guidance for AI coding agents working in this repo. `CLAUDE.md` is the long
version with the war stories behind each rule; read it before non-trivial work.

## What this is

Two halves, two languages of failure:

- **`mcp-server/`** — Node. A zero-dependency MCP stdio server + hub. Bugs here
  look like "the tool never appears in my client" or "every call times out".
- **`extension/`** — Chrome Manifest V3. Bugs here look like "it says it worked
  but nothing happened".

## Build, test, run

- No build step, no `npm install` — the repo has zero dependencies.
- `npm test` — 232 tests, no browser needed. **Run before and after every
  change.** Run it a few times when touching `ws.js` or `hub.js` (some races are
  intermittent).
- `npm run preview` — serves the UI and the in-browser accessibility-tree tests
  at `http://localhost:8850/test/a11y-browser.html` (needs a real viewport).
- `npm run hub` — run the hub standalone, verbose.
- `node mcp-server/src/index.js --health` — check whether Chrome is connected.

## Hard rules

- **Never add a dependency.** If you need a library, write the ~200 lines
  instead. This is the project's most important property.
- **`stdout` is protocol-only** in `mcp-server/`. Non-JSON-RPC output corrupts
  the stream; human-readable logging goes to stderr.
- **The service worker has no durable memory** (MV3 kills it after ~30s idle).
  Durable state lives in `chrome.storage`; every top-level statement in
  `background/` must be safe to run many times.
- **Write errors for a model to recover from.** Put the recovery action in the
  message: `"ref e12 no longer exists — take a fresh snapshot"`, not `"Error:
  null"`.
- **Sessions must not touch each other's tabs or windows.** Anything keyed by an
  agent-chosen name is keyed by `(session, name)`. Never act on a tab the session
  did not choose; `_session`, `_client` and `_browser` are stamped server-side
  after the args spread so a model cannot spoof them. Every path that takes a
  list of tab ids goes through `assertNotForeign` first.
- **Nothing an agent calls raises a window.** The only `windows.update(…focused:
  true)` in `router.js` is inside `showTab`, behind the default-off
  `raiseWindowOnSelect` setting; `npm test` asserts this. Humans raise windows
  (side-panel click); agents do not.
- **A session is one word.** `harbor`, never `client · harbor`; tab groups are
  `harbor` / `harbor · research` with no marker glyph. Agent groups are
  recognised by the ownership map in `chrome.storage.session`, never by title.
- **`element.click()` is ignored by serious sites** (`isTrusted: false`). All
  pointer/keyboard input goes through CDP's Input domain.

## The token budget is a first-class concern

`content/a11y.js` decides what a model sees; `background/format.js` decides how
it is written. Together they turn a 6,000-element page into ~350 characters. The
tool schemas in `mcp-server/src/tools.js` ship on every request and are asserted
under budget by `npm test` — don't grow them for prose. The snapshot format is
positional (`role "name" [ref] =value href states`); do not add keys.

## Adding a tool

Prefer not to — fourteen is deliberate; prefer an `action` enum on an existing
tool. If you must: schema in `mcp-server/src/tools.js`, handler in
`extension/background/router.js`, use `resolveTab(args)`, wrap mutations in
`withDelta()`, then re-run `npm test`.

## Reloads

Changes under `extension/` need `chrome://extensions` → **reload** to take
effect. Changes under `mcp-server/` are picked up when the MCP client next starts
the server. The hub is owned by whichever `mcp-server` started **first** —
restart the MCP clients, not just the extension, if hub behaviour looks stale.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope):
imperative summary`, why-in-body, link issues in trailers (`Refs: #NN`). Types:
`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`. See
[CONTRIBUTING.md](CONTRIBUTING.md).
