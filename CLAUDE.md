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

**Nothing an agent calls brings a window to the front.** `browser_tabs select`
and `browser_window focus` used to activate the tab *and* focus its window, and
with agents pooled in one background window that meant the agent window
jumping over whatever the person was reading. Both now go through `showTab` in
`router.js`, which activates the tab inside an agent-only window (its own, or
the shared pool — `windows.agentWindowIdFor`) and touches the window only when
`raiseWindowOnSelect` is on, which it is not by default. `test/run.mjs` asserts
that `chrome.windows.update(…focused: true)` appears exactly once in the router
and only behind that guard. A human who wants to look clicks a tab row in the
side panel; that path raises the window because a human asked.

**A list of tab ids from a model is checked as a whole before anything acts.**
`close`, `reload` and `group` with `tabIds` used to act on every id unchecked,
so an agent could close another agent's tabs — or the user's — by passing ids it
had read off a listing. `assertNotForeign` refuses the batch if any id belongs
to another session. Related: `browser_tabs list` shows a session only its own
tab ids; other agents are counts. An id a model never sees is one it cannot
misuse.

**"My tab" means the session's last tab, in any of its groups.** A call with no
`group` used to resolve only inside the group that shared the session's name,
so an agent that had opened its tabs under `group:"research"` and then made an
ordinary call was handed a fresh blank tab and snapshotted `about:blank`.
`rememberSessionTab` records every tab under the session as a whole as well as
under its group, and `sessionTabId` with no `group` searches the whole session.
With `group`, resolution is scoped to that group as before.

**Windows are named by role, not by id.** `windows.windowName` renders `the
agent window (id N)`, `harbor's window (id N)`, or `window N (the user's,
focused)`; `format.windowLabel` is the same function for the module the tests
load standalone. The id stays because `action:"use" windowId:` takes it. Bare
ids were the single biggest reason nobody — human or model — could read the
window output.

---

## Where the token budget goes

This is the thing most likely to regress silently.

`content/a11y.js` decides what a model sees, and `background/format.js` decides
how it is written. Together they turn a 6,000-element page into ~350 characters.
A change that looks harmless in either file can multiply cost across every step
of every task.

Guard rails already in place:

- `test/run.mjs` asserts the tool schemas stay under 17.4KB. They ship on every
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
what makes this so easy to miss. The cost is that input cannot be parallelised
across tabs in one window, which is a Chrome constraint, not a design choice.

**Foregrounding to fix this was the disease, not the cure, and it is gone.** The
earlier answer was `ensureForeground()`: activate the tab (and focus its window)
before every trusted-input dispatch. It was guaranteed, and it was the single
biggest complaint this project produced — the user's view yanked to the agent's
tab several times a second for the length of a run. That function has been
**removed**. `browser_act`, `browser_input` and `browser_upload` no longer
activate a tab or raise a window; only the two calls whose whole purpose is to
show a human a tab still focus — `browser_tabs action:"select"` and
`browser_window focus` (both still gated by `assertOwnWindow`).

What replaces it is two independent moves, neither of which touches the user's
window:

- **Keep the agent out of your window in the first place.** `soloWindow`
  (default on) gives a session its own window, and `agentWindowPool` (default
  on) collapses those into one shared background window instead of one per
  session — see "collapsing sprawl into a pool" in `windows.js`. A tab that is
  the active tab of an *unfocused* window is normally still `visible`, so it
  takes trusted input while sitting behind whatever you are doing. This covers
  the common case with no interruption at all.
- **When the tab really is `hidden`, tell the truth instead of stealing focus.**
  Full opaque coverage, a native-fullscreen app on its own Space, or off-screen
  placement do mark a tab `hidden`, and input then drops. Rather than
  foreground to force it, the dispatch reports `UNVERIFIED … dispatched`: the
  input was sent, but no page change was observed, so the agent must verify
  before continuing. A click that honestly says "I could not confirm this" is
  strictly better than one that lies about landing — which is the whole failure
  this section is about.

`Emulation.setFocusEmulationEnabled` (`emulateFocus` in `cdp.js`) is the
optional third move: it tells Blink the page is focused and active regardless of
window state, so even a fully covered tab keeps compositing and takes trusted
input — the same trick Playwright applies on every page, which is why Playwright
never calls `bringToFront()`. It is **default off**, and deliberately so: it is
an experiment, not a proven guarantee, and the honest-reporting path above
already removes the silent-wrong-click without it. Turn it on (plus launching
Chrome with `--disable-renderer-backgrounding
--disable-backgrounding-occluded-windows`) when you need input to land on a
window that stays entirely covered. `test/run.mjs` asserts the default stays
off; if you make it on, that test and this paragraph both have to change
together.

**`active` is necessary and not sufficient, and that is why an agent made the
browser unusable.** Everything above is about *tabs*, and the window the tab is
in has the same power to hide it: a tab is `active` in a minimized window and
`active` in a window another window completely covers, and Chrome calls the
document hidden in both. So `chrome.tabs.get().active` cannot answer the only
question that matters before trusted input: is this page actually taking
events? The page can answer, and the dispatch surfaces it — a tab that is
`hidden` yields an `UNVERIFIED … dispatched` result rather than a false success,
because the real fix is a human uncovering the window and a click that lies
about landing is worse than a warning. The minimized case is now stated outright
rather than papered over: `browser_window state:"minimized"` says OpenBrowser
will not raise the window automatically and that state-changing input should be
verified, instead of the old claim that "automation keeps running" while every
click went nowhere.

The bigger half of this was always social rather than technical. The old fix,
`ensureForeground()`, was correct in the narrow sense — it guaranteed the tab
took input — and ruinous in practice: in *your* window it yanked the view to the
agent's tab several times a second for the length of a run, reported as "the
agent makes the window unusable while I am working in it". `restoreFocusAfterInput`
only converted the steal into a flicker. **Both have been removed.** Nothing
polite was available while the agent shared your window, because only one tab per
window is foreground and the agent needed that slot — so the agent stops sharing
your window instead.

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
- **Most work is not trusted input, and none of it foregrounds any more.**
  Filling fields goes through the content script, which writes the DOM and works
  perfectly on a tab reporting `visibilityState: "hidden"` — measured, along with
  navigation, snapshots, screenshots and eval. Trusted input (`browser_act`, the
  file-picker click behind `browser_upload`) used to foreground the tab first;
  now nothing does. A form fill surfaces nothing, and a click on a visible
  background tab lands without touching your window.
- **Occlusion's effect on a tab is not uniform, and the logs settled it.** This
  was measured as "a window completely covered by a maximized one keeps
  `visibilityState: visible`" — and then a hundred `tab N is hidden — window
  covered … Chrome drops trusted input` warnings in real sessions said
  otherwise. Both are true: simple overlap on the same Space often keeps a tab
  visible, but full opaque coverage, a native-fullscreen app (its own Space, so
  everything else is on an *inactive* one), and off-screen placement all mark it
  `hidden` and drop input. So the one-window-per-session design cannot lean on
  occlusion-is-harmless the way this note originally claimed. What it leans on
  instead is two things that need no focus theft: an agent window that is merely
  *behind* yours stays `visible` and takes input (the common case), and when a
  window genuinely goes `hidden`, the dispatch returns `UNVERIFIED … dispatched`
  rather than a false success, so the agent verifies instead of clicking into the
  void. `emulateFocus` (default **off**, see "backgrounded tab silently drops CDP
  input" above) is the opt-in that closes the covered case outright — with the
  page emulating focus even a fully covered window takes trusted input — but it
  is not relied on by default.
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

**`browser_act coordinate space:"image"` is the Claude-in-Chrome side of that
trade, offered as an opt-in.** A vision model — a local one above all — has only
the picture, and making it invert `captureGeometry`'s factor by hand before
every click is where those clicks go wrong. So `space:"image"` says "these
pixels came off the last screenshot" and the extension inverts them: each
capture's mapping (`fmt.captureMapping` — the single source `captureGeometry`'s
advice also reads, so the two can never disagree) is saved to
`chrome.storage.session` keyed by tab, and `imageToViewport` (`router.js`)
reverses it — `origin + image/scale`, minus the *current* scroll for a
`full_page` capture, which is document-space. Default stays `css` (viewport CSS
px) so nothing that already passes coordinates breaks, and every screenshot
result ends with the one-line call that lands correctly. Session storage rather
than a variable for the same reason everything else here uses it: the worker
dies between the capture and the click. The mapping is stamped with the URL and
viewport it was taken against and cleared on navigation and tab close, and
`imageToViewport` refuses if the page navigated or resized since — so no recent
capture, a stale one, or a page that has moved on all raise an *error*, not a
guess. A silent wrong click is the whole failure this avoids, and freshness is
as much a part of it as presence: a null mapping (no viewport, no honest factor)
therefore *clears* the record rather than leaving the previous one to be read
against a different image.

**A visual element has no ref, so framing it needed a selector path, or the
model guesses pixels and clips it.** `mode:"element"` clips a screenshot to one
element's box — but it resolved that box only from a `ref`, and a ref exists
only for something the accessibility tree lists. A `<canvas>`, an `<svg>` chart,
a bare `<img>` carry no interactive role and so get no ref, which left exactly
one way to capture just the graph: `mode:"region"` with a hand-typed pixel
rectangle. The model cannot see the element's bounding box, so the rectangle is
a guess, and a guess clips — a real Opus 4.8 session burned *thirty* region
shots cropping one velocity-time graph, every crop cutting the axis off before
its endpoint, and answered off the half it could see without knowing a half was
missing. Worse than a clip, the viewport fallback is downscaled below native
(`maxWidth` 1280 against a 1512px viewport = 0.85x), so the small axis numbers
blur at the exact moment they must be read. `browser_screenshot selector:` closes
it: `locateSelector` (`router.js`) broadcasts `resolveSelector` to every frame,
each returns its single largest *visible* match in top-level viewport coords,
and the biggest box across frames wins — a selector like `"svg"` or `"canvas"`
is deliberately broad and the one the model means is almost always the largest.
The clip is then the element's real box plus a little padding, captured at the
device pixel ratio and only downscaled if it exceeds `maxWidth` — so an element
capture is both un-clipped *and* crisper than the viewport shot that drove the
flailing. `locateTarget` routes a selector the same way for `browser_act` and
`browser_scroll`, so the three speak one language; only `browser_screenshot`
advertises it, to keep the schema budget honest. Region stays, labelled the last
resort it is. `test/run.mjs` asserts the param is advertised and survives the
trip; `test/a11y-browser.html` drives the real `resolveSelector` against a wide
svg with a decoy, an `<img>`, a `display:none` node and an invalid selector.

Three refinements make the same fix land for a model that barely knows what it
wants. **`mode:"element"` with no ref and no selector auto-frames the main
graphic** (`VISUAL_SELECTOR = "canvas, svg, img, video"`, largest visible wins) —
"screenshot the chart" needs no CSS from a low-context model. **A clip now sets
`captureBeyondViewport`** (`cdp.js`), or an element taller than the fold — or one
scrolled so half sits below it — comes back blank for the off-screen part, which
is the same half-a-graph failure wearing different clothes. And a **wide-angle
shot that a chart dominates ends with a one-line nudge** to the element call
(`probeVisual` in `router.js`, gated on the graphic being a real share of the
frame), because the model that took a blurry viewport shot is exactly the one
that did not know element mode existed. The coordinate stress test in
`test/run.mjs` fuzzes 6,000 captures across 37 "sessions" — every viewport, dpr,
maxWidth and (beyond-viewport) clip — asserting the mapping never goes
NaN/∞/≤0, the clip's corners land on the image's corners, the image↔CSS round
trip holds to sub-pixel, and the pure formatter leaks nothing between sessions.

**"Sign in with Google" is two decisions a model must never take alone, so the
tool makes them stop-and-ask, and refuses the third outright.** `browser_act
action:"google_login"` exists because the tempting thing — click the first Google
account and sail through — decides *who the user is* to a third-party site and
then *grants that site access*, both silently. So the flow is gated, and the
gate is a pure function (`oauth.googleDecision`) precisely so the safety
behaviour is provable without a browser: a chooser is enumerated and the flow
**stops until an explicit `account`** is passed (the model is told to ask the
user which, or whether to use Google at all); the consent screen **stops until
`consent:true`**, which only a boolean true satisfies, never a truthy string; and
the password screen is a **hard stop with no override** — automation does not
type passwords. Only a `click`/`allow` verdict ever becomes a trusted event, in
`googleLogin` (`router.js`), which is also the one place identity resolution
(`matchAccount`) refuses ambiguity rather than guessing — `"sam@"` matching two
accounts returns nothing. The page read (`googleAccounts`, content) is pure
observation across every frame — a One-Tap iframe and the page both — and
`mergeGoogleFrames` ranks a password or consent frame *above* a stray chooser
row, so a misread on a grant page cannot become a click. Google's markup churns,
so every DOM strategy is best-effort and the default is `unknown` + stop, never
a guess. Tested three ways: the gates as a pure truth-table (`testOAuth`), the
real parser against chooser/password/consent fixtures (`test/a11y-browser.html`),
and the params surviving strict validation (`test/run.mjs`).

**The live cursor is the one overlay driven by the click point, not a ref.** A
trusted click happens off-screen in the background, so `content/actions.js`
`cursor()` draws a pointer that travels to the same top-level point the CDP click
lands on, rings on contact, and persists between actions — the only feedback a
`coordinate` click gets, since it has no element to outline (`highlight` needs a
ref). `showCursor` in `router.js` fires it fire-and-forget to the top frame from
`browser_act` and the typing path; `agentFrame(false)` tears it down with the
"driving" frame at session end. Four behaviors are deliberate:

- **Travel time scales with distance** (clamped ~140–600ms), and the press +
  ripple fire on *arrival*, not at send time — a ring played mid-flight lands
  nowhere. A newer move supersedes a pending ring.
- **It survives navigation.** `showCursor` records the position per tab
  (`CURSOR_POS_KEY`, session storage), and the `webNavigation.onDOMContentLoaded`
  listener in `router.js` reseeds the pointer — silently, no ripple, no pill —
  and re-draws the driving frame on the new document. Without this both overlays
  vanished between a navigation and the next tool call, which on a
  click-navigate-click loop is most of the run.
- **It is in `OWN_DECORATION`** (`a11y.js`). It animates *between* actions, and
  its arrival-timed ripple lands inside the settling probe's window — unlisted,
  every travelled click reported "the page is still changing".
- **The cascade rule applies to the `transition` property itself.** The
  stylesheet transition shipped `!important` once, which silently outranked both
  the inline `transition: none` used for silent first placement (the cursor flew
  in from off-screen on every fresh document) and the per-move
  `transition-duration`. The travel transform, the transition, and the
  ripple/press/label are the properties left un-`!important`.

Gated by the `showCursor` setting (default on). `test/overlay-preview.html`
self-checks all of it, including that scaling and arrival timing actually run.

**A URL read back after a click can still be the old one.** The withDelta
fallback compared the tab's URL before and after the action to catch
navigations the snapshot diff missed — and a cross-origin navigation often has
not *committed* by the time that read runs, so the most common click there is
was reported `UNVERIFIED: no page change was detected` while the result header
(rendered later) cheerfully showed the new URL. This regressed once even after
being "fixed and verified live", because the fix was still a read-back with a
smaller window. The verdict now consults an event record instead: a top-level
`webNavigation.onCommitted` listener stamps `navCommits` per tab, `withDelta`
checks it (`navSince`) with no timing window at all, and `awaitSettled` waits
for a commit whenever `onBeforeNavigate` says one is coming before any verdict
is formed. If you touch outcome reporting, keep both; `test/run.mjs` asserts
they exist.

**`element.click()` is ignored by serious sites.** It produces `isTrusted:
false`. Everything pointer-related goes through CDP's Input domain for this
reason. If you are tempted to "simplify" by using `.click()`, don't.

**A fixed sleep after a click is wrong in both directions, and it was most of
the click's cost.** `settle(350)` after every pointer action plus a 500ms
`settling` probe when nothing changed made a dead click cost ~900ms and a live
one wait long after the app had finished — and a slow server still committed
its navigation after the window closed, which is how a real navigation got
reported UNVERIFIED. `awaitSettled` (router.js) replaces both: the page's
`settled` handler (content/main.js) resolves when the DOM has mutated and gone
quiet for 120ms, when nothing has mutated within 250ms, or at a 700ms ceiling
with the page still moving — driven by the tree's own mutation counter, so the
cursor ripple and highlight box do not count and typed input does. In parallel
`webNavigation.onBeforeNavigate` records that a click sent the browser
somewhere, and a start with no commit yet is waited for (bounded) rather than
called "nothing". Measured live: a dead click 900ms → ~300ms; a link click
returns the moment its document commits. The three windows are settings. If
you are tempted to add a sleep after an action, the settle already waited; put
the expectation in `expect` instead.

**Trusted input to a hidden tab is not just dropped, it is slow.** A tab that
is not the visible one in its window (the agent window's other tabs, above all)
acks `Input.dispatchMouseEvent` about three seconds late per event — a click
took six seconds and a wheel event hung a batch for ninety — and the input
mostly does not land. Nothing in this project can fix that from outside; what
it does is report `UNVERIFIED` honestly. When driving or measuring several
tabs, `browser_tabs action:"select"` the one you are about to act on (it raises
no window). A session whose first tab was left blank makes every later tab
hidden, which is exactly how one verification run measured everything wrong.

**Every step of a batch used to pay for a delta nobody read.** `withDelta` built
the interactive tree after every action so the result could say what changed;
inside a batch only the last result is returned, so the intermediate diffs were
computed and discarded — up to the 3s budget each on a large app. The planner
(`batch.js`) stamps `_quiet` on every step but the last and `withDelta` skips
the diff for it; navigation and new-tab detection stay on, because the next
step needs them. `returnEach` turns quiet off.

**Batch control flow is declarative on purpose.** `when` / `unless` / `repeat`
/ nested `steps` give a model loops and branches inside one call — the shape
Astra's code-execution path gets from letting the model write Playwright — but
nothing a model writes is ever evaluated here: conditions are browser_wait's
vocabulary answered by the page's `check` handler, and the planner is a pure
function with hard ceilings (50 repeats, 500 tool calls, 3 levels). It is
tested without Chrome for that reason; keep it pure.

**A job is a promise in this worker and nothing more.** `browser_batch
async:true` registers the running batch in `jobs.js` — in memory, deliberately:
the worker's socket heartbeat keeps it alive while a job runs, and a record in
storage would only ever describe a job that no longer exists after a recycle.
Jobs are scoped to the session that started them, and `for:"job"` runs before
tab resolution so collecting one never opens a blank tab.

---

## Layout

```
extension/
  background/         service worker — no durable state
    router.js         tool dispatch; every MCP call lands here
    batch.js          the batch planner — when/unless/repeat/steps, pure, tested
    jobs.js           background batches (async:true) — in-memory job registry
    cdp.js            Chrome DevTools Protocol: trusted input, screenshots, uploads
    a11y.js  (content/) the accessibility tree — the token budget lives here
    format.js         rendering — the other half of the token budget
    frames.js         iframe enumeration, injection, ref routing (fN prefix)
    recorder.js       console/network ring buffers, captured continuously
    groups.js         tab groups, one per MCP session
    windows.js        which window a session works in; the in-browser chooser
    oauth.js          guided "Sign in with Google" gates — pure, unit-testable
    bridge.js         WebSocket client + reconnection + MV3 keepalive
  content/            injected into every frame
  sidepanel/          the UI — calls the same dispatch() as MCP. The Agents view
                      is built from Chrome's own tab groups plus the ownership
                      map groups.js keeps in chrome.storage.session, so it needs
                      no worker round-trip and stays right while the worker
                      sleeps. One card per agent; the design tokens (palette,
                      radius, motion) for every surface live in panel.css.
  options/            settings — shares panel.css tokens; System Settings style

mcp-server/src/
  ws.js               hand-rolled RFC 6455
  mcp.js              hand-rolled MCP over stdio
  hub.js              routes calls; lets several MCP clients share one browser
  federation.js       hub-to-hub links; remote browsers as local-looking proxies
  tools.js            the 14 tool schemas — token-critical

test/
  run.mjs             417 tests, no browser needed — incl. the parallel-session
                      stress (`testParallelSessions`): a Chrome stub faithful
                      enough to drive the real `dispatch`, N sessions opening
                      tabs at once, asserting named/backgrounded/isolated over
                      40 storms up to 10 sessions each
  a11y-browser.html   125 tests, needs a browser (npm run preview)
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
npm test          # 417 tests — run before and after every change
npm run preview   # then open /test/a11y-browser.html for 125 DOM tests
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
built-but-unverified, or verified live. The "page is settling" signal after a
click is done (`awaitSettled`); session labels are one word now.
Native-dialog handling (`browser_act action:"dialog"`), the tall-page
`full_page` fail-fast, and the `find` href-ranking fix are done and verified
live.

---

## Changes that need a reload

Chrome caches extension files. Anything under `extension/` needs a reload
before it takes effect. Anything under `mcp-server/` is picked up when the MCP
client next starts the server.

For an unpacked install there is a hook: call the internal `__reload` tool on
the hub (not published over MCP, so a model cannot; your own script can — join
with `createTransport` from `mcp-server/src/hub.js` and
`transport.call('__reload', {})`). It refuses store installs. Before it
existed the only way was `chrome://extensions` by hand, and UI-scripting that
page takes two minutes and clicks the toolbar's "Reload this page" by mistake.

This trips people up constantly — if a fix "didn't work", check this first.

## Session naming and cleanup live in the hub owner

A session *is* its name: one word (`harbor`), allocated by the **hub**, because
that is the only process that can see every live session and therefore the only
one that can guarantee two never collide onto the same tab group. The same word
is the tab-group title, the on-page caption, the panel card, and the "you" in
every result — never a composite, never a prefix. Which MCP client a session
belongs to is stamped alongside as `_client` and is display-only. Sixty-four
words are available and a word is released once the browser confirms that
session's cleanup (`_endSession` awaits `__session_end`), so names recycle.
Cleanup on disconnect is triggered there too.

The consequence trips people up: the hub is owned by whichever `mcp-server`
process started **first**. Reloading the extension does not update it. If
sessions are still showing old-style hex labels, or tabs are not being tidied
up, the hub owner is running old code — restart the MCP clients (opencode,
Claude Code) and not just the extension.

Cross-session tab protection is in `router.js` and *does* take effect on an
extension reload alone, because it is enforced browser-side.
