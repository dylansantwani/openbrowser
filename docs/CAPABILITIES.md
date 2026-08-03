# What this can actually do

Fourteen tools is a small surface. The interesting things come from how they
combine, and most of them are not obvious from reading the tool list.

Everything below is real behaviour in the current build, not a roadmap.

---

## 1. Drive many sites at once, from one call

Every tool takes a `tabId`, and `browser_batch` takes a `parallel` array of
them. So a sequence of steps can be fanned across N tabs concurrently:

```json
{ "tool": "browser_batch",
  "args": {
    "parallel": [101, 102, 103],
    "steps": [
      { "tool": "browser_find",  "args": { "query": "price" } },
      { "tool": "browser_eval",  "args": { "code": "return document.title" } }
    ] } }
```

Three product pages, one round trip, results labelled per tab. The comparison
that would normally be a dozen sequential calls is one.

**Reading parallelises; typing and clicking do not.** Snapshots, finds, evals and
screenshots all work on hidden tabs, so the example above is genuinely
concurrent. Trusted input is different: Chrome silently discards mouse and key
events aimed at a tab that is not visible, so `browser_act` and `browser_input`
foreground their tab first — and only one tab per window can be foreground.
Input across several tabs therefore serialises. That is a Chrome constraint, not
a design choice; the alternative is clicks that report success and do nothing,
which is what happened before it was found. Put the tabs in separate windows if
you genuinely need concurrent input.

Each tab an agent **opens** goes into a coloured Chrome tab group named after
the workstream, so a human watching the tab strip sees three labelled jobs
rather than an undifferentiated wall — and can tell at a glance which group is
safe to close. Several agents can share one browser and stay legible to each
other.

Groups are named `client · word` — `claude · harbor`, `opencode · meadow`. The
word is allocated by the hub, which is the only place that can see every live
session, so two sessions can never be handed the same one. That matters for
more than readability: the label is also what scopes a session to its own tabs.

**A session owns only the tabs it opened. Yours stay yours.** A call that omits
`tabId` goes to the tab that session is already working on. Failing that it uses
the active tab — but if another session *opened* that tab for its own task, the
call is refused rather than silently taking it over. Tabs you opened are never
labelled or claimed, so any session can work on the page you are looking at, and
a finished session never leaves one locked.

**A session tidies up after itself.** When its MCP client disconnects, the tabs
that session *opened* are closed. Tabs it adopted from you are never closed —
finishing a background job is not a reason to close your browser tabs. Disable
with `closeTabsOnSessionEnd` in the options page.

---

## 2. Record a flow once, replay it forever

`browser_macro` saves a step sequence under a name, with `{{placeholders}}`:

```json
{ "action": "save", "name": "ebay-comps",
  "steps": [
    { "tool": "browser_navigate", "args": { "url": "https://www.ebay.com/sch/i.html?_nkw={{query}}&LH_Sold=1" } },
    { "tool": "browser_eval",     "args": { "code": "..." } } ] }
```

Then `{ "action": "run", "name": "ebay-comps", "vars": { "query": "DDR5 SODIMM" } }`.

The point is cost. Re-deriving a login or a search-and-extract flow means
snapshotting the page, reasoning about it, and issuing five calls. Replaying it
is one call and no reasoning at all. Macros persist in `chrome.storage`, so they
survive browser restarts.

---

## 3. Retroactive console and network capture

This is the one people miss. Console output and network activity are recorded
continuously into ring buffers from the moment a tab is first touched — so
`browser_inspect` answers questions about something that **already went wrong**,
without reproducing it:

- `what: "console", level: "error"` — what threw, including browser-generated
  CSP violations and blocked mixed content that page JS never logs
- `what: "network", filter: "/api/"` — every matching request with status and
  timing
- `what: "request_body", requestId` — the actual payload

You do not have to decide to start recording before the bug happens. Results are
scoped to the current page; anything from before the last navigation is counted
in a note and available with `includePrevious: true`.

---

## 4. `mode: "diff"` — pay only for what changed

A snapshot of Gmail is thousands of characters. In a loop — waiting for a status
to flip, watching a list populate — you do not need the page again, you need
*the delta*. `browser_snapshot mode:"diff"` returns only added and removed lines
against the previous snapshot.

Every mutating tool also returns a compact post-action delta automatically, so
after a click you usually already know what changed and never issue the
follow-up snapshot at all. That is the single largest token saving in the
design.

---

## 5. Trusted input, which is why it works on real sites

Everything pointer- and keyboard-related goes through Chrome DevTools Protocol's
Input domain, producing events with `isTrusted: true`. Synthetic
`element.click()` produces `isTrusted: false`, and Stripe, Google, banking
portals and most drag-and-drop implementations reject it outright.

Consequences worth knowing:

- **Drag and drop works** — `browser_act action:"drag"` with `toRef`, including
  HTML5 drag-and-drop and canvas.
- **Canvas and map apps are reachable** by `coordinate` when there is no DOM to
  target.
- **File uploads work even with no `<input type=file>` in the DOM.** Most modern
  uploaders create the input only when their styled button is clicked, and then
  the OS dialog blocks the page. `browser_upload` intercepts the native picker
  via CDP, so Chrome hands over the input node instead of opening a dialog. This
  is the only approach that works on Meta Business Suite and Google Drive.

---

## 6. See inside cross-origin iframes

The content script runs in *every* frame, and each frame works out its own
offset within the top-level viewport — because a frame cannot ask where it is on
screen, and `window.frameElement` throws across origins. Refs from nested frames
carry an `fN` prefix and route back automatically.

So a checkout page whose card fields are a Stripe iframe three levels deep reads
as one tree, and a click lands on the right pixel.

---

## 7. Emulation without a second browser

`browser_window` does device presets, arbitrary viewports, forced light/dark,
zoom, user-agent override, and **network throttling** (`slow3g`, `fast3g`,
`offline`).

That makes real testing possible: load a page on simulated slow 3G and inspect
what the loading state actually looks like, or go `offline` and check the error
path. The `offline` profile is genuinely useful for testing failure handling
that otherwise never runs.

Automation keeps running while the window is **minimized**, so a long job can
get out of your way.

---

## 8. Animated GIF capture

`browser_screenshot` with `animate: {frames, intervalMs}` records a GIF —
encoded in the service worker, no dependency. For showing a human what a
transition or a bug actually looks like, this beats a wall of stills.

---

## 9. Nine wait conditions instead of sleeps

`browser_wait for:` accepts `text`, `no_text`, `selector`, `no_selector`,
`ref_gone`, `url`, `network_idle`, `load`, `time`.

`ref_gone` is the underrated one: "wait until the spinner I am looking at
disappears" is exactly the condition you want after submitting a form, and it is
not expressible as a selector on most SPAs.

---

## 10. It says when it cannot do something

Less flashy, more valuable. The tool reports rather than silently failing:

- **Obstruction detection** — a click point covered by a cookie banner is
  reported as covered, naming the covering element, distinct from off-screen.
  The fixes differ, so conflating them wastes turns.
- **CAPTCHA presence** is surfaced, and never bypassed. A blocking challenge
  must be solved by a human, and the tool says so instead of looping.
- **Truncation is always reported.** A read that ran out of budget says so,
  because "no matches" and "no matches in the part I read" mean completely
  different things.
- **Typing that did not land is an error**, not a success. Keystrokes go to
  whatever has focus, so a failed focus would otherwise look like a filled field.
- **A click that opens a new tab says so**, with the new tab's id. `target="_blank"`
  is everywhere in commerce and search results, and a click that appears to do
  nothing because the result is one tab over is a dead end an agent cannot
  reason its way out of. Popup windows count too.
- **A click that changed nothing says which kind of nothing.** Either *"the page
  is still changing — snapshot again in a moment"* or *"no change detected — the
  click may have missed"*. Those need opposite responses, and they are
  indistinguishable from the outside. A delta that is only the focus ring moving
  counts as nothing, because that is what a dead button produces.
- **Input reaches a hidden tab.** Chrome silently discards mouse and key events
  aimed at a backgrounded tab, so the tab is foregrounded first rather than the
  click being quietly thrown away.

---

## The design constraint behind all of it

Zero dependencies, on purpose — including a hand-written WebSocket and MCP
implementation. A failed `npm install` is the most common reason a local MCP
server silently does not work, and this cannot fail that way.

The other constraint is token cost. A 6,000-element page becomes ~350 characters
of accessibility tree. That ratio is what makes long multi-step tasks affordable,
and it is guarded by tests: the tool schemas must stay under 13.5KB, and a login
form must render in under 250 characters.
