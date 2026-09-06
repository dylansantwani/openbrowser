# Tool reference

Every tool takes an optional `tabId`. Omit it to act on your session's last-used
tab (one is opened for you if you have none); pass it to drive many tabs in
parallel. A tab another agent owns is refused.

Refs (`e12`, `f2e5`) come from `browser_snapshot` or `browser_find`. A ref
prefixed with `fN` lives inside iframe N. Refs survive minor re-renders and
re-resolve through a stored selector when the element is replaced; when one is
truly gone you get an error telling you to re-snapshot.

---

## browser_tabs

| Param | Type | Notes |
|---|---|---|
| `action` | `list` \| `new` \| `close` \| `select` \| `reload` \| `duplicate` | default `list` |
| `tabId` | number | |
| `tabIds` | number[] | batch close/reload |
| `url` | string | for `new` |
| `background` | boolean | default `true` — opens without stealing focus |
| `windowId` | number | for `new` |

```json
{ "action": "new", "url": "example.com" }
```

`list` returns `tabId  url  "title"  (flags)` per line. Those ids are what you
pass to every other tool.

---

## browser_navigate

| Param | Type | Notes |
|---|---|---|
| `url` | string | **required.** URL, or `back` / `forward` / `reload` |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` \| `none` | default `load` |
| `timeout` | number | ms, default 30000 |

Scheme is optional — `example.com` becomes `https://example.com`.

Use `networkidle` for SPAs that render after `load`. A load timeout is reported
but does not throw away the page you did get, since many sites never fully
quiesce.

---

## browser_snapshot

The primary way to see a page.

| Param | Type | Notes |
|---|---|---|
| `mode` | `interactive` \| `full` \| `text` \| `diff` \| `outline` | default `interactive` |
| `selector` | string | scope to one region |
| `maxChars` | number | default 8000 |
| `frames` | boolean | include iframes, default `true` |
| `viewportOnly` | boolean | only what is currently on screen |

**Modes**

- `interactive` — controls and structure. The default; smallest useful view.
- `full` — adds static text. Use when you need to read content, not just act.
- `text` — plain readable text, no refs. For extracting prose.
- `diff` — only what changed since the last snapshot of this tab. Use in loops.
- `outline` — the page as a table of contents: every landmark with how many
  controls it holds and the selector that scopes a snapshot to it, plus the
  headings between. Ten to forty lines for a page whose full tree is hundreds.
  The cheap first look at a big page; the next call goes straight to
  `selector:"…"`.

```
en.wikipedia.org/wiki/HTTP · tab 481 · 1512x720
banner (1 link) selector:"#mw-head"
  search selector:"#p-search"
    form (1 searchbox, 1 button) selector:"#searchform"
navigation "Contents" (11 links, 4 buttons) selector:"#mw-panel-toc"
main (836 links) selector:"#content"
  h1 "HTTP"
  navigation "Views" (3 links) selector:"#right-navigation > nav:nth-of-type(1)"
  h2 "Versions"
  h2 "Use"
895 controls on the page · next: browser_snapshot selector:"<one of the selectors above>", or viewportOnly:true
```

A landmark counts its own controls, not a nested landmark's, so nothing is
counted twice.

**Truncation.** The default budget is 8,000 characters. A whole-page read that
runs out ends with the page's outline, so the next call can scope to the right
region instead of paging; a scoped read is already scoped and gets no outline.

**Output**

```
app.example.com/login · "Sign in" · tab 481 · 1280x800
form
  textbox "Email" [e2] required
  password "Password" [e3]
  checkbox "Remember me" [e4] unchecked
  button "Sign in" [e5]
```

The grammar is `role "name" [ref] =value href states`, indented by depth.
Anything absent is omitted rather than emitted empty.

---

## browser_find

| Param | Type | Notes |
|---|---|---|
| `query` | string | **required.** e.g. `"blue checkout button"` |
| `limit` | number | default 10 |
| `interactiveOnly` | boolean | default `true` |

Scored token overlap over role, name, value, and href — not embeddings, so it
costs nothing and is deterministic. Results include position, which is the
best way to disambiguate twelve identical "Add to cart" buttons.

Cheaper than a full snapshot when you already know what you are looking for.

---

## browser_act

| Param | Type | Notes |
|---|---|---|
| `action` | see below | **required** |
| `ref` | string | preferred targeting |
| `coordinate` | `[x,y]` | viewport CSS pixels; for canvas/maps/PDF |
| `to` / `toRef` | `[x,y]` / string | drag destination |
| `value` | string \| string[] | for `select_option` |
| `accept` | boolean | for `dialog`: true = OK/Leave, false = Cancel/Stay |
| `promptText` | string | for `dialog`: text to type for `prompt()` |
| `modifiers` | `Alt` \| `Control` \| `Meta` \| `Shift` | |
| `force` | boolean | skip the visible/enabled precheck |
| `expect` | `{for, value, timeout?}` | verify in the same call — see below |

**Actions:** `click`, `double_click`, `right_click`, `middle_click`, `hover`,
`focus`, `blur`, `scroll_to`, `scroll`, `drag`, `select_option`, `check`,
`uncheck`, `clear`, `submit`, `dialog`

Pointer actions dispatch trusted events through the debugger. The target is
scrolled into view first.

**Settling.** After the input lands the tool waits for the page to react, or to
prove it will not — not for a fixed time. It returns at the first of: the DOM
changed and has been quiet for 120ms; nothing changed within 250ms; 700ms passed
with the page still changing (the result says so). A click that starts a
navigation is recognised the moment the browser starts it and waits for the new
document to commit. A click that does nothing reports in about 300ms instead of
900. Do not follow a click with `browser_wait for:"time"`; the wait already
happened. The three windows are settings (`settleIdleMs`, `settleQuietMs`,
`settleMaxMs`).

**Verdicts.** When the interactive tree did not change, the result says which of
four things happened: `navigated to …`; `the page is still changing`; `the page
reacted (N DOM changes) but no control changed` (a text-only update — read it
with `mode:"full"`); or `UNVERIFIED: no page change was detected`.

### `expect` — verify in the same call

```json
{ "action": "click", "ref": "e14", "expect": { "for": "url", "value": "/issues" } }
```

`expect` is a `browser_wait` condition (`text`, `no_text`, `selector`,
`no_selector`, `url`, `ref_gone`, `load`, `network_idle`) with an optional
`timeout` (default 5000ms). The tool blocks until it holds and appends the
verdict:

> `dispatched click e14 ("Issues ( 44 )")`
> `expect url "/issues": met after 412ms`

A miss is an **error** — `dispatched click e14 — the action was dispatched, but
EXPECT FAILED: url "/issues" not met after 5000ms. Currently: …` — so a batch
stops there. That is what makes it a verification gate rather than a note, and
it replaces the act → wait → snapshot round trip that used to sit between every
click that mattered and the next step.

If something covers the target, you get an error naming it:

> `e12` is covered by `<div.cookie-banner>`. Dismiss the overlay first, or pass
> `force: true` to click through it.

### Native dialogs (`alert` / `confirm` / `beforeunload` / `prompt`)

A native dialog pauses the page's renderer. It is invisible to the
accessibility tree, unclickable, and it makes every page-side call hang until
timeout — so instead, while one is open, every call fails fast with the
diagnosis:

> `a confirm() dialog is open: "Leave site?" — answer it with browser_act action:"dialog" accept:true (OK/Leave) or accept:false (Cancel/Stay)`

Answer it with `action: "dialog"`:

```json
{ "action": "dialog", "accept": false }
```

`accept: true` answers OK/Leave (including the beforeunload "leave this page"
case); `accept: false` cancels. For a `prompt()` dialog, pass the text to type
with `promptText`. The page sees the answered result — a `confirm()` that was
dismissed returns `false`, exactly as if a user had clicked Cancel.

---

## browser_input

| Param | Type | Notes |
|---|---|---|
| `fields` | `[{ref, value, clear?}]` | fill many inputs at once |
| `text` | string | type into `ref`, or whatever has focus |
| `ref` | string | target for `text` |
| `keys` | string[] | e.g. `["Enter"]`, `["Control+a"]` |
| `newline` | `paragraph` \| `soft` | how a newline in `text` breaks lines |
| `submit` | boolean | press Enter when done |
| `delay` | number | ms between keystrokes |
| `expect` | `{for, value, timeout?}` | verify in the same call — as on `browser_act` |

`fields`, `text`, `keys`, `submit` run in that order, so one call can fill a
form and submit it.

`keys` focuses `ref` first, the same way `text` does. Sent with no `ref` and
nothing else in the call, they are refused rather than dispatched blind: a
chord like `Control+a` with focus on the body selects the whole document, which
looks like it worked and then corrupts the next action.

`newline: "soft"` sends Shift+Enter between lines. Rich editors open a new
paragraph on Enter, which renders as a blank line — so in a Gmail or Meta
composer one `\n` gives one break and two give *three*, and exactly one blank
line between paragraphs is otherwise unreachable.

Values are set through the native setter plus the event pair frameworks listen
for, so React, Vue, Angular, and Svelte all see the change.

`delay: 0` (the default) uses a single fast insert. Raise it for inputs with
masking, character counters, or as-you-type validation, which need real
per-character key events.

Checkbox and radio values take a boolean.

Like `browser_act`, the call returns as soon as the page has reacted to the
typing and gone quiet — typically well under the 300ms it used to sleep — and
`expect` verifies the outcome in the same call:

```json
{ "ref": "e3", "text": "latency", "submit": true, "expect": { "for": "url", "value": "/wiki/" } }
```

---

## browser_screenshot

| Param | Type | Notes |
|---|---|---|
| `mode` | `viewport` \| `full_page` \| `element` \| `region` | default `viewport` |
| `ref` | string | for `element` |
| `region` | `[x,y,w,h]` | for `region`; also use to zoom into detail |
| `format` | `png` \| `jpeg` | default `jpeg` |
| `quality` | number | jpeg, 1-100, default 70 |
| `maxWidth` | number | downscale, default 1280 |
| `animate` | `{frames, intervalMs}` | record an animated GIF |

Roughly 20x the token cost of a snapshot. Use it to verify something visual, to
read canvas/video/PDF content, or when a snapshot does not explain what you are
seeing — not to navigate.

Captures are downscaled before sending: a retina capture carries no extra
readable information at four times the cost.

---

## browser_wait

| Param | Type | Notes |
|---|---|---|
| `for` | see below | **required** |
| `value` | string | the text, selector, ref, or URL |
| `timeout` | number | ms, default 15000 |

**Conditions:** `text`, `no_text`, `selector`, `no_selector`, `ref_gone`, `url`,
`network_idle`, `load`, `time`, `job`

`for:"job"` collects a `browser_batch async:true` job by id (`value`). If it is
not finished within `timeout` you get its progress (`job2 running 4s — at step
3 (browser_navigate)`) and can call again or carry on with other work. With no
`value` it lists this session's jobs. A session only sees its own jobs; a job
is forgotten ten minutes after it finishes, or when the extension restarts.

`value` accepts `/regex/flags` as well as a substring for `text` and `url`.

Use this instead of guessing at sleeps. On timeout the error includes the page's
current state, so a wrong expectation is diagnosable without another call.

`network_idle` waits for quiet, not silence — apps with polling or open
websockets never reach zero in-flight requests.

---

## browser_eval

| Param | Type | Notes |
|---|---|---|
| `code` | string | **required.** One expression, or a function body with an explicit `return`; top-level `await` allowed |
| `world` | `main` \| `isolated` | default `main` |
| `ref` | string | |
| `frameId` | number | run inside a specific iframe |
| `timeout` | number | ms, default 10000 |

`main` sees the page's own globals (`window.__NEXT_DATA__`, app state, library
handles). `isolated` runs in the extension's world, sealed off from page script.

Best for reading computed state or scraping structured data in one shot. Prefer
`browser_act` for interaction — clicks dispatched from here are untrusted and
widely rejected.

---

## browser_inspect

| Param | Type | Notes |
|---|---|---|
| `what` | see below | **required** |
| `filter` | string | substring or `/regex/` |
| `level` | `all` \| `error` \| `warn` | console only |
| `requestId` | string | for `request_body` — the `#id` from `network` |
| `limit` | number | default 50, newest first |
| `since` | number | ms timestamp, for polling loops |
| `includePrevious` | boolean | include entries from before the last navigation |

**Targets:** `console`, `network`, `request_body`, `cookies`, `storage`,
`downloads`, `page_info`, `frames`

Console and network are captured continuously into a ring buffer from the moment
a tab is first touched, so this works retroactively — you can ask what went
wrong after it already has.

Results cover the **current page only**. Buffers are per tab and outlive a
navigation, so without this an agent asking for the console on one site was
shown the previous site's errors. Anything captured before the last navigation
is counted in a trailing note and returned only with `includePrevious: true` --
which is what you want for a redirect or login chain.

Response bodies are evicted quickly by the network agent; fetch them soon after
the request, or re-trigger it.

---

## browser_batch

| Param | Type | Notes |
|---|---|---|
| `steps` | `[{tool, args, when?, unless?, repeat?, steps?}]` | **required.** Any `browser_*` tool except `browser_batch` |
| `parallel` | number[] | run `steps` concurrently against each tabId |
| `async` | boolean | return a job id at once; collect with `browser_wait for:"job"` |
| `stopOnError` | boolean | default `true` |
| `returnEach` | boolean | default `false` — returns only the last result |

The main token-saving tool. On failure you get the trail of what ran plus the
step that broke, so a partial failure is still diagnosable.

**Only the last step pays for a page delta.** Intermediate results are discarded
unless `returnEach`, so their deltas are not computed — on a large app that is
up to three seconds a step. Navigation and new-tab detection stay on for every
step.

### Control flow

A step may carry:

| Field | Meaning |
|---|---|
| `when` | run the step only if this condition holds now |
| `unless` | run the step only if it does not |
| `repeat` | `{until: cond}` / `{while: cond}` with optional `max` (default 10, cap 50), or a plain count |
| `steps` | a sub-list run as one unit under this step's `when`/`unless`/`repeat` (no `tool` on such a step) |

Conditions are `browser_wait`'s vocabulary — `{for, value}` with `text`,
`no_text`, `selector`, `no_selector`, `url`, `ref_gone`, `load` — evaluated
**instantly** against the step's tab, never waited for. Put a `browser_wait`
step before a condition that depends on a load. `until` runs at least once
(do/while); `while` may run zero times. Nothing here is evaluated code: a model
gets loops and branches without the extension running a string it wrote.

```json
{
  "tabId": 481,
  "steps": [
    { "tool": "browser_navigate", "args": { "url": "news.ycombinator.com" } },
    { "tool": "browser_act", "args": { "action": "click", "selector": "#cookie-accept" },
      "when": { "for": "selector", "value": "#cookie-accept" } },
    { "repeat": { "until": { "for": "url", "value": "p=3" }, "max": 5 },
      "steps": [
        { "tool": "browser_act", "args": { "action": "click", "selector": "a.morelink" } },
        { "tool": "browser_wait", "args": { "for": "load" } }
      ] },
    { "tool": "browser_snapshot", "args": { "mode": "outline" } }
  ]
}
```

> `✓ browser_navigate → – browser_act (skipped: selector "#cookie-accept" was false) → ✓ browser_act ×2 → ✓ browser_wait ×2 → ✓ browser_snapshot`

Measured live: 1.8s for the whole flow, one round trip. A `repeat` whose
condition is still unmet at `max` is an error naming the count and the
condition; a batch is capped at 500 tool calls and groups nest three deep.

### Background jobs

`async: true` returns immediately with a job id and runs the batch in the
background. Collect it with `browser_wait for:"job" value:"job2"`, which
reports progress if it is not done. Every other tool stays usable meanwhile —
read another tab, or think — and a client that issues independent calls
concurrently gets real overlap. The job holds the tab's mutation lock for its
duration, so another agent cannot interleave clicks with it.

Fan the same steps across tabs:

```json
{
  "steps": [
    { "tool": "browser_navigate", "args": { "url": "example.com/pricing" } },
    { "tool": "browser_snapshot", "args": { "selector": "main" } }
  ],
  "parallel": [481, 482, 483]
}
```

---

## browser_upload

| Param | Type | Notes |
|---|---|---|
| `paths` | string[] | **required.** Absolute paths on the machine running Chrome |
| `ref` | string | the file input, or the button that opens it |

Most upload UIs hide the real `input[type=file]` behind a styled button, so
pointing at the visible control is fine — the actual input is located from it.

---

## browser_window

| Param | Type | Notes |
|---|---|---|
| `action` | `list` \| `use` \| `pick` \| `browsers` \| `connect` \| `disconnect` \| `remotes` | omit for the emulation params below |
| `windowId` | number | for `use` |
| `browser` | string | for `use`; a name from `browsers` |
| `hub` | string | for `connect`/`disconnect`; `host` or `host:port` |
| `preset` | `mobile` \| `tablet` \| `desktop` \| `wide` | |
| `width` / `height` | number | override the preset |
| `colorScheme` | `light` \| `dark` \| `no-preference` | |
| `zoom` | number | page zoom factor |
| `userAgent` | string | |
| `throttle` | `none` \| `slow3g` \| `fast3g` \| `offline` | |
| `focus` | boolean | bring tab and window to the front |

Presets carry the right device scale factor and mobile flag, so `mobile` gets
touch layout rather than just a narrow window.

### Machines elsewhere

`connect` attaches a hub on another machine; its browsers then appear alongside
local ones as `remote/browser` and are driven identically.

```json
{ "action": "connect", "hub": "10.0.0.5" }
{ "action": "remotes" }
{ "action": "disconnect", "hub": "10.0.0.5" }
```

The far end must be started with `--host 0.0.0.0`; it binds `127.0.0.1` by
default. These three actions work with no browser attached — `connect` is how a
browser becomes reachable in the first place.

Names are namespaced because instance ids are only unique within one hub, the
same way tab ids are only unique within one browser. Two machines each running
an unnamed Chrome would otherwise be indistinguishable in the chooser.

> The hub has no authentication. Anything that reaches it can run JavaScript in
> a logged-in browser — keep federated hubs on a private network.

---

## browser_macro

| Param | Type | Notes |
|---|---|---|
| `action` | `list` \| `save` \| `run` \| `delete` \| `show` | **required** |
| `name` | string | |
| `description` | string | shown in `list` |
| `steps` | `[{tool, args}]` | for `save`; may contain `{{placeholders}}` |
| `vars` | object | for `run` |

```json
{ "action": "save", "name": "login", "description": "Sign in to staging",
  "steps": [
    { "tool": "browser_navigate", "args": { "url": "{{site}}/login" } },
    { "tool": "browser_input", "args": { "fields": [{ "ref": "e2", "value": "{{user}}" }] } }
  ]}
```

```json
{ "action": "run", "name": "login", "vars": { "site": "https://staging.example.com", "user": "ada" } }
```

A placeholder alone in a string keeps its type — `{{count}}` with `count: 3`
yields the number `3`. Embedded in longer text it interpolates as a string.
Substituted values are never re-expanded, so a value containing braces cannot
corrupt the step structure.

Deriving a login flow might cost an agent eight calls and several thousand
tokens of snapshot. Replaying it costs one call.
