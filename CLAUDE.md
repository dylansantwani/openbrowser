# OpenBrowser — working guidance

Read this before changing anything in `openbrowser/`. It exists because most of
what is non-obvious here was learned by driving the extension against real sites
and watching it fail in ways that are invisible from unit tests.

---

## What this is

A Chrome extension plus a zero-dependency MCP server, letting any MCP client
(Claude Code, opencode, Cursor) drive a real Chrome browser with the user's real
logins.

```
  MCP client ──stdio──> mcp-server ──ws://127.0.0.1:8848──> extension ──> tabs
```

Two halves, two languages of failure:

- **`mcp-server/`** is Node. Bugs here look like "the tool never appears in my
  client" or "every call times out".
- **`extension/`** is MV3. Bugs here look like "it says it worked but nothing
  happened".

---

## Hard rules

**Never add a dependency.** Both `package.json` files have empty `dependencies`
and that is the single most important property of this project. `npm install`
failing is the most common reason a local MCP server does not work, and it fails
silently from the user's point of view. The WebSocket (`src/ws.js`) and the MCP
protocol (`src/mcp.js`) are hand-written for exactly this reason. If you need a
library, write the 200 lines instead.

**stdout is protocol-only.** In `mcp-server/`, anything written to stdout that
is not a JSON-RPC frame corrupts the stream and the client drops the connection
with no useful error. Human-readable output goes to stderr.

**The service worker has no memory.** MV3 kills it after ~30s idle and restarts
it constantly. Anything durable lives in `chrome.storage`; anything else is
rebuilt on demand. Every top-level statement in `background/` must be safe to
run many times.

**Errors are written for a model to recover from.** `"ref e12 no longer exists —
the page changed; take a fresh snapshot"` beats `"Error: null"`. Put the
recovery action in the message. This is not politeness; it is the difference
between an agent retrying correctly and an agent giving up.

**Sessions must not be able to touch each other's tabs.** Several agents share
one browser; that is the point of the hub. So anything keyed by a name an agent
chooses — tab groups above all — is keyed by `(session, name)`, never by name
alone. Two agents will both call a workstream "research", and if that is one
group then one agent's `close_group` closes the other's tabs. `_session` is
stamped by the server *after* the argument spread so a model cannot assert
someone else's identity by emitting `_session` itself.

**Never act on a tab the session did not choose.** A call with no `tabId`
resolves to the session's own last-driven tab, and opens a fresh one in the
session's group when it has none. It never falls back to whatever the human is
looking at — that is how two agents ended up fighting over one tab, and how an
agent followed the human around as they switched tabs. Pointing a session at an
existing page is an explicit `tabId`, and that tab is then pulled into the
session's group like everything else it drives.

**A session works in one window, and it is told which.** Tab groups only
organise tabs inside a window, so with two windows open an agent's first tab
lands in whichever one Chrome considers current — the one the human was last
looking at. `windows.js` binds a session to a window before it opens anything;
with several open, `ensureWindow` throws a chooser instead of guessing, and the
human answers either through the agent (`browser_window action:"use"`) or by
clicking the prompt `action:"pick"` paints in every window. Bindings are keyed
by session label in `chrome.storage.session` and released when the session ends,
so a name reused later never inherits a window nobody chose for it.

The pick prompt is the one thing on a page an agent must not be able to see:
it is in `OWN_DECORATION` in `a11y.js`, so it never enters a snapshot, so no
agent can find its buttons and answer a question about itself.

---

## Where the token budget goes

This is the thing most likely to regress silently.

`content/a11y.js` decides what a model sees, and `background/format.js` decides
how it is written. Together they turn a 6,000-element page into ~350 characters.
A change that looks harmless in either file can multiply cost across every step
of every task.

Guard rails already in place:

- `test/run.mjs` asserts the tool schemas stay under 14.1KB. They ship on every
  request. Raise it only for guidance that demonstrably prevents a failed call —
  never to make room for prose. The comment there records every time it moved
  and what failure each raise bought.
- `test/a11y-browser.html` asserts a login form renders under 250 characters.

Before changing either file, run both. If output grows, justify it.

`a11y.js` also caches the built tree, keyed by mode/selector/viewportOnly (plus
scroll position when `viewportOnly`, since scrolling mutates nothing). The cache
is only safe because invalidation is deliberately stupid: *any* mutation
anywhere throws all of it away. Resist making it clever about which subtree
changed — a stale ref points at an element that no longer exists, and that costs
far more than the walk it saved. Cached trees are returned by identity, so
nothing downstream may mutate the node objects.

**The format is positional**: `role "name" [ref] =value href states`, indented by
depth. Do not add keys. A model infers this grammar from two lines; adding
`visible: true` to every node costs thousands of tokens to say nothing.

---

## Things that are true and surprising

Each of these was a real bug. They are the reason the code looks the way it does.

**`checkVisibility()` returns false for `display: contents`.** The element
generates no box, but its children render normally. Facebook wraps large
subtrees in `<span style="display:contents">`, so treating this as invisible
blanks out the entire page. See `isVisible()`.

**Virtual key codes are not character codes.** `'.'` is charCode 46, which is
`VK_DELETE`. `"'"` is 39, which is `VK_RIGHT`. Deriving key codes from
`charCodeAt` means every period deletes a character and every apostrophe moves
the caret. See `PUNCTUATION_VK` in `background/cdp.js`.

**`requestAnimationFrame` never fires in a background tab.** Awaiting it bare
hangs forever — and backgrounded tabs are the normal case for parallel work. See
`nextFrame()` in `content/actions.js`.

**A server's first WebSocket frame arrives with the handshake.** TCP coalesces
them, so parsing immediately fires `'message'` before the caller has attached a
listener. See `deliverWhenListening()` in `mcp-server/src/ws.js`. Node hands the
same leftover bytes to the `upgrade` handler as its third argument.

**Typing produces no mutation record.** `input.value` is a property, not the
`value` attribute, so a MutationObserver sees nothing when a field is filled.
The tree cache in `a11y.js` therefore also listens for `input`/`change` — without
that it would report a field as still empty immediately after typing into it,
which reads to an agent as "my typing did not land" and prompts a retry that
types the text twice. Focus has the same shape of problem and a different fix:
Chrome defers focus events while a document lacks system focus, and backgrounded
tabs are the normal case here, so `document.activeElement` is compared directly
rather than listened for.

**`chrome.storage` has no read-modify-write, and three agents will find that
out.** The natural shape — read the map, edit your session's key, write the map
back — spans two awaits, so a second session's read lands before the first's
write and the first's change is simply gone. Two agents survive it by luck;
three hit it constantly, which is exactly the configuration the hub exists for.
The damage is not a missing entry but a *wrong* one: a session whose window
binding vanished asks again, and with one window open it is answered silently
with the focused window — where the other agents already are. Reported live as
"agents are using the wrong window". Everything touching a shared storage key
now goes through a per-key promise chain (`mutate` in `windows.js`,
`mutateStored` in `router.js`). One service worker means one JS context, so a
promise chain is a sufficient lock.

`groups.assign` had the same shape against Chrome's own state: look for the
group, miss, create it. Two tabs grouped at once made *two* groups with one
title, and a lookup taking the first match then saw half a workstream — in
whichever window it happened to pick. It is serialised per workstream now, and
the lookups gather every matching group rather than the first, so a duplicate
from an older run cannot hide tabs. `test/run.mjs` covers both; the group one
was verified to fail when the guard is removed.

**The service worker dies while a prompt is waiting for a human.** The window
picker asks the user a question and waits up to 90s. MV3 tore the worker down
in the middle of that repeatedly — visible in the hub log as a disconnect and
reconnect with the prompt still on screen — and the click then arrived at a
*fresh* worker whose `pending` map was empty. The answer was dropped, silently,
and the call hung until it timed out. The bridge's 20s heartbeat did not prevent
it: a WebSocket send does not reliably reset Chrome's idle timer, while an
extension API call does. So `windows.js` runs a `getPlatformInfo` keepalive for
as long as a prompt is up, *and* keeps the tally in `chrome.storage.session` so
a respawned worker still counts the answer and the retry can report it. Anything
else that waits on a human needs both halves — the keepalive is not a guarantee.

**`!important` beats a CSS animation, so forcing a property makes it inert.**
Author `!important` declarations sit *above* animations in the cascade. Every
rule in `overlay.css` is forced, because a page's own reset must not be able to
hide our overlays — so when the agent frame was given a pulse, the base
`border: … !important` silently won and the animation did nothing. It is
attached, `playState` is `running`, `animationName` is right, and the computed
value never moves. Nothing about it looks broken. Any property a keyframe drives
must therefore be declared *without* `!important`, which is the one place this
file breaks its own rule. `test/overlay-preview.html` samples the computed value
across the cycle rather than trusting that the animation exists.

**MutationObserver does not cross a shadow boundary, but the tree walk does.**
`subtree: true` stops at the shadow root; `childrenOf` walks straight through
open ones. Every shadow root met during a walk is observed explicitly, or a web
component's internal re-render leaves the cache quietly stale.

**Content scripts get injected more than once.** `injectInto` fires whenever a
command meets a frame without a script, and two commands racing on one frame
both inject. Re-running `a11y.js` used to hand out a fresh ref registry, silently
invalidating every ref the agent held; re-running `actions.js` reset
`frameOffset` to 0,0, sending every click in that frame to the wrong pixel until
the next offset cascade. Both now guard on an `OB.__*Loaded` flag — anything new
with module-level state must do the same.
    See `drainPending()` in `content/a11y.js`.

**Modals live at the end of the DOM.** Any read budget that runs out cuts off
exactly the dialog the agent wants. Truncation must always be reported —
silently returning a partial page is worse than an error, because "no matches"
then means two completely different things.

**A backgrounded tab silently drops CDP input.** `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent` land nowhere when `document.visibilityState` is
`hidden` — no error, the call reports success, and the page never sees the
click. Screenshots and the accessibility tree work fine on hidden tabs, which is
what makes this so easy to miss. Anything dispatching trusted input must
foreground the tab first; see `ensureForeground()` in `background/router.js`.
The cost is that input cannot be parallelised across tabs in one window, which
is a Chrome constraint, not a design choice.

**`element.click()` is ignored by serious sites.** It produces `isTrusted:
false`. Everything pointer-related goes through CDP's Input domain for this
reason. If you are tempted to "simplify" by using `.click()`, don't.

---

## Layout

```
extension/
  background/         service worker — no durable state
    router.js         tool dispatch; every MCP call lands here
    cdp.js            Chrome DevTools Protocol: trusted input, screenshots, uploads
    a11y.js  (content/) the accessibility tree — the token budget lives here
    format.js         rendering — the other half of the token budget
    frames.js         iframe enumeration, injection, ref routing (fN prefix)
    recorder.js       console/network ring buffers, captured continuously
    groups.js         tab groups, one per MCP session
    windows.js        which window a session works in; the in-browser chooser
    bridge.js         WebSocket client + reconnection + MV3 keepalive
  content/            injected into every frame
  sidepanel/          the UI — calls the same dispatch() as MCP
  options/            settings

mcp-server/src/
  ws.js               hand-rolled RFC 6455
  mcp.js              hand-rolled MCP over stdio
  hub.js              routes calls; lets several MCP clients share one browser
  tools.js            the 14 tool schemas — token-critical

test/
  run.mjs             99 tests, no browser needed
  a11y-browser.html   73 tests, needs a browser (npm run preview)
  overlay-preview.html the on-page overlays, self-checking (same server)
```

---

## Driving the extension by hand during development

You cannot call the browser tools directly while developing them — your own
session's tools are a different thing. To exercise the real extension against a
real page, act as an MCP client yourself: spawn the server over stdio, complete
the handshake, and issue `tools/call`.

Write this once into a scratch directory (not the repo):

```js
// live.mjs — usage: node live.mjs '[{"name":"browser_tabs","args":{"action":"list"}}]'
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const p = spawn('node', ['<abs-path>/mcp-server/src/index.js'], { stdio: ['pipe','pipe','pipe'] });
const pend = new Map(); let id = 1;
createInterface({ input: p.stdout }).on('line', l => {
  if (!l.trim()) return; let m; try { m = JSON.parse(l) } catch { return }
  const r = pend.get(m.id); if (r) { pend.delete(m.id); r(m) }
});
const req = (method, params) => new Promise((res, rej) => {
  const i = id++; pend.set(i, res);
  setTimeout(() => rej(new Error('timeout')), 60000);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
});
await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dev', version: '1' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
for (const c of JSON.parse(process.argv[2])) {
  const r = await req('tools/call', { name: c.name, arguments: c.args || {} });
  console.log(`\n### ${c.name}\n` + (r.result?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'));
}
p.kill(); process.exit(0);
```

Two hard-won notes on this:

- **Write JS for `browser_eval` to a file and read it in**, rather than
  embedding it in JSON. Regex literals (`\d`, `\s`, `\.`) are invalid JSON
  escapes and will burn several calls before you notice. A second tiny harness
  that takes a `.js` file path pays for itself immediately.
- **Windows paths need forward slashes** in any JSON argument. `C:\Users\...`
  does not parse.

Screenshots are worth saving to disk and opening, not just checking for
presence — a `.value` can be empty while the control visibly shows a value
(Meta's time picker does exactly this).

## Testing

```bash
npm test          # 99 tests — run before and after every change
npm run preview   # then open /test/a11y-browser.html for 68 DOM tests
```

The DOM tests need a **real viewport**. In a zero-sized or not-yet-laid-out
window the three click-point geometry assertions fail with nonsense rects —
that is the harness, not a regression. Check `innerHeight` before believing a
failure there.

Run `npm test` **several times** when touching `ws.js` or `hub.js`. The greeting
race described above failed roughly two runs in three; a single green run proved
nothing.

`docs/TESTING.md` has the manual checklist for behaviour that needs a real
browser. Work through it after changing `content/` or `background/cdp.js`.

---

## Adding a tool

Don't, if you can avoid it. Fourteen is deliberate — prefer an `action` enum on
an existing tool. Models pick enum values more reliably than they pick between
similarly-named tools, and every new tool taxes every request forever.

If you must:

1. Add the schema to `mcp-server/src/tools.js`. Keep the description to what it
   does plus the one thing that is easy to get wrong.
2. Add the handler to `HANDLERS` in `extension/background/router.js`.
3. Use `resolveTab(args)` to get the tab — it is also where session grouping
   happens.
4. Wrap mutations in `withDelta()` so the result includes what changed.
5. Re-run `npm test`; the schema size assertion will tell you if you overspent.

---

## Known rough edges

`TODO.md` lists them with reproduction details, and marks each as not started,
built-but-unverified, or verified live. The highest-value open ones: session
labels are opaque hex that tells a human nothing about the work, and there is
no explicit "page is settling" signal after a click that changed nothing.
Native-dialog handling (`browser_act action:"dialog"`), the tall-page
`full_page` fail-fast, and the `find` href-ranking fix are done and verified
live.

---

## Changes that need a reload

Chrome caches extension files. Anything under `extension/` needs
`chrome://extensions` → reload before it takes effect. Anything under
`mcp-server/` is picked up when the MCP client next starts the server.

This trips people up constantly — if a fix "didn't work", check this first.

## Session naming and cleanup live in the hub owner

Session names (`claude · harbor`) are allocated by the **hub**, because that is
the only process that can see every live session and therefore the only one that
can guarantee two never collide onto the same tab group. Cleanup on disconnect
is triggered there too.

The consequence trips people up: the hub is owned by whichever `mcp-server`
process started **first**. Reloading the extension does not update it. If
sessions are still showing old-style hex labels, or tabs are not being tidied
up, the hub owner is running old code — restart the MCP clients (opencode,
Claude Code) and not just the extension.

Cross-session tab protection is in `router.js` and *does* take effect on an
extension reload alone, because it is enforced browser-side.
