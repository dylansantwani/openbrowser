# TODO — improvements worth making

Everything here came out of actually driving the extension against real sites
(Gmail, Wikipedia, Meta Business Suite, eBay) rather than from theory. Each item
says what went wrong, why it matters, and what to do about it.

Ordered by how much pain it removes per unit of work.

**Status legend:** 🔴 not started · 🟡 built, not yet verified against the real
extension · ✅ verified live.

## 1. Native dialogs freeze everything

**What happened.** Reported from real use: leaving a page with unsaved changes
raises the browser's own *"Are you sure you want to leave?"* box. `alert()`,
`confirm()` and `beforeunload` all do the same thing — a **native** dialog, not
page DOM. It is invisible to the accessibility tree, unclickable by CDP input,
and it pauses the renderer, so the content script cannot answer and every
subsequent call sits there until it times out. Nothing says why.

**Fix.** CDP already has exactly the right hooks and neither is wired up:

- `Page.javascriptDialogOpening` fires with the dialog's `type` and `message`.
  Record it, and report it in the next result rather than letting the call die
  silently: *"a confirm() dialog is open: 'Leave site?' — accept or dismiss it
  before continuing"*.
- `Page.handleJavaScriptDialog {accept, promptText}` answers it.

Surface both: a `browser_act action:"dialog"` (or a `dialog` target on
`browser_inspect` plus accept/dismiss) so an agent can see one and answer it.
Auto-accepting by default would be wrong — "are you sure you want to delete
this" is the same shape as "are you sure you want to leave" — but a dialog that
blocks everything and explains nothing is worse than either choice.

**Impact.** Any form-heavy flow can hit this on navigation, and when it does the
session is stuck with no diagnosis. Highest-value item open.

> Verifying anything under `extension/` requires a reload at
> `chrome://extensions` — Chrome caches extension files. Changes under
> `mcp-server/` take effect when the MCP client next starts the server, which is
> why the server-side fixes below could be confirmed immediately and the
> extension-side ones could not.

---

## Open

### 1. Enter in rich editors produces double line breaks 🔴

**What happened.** Typing `\n\n` into Meta's composer yielded three newlines;
typing `\n` yielded one. Exactly one blank line between paragraphs was not
reachable.

**Fix.** In a `contenteditable`, send `Shift+Enter` for a soft line break
instead of `Enter`, or expose a `newline: "soft" | "paragraph"` option on
`browser_input`. Worth doing because captions and comments are a common target
and paragraph spacing is visible to the public.

### 2. `Control+a` selects the page when focus is lost 🔴

**What happened.** Several `browser_input {keys:["Control+a"]}` calls with no
`ref` selected the entire document instead of a field, because focus was not
where it was assumed to be.

**Fix.** When `keys` are sent without `ref`, check `document.activeElement`
first; if it is `body`, return an error naming the problem rather than
dispatching a chord that will do something surprising. Alternatively let `keys`
accept a `ref` and click it first, as `text` already does.

### 3. `full_page` screenshots fail outright on tall pages 🔴

**Found live, 2026-08-02.** A full-page capture of the Wikipedia "Berlin"
article (~42,000 CSS px tall) spun for **14.7 seconds** and then returned the
raw protocol error:

```
Page.captureScreenshot failed: {"code":-32000,"message":"Unable to capture screenshot"}
```

Chrome cannot allocate a texture that large. Nothing in the message says so, so
the natural next move is to retry — which burns another 15 seconds.

**Fix.** Read `Page.getLayoutMetrics` first (`captureScreenshot` already calls
it for `fullPage`). When the content height exceeds a safe ceiling, either
capture in horizontal bands and stitch, or fail immediately with a message that
names the real problem and the way out:
`"the page is 42,000px tall — too tall to capture in one image; use mode:"region" over the part you need, or scroll and take viewport shots"`.
Failing in 50ms with a next step beats failing in 15s without one.

### 4. `find` ranks href-only matches as highly as real controls 🔴

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

**Fix.** In `findElements`, score `href` matches below `name` matches, and
discount an element whose *only* hit is in the href and whose name is empty.
The href is in the haystack to catch `/login` and `/cart`, not to match prose.

### 5. Session and workstream naming is opaque 🔴

Group labels currently read `opencode 5020`, `opencode a670` — a client name
plus a hex slice of the pid. A human looking at the tab strip cannot tell which
is which, and the hex conveys nothing about the work. Making the id
collision-proof (see *Session isolation*, below) made it **worse**, not better:
labels are now `opencode 5020a3f1`.

**Fix — separate the identity from the label.** They are two different jobs
being done by one string:

- **Session id**: opaque, unique, never shown. Used as the group-map key and
  for tab ownership. Uniqueness is the only requirement.
- **Display label**: short and human. `opencode 1`, `opencode 2` numbered per
  client within a browser session; or a memorable word pair (`opencode
  swift-otter`); or, best, the workstream the agent actually named
  (`opencode · reel uploads`), falling back to a number when it has not named
  one. Disambiguate with a numeric suffix only on an actual collision, rather
  than pre-emptively for every session.

The tab strip is the only place a human sees what the agents are doing, so the
label should describe the work, not the process that started it.

### 6. Surface a "page is settling" signal 🔴

**What happened.** Several clicks on Meta's "Create post" registered but did not
navigate, needing a second attempt. There was no way to distinguish "the click
missed" from "the app has not reacted yet".

**Fix.** After a click that produces no delta, poll briefly for any DOM mutation
and report `"no change detected — the page may still be reacting, or the click
missed"`. Better than the current silence.

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

- **`browser_find` with a `selector` that matches a single element returns
  nothing.** `buildTree` sets the match as its root and then walks the root's
  *children*, so the element itself is never emitted. Scoping to a dialog works
  because you want its contents; scoping to one control silently reports "no
  matches", which reads as "it is not there". Either emit the root or say that
  scoping is subtree-only. Hit while trying to scope to a planted `#ob-probe`.
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

## Loose end from the 2026-08-03 merge

- **`captureGeometry()` in `extension/background/format.js` is currently unreferenced.**
  It maps a returned screenshot back to CSS pixels — the image goes through two
  independent rescalings (device pixel ratio at capture, then the downscale to
  `maxWidth`), so a coordinate read off a screenshot is in neither space, and
  passing it to `browser_act` clicks the wrong place silently. The function
  survived the merge but its caller did not: it was wired into a `router.js`
  screenshot handler from a parallel branch that was superseded. Hook it into
  the current `browser_screenshot` result, or drop it deliberately.

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
