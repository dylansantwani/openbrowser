# TODO — improvements worth making

Everything here came out of actually driving the extension against real sites
(Gmail, Wikipedia, Meta Business Suite, eBay) rather than from theory. Each item
says what went wrong, why it matters, and what to do about it.

Ordered by how much pain it removes per unit of work.

**Status legend:** 🔴 not started · 🟡 built, not yet verified against the real
extension · ✅ verified live.

## 0. The 1.1.0 visibility + UI rework 🟡 built, tested, needs an extension reload to verify live

Four things shipped together (2026-08-31); unit tests (257), the browser a11y
suite (73), and the overlay self-checks (12) all pass. Reload the extension at
`chrome://extensions` to see any of it.

- **Navigation clicks are no longer reported UNVERIFIED.** The URL read-back in
  `withDelta` raced the navigation commit; verdicts now consult a
  `webNavigation.onCommitted` record (`navSince`), checked both in the fallback
  and again after the settling probe. See "A URL read back after a click can
  still be the old one" in CLAUDE.md.
- **The cursor and the driving frame survive navigation.** Position stored per
  tab; both overlays are re-drawn on `onDOMContentLoaded`. Previously both
  vanished between a navigation and the next call — most of a
  click-navigate-click run.
- **Cursor feel.** Distance-scaled travel, press/ripple on arrival, a soft halo
  so the pointer is findable on busy pages — and a cascade bug fixed where the
  `!important` stylesheet transition silently disabled the silent-first-placement
  and per-move duration (`.ob-cursor` is also in `OWN_DECORATION` now, or every
  travelled click polluted the settling signal).
- **Side panel + settings redesigned.** Panel leads with an Agents view (which
  session drives which tabs, from the ⚡ tab groups), then Activity and Tools;
  settings page is a System Settings-style grouped list. Both share one token
  set in `panel.css`, light and dark.

## 1. Native dialogs freeze everything ✅ fixed, verified live

**What happened.** Reported from real use: leaving a page with unsaved changes
raises the browser's own *"Are you sure you want to leave?"* box. `alert()`,
`confirm()` and `beforeunload` all do the same thing — a **native** dialog, not
page DOM. It is invisible to the accessibility tree, unclickable by CDP input,
and it pauses the renderer, so the content script cannot answer and every
subsequent call sits there until it times out. Nothing says why.

**Fix (done).** CDP's hooks are wired up:

- `Page.javascriptDialogOpening` is recorded per tab (`cdp.pendingDialog`),
  cleared on `Page.javascriptDialogClosed`, detach, and tab removal.
- **Every page-touching call fails fast** while a dialog is open, via a check in
  `prepareTab` (and at the top of `browser_navigate`, so a beforeunload raised
  by navigation itself is caught too). The error names the dialog and the way
  out:
  `a confirm() dialog is open: "Leave site?" — answer it with browser_act action:"dialog" accept:true (OK/Leave) or accept:false (Cancel/Stay)`
- `browser_act action:"dialog"` answers it (`Page.handleJavaScriptDialog`),
  with optional `promptText` for `prompt()`.
- A click that opens a dialog reports it in its own result (the note replaces
  the settling probe, which would otherwise hang on the paused renderer), and
  `pageMeta` falls back to tab metadata instead of waiting on the content
  script.
- `Page` is enabled for every prepared tab (and before navigation), because the
  opening event is the only record a dialog exists.

Verified live in Chrome: schedule a `confirm()`, watch every subsequent call
fail fast with the named dialog, dismiss it with `action:"dialog"`, and watch
the page's `confirm()` return the dismissed result. Auto-accepting by default
would still be wrong — "are you sure you want to delete this" is the same shape
as "are you sure you want to leave" — but a dialog that blocks everything and
explains nothing is worse than either choice.

---

## Open

> Nothing currently open. Every item below was found live, fixed, and verified;
> they are kept here for the record. New candidates go above the line.

### 1. Enter in rich editors produces double line breaks ✅ fixed

**What happened.** Typing `\n\n` into Meta's composer yielded three newlines;
typing `\n` yielded one. Exactly one blank line between paragraphs was not
reachable.

**Fix (done).** `browser_input` takes `newline: "soft"`, which sends
`Shift+Enter` between lines — the soft break every rich editor honours — so
`\n\n` gives exactly one blank line. `cdp.js` (`typeText`) implements it.

### 2. `Control+a` selects the page when focus is lost ✅ fixed

**What happened.** Several `browser_input {keys:["Control+a"]}` calls with no
`ref` selected the entire document instead of a field, because focus was not
where it was assumed to be.

**Fix (done).** When `keys` are sent without `ref`, the router checks
`document.activeElement` first; if it is `body` (or missing), the call fails
with the diagnosis instead of dispatching a chord that selects the whole page.

### 3. `full_page` screenshots fail outright on tall pages ✅ fixed (fail-fast)

**Found live, 2026-08-02.** A full-page capture of the Wikipedia "Berlin"
article (~42,000 CSS px tall) spun for **14.7 seconds** and then returned the
raw protocol error:

```
Page.captureScreenshot failed: {"code":-32000,"message":"Unable to capture screenshot"}
```

Chrome cannot allocate a texture that large. Nothing in the message says so, so
the natural next move is to retry — which burns another 15 seconds.

**Fix (done).** `cdp.captureScreenshot` already reads `Page.getLayoutMetrics`
for `fullPage`; it now checks the device-pixel height against the GPU's common
max texture size (16,384px) and refuses up front:

```
the page is 42,000px tall — too tall to capture in one image; use mode:"region" over the part you need, or scroll and take viewport shots
```

Failing in ~50ms with a next step beats failing in 15s without one. Capturing
in horizontal bands and stitching is still open as a future improvement, but
the stall-plus-raw-error case is gone.

### 4. `find` ranks href-only matches as highly as real controls ✅ fixed

**Found live, 2026-08-02.** `browser_find query:"search box"` on a Wikipedia
article returned the search box second and then filled the next four slots with
citation links whose only connection to the query was the substring `search` in
`search.worldcat.org`:

```
button    "Search"          [e4]    @1096,17
searchbox "Search Wikipedia" [e3]   @691,17
link      "33163088"  [e2249] search.worldcat.org/oclc/33163088   @1380,34827
link      "0362-4331" [e2361] search.worldcat.org/issn/0362-4331  @1508,37242
```

Those links are 34,000px down the page and are named after ISSN numbers. The
top two results are right, so this is noise rather than breakage — but it is
noise the model pays for on every find, and on a page where the real control
ranks lower it becomes breakage.

**Fix (done).** `findElements` now scores role/name/value hits first and href
hits as the weaker fallback (word match 1 instead of 2, substring 0.25 instead
of 0.5), and an element whose only connection to the query is the URL, with no
name of its own, is discounted to a quarter. The href stays in the haystack —
`/login` and `/cart` are still findable — but prose matches no longer compete
with real controls. Two regression tests cover it in `test/a11y-browser.html`.

### 5. Session and workstream naming is opaque ✅ fixed

Group labels used to read `opencode 5020`, `opencode a670` — a client name
plus a hex slice of the pid. A human looking at the tab strip could not tell
which was which, and the hex conveyed nothing about the work.

**Fix (done).** The hub now hands out short, common, visually distinct words —
`claude · harbor`, `opencode · meadow` — no two starting with the same letter
so they stay separable in a narrow tab group. The identity and the label are
separate jobs: the word is the display label, and uniqueness for tab ownership
is guaranteed by reserving every label (whole and by its distinguishing half)
against the browser's own record of names already in use (`__session_list`), so
a restarted hub cannot drop a fresh session into a dead one's tabs. The agent's
own `group` argument still wins for sub-workstreams (`opencode · reel
uploads`). Exhausted the list? Numbered fallback (`session-2`) — ugly but
unique, which is the property that actually matters.

### 6. Surface a "page is settling" signal ✅ fixed

**What happened.** Several clicks on Meta's "Create post" registered but did not
navigate, needing a second attempt. There was no way to distinguish "the click
missed" from "the app has not reacted yet".

**Fix (done).** After a click that produces no delta, the router runs a 500ms
DOM-mutation probe in the page and reports which of the two it was:
`"no diff yet, but the page is still changing — browser_wait or snapshot again
in a moment"` vs `"no change detected — the click may have missed, or this
control does nothing on its own"`. The probe is skipped when a native dialog
explains the stillness — the dialog's paused renderer could never answer it.

---

## Built, awaiting verification against a reloaded extension 🟡

All four are covered by tests (`npm test`, plus `test/a11y-browser.html` for the
tree cache) but none has been exercised through the real extension yet, because
that needs a `chrome://extensions` reload.

### `browser_find` takes a `selector`

`browser_snapshot` could already be scoped and `browser_find` could not, so on
exactly the pages where find is most useful — big ones — it was the tool that
could not be narrowed. On Meta Business Suite, find for "Send" returned *no
matches* while the Send button was on screen, because the tree read hit its
budget before reaching the compose dialog at the end of the DOM. Cost roughly a
dozen extra round trips during the reel uploads.

A selector that matches in no frame is now an explicit error rather than an
empty result — "not found" and "never looked" are different answers.

### The accessibility tree is cached between calls

Every `find` and `snapshot` rebuilt the whole tree. Measured in a real browser
on a synthetic 4,000-row page: **2,527ms → 0ms** on a repeat read, and
**373ms → 0ms** on a moderate one. Any mutation throws the cache away.

Invalidation is deliberately coarse, and three things about it are load-bearing:

- **Shadow roots are observed individually.** `subtree: true` does not cross a
  shadow boundary, but the tree walk does, so a component's internal re-render
  would otherwise go unseen.
- **`input.value` is a property, not an attribute.** Typing produces no
  mutation record at all. `input`/`change` are observed for this, or a cached
  tree would report a field as still empty right after typing into it — which
  reads as "my typing did not land" and prompts a retry that types it twice.
- **Focus is compared, not listened for.** Chrome defers focus events while a
  document lacks system focus, and a backgrounded tab is the normal case for
  parallel work, so `document.activeElement` is compared directly instead.

Truncated trees are cached too, on purpose: truncation means the page was too
big to walk, which is exactly where a rebuild costs seconds.

### Screenshots report what their coordinates mean

`region` is in CSS pixels, but the returned image is rescaled twice — by the
device pixel ratio at capture, then by the downscale to `maxWidth` — so a
coordinate measured off the image mapped to neither space.

Confirmed live on 2026-08-02, and worse than recorded: a request for region
`[830,190,460,410]` came back as a **690x615** image (this display runs at
1.5x), described only as `region screenshot, 690x615`. A control measured at
image (345,307) is at page (1060,395); an agent would have clicked (345,307).
A viewport capture on the same display returned 1280x608 for a 2327x1105
viewport — a 0.55x factor, equally unstated.

The result now reads:

```
region screenshot, 690x615 — 1.50x of 460x410 CSS px at (830,190)
to convert: page x = 830 + imageX/1.50, page y = 190 + imageY/1.50
```

The factor is derived from the image against the region it covers, not computed
from the pixel ratio, so it holds on any display. Full-page captures also say
their coordinates are document-space, not viewport-space.

### The file-chooser click is retried once

`browser_upload` failed twice on Meta with "timed out waiting for
Page.fileChooserOpened", then worked on a fresh page load — the click landed
before the site attached its handler. The ref is re-resolved rather than the old
click point replayed, since a re-render moves the button. After two failures the
error now says which of the two causes to check.

---

## Verified live ✅

### Upload paths are validated in the MCP server

`DOM.setFileInputFiles` does not check that a path exists: it accepts a missing
file, reports "attached 1 file(s)", and the upload then sits at 0% forever. This
turned a two-second error into a fifteen-minute debugging detour when half the
reel files were moved mid-session. The extension cannot check — a service worker
has no filesystem — but the MCP server runs in Node on the same machine.

Confirmed against the real stack, all failing in ~1ms before touching the
browser:

| Input | Result |
|---|---|
| missing file | `no such file: …/does-not-exist.mp4` |
| `C:\Users\dylan\nope.mp4` | `no such file: … (paths use forward slashes: "C:/Users/..." not "C:\Users\...")` |
| a directory | `that is a directory, not a file: …` |

### Session isolation

Two agents driving one browser could reach into each other's work. Both
reproduced live on 2026-08-02 with two real `opencode` sessions running.

**Groups were keyed by label alone.** Two sessions both naming a workstream
`research` silently shared one group — and then `close_group "research"` from
one session closed the other session's tabs. Keys are now scoped by session.
Verified by mutation testing: reverting the key to label-only fails 8 of the 13
isolation tests, including "closing a workstream closes only that session's
tabs".

**A call with no `tabId` landed on whatever tab the human was looking at.**
Observed directly: a `browser_find` from this session with no `tabId` resolved
onto *another* session's Meta Business Suite composer, mid-compose. Read-only
that time; a click would have disrupted live business work. Two sessions would
also both resolve to the same tab and fight over it, however carefully their
groups were separated.

Each session now remembers the tab it last drove (mirrored into
`storage.session`, since MV3 tears the worker down after ~30s idle and an agent
that paused to think would otherwise snap back to the human's tab). A tab the
session did *not* choose is deliberately left ungrouped — pulling the page a
human is reading into an agent's group moves and re-colours it in the tab strip,
which reads as the browser acting on its own.

The session label is also now applied *after* the argument spread in
`mcp-server/src/index.js`. Spread first, a model that emitted `_session` in its
arguments — by accident, or by copying one out of a transcript — would take on
another session's identity and gain the ability to close its tabs.

### Documented footguns

Both were costing failed calls before an agent noticed the pattern:

- **No regex literals in `browser_eval`.** `\d`, `\s`, and `\.` are invalid JSON
  escapes, so the call is rejected during argument parsing, before the code ever
  reaches the page. Cost four failed calls in one session. Now in the tool
  description: use `new RegExp('[0-9]')` or string methods.
- **Windows paths need forward slashes.** `C:\Users\...` is not valid JSON. Now
  in the `paths` description — and confirmed to be a live tripwire: the test
  harness for this very session hit it twice.

The schema budget was raised from 13KB to 13.5KB to fit these (~90 tokens per
request). Each prevents a failed call, which costs far more than it saves;
`test/run.mjs` records the reasoning and the rule for raising it again.

---

## Verification pass, 2026-08-04 (reloaded extension) ✅

All three of the changes below were exercised against the real extension.

| Check | Result |
|---|---|
| `test/a11y-browser.html` after the badge exclusion | 71 passed, 0 failed |
| Border present, orange, `pointer-events: none`, captioned | ✅ `OpenBrowser · claude-code · 90d0` |
| Snapshot identical with the border on and off | ✅ byte-identical |
| Re-applying the border twice counts as page activity | ✅ **0** — the risk that would have broken the settling signal |
| Border survives a navigation | ✅ re-applied by `prepareTab` |
| Focus returned after the agent clicks a background tab | ✅ the human's tab was active again |
| "Leave site?" answered without a human, note on the result | ✅ |
| A real `confirm()` still blocks and names itself | ✅ |

Two things learned while testing that are worth keeping:

- **`confirm()` cannot be tested from the main world on this profile.** Another
  installed automation extension (chromeflow) replaces `window.confirm` with a
  stub returning `true` — no native dialog, no CDP event, nothing for
  OpenBrowser to see. It looked exactly like a regression in the beforeunload
  change until `Function.prototype.toString` showed the override. Test dialogs
  from `world:"isolated"`, where the binding is pristine. The `autoDismissed`
  counter is what ruled the change out: it is only incremented on an auto-accept,
  and the following navigation reported nothing.
- **The running MCP server can be older than `mcp-server/src/tools.js`.**
  `browser_act action:"dialog" accept:false` was rejected with "unknown
  parameter: accept" while the schema on disk declares it — the server process
  predated the feature, and `checkArgs` derives its list from whatever schema
  that process loaded. Reloading the extension does not restart the MCP server;
  the client has to. Worth remembering before diagnosing a "missing" parameter,
  and it leaves a blocking dialog with no way out until the restart.

## The agent stole the tab you were working in ✅ fixed, verified live

Reported from real use: with the agent's tabs in their own group and the user
working in a different one, the view still jumped to the agent's tab whenever it
did something.

A tab group is not isolation. Groups share a window, and only one tab per window
can be foreground, so `ensureForeground` — which exists because a hidden tab
silently drops `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`, the worst
failure this project can produce — pulled the user out of their group every time
the agent clicked.

The requirement was taken to be that the tab be foreground *while input is
dispatched*. Keeping it afterwards was never part of that, and was the whole of
the annoyance. The intermediate fix — `restoreFocusAfterInput`, **since removed**
along with `ensureForeground` itself (see "Superseded" below and HANDOFF.md) —
recorded what was active before the first steal in a burst and put it back once
the call was done:

- Debounced (700ms), so twenty clicks do not flip the view twenty times.
- Restores to the tab active before the *first* steal, not the previous one.
- Skipped entirely if the agent's tab is no longer active — if the user switched
  tabs by hand, that decision wins.
- Released from `dispatch`'s `finally`, so it happens on the error paths too,
  and never for `browser_tabs`/`browser_window`, where being asked to focus a
  tab is the point of the call.

**Superseded: give the agent its own window — shipped as `soloWindow` (default
on), pooled by `agentWindowPool` (default on).** This was first rejected because
a fully covered window is marked hidden and reintroduces silently dropped input.
It shipped anyway, because the alternative (`restoreFocusAfterInput`) only
converted the steal into a flicker and never removed it — and both it and
`ensureForeground` are now gone. An agent's window that is merely *behind* yours
stays `visible` and takes trusted input, which is the common case and the whole
reason the design works without stealing focus. The residual case — a window
that goes genuinely `hidden` (full opaque coverage, native-fullscreen on its own
Space, off-screen) — is handled honestly rather than by force: the dispatch
returns `UNVERIFIED … dispatched` so the agent verifies instead of clicking into
the void. `Emulation.setFocusEmulationEnabled` (`emulateFocus`, `cdp.js`) keeps
even a fully covered tab compositing so input lands, but it is **default off** —
an opt-in for people who need input on a permanently covered window, paired with
the `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
launch flags. `test/run.mjs` pins the default off. See CLAUDE.md, "backgrounded
tab silently drops CDP input".

## Agent-driven tabs are marked on the page ✅ fixed, verified live

The tab-group colour only exists in the tab strip, so once you were looking at a
page there was nothing to say whether an agent was driving it. There is now a
persistent orange border and a caption naming the workstream
(`OpenBrowser · <label>`), controlled by `showAgentBadge`.

Three things about it are load-bearing:

- **It is inert.** `pointer-events: none` throughout, so it can never swallow a
  click meant for the page.
- **It is excluded from the tree and from the mutation counter.** The decoration
  test that used to name `.ob-highlight` now covers both overlays. Missing this
  would have been worse than the bug it was written for: the border is
  re-applied on every call, so counting it would report page activity on every
  single call and destroy the settling signal permanently.
- **It is re-applied, not tracked.** A navigation throws the document away along
  with the border, and `prepareTab` runs on every page-touching call anyway.

Cleared when a session ends, for adopted tabs as well as created ones — those
are the user's own tabs and outlive the session, and a stale "an agent is
driving this" border on a tab nothing is driving is worse than no border.

**Still to verify live:** that the border appears and survives navigation, that
it never appears on the user's own tabs, that snapshots are byte-identical with
it on and off, and that focus is actually returned after a click.

## "Leave site?" had to be clicked by hand ✅ fixed, verified live

Reported from real use: the beforeunload prompt kept appearing mid-run and a
human had to click it, which is the one thing this tool exists to avoid.

The 2026-08-03 dialog work (§1) treated all four native dialog types the same —
block everything, name the dialog, wait for an explicit `browser_act
action:"dialog"`. That reasoning holds for `alert`, `confirm` and `prompt`, and
they are unchanged. It does not hold for `beforeunload`, which is a different
kind of event: it only ever appears **because something is already trying to
leave**. When the agent navigates, the intent to leave is the instruction it was
given, so answering carries that out rather than deciding anything new. The old
behaviour asked the caller to confirm a thing it had just asked for, from behind
a native box nothing on the page side can reach.

`autoConfirmLeave` (default on, in the options page) accepts beforeunload
prompts only. The gate is structural rather than a heuristic: the opening event
arrives over the debugger, which is attached only to tabs the agent drives, so a
prompt raised by the user's own browsing never reaches this code at all.

Not silent — accepting discards whatever the old page held unsaved, so
`browser_navigate` reports how many it answered and how to turn it off. If
`handleJavaScriptDialog` fails the dialog stays recorded as pending, so the next
call fails fast and names it rather than hanging on a paused renderer.

**Still to verify live** (Chrome was closed when this was written): that a
beforeunload prompt is answered without a human touching it, that the note
appears on the navigation result, that `autoConfirmLeave:false` restores the
blocking behaviour, and that a real `confirm()` still blocks.

## A read erased the evidence that the page had changed ✅ fixed 2026-08-03

`drainPending()` called `observer.takeRecords()` for its `.length` and dropped
the records. `takeRecords` *removes* what it returns, so those records never
reached the MutationObserver callback and never reached `invalidate` — the
`mutations` counter simply never saw them. Only `cache.dirty` was set, so
caching stayed correct and nothing looked wrong.

The counter is the settling signal: it is what tells "the app has not reacted
yet" apart from "the click went nowhere". `buildTree` runs on every
`browser_snapshot` and every `browser_find`, so a page change that landed just
before a read was counted **zero** times, while the identical change with no
read in between counted once. Snapshots are the common path, so the usual
sequence — act, then look — is exactly the one that erased the proof the action
had worked. A click that did fire could report that nothing happened.

Measured in a real browser, appending a `<p>` to the fixture:

| | counted |
|---|---|
| change, then a `buildTree` read in the same tick | **0** ❌ |
| same change, no read in between (control) | 1 |

Now `drainPending` routes the drained records through `invalidate`, which
applies the same decoration test the callback would, so both cases count 1.
Mutation-tested: reverting the two lines fails the new regression test
"a change that raced a read is still counted" (`6 -> 6`).

**The highlight-box test was also flaky for an unrelated reason.** It asserted
that our own `.ob-highlight` box adds nothing to the counter, but measured
without waiting for the page to go quiet. Other installed extensions inject
their own UI into every page — this profile has `#SASContainer` and
`#ibotta-extension-root`, jQuery-UI drag handles and all — and that churn is
real page activity to the counter, so the assertion failed `0 -> 4` on one run
and `0 -> 1` on the next. The decoration filter itself was always correct. The
test now waits for quiescence before measuring. Worth knowing generally: the
browser suite is not isolated from whatever else is installed in the profile.

## Smaller notes

- **OAuth and form-heavy checkout are now exercised** (2026-08-03). A real
  third-party sign-in redirected cross-origin to `accounts.google.com` and the
  blocklist stopped it with a usable message; refs, waits and page headers all
  tracked the redirect correctly. A five-field batch fill plus a checkbox landed
  intact, verified against the DOM rather than the tool's own report. Popup-based OAuth is
  covered too: a real `window.open(url, name, 'width=520,height=640')` popup was
  reported on open and the popup window then read and inspected normally.
- **Payment entry is deliberately never tested.** Card fields are usually a
  cross-origin iframe (Stripe/Adyen), which the frame routing handles in
  principle, but nobody should be typing real card numbers to find out. If this
  matters, test against a payment provider's own sandbox with test card numbers.

- ~~**`browser_find` with a `selector` that matches a single element returns
  nothing.**~~ ✅ **fixed** — `walkTree` falls back to walking the match itself
  when walking its children yielded nothing, so scoping to one control returns
  that control while scoping to a container still splices in its contents.
  Covered by "scoping to a single control returns that control" in
  `test/a11y-browser.html`; verified passing live 2026-08-03. This note was
  stale, not open.
- **`browser_eval`'s `ref` does not bind anything usable.** Passing `ref` and
  writing `element.target = '_blank'` throws `ReferenceError: element is not
  defined`. Either bind the resolved node to a documented name, or drop `ref`
  from the schema — right now it reads as if it does something it does not.

- **Screenshot dependence is very low, and that is working as intended.** Across
  the reel-upload session every interaction used a11y refs; screenshots were only
  used to show a human something or to verify a control that had no DOM value
  (Meta's time picker renders its value outside the DOM). Keep it that way —
  the snapshot-first design is the main reason this is cheap to run.
- `browser_wait for:"time"` reported `0ms` elapsed. Fixed, but worth a test.
- The obstruction check flagged a placeholder as a blocking overlay. Fixed via
  the local-decoration heuristic, but it is a heuristic — watch for false
  negatives where a real overlay sits inside the target's container.
- Consider a `browser_act action:"upload"` alias so uploading does not require
  remembering a separate tool name.
- The tree cache invalidates on any mutation, which on a continuously animating
  page means it never hits. That is correct, not a bug — but if a real site
  turns out to churn without changing anything an agent cares about, the answer
  is a narrower observer config, not a longer-lived cache.

---

## Loose end from the 2026-08-03 merge — resolved

- ~~**`captureGeometry()` in `extension/background/format.js` is currently unreferenced.**~~
  **Done.** Wired into `browser_screenshot` in `router.js`, replacing the inline
  coordinate-factor block. The result now reads `viewport screenshot, 929x869 —
  1.00x of 929x869 CSS px`, and region captures include the conversion math
  (`to convert: page x = 830 + imageX/1.50, …`). The now-dead
  `cdp.layoutMetrics()` helper was removed with it.

---

## Already fixed (do not redo)

Found by driving real sites, and done. Listed so nobody re-investigates.

- `browser_batch` cannot nest. That is deliberate, but the error should suggest
  flattening rather than just refusing.
- **Content scripts are now guarded against double injection.** `injectInto`
  fires whenever a command meets a frame without a script, and two commands
  racing on one frame both inject. Re-running `a11y.js` handed out a fresh ref
  registry — silently invalidating every ref the agent held — and re-running
  `actions.js` reset `frameOffset` to 0,0, sending every click in that frame to
  the wrong pixel until the next offset cascade.

---

## Reference: measured latency

Real extension, Wikipedia "Berlin" (4,017 links, 20,291-char tree), before the
tree cache:

| Call | Cold | Repeat |
|---|---|---|
| `browser_snapshot` | 164ms | 132ms, 142ms |
| `browser_find` | 89ms | 79ms, 82ms |
| `browser_inspect page_info` | 11ms | — |
| `browser_screenshot` viewport | 564ms | — |
| `browser_screenshot` region | 1,122ms | — |
| `browser_screenshot` full_page | **14,688ms, then failed** | — |

Repeat reads not getting cheaper is the cache's whole target. Wikipedia is a
mild case at ~140ms; the Gmail figure that motivated it was 3.6s, twice.

---

## Already fixed in earlier sessions (do not redo)

| Bug | Where |
|---|---|
| WebSocket greeting lost to TCP coalescing | `mcp-server/src/ws.js` |
| `display: contents` hid entire React subtrees | `content/a11y.js` |
| Punctuation typed as VK_DELETE / VK_RIGHT | `background/cdp.js` |
| `requestAnimationFrame` hang in background tabs | `content/actions.js` |
| Node budget cut off late-DOM dialogs, silently | `content/a11y.js` |
| Post-action delta cost 44s on Gmail | `background/router.js` |
| `getComputedStyle` per element | `content/a11y.js` |
| Decorative `alt=""` beat the real logo alt | `content/a11y.js` |
| Long tracking query strings in every href | `content/a11y.js` |
| `find` ranked by raw substring | `content/a11y.js` |
| `browser_eval world:"isolated"` returned null | `background/router.js` |
| `browser_input` reported success when nothing typed | `background/router.js` |
| `browser_find` could not be scoped with a `selector` | `mcp-server/src/tools.js` |
| Tree rebuilt from scratch on every call (3.6s×N on Gmail) | `content/a11y.js` |
| Screenshot region coords did not match the returned image | `background/router.js` |
| File-chooser click failed transiently with no retry | `background/cdp.js` |
| `browser_upload` accepted paths that did not exist | `mcp-server/src/index.js` |
| Enter in rich editors gave an unreachable blank line | `background/cdp.js` |
| `Control+a` with no focus selected the whole document | `background/router.js` |
| Regex literals in `browser_eval` rejected by JSON | `mcp-server/src/tools.js` |
| Windows backslash paths rejected by JSON | `mcp-server/src/tools.js` |
| Unknown arguments silently ignored | `mcp-server/src/index.js` |
| `browser_eval` rejected every multi-statement snippet | `background/router.js` |
| Console/network buffers mixed pages across a navigation | `background/recorder.js` |
| A call with no `tabId` drove the globally active tab | `background/router.js` |
| Workstream groups did not survive an MV3 restart | `background/groups.js` |
| Raw bfcache error leaked when a click navigated mid-call | `background/frames.js` |
| Invisible reCAPTCHA reported as a blocking CAPTCHA | `content/main.js` |
| Adopting a tab marked it owned forever, locking out later sessions | `background/router.js` |
| A recycled MV3 worker was reported as a broken connection | `background/bridge.js` |
| `browser_batch` had no `tabId` of its own | `mcp-server/src/tools.js` |
| A click that opened a new tab was never reported | `background/router.js` |
| **CDP input silently dropped by a backgrounded tab** | `background/router.js` |
| `browser_wait for:"text"` could not see accessible names | `content/actions.js` |
| "message channel closed" leaked as a raw Chrome error | `background/frames.js` |
| Scoping a read to one element returned nothing | `content/a11y.js` |
| `browser_eval`'s `ref` was accepted and ignored | `background/router.js` |
| A click that changed nothing gave no clue why | `background/router.js` |

### Notes on the trickier ones

**Tree caching.** `buildTree` memoises on `(mode, selector, viewportOnly +
scroll)`, invalidated by a MutationObserver plus listeners for the live
properties an observer cannot see (`value`, `checked`, hover reveals). Two
details are load-bearing and easy to undo by accident:

- `observer.takeRecords()` is drained *synchronously* on every read. The
  observer callback is a microtask, so a caller that mutates and reads in one
  synchronous stretch would otherwise be handed the tree from before its own
  change.
- Focus is compared, not listened for. Chrome withholds `focus`/`focusin` from a
  document that lacks system focus, so in a background tab — the normal case for
  parallel work — a listener never fires. See `CLAUDE.md`.

**Unknown arguments.** Validated in the MCP server against the tool's own
schema, including inside `browser_batch` steps. `group` has to be allowlisted:
the router reads it for every tool but it is declared only on `browser_tabs`.

**`browser_eval` multi-statement code.** The retry that re-runs the snippet as a
statement body tested `exceptionDetails.text`, which for a compile error is only
ever `"Uncaught"` — the message is on `exception.description`. So the retry
never fired and `const x = 1; x + 1` came back as a bare SyntaxError, despite
the schema advertising that a function body was acceptable. A statement body
also discards its last value, so that case now says so instead of returning a
bare `undefined`.

**CAPTCHA detection.** Matching `iframe[src*="recaptcha"]` is not sufficient:
invisible reCAPTCHA ships a zero-sized aframe on a huge number of ordinary
pages, and eBay's working search results carry one. A marker now has to be at
least 60×60 and visible before it counts. The text heuristic also covers
Imperva's "Pardon Our Interruption" wall, which renders no marker element at
all — so the two halves cover opposite failure modes and both are needed.

**`wait` must agree with `find`.** `browser_wait for:"text"` only searched
rendered text, while snapshot and find names also come from `aria-label`,
`title`, `alt` and `placeholder`. So a caller waits for the exact string the
tool just showed it and the wait times out — 40 seconds of dead waiting in one
demo-store checkout, on a button `browser_find` located in 43ms. Waiting for
something the tool has just displayed must never be the failure.

**Backgrounded tabs drop input.** The worst bug found so far, because it is
invisible: a hidden tab silently discards `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent`, so a click reports success and the page never sees it.
Screenshots and the tree still work on hidden tabs, which is exactly why it went
unnoticed — everything *looks* fine. `ensureForeground()` now activates the tab
before any trusted input. Consequence worth knowing: input cannot run in
parallel across tabs of one window. That is Chrome, not us.

**Screenshot coordinates.** The result now reports the factor between the image
and CSS pixels (`0.67x of 1920x897 css px`) whenever it is not 1, since `region`
and every coordinate argument are CSS pixels while the image is device pixels
and then downscaled.
