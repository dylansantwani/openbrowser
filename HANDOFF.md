# Handoff — the foreground-interruption + multi-agent rework

**Status:** code complete, unit-tested (`npm test` → 246 passing), **and
verified live against a reloaded extension in real Chrome on 2026-08-26.** The
live run caught three more bugs, now fixed and re-verified (see §8). Everything
below is in the working tree on top of `b044fa9`, uncommitted. Read this before
you touch anything; it is the record of what was found, what was decided, exactly
what changed, and what was proven live.

This work was done by GPT-5 (Codex) alongside a parallel Claude Code audit of the
same repo, then finished and reconciled by Claude. Where the two agents
disagreed, the disagreement and its resolution are written down rather than
smoothed over — see "The disputed conclusion" below.

---

## 1. The ask

Two complaints from real use, both about `openbrowser`:

1. **The agent keeps yanking a tab to the front and interrupting me.** A run
   would pull the user's view to the agent's tab several times a second.
2. **Multiple agents fight over the browser.** Sessions reached into each
   other's tabs and windows.

Fix both without weakening isolation or reintroducing silently-dropped input.

---

## 2. What was found

### P0-A — the foreground interruption was code, not chance

Trusted CDP input (`Input.dispatchMouseEvent` / `dispatchKeyEvent`) is silently
dropped by a tab whose `document.visibilityState` is `hidden` — no error, the
call reports success, the page never sees the click. The old defense was
`ensureForeground()`: activate the tab and focus its window before every
dispatch. Correct, and ruinous — that is the interruption. `browser_tabs select`
and `browser_window focus` additionally called `chrome.windows.update({focused:
true})` unconditionally.

### P0-B — `group` was doubling as the security identity

The server safely stamps `_session`, but the extension used `args.group ||
args._session` for tab ownership, tab resolution, and window binding, while
groups were keyed by their visible name alone. Consequences, all reproduced in
the logs:

- Two sessions naming a workstream `research` shared ownership and a window.
- `close_group "research"` from one session closed the other's tabs.
- A session that used `group:"email-send"` then omitted `group` became a
  different apparent owner and locked itself out of its own tab.

### The decisive evidence — the "hidden" warning was lying

OpenBrowser told agents a hidden-tab action had probably failed. The logs prove
it often **succeeded**: a hidden Gmail `Send` produced `{composeOpen:false,
sentToast:true}`; hidden eBay clicks opened menus, changed selections, and
enabled Continue; a hidden type produced a 3,976-char body. The tool was
reporting probable failure over actions that demonstrably worked.

The installed **Claude-in-Chrome extension (v1.0.85)** was read directly as a
reference implementation. Its click/type path sends `Input.dispatchMouseEvent`,
`Input.dispatchKeyEvent`, and `Input.insertText` **straight to the target tab**
and does **not** activate the tab, focus the window, call
`Emulation.setFocusEmulationEnabled`, or use special Chrome launch flags. Its
pressed mouse events carry `force: 0.5`. Conclusion: a background (unfocused but
visible) tab takes trusted input, and foregrounding was never required for the
common case.

### Sprawl

At audit time: 1,706 OpenBrowser calls across 183 transcripts / 28 sessions; 39
live MCP processes split between `/Users/dylan/openbrowser` and an older
`/Users/dylan/Downloads/openbrowser`; a new window created per short-lived
session.

---

## 3. The disputed conclusion (do not re-litigate blindly)

The parallel Claude Code audit patched `emulateFocus()` in and declared focus
emulation *the* root-cause fix. That claim was **not accepted**, for two
concrete reasons:

- The installed Claude-in-Chrome build contains **zero**
  `Emulation.setFocusEmulationEnabled` and **zero** `Page.bringToFront` calls. It
  does not use focus emulation, yet its background input lands.
- Claude's patch did not remove a single `ensureForeground()` / focus call, so
  even if harmless it could not by itself deliver "never interrupt me."

Resolution actually shipped: **stop foregrounding on normal paths and tell the
truth when a tab is genuinely hidden.** `emulateFocus` is retained only as a
**default-off** opt-in for the fully-covered-window case. `test/run.mjs` pins the
default off; if you ever flip it, change the test and the docs in the same
commit.

---

## 4. What was decided, and why

| Decision | Rationale |
|---|---|
| Remove `ensureForeground()` and `restoreFocusAfterInput` entirely | Foregrounding *was* the interruption; restore-after only turned a steal into a flicker. |
| Normal `browser_act` / `browser_input` / `browser_upload` never activate a tab or raise a window | An unfocused-but-*visible* tab takes trusted input, so nothing needs the foreground. |
| Keep foregrounding only in `browser_tabs select` and `browser_window focus` | There, showing a human the tab is the entire point of the call. Both stay gated by `assertOwnWindow`. |
| When a tab is genuinely `hidden`, return `UNVERIFIED … dispatched` instead of a false success | A click that admits "I couldn't confirm this" beats one that lies about landing — the whole failure mode being fixed. |
| Security identity = `_session` only; `group` demoted to a cosmetic workstream label | Kills P0-B. Two sessions using the same label can never touch each other's tabs. |
| `soloWindow` (default on) + `agentWindowPool` (default on) | Agents work in a background window that is not yours, collapsed into one shared pool instead of one window per session. |
| Per-window trusted-input lease (`serializeTabMutation`) | Serializes concurrent clicks/types on one tab so parallel agents don't interleave input; reads stay parallel. |
| `emulateFocus` shipped **default off** | Not required for background input; an experiment, not a proven guarantee. Opt-in for permanently-covered windows, with `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows`. |
| `PROTOCOL_REVISION = 2` handshake guard | Ownership/routing semantics changed; a stale server or extension from another checkout must fail loud, not misroute. |

---

## 5. Exactly what changed (per file)

Baseline `b044fa9`; 15 files changed, +652/−547, plus one new file.

- **`extension/background/router.js`** — `ensureForeground()` and
  `restoreFocusAfterInput` removed. `sessionIdOf(args)` (= `_session`) is the
  sole authority; `workstreamOf(args)` (= `group || _session`) is only a display
  label. Every ownership check (`claimTab`, tab resolution, binding) keys on
  `sessionId`. Trusted-input handlers wrapped in `serializeTabMutation(tabId,
  …)`. No-page-change results now say `UNVERIFIED: … dispatched`.
- **`extension/background/mutation-queue.js`** *(new)* — per-tab serialization of
  mutating input; `serializeTabMutation` / `clearTabMutation` (cleared on
  `tabs.onRemoved`).
- **`extension/background/groups.js`** — groups keyed by `(sessionId,
  workstream)`; durable `groupId → {sessionId, workstream}` owner map; lookups
  gather *all* matching groups (dup-safe); `assign` serialized per workstream.
- **`extension/background/windows.js`** — `agentWindowPool`: `pooledWindow()` /
  `poolPromise` share one background window across agent sessions; `bind()` takes
  `{own, agent}`; ownership recorded, not inferred.
- **`extension/background/cdp.js`** — `emulateFocus(tabId)` calls
  `Emulation.setFocusEmulationEnabled` **only when `settings.emulateFocus` is
  true** (default off). Mouse press carries `force: 0.5`, matching
  Claude-in-Chrome.
- **`extension/background/settings.js`** — `agentWindowPool: true`,
  `emulateFocus: false` added; `restoreFocusAfterInput` removed. See comments.
- **`extension/background/format.js`** — tab rows carry `{workstream, sessionId}`
  so same-named workstreams from different sessions never render as one job;
  "(you)" compares `sessionId`.
- **`extension/background/bridge.js`** + **`mcp-server/src/hub.js`** —
  `PROTOCOL_REVISION = 2` on both sides; a mismatch fails the call with a message
  telling the user to restart every MCP server from one checkout and reload the
  extension. Hub `info` now carries `protocolRevision` (this is the federation
  gap the last test run caught — remote browser metadata wasn't propagating the
  revision, so a valid peer looked "legacy").
- **`extension/content/main.js`** — dropped the stale comment claiming visibility
  is an input-delivery verdict and that `ensureForeground` exists.
- **`mcp-server/src/tools.js`** — `SERVER_INSTRUCTIONS` rewritten: omit `group`
  for normal work, never `select`/`focus` merely to interact, trust the
  `UNVERIFIED` result and don't blindly retry with force. `group` schema
  descriptions softened. Schema stays under the 14,500-byte budget (now 14,449).
- **`test/run.mjs`** — coverage for the pooled window, the mutation-queue lease,
  the `(sessionId, workstream)` group keying, the protocol-revision guard
  (including hub-to-hub), and an assertion that `emulateFocus` stays default off.
- **`CLAUDE.md` / `TODO.md`** — reconciled to the shipped design (this was the
  main thing that had drifted: they described `emulateFocus` as default-on and
  load-bearing, and still referenced the removed `ensureForeground`).

---

## 6. Live verification — done (2026-08-26)

Exercised against a reloaded extension in real Chrome (Chrome 151), driving the
stack through both a real MCP client and the `live.mjs` peer harness. Unit tests
use stubs and cannot see the failures this project cares about ("says it worked,
nothing happened"); every item below was confirmed on the real browser.

- [x] Click on an agent tab in a background window lands **without** the user's
      window coming forward — tab reported `visibilityState:"visible"`,
      `hasFocus:false`, and the click navigated.
- [x] `soloWindow` gives the agent its own window; the user's tabs are untouched.
- [x] `agentWindowPool` collapses multiple sessions/workstreams into one shared
      background window (observed three sessions in one window).
- [x] Two sessions both using `group:"research"` are isolated — the peer's
      `close_group "research"` closed only its own tab; the other survived.
- [x] A genuinely inert click returns `UNVERIFIED … dispatched`.
- [x] `browser_tabs select` foregrounds an owned tab on purpose, and is **refused**
      (not silently redirected) for a tab in a window the session does not own.
- [x] Protocol-revision guard fails loud on a mismatched stack with the restart
      message rather than misrouting.

Not separately exercised (opt-in / hard to force live), covered by construction
and unit tests: parallel-click serialization (mutation-queue unit tests), and
`emulateFocus:true` + launch flags on a fully covered window (default-off
opt-in). `docs/TESTING.md` has the manual checklist; drive the real extension
with the `live.mjs` harness in CLAUDE.md ("Driving the extension by hand").

---

## 7. Rollback

All changes are uncommitted on top of `b044fa9`. To discard:

```bash
git checkout -- . && git clean -f extension/background/mutation-queue.js
```

The single most likely regression to watch for after this ships is the inverse
of the bug it fixes: if a real site's JavaScript gates on `document.hasFocus()`
and an agent's clicks stop working on a background window, that is the case
`emulateFocus:true` exists for — turn it on for that site before concluding the
no-foreground design is wrong.

---

## 8. Bugs the live run caught (fixed + regression-tested)

The three P0/P1 fixes were sound, but exercising the real stack surfaced three
more defects that unit tests missed. All are fixed and covered.

1. **Hub dropped the protocol stamp on every non-owner path — P0.**
   `call()` (the hub owner's path) stamped `_protocolRevision`, but the peer
   relay (`_onPeerMessage`), the federation relay (`_relayToTarget`), and the
   `__session_end` cleanup did **not**. Since only the first MCP client owns the
   hub and the rest join as peers, this rejected **every secondary client** with
   "server legacy", broke hub-to-hub federation, and silently skipped
   disconnect cleanup. This is the exact shape of the documented `_nameBrowserIn`
   bug ("written in `call()` alone, absent for every other client"). Fixed at all
   three sites in `hub.js`; regression tests assert the stamp on the peer-relay
   and session-end paths (the mock extension does not enforce it, which is why it
   slipped through — the tests now assert it directly on what the extension was
   sent).

2. **Spurious `UNVERIFIED` on navigation clicks — P1.** A click that navigated
   cross-origin was reported as "no page change detected": the post-action
   snapshot in `withDelta` runs before the new document's content script is
   ready, throws, and only the delta-budget branch set `changed`, so a real
   navigation looked like a dead click — the exact false-negative the honest
   report is meant to prevent, on the most common click there is. Fixed in
   `withDelta` by comparing the tab's own URL across the action and treating a
   change as a real delta. Verified live: the navigation click now reports the
   change; an inert click still returns `UNVERIFIED`.

3. **Duplicated session label in tab/workstream output — P2 (cosmetic).** With no
   explicit `group`, the workstream label defaults to the session label, and the
   new ownership rendering printed both as `harbor · harbor`. Fixed in
   `format.js` and the `router.js` workstream summary to append the session id
   only when it differs from the workstream. Verified live: labels read
   `[claude-code · harbor]`, `[research]`, etc.

`npm test` is at 246 passing after these.
