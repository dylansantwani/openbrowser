# Contributing to OpenBrowser

Thanks for taking the time to contribute. OpenBrowser is deliberately small and
opinionated, so a few rules keep it that way. Please read this before opening a
pull request.

## The one rule that matters most

**Never add a dependency.** Both `package.json` files ship with empty
`dependencies`, and that is the single most important property of this project.
`npm install` failing is the most common reason a local MCP server does not work,
and it fails silently from the user's point of view. The WebSocket
(`mcp-server/src/ws.js`) and MCP protocol (`mcp-server/src/mcp.js`) are
hand-written for exactly this reason. If you need a library, write the ~200 lines
instead.

## Development setup

Requirements: **Node 18+** and **Chrome 116+**. There is no build step and no
install step.

```bash
git clone https://github.com/dylansantwani/openbrowser.git
cd openbrowser
```

Load the extension once (`chrome://extensions` → Developer mode → **Load
unpacked** → select `extension/`), then point an MCP client at
`mcp-server/src/index.js`. See the [README](README.md#install) for per-client
config.

A couple of platform facts that trip people up:

- **Changes under `extension/` need a reload.** Chrome caches extension files:
  after editing anything in `extension/`, go to `chrome://extensions` and click
  **reload**. Changes under `mcp-server/` are picked up the next time your MCP
  client starts the server.
- **`stdout` is protocol-only** in `mcp-server/`. Anything written to stdout that
  is not a JSON-RPC frame corrupts the stream and the client drops the connection
  with no useful error. Human-readable output goes to stderr.

## Running the tests

```bash
npm test          # 232 tests, no browser needed — run before and after every change
npm run preview   # then open http://localhost:8850/test/a11y-browser.html
npm run hub       # run the hub standalone, verbose (handy for debugging)
```

`npm test` covers the parts that are easy to get subtly wrong: the hand-rolled
WebSocket framing, the MCP stdio protocol, the full round trip, and output
formatting. It also asserts the tool schemas stay under budget — they ship on
every request, so growing them costs tokens on every call.

The in-browser suite at `/test/a11y-browser.html` needs a **real viewport**; a
few geometry assertions fail with nonsense rects in a zero-sized window. When you
touch `ws.js` or `hub.js`, run `npm test` a few times — some races only show up
intermittently. `docs/TESTING.md` has the manual checklist for behaviour that
needs a real browser.

## Adding a tool

Prefer not to. Fourteen tools is deliberate — models pick an `action` enum on an
existing tool more reliably than they pick between similarly named tools, and
every new tool taxes every request forever. If you genuinely need one, follow the
steps in `CLAUDE.md` (schema in `mcp-server/src/tools.js`, handler in
`extension/background/router.js`, wrap mutations in `withDelta()`), then re-run
`npm test`.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): imperative summary

Why the change is needed and what it does, in the body. Wrap at ~72 columns.

Refs: #123
```

- **type** — one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.
- **scope** (optional) — the area touched, e.g. `extension`, `mcp-server`,
  `hub`, `a11y`, `docs`.
- **summary** — imperative mood ("add", not "added"), no trailing period.
- **body** — explain *why*, not just *what*. The diff already shows what changed.
- **trailers** — link issues with `Refs: #NN` or `Closes: #NN`.

Examples:

```
fix(router): foreground a backgrounded tab before dispatching trusted input
docs: rewrite README and add contributor + agent meta-files
feat(hub): federate hubs so one config reaches browsers on any machine
```

## Pull requests

1. Branch from `main` (e.g. `fix/stale-refs`, `docs/tools-reference`).
2. Keep the change focused — one logical change per PR.
3. Make sure `npm test` passes, and exercise anything browser-facing by hand
   (the side panel's **Tools** tab is the fastest way).
4. Update the docs when behaviour changes — the README, `docs/`, and `CLAUDE.md`
   are part of the code.
5. Fill out the PR template, describe what you changed and why, and link any
   related issues.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
