# Testing

## Automated

```bash
npm test
```

75 tests covering the WebSocket framing, the MCP protocol, the full round trip
(including two clients sharing one browser and the disconnected case), output
formatting, and macro substitution. No browser required — a fake extension
stands in for Chrome.

Run it a few times when touching `ws.js` or `hub.js`. The greeting race
documented in [ARCHITECTURE.md](ARCHITECTURE.md#framing-and-the-greeting-race)
failed intermittently, so a single green run proved nothing.

## Accessibility tree tests

```bash
node scripts/serve-preview.mjs
# open http://localhost:8850/test/a11y-browser.html
```

41 assertions against a real DOM, covering the file that decides what a model
sees. The fixture is deliberately awkward — five levels of wrapper divs, labels
associated three different ways, an open shadow root, a `div` acting as a
button, and four flavours of hidden element. Results render in the page, with
the resulting tree at the bottom.

This needs a browser (it is DOM-dependent), so it is not part of `npm test`.
Run it after touching `content/a11y.js` or `content/actions.js`.

## UI preview

```bash
node scripts/serve-preview.mjs   # http://localhost:8850
```

Renders the side panel with the Chrome APIs stubbed, so you can iterate on the
UI without reloading the extension. Toggle your OS light/dark setting to check
both themes.

---

## Manual checklist

These need a real Chrome. Work through them after changing anything in
`content/` or `background/cdp.js`.

### Setup

- [ ] Load unpacked from `extension/`, no manifest errors
- [ ] Options page opens on first install
- [ ] Badge shows `○` with no server running
- [ ] Start the server; badge clears within a few seconds
- [ ] `node mcp-server/src/index.js --health` reports the browser connected
- [ ] Stop the server; badge returns to `○`. Restart it; it reconnects on its own

### Service worker lifetime

- [ ] Leave the browser idle 2+ minutes, then run a tool — it still works
- [ ] `chrome://extensions` → "service worker" → Stop, then run a tool — it
      respawns and reconnects
- [ ] Reload the extension while the server runs — it reconnects without
      restarting the server

### Reading pages

- [ ] `browser_snapshot` on a content-heavy page (Wikipedia) — readable, refs present
- [ ] `browser_snapshot` on an SPA (Gmail, Linear) — controls appear, not just wrappers
- [ ] `mode: "diff"` after clicking — shows only the change
- [ ] `selector` scoping cuts the output down
- [ ] `mode: "text"` returns readable prose
- [ ] A page with open shadow DOM (YouTube) — inner controls appear
- [ ] A page with iframes — subframe content appears with `fN` refs

### Interaction

- [ ] Click a plain button
- [ ] Click a button under a sticky header — reports the obstruction, and
      `force: true` clicks through
- [ ] Fill a React form — values stick and are not reverted on re-render
- [ ] Fill a masked input (phone, card number) with `delay: 50` — formatting applies
- [ ] `select_option` by visible label, not just value
- [ ] Check and uncheck a checkbox; select a radio in a group
- [ ] `Control+a` selects all rather than typing "a"
- [ ] Drag an item in a sortable list (dnd-kit, react-beautiful-dnd)
- [ ] Click a control inside a cross-origin iframe — lands correctly
- [ ] Click something that navigates — the returned delta reflects the new page

### Trusted input

The point of the debugger. Verify on a site that rejects synthetic events:

- [ ] A Stripe test checkout card field accepts typing
- [ ] A hover-only dropdown menu opens on `hover`
- [ ] Turn off "trusted input events" in options — the same actions now fail or
      do nothing. Turn it back on

### Waiting

- [ ] `for: "text"` resolves when the text appears
- [ ] `for: "network_idle"` on an SPA resolves rather than hanging
- [ ] A timeout error includes the page's current state
- [ ] `for: "selector"` on an element that never appears times out cleanly

### Screenshots

- [ ] `viewport`, `full_page`, `element`, and `region` all render correctly
- [ ] `full_page` on a long page has no seams or repeated bands
- [ ] A background (non-active) tab screenshots correctly
- [ ] `animate: {frames: 8}` produces a GIF that actually animates
- [ ] Retina display — output is downscaled to `maxWidth`, not 2x

### Parallel tabs

- [ ] Open 5 background tabs — focus does not jump
- [ ] `browser_batch` with `parallel` across all 5 completes
- [ ] Snapshot two tabs alternately — refs do not bleed between them
- [ ] Close a tab mid-run — the error names the tab, others keep working

### Inspection

- [ ] `console` shows output from before the call was made
- [ ] `console` with `level: "error"` filters correctly
- [ ] `network` lists requests with status, size, timing
- [ ] `request_body` returns a body for a recent XHR
- [ ] `cookies`, `storage`, `downloads`, `frames`, `page_info` all return

### Edge cases

- [ ] `chrome://settings` — clear error explaining browser pages cannot be automated
- [ ] Open DevTools on a tab, then act on it — error names DevTools as the cause
- [ ] A page with a CAPTCHA — reported, not attempted
- [ ] A blocklisted host — refused with a message pointing at options
- [ ] Add a host to the allowlist — other hosts are refused
- [ ] A stale ref after a full re-render — error says to re-snapshot

### Native dialogs

Trigger with a page that calls `confirm()`/`beforeunload` (an unsaved-changes
form is the realistic case):

- [ ] A click that opens a `confirm()` — the action's own result notes the
      dialog and how to answer it
- [ ] Any later call (snapshot, find, eval, wait) fails fast with the dialog's
      text and the `action:"dialog"` instruction — no 60s hang
- [ ] `action:"dialog" accept:false` dismisses; the page's `confirm()` returns
      false
- [ ] `action:"dialog" accept:true` on a beforeunload proceeds with the
      navigation
- [ ] Navigating away from a page with a `beforeunload` handler is caught by
      the navigate precheck, not a silent stall
- [ ] After answering, calls work normally again
- [ ] `action:"dialog"` without `accept` errors with the usage message
- [ ] `browser_upload` to a styled "Browse" button, not the raw input

### Side panel

- [ ] All four views render and switch
- [ ] Quick actions produce output; screenshots render inline
- [ ] Tool runner: invalid JSON gives a clear error, not a silent failure
- [ ] Activity log fills as an agent works, errors shown in red
- [ ] Macro save from an agent then run from the panel
- [ ] Narrow the panel to its minimum — no horizontal overflow
- [ ] Switch OS theme — panel follows, both themes readable
