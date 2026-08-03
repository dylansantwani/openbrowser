# Architecture

Why the pieces are split the way they are, and the constraints that forced it.

```
  MCP client (Claude Code, opencode, …)
        │  stdio, JSON-RPC 2.0
        ▼
  mcp-server/src/index.js
        │  ws://127.0.0.1:8848
        ▼
  Chrome extension — service worker
        ├── chrome.debugger (CDP) ──> trusted input, screenshots, network
        └── chrome.tabs.sendMessage ──> content scripts in every frame
```

---

## Zero dependencies

Both halves have an empty `dependencies` block, and that is deliberate.

The most common reason a local MCP server does not work is that its install
failed — wrong Node version, a native module that will not build, a corporate
proxy, a lockfile drift. Every one of those turns into "the tool does not appear
in my client" with no useful error.

So the two things that would have pulled in packages are written here instead:

- **`ws.js`** — RFC 6455 WebSocket, client and server. Frame parsing, masking,
  continuation frames, ping/pong, close handshake. ~350 lines.
- **`mcp.js`** — MCP over stdio. It is JSON-RPC 2.0 with newline-delimited
  messages, which is small enough to implement directly and keeps the wire
  behaviour inspectable when something misbehaves.

The trade is real: these are now our bugs to fix. `test/run.mjs` covers them
first and hardest for that reason — and it has already caught one (see
[Framing](#framing-and-the-greeting-race)).

---

## The hub, and sharing one browser

One process owns the port. Whoever starts first binds it; anyone starting later
detects `EADDRINUSE` and joins over `/mcp` as a peer, proxying its calls through
the owner.

This matters because the normal state of affairs is more than one agent: an
editor agent and a CLI agent running at once. Without it the second one simply
fails to start, and the failure looks like a bug in the extension.

The extension connects to `/ext`. Only one extension is allowed at a time — a
reconnect supersedes the previous connection, which is what happens every time
the service worker is recycled.

### Framing and the greeting race

The hub greets a peer the moment it connects, in the same tick as the handshake
response. TCP coalesces the two writes into one packet, so the greeting arrives
in the same read as the HTTP 101.

The first version parsed those leftover bytes immediately — which fired
`'message'` before the caller, still blocked on the connect promise, had
attached a listener. The greeting was silently dropped, and the second agent
reported "no browser connected" while a browser was plainly connected. It failed
about two runs in three, which is the worst kind of bug: frequent enough to
matter, rare enough to look like something else.

`deliverWhenListening()` in `ws.js` holds buffered bytes until a `'message'`
listener exists. The same fix applies on the server side, where Node hands
leftover bytes to the `upgrade` handler as its third argument.

---

## Why the Chrome debugger

`element.click()` produces an event with `isTrusted: false`. Payment forms,
login pages, drag-and-drop libraries, and most anti-bot layers check that flag,
so synthetic events are silently ignored — the click "works", nothing happens,
and there is no error to read.

CDP's `Input` domain injects events at the browser level, indistinguishable from
a real user's. That is the difference between automation that works on real
sites and automation that only works on demos.

The cost is Chrome's "OpenBrowser is debugging this browser" banner. We attach
lazily, per tab, only when a tab needs trusted input, and detach when the tab
closes. It can be turned off entirely in options — with the caveat, stated
there, that many sites will then ignore the agent.

The debugger also gives us the things no extension API exposes: screenshots of
background tabs, `captureBeyondViewport` for seamless full-page shots,
`DOM.setFileInputFiles` for uploads, network and console capture, and device
emulation.

### Input details that matter

- A `mouseMoved` precedes every press. Hover-activated menus and tooltip-gated
  buttons need to see the cursor arrive before it clicks.
- `dblclick` needs two separate clicks with escalating `clickCount`. Sending
  `clickCount: 2` alone does not fire it.
- Drags interpolate with easing and pause after pressing. Drag libraries need
  movement above a threshold, and a single jump to the destination reads as a
  click.
- Chords omit `text` so `Control+a` selects all instead of typing "a".
- `Input.insertText` types a whole string in one round trip. It skips per-key
  events, so anything with input masking needs the slow path — hence `delay`.

---

## The accessibility tree

`content/a11y.js` decides what a model sees, which makes it the single biggest
lever on both token cost and reliability.

A typical page is ~90% wrapper divs, tracking pixels, and boilerplate. None of
it helps a model decide what to click. So the tree keeps controls and landmarks,
splices transparent wrappers into their parent, and drops everything else.

Beyond ARIA, it treats `onclick` handlers, non-negative `tabindex`, and
`cursor: pointer` on small leaf-ish elements as interactive. The
`<div class="btn" onclick=…>` pattern is everywhere, and a tree that only
respects real ARIA misses half the buttons on the modern web.

### Refs

Refs are reused across snapshots: an element that appears again keeps its old
ref. That is what makes `mode: "diff"` cheap and stops an unrelated re-render
from invalidating a model's plan.

Each ref stores both an element handle and a CSS selector. SPAs detach nodes
constantly, so when the handle goes stale the selector re-resolves it — which
recovers the common case where the page rebuilt the same UI.

Selector generation rejects generated identifiers (`css-1x2y3z`, `:r7:`, bare
hashes). Keying on those produces selectors that break on the next build.

### Frames

Refs carry their frame: `e12` is the main frame, `f2e12` is frame index 2.
Encoding it in the name means a ref stays meaningful across calls without a
fragile translation table, and stays readable in a transcript.

The hard part is coordinates. A frame cannot see its own position —
`window.frameElement` throws across origins, and nothing answers "where am I on
screen". So the parent tells it: each frame measures its child iframes, adds its
own known offset, and `postMessage`s the sum down. `postMessage` crosses origins,
so the offset cascades to the leaves, seeded by the top frame at (0, 0).

Without this, clicking anything inside a cross-origin iframe lands in the wrong
place.

---

## Output format

`background/format.js` is where the token budget is actually spent. Every byte
ships on every step of every task.

```
role "name" [ref] =value href states
```

Indentation carries structure. Fields are positional — a model infers the
grammar from two lines and never needs it explained. Anything derivable is
omitted: no `visible: true`, no empty arrays, no coordinates unless coordinates
are the point.

A login page renders in ~350 characters, against ~4,000 tokens of raw
accessibility JSON or ~1,500 for a screenshot.

### Diffs

`diffSnapshot` is a set difference over lines, not an LCS. The question a model
asks after clicking is "what appeared and what went away", not "what moved". Set
difference answers that in a fraction of the output, and a moved-but-unchanged
line correctly shows as no change.

When the diff approaches the size of the page, the page was replaced wholesale
and we send the new page instead. That check has a size floor — on a short page
the `+ `/`- ` prefixes alone can make a two-line diff "larger" than the page,
which is not a wholesale replacement. (This was a real bug; the test suite has a
case for it.)

### Action deltas

Every mutating tool returns a compact page delta. The model should rarely need
to call `browser_snapshot` just to find out whether its click worked — that
round-trip is pure cost, and removing it is the single biggest saving in the
design.

---

## MV3 and the disappearing service worker

The service worker is killed after ~30s idle and restarted constantly. So it
holds no meaningful state: durable things live in `chrome.storage`, transient
things are rebuilt on demand, and every top-level statement is safe to run many
times.

Keeping the hub connection alive takes two mechanisms:

1. **A 20s heartbeat.** WebSocket traffic resets the idle timer, but only if
   messages actually flow, so 20s sits comfortably inside the 30s window.
2. **A `chrome.alarms` backstop.** `setTimeout` dies with the worker. The alarm
   survives it and respawns the worker to reconnect — without it the extension
   goes quiet after a suspension and never comes back until you click something.

Reconnection backs off exponentially and never gives up. "Connection refused" is
the normal steady state, not an error: the extension is usually running long
before any MCP client launches a server.

---

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Trusted input, screenshots of background tabs, network/console capture, file inputs, device emulation |
| `tabs` | Enumerate, create, close, and address tabs by id |
| `scripting` | Inject content scripts into tabs that predate the extension |
| `<all_urls>` | Automation is not useful if it only works on a fixed list. Narrow it with the allowlist in options |
| `webNavigation` | Frame enumeration and load events |
| `cookies`, `downloads` | `browser_inspect` targets |
| `storage` | Settings and macros |
| `sidePanel` | The UI |

`debugger` is the broad one. It is what makes trusted input possible; it can be
disabled in options, at the cost of many sites ignoring the agent.

Everything binds loopback only. There is no telemetry and no outbound network
call of any kind.

---

## Testing

`test/run.mjs` covers what a real browser is not needed for, in order of how much
damage a bug would do:

1. WebSocket framing — masking and length-prefix bugs show up as silent
   corruption on large payloads (screenshots) and nowhere else. Covered with a
   500KB payload, which exercises the 64-bit length path.
2. MCP protocol — getting this wrong means the server never appears in the
   client, with no useful error.
3. The full round trip, including two clients sharing one browser, and the
   disconnected case.
4. Output formatting and macro substitution, including a token-budget assertion
   on the tool schemas so regressions there cannot creep in unnoticed.

Browser behaviour needs a real Chrome; [TESTING.md](TESTING.md) is the manual
checklist for it.
