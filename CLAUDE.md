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

Several MCP clients share one hub, and one hub drives *several browsers*. A
session is bound to one browser and to one window inside it; the hub routes by
that binding. See "The browser was never a singleton" below.

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

The binding has to constrain *reads*, not just writes. Binding used to decide
only where the next `tabs.create` went, which left three ways for a session to
end up acting outside its own window — a rebind that moved the bookkeeping and
not the tabs, a user dragging a tab out, an explicit `tabId` from elsewhere — and
in every one of them `browser_window list` still cheerfully reported the chosen
window. So `sessionTabId` filters candidates by the bound window, `use`/`pick`
move the workstream to the new window (`groups.moveTo`), and an adopted tab
either sets the binding, if the session has none, or is moved to it.

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

**"The browser" was never a singleton, and every bug in that area was the same
bug.** The hub held one extension socket and evicted whoever was there when a
new one arrived — right for the case it was written for (an extension reload or
an MV3 worker respawn reconnecting), ruinous for a second browser. Both connect,
each eviction triggers the other's one-second reconnect, and the pair flaps
forever; every eviction runs `pending.rejectAll`, so agents mid-call get
"browser extension disconnected mid-call" at random. The first fix made the
second browser a standby, which stopped the flap by making that browser useless
— the same singleton assumption with better manners.

Now every connected browser is live and a *session* is bound to one, exactly as
a session is bound to a window one level in. `_routeFor` is `ensureWindow`'s
shape: bound sessions pass through, one browser is never a question, anything
ambiguous raises a chooser rather than guessing. Identity comes from a stable
`instance` id the extension keeps in `chrome.storage.local`, so a reconnection
is distinguishable from an arrival and supersedes only its own socket.

Guessing a browser is worse than guessing a window, and this is the reason the
design is strict: **tab ids are only unique within a browser.** Two Chromes each
allocate from their own counter, so id `511957184` names a real but different
tab in both — a misrouted call does not fail, it succeeds on the wrong page.
Hence `_browser` on every call, stamped by the hub after the caller's args for
the same reason `_session` is, and checked in `bridge.js` against the browser's
own instance. That one comparison is what makes a misroute loud.

Two consequences worth keeping: a browser that disconnects keeps its sessions'
bindings rather than releasing them (an extension reload is routine and the tabs
are still there — rebinding to whatever else is connected is the silent
wrong-target failure again), and `_onExtensionClose` fails only the calls that
were in flight *to that browser*, because one browser closing must not fail
another's work. The chooser lists windows across all browsers in one question:
nobody thinks "the work browser, then its second window", they think "that
window over there", so picking a window names its browser implicitly.

**A hub on another machine is that same problem a third time, and the fix is to
make it not a new problem at all.** `browser_window action:"connect"
hub:"10.0.0.5"` attaches a remote hub, and its browsers join `liveBrowsers()` as
`RemoteBrowser` proxies wearing the shape an extension connection has —
`instance`, `info`, `closed`, `sendJSON`. Everything downstream is untouched:
`_routeFor`, the chooser, session binding, the `_browser` stamp. That is the
whole design, and it is why federation cost `router.js` nothing.

What it replaced, built by hand against a real VM first: an SSH tunnel per
machine plus an `mcp-server` config entry per machine, because `mcp-server` only
ever dials `127.0.0.1` and the sole knob is `--port`. It works, and it does not
scale — a spare local port, a config block, and a process to babysit for every
box you add.

Two rules keep federation comprehensible:

- **One level deep.** `_sharedBrowsers` offers only `localBrowsers()`, never one
  reached through someone else, so A→B→A cannot form. A cycle here is not a hang
  but a call ping-ponging until it times out, and structural impossibility beats
  detection. Covered in `test/run.mjs`, and verified to fail when the guard is
  removed.
- **Names are namespaced at the boundary** — `remote/browser`. Instance ids are
  unique only within a hub, exactly as tab ids are unique only within a browser,
  and two machines each running an unnamed Chrome would otherwise put the same
  label in one chooser. The far side is always sent *its own* id, never the
  namespaced one, or the extension's `_browser` guard would reject every call.

**Receiving federation is always on; the gate is the bind address.** There is no
toggle for it, because a toggle in the extension would put a security control in
a different process from the thing it protects — and the hub can be running with
no extension attached at all, which is exactly when you would least want it
quietly accepting peers. `--host` defaults to `127.0.0.1`, so `/hub` is
unreachable off-machine until someone says otherwise.

**The hub has no authentication, so that default is load-bearing.** Anything
that reaches it gets `browser_eval` in a logged-in browser plus CDP trusted
input — remote code execution and session hijacking in one. `--host 0.0.0.0`
logs a warning saying so. Do not put this on a public address without auth in
front of it; a mesh (Tailscale/WireGuard) is the cheapest correct answer,
because it deletes the problem rather than solving it.

**A workstream group is not a window, and treating it as one is how agents get
lost.** `tabGroups.query({})` spans every window, so a workstream with a group in
two windows — from a rebind, or a tab dragged out — returned tabs from both, and
`sessionTabId` took the most recently accessed. The agent is then working in a
window while every status call it can make insists it is in the other one, with
both answers internally consistent. Two credible stories that disagree is worse
than one incomplete one. `tabsFor(name, windowId)` scopes resolution; cleanup
(`release`, `closeWorkstream`) deliberately stays unscoped, because releasing
half a workstream is worse than releasing all of it.

Related, and the reason it stayed invisible for so long: `browser_tabs list`
was a flat list of every tab in the browser with the window nowhere in it, and
it accepted `windowId` and silently ignored it — so two different windows
returned byte-identical output. An agent trying to work out where it was
literally could not. It is grouped by window now, with the session's own window
marked.

**The same omission one level up cost more, because a browser can be a different
machine.** `browser_tabs list` and `browser_window list` are each answered by one
browser and neither said which, so a hub driving the local Chrome and a hub
federated to a box in another building produced indistinguishable output. An
agent told to work on a remote machine called `browser_tabs list`, got a
perfectly good answer from the local Chrome, and concluded it was already
connected — it never issued `connect` at all, then spent the rest of the session
reading `ws.js` to find a connection problem that did not exist. `_nameBrowser`
appends one line naming the browser, and the remote hub when there is one.

Only on those two actions. Naming the browser on every call taxes every step of
every task to answer a question only orientation asks; doing it only when several
browsers are live — the tempting cheap version — would have missed the case above
entirely, where exactly one was.

**A peer's call does not go through `Hub.call()`.** `_onPeerMessage` routes the
frame straight at a connection, so anything that shapes a *result* has to be in
the relay as well — `_nameBrowserIn`, at both settle points, local and remote.
Written in `call()` alone it worked perfectly for the process that owns the hub
and was silently absent for every other MCP client on it, which is most of them:
one client starts the hub and the rest join. Nothing in `test/run.mjs` covered
the peer path at all, which is how it got that far; it does now.

**`chrome.tabs.group()` moves tabs, and it moves them to the wrong window.**
With no `createProperties.windowId`, the new group is created in the *current*
window — Chrome's last-focused one, which is the human's — and the tabs are
**moved there** to join it. Grouping is presentation: its failures are swallowed
on purpose, because a tab that could not be coloured still works. That reasoning
is only sound while grouping cannot do anything but colour.

Invisible for as long as agents worked in the window that was already current,
where the move was a no-op. `soloWindow` made it total: every first tab of every
workstream was dragged straight back into the user's window, and the agent's own
window — now empty — closed itself, so the session reported no window bound two
calls after being given one. Three separate symptoms, one line.

Two lessons worth more than the fix. The first is that it hid behind a *better*
symptom: the tab was misplaced, so the obvious suspect was `tabs.create`, and
`createTabIn` grew a readback that was correct, tested, and irrelevant. The
thing that moved the tab ran afterwards. The second is that `test/run.mjs`
modelled `tabs.group` as leaving tabs where they were — a stub that implements
the API you assume rather than the one that ships cannot fail. It models the
real contract now, and the group assertions were verified to fail without
`createProperties` (`[99,99,99]` — every tab in the focused window).

**`chrome.tabs.create({windowId})` is a request, not a promise of placement.** A
`windowId` Chrome will not honour does not reliably throw; the tab appears in the
last-focused window instead — the exact window the binding exists to keep agents
out of. `createTabIn` reads `windowId` back off the created tab and moves it if
it landed wrong. `tabs.move` after the fact is reliable in a way `create` is not,
because the tab exists by then.

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

**`active` is necessary and not sufficient, and that is why an agent made the
browser unusable.** Everything above is about *tabs*, and the window the tab is
in has the same power to hide it: a tab is `active` in a minimized window and
`active` in a window another window completely covers, and Chrome calls the
document hidden in both. So `chrome.tabs.get().active` cannot answer the only
question `ensureForeground` cares about. The page can, and now does — one
`visibility` round trip after activating, reported rather than fixed, because
the fix is a human uncovering a window and a click that lies about landing is
worse than a warning. The minimized case was not merely unhandled but
*advertised*: `browser_window state:"minimized"` said "automation keeps running",
and every click after it went nowhere. Input un-minimizes now.

The bigger half of this is social rather than technical. Foregrounding is
correct and unavoidable, and in *your* window it means the view being yanked to
the agent's tab several times a second for the length of a run — reported as
"the agent makes the window unusable while I am working in it".
`restoreFocusAfterInput` does not fix it; it converts a steal into a flicker.
Nothing polite is available, because only one tab per window is foreground and
the agent needs that slot.

So a session stops sharing: `soloWindow` (default on) has `ensureWindow` open a
window rather than hand over the one you are in. A tab that is foreground in an
*unfocused* window is still visible, so the agent gets what it needs and you
keep what you were doing. Three consequences worth keeping in view:

- **The chooser leaves the common path entirely.** It existed to stop agents
  landing in the wrong window; with a window of its own there is no wrong window,
  so there is nothing to ask. It still fires under `soloWindow: false`, which is
  the setting for people whose reason to share a window is to watch. This also
  removed a bug the fix would otherwise have created: the first agent's new
  window made a *second* window exist, so the next session hit "2 browser windows
  are open" and blocked on a human who had done nothing.
- **`focused: false` governs keyboard focus, not stacking order.** A window
  created unfocused is still placed *above* its siblings on macOS, so an agent
  starting up threw its window over the page being read. From the outside that
  is the takeover this whole module exists to prevent — the agent did not steal
  the window, it parked in front of it, and nobody cares about the difference.
  `createFor` reads `getLastFocused` before creating and puts that window back
  on top after, but only when it was genuinely focused: `getLastFocused` answers
  with a window whether or not Chrome is the front application, and raising one
  in a browser nobody is looking at drags the entire browser in front of the app
  they are actually using. Worth knowing that this is invisible to
  `browser_window action:"list"` whenever Chrome is backgrounded — every window
  reports unfocused, so the instrument reads clean at exactly the moment the
  behaviour is worth measuring.
- **The window a session is given must be reused, not decorated.** A fresh window
  arrives holding a New Tab page; opening a second tab beside it means closing
  the session's tabs at the end leaves that one behind, and Chrome keeps the
  window open for it — an empty window per finished session. `adoptBlankTab`
  takes the existing tab when it is a New Tab or blank page and nothing else,
  which is the narrowest reading of "empty" and the reason it does not violate
  "never act on a tab the session did not choose".
- **Owning a window and being bound to one are different facts, and only the
  first makes a tab switch invisible.** A window id says nothing about who else
  is in it, so ownership is recorded when the window is opened (`{id, own}`)
  rather than inferred. Bare ids from before that distinction read as *not*
  owned, which is the safe side. The hole this closed: `claimTab` used to bind a
  session to the window of any tab it was handed, and an explicit `tabId` only
  ever comes from one place — a tab of yours. Handing an agent one tab handed it
  your whole window, one switch at a time. The tab comes to the session now; the
  session never goes to the window.
- **The guard fails closed.** Relocating a tab home is best-effort; refusing to
  activate one anywhere else is not. The tempting fallback — activate it where
  it is, the call succeeds, the agent gets on with it — is the failure worth
  refusing over, because the tab in front of someone can change while they are
  typing into it, and the next keystrokes of whatever they were writing go to a
  page an agent chose. A stopped call is recoverable and names its remedy; a
  stolen keystroke is neither. Every path that can bring a tab forward goes
  through `assertOwnWindow`.
- **Only trusted input needs the tab in front, and most work is not trusted
  input.** Filling fields goes through the content script, which writes the DOM
  and works perfectly on a tab reporting `visibilityState: "hidden"` — measured,
  along with navigation, snapshots, screenshots and eval. So `browser_input`
  foregrounds lazily, at the first thing that actually needs it, and a form fill
  now surfaces nothing at all. `browser_upload` likewise: `setFileInput` never
  foregrounds, only the file-picker click does.
- **Occlusion does not hide a tab.** Measured, after being assumed twice in the
  other direction: a window completely covered by a maximized one keeps
  `visibilityState: "visible"`, as does every tab in a Chrome that is behind
  another application. Only *not being the active tab of its window* hides a
  tab. So an agent's window can sit permanently behind yours, or on another
  Space, and still take trusted input — which is the whole reason the
  one-window-per-session design works rather than merely relocating the problem.
- **Sharing is still reachable, so it still has to be survivable.** An explicit
  `use`/`pick`, or adopting a tab in your window, puts a session back in it. That
  path now says so once per session per window and names `action:"new"` — once,
  because advice repeated on every click is just cost.

**A screenshot is not a coordinate space, and pretending it is puts every click
in the wrong place.** Coordinates *in* — `browser_act coordinate`, `region` —
are viewport CSS pixels. The image *out* is neither: it has been through two
independent rescalings, the device pixel ratio at capture and the `maxWidth`
downscale, and on a 2560px viewport at dpr 1.5 that lands at 1280px wide, a
factor of exactly 0.5. A model reading a button's centre off the image and
passing it back clicks at half the intended offset — and does so silently,
because there is always *something* at the wrong coordinate.

This is why `fmt.captureGeometry` exists, and why it earns its bytes: every
capture states what it covers and how to invert it (`0.50x of 2560x1271 CSS px
· divide image coords by 0.50`), and says nothing extra when the mapping is 1:1.
Two properties are load-bearing and easy to lose:

- **Viewport-relative, not document-relative.** Scrolling does not shift the
  input space — the same coordinate is the same screen position at any scroll
  offset — so a coordinate cannot be reached by adding `scrollY` to a
  document-space number. `full_page` is the exception and the reason the note
  says so: its image runs past the viewport, so its coordinates are document
  space and the scroll offset has to come back off before clicking.
- **CSS pixels, not device pixels.** `devicePixelRatio` is part of why the image
  is the size it is and no part of the coordinate space.

Worth knowing when comparing against Claude in Chrome, which takes the opposite
side of the same trade: its coordinates are in *screenshot* pixels and it
converts for you, so a `getBoundingClientRect()` value passed straight through
is wrong there by exactly the factor above. Neither convention is wrong; a
capture that does not state which one it is using is.

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
  federation.js       hub-to-hub links; remote browsers as local-looking proxies
  tools.js            the 14 tool schemas — token-critical

test/
  run.mjs             199 tests, no browser needed
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
npm test          # 199 tests — run before and after every change
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
