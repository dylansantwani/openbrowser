/**
 * Tool dispatch. Every MCP call and every side-panel action lands here.
 *
 * Two conventions run through the whole file:
 *
 *  1. Errors are written for a model that has to recover from them. "ref e12 no
 *     longer exists — take a fresh snapshot" beats "Error: null". The recovery
 *     action goes in the message.
 *  2. Mutating tools return a short page delta. The model should rarely need to
 *     call browser_snapshot just to find out whether its click worked, because
 *     that round-trip is pure cost.
 */

import * as cdp from './cdp.js';
import * as frames from './frames.js';
import * as recorder from './recorder.js';
import * as fmt from './format.js';
import * as macros from './macros.js';
import * as groups from './groups.js';
import * as windows from './windows.js';
import * as oauth from './oauth.js';
import { encodeGif } from './gif.js';
import { getSettings, checkUrlAllowed } from './settings.js';
import { serializeTabMutation, clearTabMutation } from './mutation-queue.js';
import { runPlan } from './batch.js';
import * as jobs from './jobs.js';

/** Emitted for the side panel's activity log. */
const activityListeners = new Set();

export function onActivity(fn) {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

function logActivity(entry) {
  for (const fn of activityListeners) {
    try {
      fn(entry);
    } catch {
      /* never let the UI break a tool call */
    }
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export async function dispatch(tool, args = {}) {
  const started = Date.now();
  const handler = HANDLERS[tool];
  if (!handler) throw new Error(`unknown tool: ${tool}`);

  try {
    let result;
    if (TAB_MUTATIONS.has(tool) && !args._mutationLockHeld) {
      const tabId = await resolveTab(args);
      result = await serializeTabMutation(tabId, () =>
        handler({ ...args, _resolvedTabId: tabId, _mutationLockHeld: true })
      );
    } else {
      result = await handler(args);
    }
    logActivity({ tool, args, ok: true, ms: Date.now() - started });
    return normalize(result);
  } catch (err) {
    logActivity({ tool, args, ok: false, error: err.message, ms: Date.now() - started });
    throw err;
  }
}

/** Tools may return a string or {text, images}; MCP wants the latter shape. */
function normalize(result) {
  if (typeof result === 'string') return { text: result };
  return result;
}

/** A model-controlled group label is display metadata, never identity. */
const sessionIdOf = (args) => args?._session || null;
const workstreamOf = (args) => args?.group || args?._session || 'agent';
/** Which MCP client the session belongs to — stamped server-side, display only. */
const clientOf = (args) => (typeof args?._client === 'string' && args._client) || null;
/**
 * The scope a call resolves tabs in. With `group`, that group; without it, the
 * whole session — "my tab", wherever it sits. Keyed with `null` rather than the
 * session's own name so the two never alias.
 */
const recentScopeKey = (args) => JSON.stringify([sessionIdOf(args), args?.group || null]);
/** What this call's tabs are called on the strip and the page: "harbor" or "harbor · research". */
const groupTitleOf = (args) => groups.titleFor(sessionIdOf(args), workstreamOf(args));

/**
 * Mutating sequences on one tab are atomic with respect to other agents.
 * Reads can still fan out freely, and mutations on different tabs remain fully
 * parallel. The lock covers locate -> dispatch -> verify, not just the final
 * CDP command; serialising only the command leaves both callers acting on
 * geometry captured before either page change.
 */
const TAB_MUTATIONS = new Set(['browser_navigate', 'browser_act', 'browser_input', 'browser_eval', 'browser_upload']);
chrome.tabs.onRemoved.addListener(clearTabMutation);

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/** Pages that exist but can never be automated, so they are useless defaults. */
const automatable = (tab) => /^https?:|^file:/.test(tab?.url || tab?.pendingUrl || '');

/**
 * The tab to act on when the caller did not name one.
 *
 * Prefers the active tab, but skips over pages that cannot be driven at all.
 * Without that, an agent fails for the duration that the human happens to be
 * looking at chrome://extensions or the side panel — which is exactly when
 * someone is most likely to be setting this up for the first time.
 */
async function activeTabId() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (automatable(active)) return active.id;

  // Fall back to the most recently used automatable tab. `lastAccessed` is the
  // best available proxy for "the one they actually mean".
  const candidates = (await chrome.tabs.query({ windowType: 'normal' })).filter(automatable);
  if (!candidates.length) {
    throw new Error(
      active
        ? `The active tab (${active.url?.split('/')[0]}) cannot be automated, and no other suitable tab is open. ` +
          'Open a normal web page, or pass an explicit tabId.'
        : 'No open tabs. Use browser_tabs action:"new" to open one.'
    );
  }
  candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return candidates[0].id;
}

/**
 * @param {object} args
 * @param {{create?: boolean}} [opts] `create: false` for calls that act *on* a
 *   tab rather than through one — closing, reloading, selecting. Opening a fresh
 *   tab so it can immediately be closed is not a sensible reading of "close",
 *   and the error that replaces it says the one thing that helps.
 */
async function resolveTab(args, { create = true } = {}) {
  const sessionId = sessionIdOf(args);
  let tabId;

  if (args._resolvedTabId != null) {
    tabId = args._resolvedTabId;
  } else if (args.tabId != null) {
    try {
      await chrome.tabs.get(args.tabId);
      tabId = args.tabId;
    } catch {
      throw new Error(`tab ${args.tabId} no longer exists. Use browser_tabs action:"list" to see open tabs.`);
    }
    // Naming a tab explicitly is how you hand one of your own pages to an
    // agent, and from that point it is part of the session's work — so it joins
    // the session's group like everything else it touches. See `claimTab`.
    await claimTab(tabId, sessionId, workstreamOf(args), clientOf(args));
  } else {
    tabId = await sessionTabId(args);
    if (tabId == null) {
      if (!create && sessionId) {
        throw new Error(
          args.group
            ? `you ("${sessionId}") have no open tab in group "${args.group}", so there is nothing to act on — pass tabId, ` +
              'or see your tabs with browser_tabs action:"list".'
            : `you ("${sessionId}") have no open tab, so there is nothing to act on — open one with browser_tabs action:"new", ` +
              'or see what is open with browser_tabs action:"list".'
        );
      }
      tabId = await openSessionTab(args);
    }
  }

  await rememberSessionTab(args, tabId);
  noteAgentLabel(tabId, groupTitleOf(args));
  return tabId;
}

/**
 * Every tab a session works in belongs to that session's group.
 *
 * This used to be untrue on purpose: grouping a tab marked it *owned*, and
 * ownership outlived the session, so pointing an agent at your Gmail tab once
 * meant no later session could ever touch it. The fix at the time was to never
 * group a tab the agent did not open — which left agent tabs scattered among
 * yours with nothing to tell them apart, exactly the problem groups exist for.
 *
 * The real bug was the leak, not the grouping. `endSession` now releases the
 * whole workstream when a session ends, so a tab lent to an agent goes back to
 * being an ordinary tab of yours the moment the agent is gone. With that closed,
 * grouping every tab a session touches is safe, and the tab strip finally tells
 * the truth: everything inside the group is being driven, everything outside it
 * is yours.
 *
 * Cosmetic, so it never fails a call — a tab that could not be grouped still
 * works perfectly.
 */
async function claimTab(tabId, sessionId, workstream, client) {
  if (!sessionId) return; // the side panel is a human driving their own tabs

  // Naming a tab used to be the documented way to *override* this check, back
  // when the alternative was an agent stuck with no tab at all. It is not any
  // more — a session that wants a tab opens one — so the override has become
  // nothing but the one thing the hard rule forbids: two agents on one tab,
  // where a navigate for a fresh page wipes out another session's work mid-task.
  const owner = await groups.ownerFor(tabId);
  if (owner?.sessionId && owner.sessionId !== sessionId) throw foreignTabError(tabId, owner, sessionId);

  // A session works in one window. An explicit `tabId` is the one way a tab
  // from somewhere else enters the picture, and leaving it there quietly breaks
  // that invariant: resolution is window-scoped, so the very next call with no
  // `tabId` would silently move to a different tab, in a different window, than
  // the one just worked on. Both ways of restoring the invariant are honest;
  // which applies depends on whether the session has committed to a window yet.
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    let bound = await windows.boundWindowId(sessionId);

    if (bound == null) {
      // This branch used to bind the session to the tab's own window — "drive
      // my Gmail tab" settling the window without anyone answering the chooser.
      // It reads well and it is how an agent ends up owning the window you are
      // working in, because an explicit `tabId` comes from exactly one place:
      // a tab of yours. From that moment resolution is scoped to your window
      // and every action activates a tab inside it, so handing an agent one tab
      // hands it the whole window, one view-stealing switch at a time.
      //
      // The tab still comes to the session. The session no longer goes to the
      // window.
      bound =
        settings.soloWindow === false
          ? await windows.bind(sessionId, tab.windowId)
          : await windows.ensureWindow(sessionId, settings);
    }

    if (tab.windowId !== bound) {
      // Bring the tab to the session rather than the session to the tab. When
      // the binding was a human's answer to the chooser, quietly reassigning it
      // would undo a decision they made; when it is a window opened for this
      // session, moving is what taking the tab means.
      await chrome.tabs.move(tabId, { windowId: bound, index: -1 }).catch(() => {});
      await tidyBlankTabs(bound, tabId);
    }
  }


  if (settings.groupTabs === false) return;
  await groups.assign(tabId, sessionId, workstream, client).catch(() => {});
}

/**
 * The one error every cross-session path throws, so it always reads the same
 * and always says what to do instead.
 */
function foreignTabError(tabId, owner, sessionId) {
  const theirs = groups.titleFor(owner.sessionId, owner.workstream);
  return new Error(
    `tab ${tabId} belongs to agent "${owner.sessionId}"${theirs !== owner.sessionId ? ` (group "${theirs}")` : ''}, ` +
      `not to you ("${sessionId}") — refusing to touch another agent's tab. ` +
      'Work in your own tabs: browser_tabs action:"list" shows them, action:"new" opens one.'
  );
}

/**
 * Refuse a batch that names another agent's tabs.
 *
 * `close`, `reload` and `group` take a list of ids straight from a model, and
 * until this existed acted on every one of them unchecked — so one agent could
 * close another's tabs, or the user's, by passing the ids it had read off a
 * listing. Checked as a whole before anything is touched: a batch that half
 * ran is harder to reason about than one that did nothing.
 */
async function assertNotForeign(tabIds, sessionId) {
  if (!sessionId) return; // the side panel is a human
  const owners = await groups.ownersFor(tabIds);
  for (const tabId of tabIds) {
    const owner = owners.get(tabId);
    if (owner?.sessionId && owner.sessionId !== sessionId) throw foreignTabError(tabId, owner, sessionId);
  }
}

/**
 * A session with no tab yet opens its own, in the window it was given.
 *
 * The old behaviour was to adopt whatever tab the human was looking at. That
 * reads well in a demo and badly everywhere else: it makes an agent follow you
 * around as you switch tabs, it puts two agents on one tab when both start with
 * nothing, and it means a background job's first act is to take over the page
 * you are reading. A session opening its own tab, in its own group, in a window
 * it was told to use, is unambiguous — and pointing it at an existing page is
 * still one explicit `tabId` away.
 *
 * `ensureWindow` is what throws the "which window?" question, so it happens
 * here, before anything is created. A session that cannot answer it has opened
 * nothing and left no mess.
 */
async function openSessionTab(args) {
  const sessionId = sessionIdOf(args);
  if (!sessionId) return activeTabId(); // side panel: the window the human is in

  const settings = await getSettings();
  const windowId = await windows.ensureWindow(sessionId, settings);

  const tab = await openInWindow({ url: 'about:blank', active: false }, windowId);
  await claimTab(tab.id, sessionId, workstreamOf(args), clientOf(args));
  await rememberCreatedTab(sessionId, tab.id);
  return tab.id;
}

/**
 * Bring a session's existing tabs to the window it has just been bound to.
 *
 * Binding used to change only where the *next* tab would open. Everything the
 * session already had stayed where it was, still carrying its workstream label,
 * so `browser_window list` reported the session in its new window while its
 * group — and the tab a call with no `tabId` would resolve to — sat in the old
 * one. This is the drift that reads, from inside an agent, as "I was told I am
 * in window A and I am demonstrably acting in window B".
 *
 * The alternative was to refuse to rebind while a session has tabs, which
 * solves the inconsistency by forbidding the thing people actually want. Moving
 * is what "this session works here now" means.
 */
async function rehomeSession(sessionId, windowId) {
  if (!sessionId || windowId == null) return 0;
  const settings = await getSettings();
  if (settings.groupTabs === false) return 0;
  return groups.moveTo(sessionId, windowId).catch(() => 0);
}

/**
 * The one empty tab a freshly created window arrives with, or null.
 *
 * Only a blank or New Tab page counts, which is the narrowest possible reading
 * of "empty" and the reason using it does not violate the rule it looks like it
 * breaks — a session must never act on a tab the human was using — since neither
 * holds anything a human could be in the middle of.
 */
const BLANK_URL = /^(chrome:\/\/newtab\/?|about:blank|about:newtab)$/;

async function blankTabIn(windowId) {
  if (windowId == null) return null;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.length !== 1) return null;
    return BLANK_URL.test(tabs[0].url || tabs[0].pendingUrl || '') ? tabs[0] : null;
  } catch {
    return null;
  }
}

/**
 * Drop the placeholder a fresh window came with, once real work has arrived.
 *
 * A window opened for a session holds one blank tab. When the session's first
 * page is *moved* in rather than opened there, that placeholder is left over —
 * and nothing tracks it for cleanup, so it keeps the window alive after every
 * tab the session actually opened has been closed.
 */
async function tidyBlankTabs(windowId, keepTabId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.length < 2) return;
    const spare = tabs.filter(
      (t) => t.id !== keepTabId && BLANK_URL.test(t.url || t.pendingUrl || '')
    );
    if (spare.length && spare.length < tabs.length) {
      await chrome.tabs.remove(spare.map((t) => t.id));
    }
  } catch {
    // A leftover blank tab is untidy. Failing the call over it would be worse.
  }
}

/**
 * Open a page in a specific window, reusing that window's blank tab if it has
 * one. Two separate failures, one answer.
 *
 * The first is litter: a window opened for a session arrives holding an empty
 * tab, so creating a second beside it means closing the session's tabs at the
 * end leaves that one behind, and Chrome keeps the window open for it. An empty
 * window per finished session accumulates fast.
 *
 * The second is worse and is why this is not just a tidiness helper. A window
 * that Chrome has created but not finished setting up does not honour
 * `tabs.create({windowId})` — the tab is placed in the last-focused window
 * instead, which is the human's, and `create` reports the window that was
 * *asked for* rather than the one it used, so `createTabIn`'s readback agrees
 * with itself and corrects nothing. Observed live: the session bound to a new
 * window while its first tab, its tab group, and everything it then did were in
 * the window the fix exists to stay out of.
 *
 * Navigating a tab that already exists in the right window has no such race.
 */
async function openInWindow({ url, active }, windowId) {
  const blank = await blankTabIn(windowId);
  if (!blank) return createTabIn({ url, active }, windowId);

  const patch = {};
  if (url && url !== 'about:blank') patch.url = url;
  if (active) patch.active = true;
  if (!Object.keys(patch).length) return blank;
  return (await chrome.tabs.update(blank.id, patch)) || blank;
}

/**
 * Create a tab, and make sure it really is where it was asked to be.
 *
 * `chrome.tabs.create({windowId})` is not a promise of placement. A window that
 * is closing, minimising, or mid-drag can end up with the tab somewhere else,
 * and — worse — a `windowId` Chrome rejects surfaces as a tab created in the
 * *last focused* window, which is precisely the window this whole module exists
 * to keep agents out of. Nothing errors, so the only way to know is to read
 * `windowId` back off the created tab and correct it.
 *
 * The correction is a `tabs.move`, which is reliable in a way `create` is not
 * because the tab already exists by then.
 */
async function createTabIn(props, windowId) {
  const created = await chrome.tabs.create({ ...props, ...(windowId ? { windowId } : {}) });
  if (windowId == null) return created;

  // The readback has to be a fresh `tabs.get`, not `create`'s own return value.
  // Against a window Chrome has not finished setting up, `create` reports the
  // `windowId` it was *asked* for while placing the tab in the last-focused
  // window — so checking its return agrees with itself and corrects nothing.
  const tab = (await chrome.tabs.get(created.id).catch(() => null)) || created;
  if (tab.windowId === windowId) return tab;
  try {
    const moved = await chrome.tabs.move(tab.id, { windowId, index: -1 });
    return { ...tab, windowId: (Array.isArray(moved) ? moved[0] : moved)?.windowId ?? windowId };
  } catch {
    // Report the truth rather than the intent: a caller that groups this tab
    // needs its real window, or it creates a duplicate group in the wrong one.
    return tab;
  }
}

/**
 * Which workstream is driving each tab, for the on-page border's caption.
 *
 * Deliberately in-memory and best-effort: if an MV3 restart loses it the border
 * still appears, just without a name. Worth nothing to persist, and a wrong name
 * would be worse than none.
 */
const agentLabels = new Map();

function noteAgentLabel(tabId, label) {
  if (label) agentLabels.set(tabId, String(label));
}

function agentFrameLabel(tabId) {
  const label = agentLabels.get(tabId);
  return label ? `OpenBrowser · ${label}` : 'OpenBrowser agent';
}

chrome.tabs.onRemoved.addListener((tabId) => {
  agentLabels.delete(tabId);
  navCommits.delete(tabId);
  // The saved screenshot mapping dies with the tab; without this its
  // session-storage entry would leak for the life of the browser.
  clearCaptureGeometry(tabId);
  clearMarks(tabId);
  // So does the pointer's remembered position.
  mutateStored(CURSOR_POS_KEY, (all) => {
    delete all[tabId];
  }).catch(() => {});
});

/**
 * Main-frame navigation commits, newest per tab.
 *
 * Two consumers. `withDelta` reads it to catch a click whose navigation commits
 * *after* the settle window: reading the tab's URL back too early reported real
 * navigations as UNVERIFIED — the exact false negative the URL fallback exists
 * to prevent, on the most common click there is. An event record has no such
 * timing window. The redraw listener below uses the same event stream to put
 * the driving frame and the live cursor back on the new document, which
 * otherwise stay gone until the next tool call.
 *
 * In-memory is correct here: a withDelta spans one worker invocation, and the
 * redraw is best-effort decoration. Optional-chained because the unit-test stub
 * models only what the tests drive.
 */
const navCommits = new Map();

chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId !== 0) return;
  navCommits.set(details.tabId, { url: details.url, at: Date.now() });
});

/** The newest main-frame commit for a tab at or after time `t`, or null. */
function navSince(tabId, t) {
  const nav = navCommits.get(tabId);
  return nav && nav.at >= t ? nav : null;
}

/**
 * Main-frame navigation *starts*, newest per tab.
 *
 * A click that navigates commits its new document anywhere from a few
 * milliseconds to a few seconds later, depending on the server. The old fixed
 * sleep papered over that with 350ms and got it wrong both ways: too long for
 * every click that did not navigate, too short for a slow one, which was then
 * reported UNVERIFIED and retried on a page that was already changing. The
 * start event fires the instant the click sends the browser somewhere, so the
 * settle can tell "nothing happened" from "the answer is in flight" and wait
 * only in the second case.
 */
const navStarts = new Map();

chrome.webNavigation?.onBeforeNavigate?.addListener((details) => {
  if (details.frameId !== 0) return;
  navStarts.set(details.tabId, { url: details.url, at: Date.now() });
});

function navStartedSince(tabId, t) {
  const nav = navStarts.get(tabId);
  return nav && nav.at >= t ? nav : null;
}

/** How long to wait for a navigation that has started to commit. */
const COMMIT_WAIT_MS = 2500;

/**
 * Wait for the page to finish reacting to an action.
 *
 * Replaces `settle(350)` after every click and the 500ms `settling` probe that
 * followed when nothing changed — 850ms of fixed cost on the most common call
 * there is, most of it spent waiting for a page that had either finished long
 * ago or was never going to react. The page reports the moment it knows: it
 * mutated and went quiet, or it did not mutate within the idle window
 * (`settled` in main.js). In parallel, the navigation records above catch the
 * one reaction the page cannot report on — its own replacement.
 *
 * Returns what happened, so the caller can say the right thing: `navigated`
 * (the URL), `mutated` (true/false, or null when the page went away before it
 * could answer), `quiet` (false when it hit the ceiling still changing).
 */
async function awaitSettled(tabId, startedAt, { idle, quiet, max } = {}) {
  const settings = await getSettings();
  const opts = {
    idleMs: idle ?? settings.settleIdleMs ?? 250,
    quietMs: quiet ?? settings.settleQuietMs ?? 120,
    maxMs: max ?? settings.settleMaxMs ?? 700,
  };
  const t0 = Date.now();

  let resolveCommit;
  const committed = new Promise((r) => {
    resolveCommit = r;
  });
  const onCommit = (details) => {
    if (details.tabId === tabId && details.frameId === 0) resolveCommit({ url: details.url, at: Date.now() });
  };
  chrome.webNavigation?.onCommitted?.addListener(onCommit);

  try {
    let page = null;
    let nav = navSince(tabId, startedAt);
    if (!nav) {
      // The page's verdict, unless the document is replaced first — in which
      // case its answer is moot and the commit is the answer.
      page = await Promise.race([
        frames.sendToTab(tabId, 'settled', opts).catch(() => null),
        committed.then(() => null),
      ]);
      nav = navSince(tabId, startedAt);
    }
    if (!nav && navStartedSince(tabId, startedAt)) {
      // Started but not committed: the server has not answered yet. Wait for
      // it — bounded, because a hung request must not hang the tool.
      nav = await Promise.race([committed, settle(COMMIT_WAIT_MS).then(() => null)]);
    }
    return {
      navigated: nav || null,
      mutated: page ? !!page.mutated : null,
      changes: page?.changes ?? 0,
      quiet: page ? page.quiet !== false : true,
      ms: Date.now() - t0,
    };
  } finally {
    chrome.webNavigation?.onCommitted?.removeListener(onCommit);
  }
}

/**
 * What to tell a model when an action produced no visible delta. The settle
 * watched the page while the input landed, so it can say which of the four
 * things this is — and each needs a different next move.
 */
function settleVerdict(settled) {
  if (settled?.navigated) return `navigated to ${fmt.shortUrl(settled.navigated.url)}`;
  if (settled?.mutated && !settled.quiet) {
    return 'no change in the controls yet, but the page is still changing — browser_wait or snapshot again in a moment';
  }
  if (settled?.mutated) {
    const n = settled.changes;
    return `the page reacted (${n} DOM change${n === 1 ? '' : 's'}) but no control changed — likely a text-only update; browser_snapshot mode:"full" reads it`;
  }
  return 'UNVERIFIED: no page change was detected — the input was dispatched, but it may have missed or this control may do nothing on its own. Verify the expected state before continuing.';
}

/**
 * Put the overlays back on a fresh document.
 *
 * A navigation throws the old document away along with the driving frame and
 * the cursor, and the next tool call redraws them — but between the two the tab
 * looks undriven and the pointer vanishes, which on a click-navigate-click loop
 * is most of the run. `agentLabels` is in-memory best-effort, so after an MV3
 * restart the redraw resumes on the next call rather than here; that is the
 * accepted cost of not persisting a name that could go stale.
 */
chrome.webNavigation?.onDOMContentLoaded?.addListener(async (details) => {
  if (details.frameId !== 0 || !agentLabels.has(details.tabId)) return;
  const tabId = details.tabId;
  try {
    const settings = await getSettings();
    if (settings.showAgentBadge !== false) {
      frames
        .sendToTab(tabId, 'agent_frame', { on: true, label: agentFrameLabel(tabId) })
        .catch(() => {});
    }
    if (settings.showCursor !== false) {
      const pos = ((await chrome.storage.session.get(CURSOR_POS_KEY))[CURSOR_POS_KEY] || {})[tabId];
      // Reseed silently — no ripple, no pill. Nothing happened; the pointer is
      // simply still where it was.
      if (pos) frames.sendToTab(tabId, 'cursor', { x: pos.x, y: pos.y, action: '', click: false }).catch(() => {});
    }
  } catch {
    // Decoration. Never let it surface anywhere.
  }
});

/**
 * Send the live pointer to a top-level viewport point, if the setting is on.
 *
 * Fire-and-forget and always to the top frame: the point is already in
 * top-level coordinates, and a click three iframes deep should still show the
 * pointer at the right pixel on the screen. Never awaited — the visual must not
 * add latency to, or fail, the action it is illustrating.
 */
function showCursor(tabId, settings, opts) {
  if (settings.showCursor === false) return;
  frames.sendToTab(tabId, 'cursor', opts).catch(() => {});
  // Remember where the pointer is, so the post-navigation redraw can put it
  // back on the new document instead of losing it until the next action.
  if (typeof opts.x === 'number' && typeof opts.y === 'number') {
    mutateStored(CURSOR_POS_KEY, (all) => {
      all[tabId] = { x: Math.round(opts.x), y: Math.round(opts.y) };
    }).catch(() => {});
  }
}

/** A short human label for the cursor pill: the target's name, else the verb. */
function cursorLabel(action, name) {
  if (name) return fmt.truncate(name, 32);
  return action.replace(/_/g, ' ');
}

/**
 * Tabs each workstream opened for itself.
 *
 * Kept in `chrome.storage.session` rather than a variable: MV3 tears the worker
 * down constantly, and this has to survive that. Session storage is also
 * exactly the right lifetime — it is gone when the browser restarts, which is
 * when every session is over anyway.
 */
const CREATED_TABS_KEY = 'createdTabs';

/** Tabs each session last worked on, opened by it or not. Most recent first. */
const RECENT_TABS_KEY = 'recentTabs';

/** Last cursor position per tab, so the pointer survives a navigation. */
const CURSOR_POS_KEY = 'cursorPos';

/**
 * Serialised, one queue per storage key.
 *
 * `chrome.storage` has no read-modify-write, so this shape — read the map, edit
 * one session's entry, write the map back — loses updates whenever two sessions
 * do it at once: the second read happens before the first write lands, and the
 * second write puts back a map that never had the first session's change in it.
 * Three agents working in parallel hit it constantly. The damage here is a
 * session's tab list silently emptying, so its tabs are never cleaned up and it
 * loses track of the tab it was working on.
 *
 * One service worker means one JS context, so a promise chain is a sufficient
 * lock. `windows.js` has the same guard for the same reason, and the failure
 * there is worse — see the comment on `mutate`.
 */
const storageQueues = new Map();

function mutateStored(key, fn) {
  const run = (storageQueues.get(key) || Promise.resolve()).then(async () => {
    const all = (await chrome.storage.session.get(key))[key] || {};
    const result = fn(all);
    await chrome.storage.session.set({ [key]: all });
    return result;
  });
  storageQueues.set(key, run.then(() => {}, () => {}));
  return run;
}

async function remember(key, label, tabId, limit) {
  if (!label) return;
  try {
    await mutateStored(key, (all) => {
      all[label] = [tabId, ...(all[label] || []).filter((id) => id !== tabId)].slice(0, limit);
    });
  } catch {
    // Bookkeeping for a convenience feature. Never fail a real call over it.
  }
}

const rememberCreatedTab = (sessionId, tabId) => remember(CREATED_TABS_KEY, sessionId, tabId, 64);

/**
 * Twice: under the call's group, and under the session as a whole.
 *
 * A call with no `group` used to look only under the session's own name, so an
 * agent that had opened its tabs with `group:"research"` and then made an
 * ordinary call found nothing there, was handed a brand-new blank tab, and
 * snapshotted `about:blank` — then concluded its page had vanished. "My tab"
 * has to mean the last tab this session touched, in whichever of its groups.
 */
const rememberSessionTab = async (args, tabId) => {
  await remember(RECENT_TABS_KEY, recentScopeKey(args), tabId, 16);
  if (args?.group) await remember(RECENT_TABS_KEY, recentScopeKey({ _session: sessionIdOf(args) }), tabId, 16);
};

async function recallTabs(key, label) {
  if (!label) return [];
  try {
    return ((await chrome.storage.session.get(key))[key] || {})[label] || [];
  } catch {
    return [];
  }
}

/**
 * A session's MCP client disconnected, so its task is over — close the tabs it
 * opened.
 *
 * Deliberately not `close_group`: a group can also contain tabs the session
 * adopted from the user, and closing someone's own tab because a background job
 * finished is unforgivable. Only what the session created is cleaned up.
 */
async function endSession(sessionId) {
  if (!sessionId) return 'no session label';

  // Forget the session either way. Its bookkeeping must not outlive it even
  // when auto-close is off, or a later session inherits stale tab ids.
  const forget = async (key) => {
    try {
      // Through the same queue as `remember`: a session ending while two others
      // are opening tabs is the ordinary case, and an unguarded read-modify-write
      // here would erase their bookkeeping on the way out.
      return await mutateStored(key, (all) => {
        if (key === RECENT_TABS_KEY) {
          const ids = [];
          for (const [scope, tabs] of Object.entries(all)) {
            try {
              if (JSON.parse(scope)[0] !== sessionId) continue;
              ids.push(...tabs);
              delete all[scope];
            } catch {
              /* legacy key; handled by the created-tab record instead */
            }
          }
          return ids;
        }
        const ids = all[sessionId] || [];
        delete all[sessionId];
        return ids;
      });
    } catch {
      return [];
    }
  };

  const ids = await forget(CREATED_TABS_KEY);
  const recent = await forget(RECENT_TABS_KEY);

  // The window choice was made for this session and dies with it. Leaving it
  // behind would drop the next session carrying the same name straight into a
  // window nobody chose for it.
  await windows.unbind(sessionId);

  // Take the border off every tab this session touched. Tabs it merely adopted
  // are the ones that matter — those are the user's own, they outlive the
  // session, and a stale "an agent is driving this" border on a tab nothing is
  // driving is worse than no border at all. Tabs about to be closed below cost
  // nothing to clear first.
  for (const tabId of new Set([...ids, ...recent])) {
    agentLabels.delete(tabId);
    frames.sendToTab(tabId, 'agent_frame', { on: false }).catch(() => {});
    // The frame teardown also removes the cursor; forget its position too, or
    // a tab that outlives the session redraws a ghost pointer on its next
    // navigation while another session is driving it.
    mutateStored(CURSOR_POS_KEY, (all) => {
      delete all[tabId];
    }).catch(() => {});
  }

  const settings = await getSettings();
  if (settings.closeTabsOnSessionEnd === false) {
    // Ungroup instead, so a finished session leaves no label behind to block
    // whoever comes next.
    await groups.release(sessionId).catch(() => {});
    return 'auto-close disabled';
  }

  // Only tabs that still exist, and only those still sitting in *some* agent
  // workstream. A tab the user dragged out of its group is one they decided to
  // keep, and it is no longer ours to close. The check is "still grouped"
  // rather than "in this exact group" because one session spreads its tabs over
  // several task-named groups.
  const closable = [];
  for (const tabId of ids) {
    try {
      await chrome.tabs.get(tabId);
      if ((await groups.ownerFor(tabId))?.sessionId === sessionId) closable.push(tabId);
    } catch {
      /* already gone */
    }
  }

  if (closable.length) await chrome.tabs.remove(closable).catch(() => {});

  // Anything still carrying this session's label — a tab dragged out and back,
  // or one whose close failed — is released rather than left owned by a session
  // that no longer exists.
  await groups.release(sessionId).catch(() => {});

  return closable.length
    ? `session "${sessionId}" ended; closed ${closable.length} tab(s) it opened`
    : `session "${sessionId}" ended; nothing to close`;
}

/**
 * The tab this session is already working on.
 *
 * Without this, a call that omits `tabId` targets the globally active tab —
 * whatever the *human* has just clicked on, or whatever another agent last
 * touched. That is how a navigate intended for a fresh page took over a
 * different session's Meta Business Suite tab, mid-task.
 *
 * Tabs the session opened come first, since those are unambiguously its own.
 * Failing that, the last tab it actually worked on — which is what keeps a
 * session on your Gmail tab across several calls even though it never owned it.
 * Both are checked for existence, because either can be closed underneath us.
 */
async function sessionTabId(args) {
  const sessionId = sessionIdOf(args);
  if (!sessionId) return null; // the side panel drives the active tab, as a human expects

  // The window the session was told to work in. Everything below is filtered
  // against it, because a candidate in another window is the wrong-window bug:
  // the session believes it is in the window it chose — that is what
  // `browser_window list` says — while every call lands somewhere else. Both a
  // stale group left behind by a rebind and a tab the user dragged out produce
  // exactly that, and neither is rare.
  //
  // Read rather than ensured: this must never ask "which window?" as a side
  // effect of resolving a tab. A session with no binding yet has no constraint
  // to apply, and `openSessionTab` is where the question belongs.
  const boundWindow = await windows.boundWindowId(sessionId);

  // The last tab this session touched comes first — that is what "my tab"
  // means mid-task — then anything else it has in scope, most recent first.
  // With `group` the scope is that group; without it, every tab the session
  // owns. (`groups.tabsFor` takes `null` for "all of the session's groups".)
  const candidates = [
    ...(await recallTabs(RECENT_TABS_KEY, recentScopeKey(args))),
    ...(await groups.tabsFor(sessionId, args.group || null, boundWindow ?? undefined)),
  ];

  for (const tabId of candidates) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (boundWindow != null && tab.windowId !== boundWindow) continue;
      return tabId;
    } catch {
      /* closed since; try the next */
    }
  }
  return null;
}

/**
 * Get a tab ready to be driven: permission check, content scripts present,
 * capture running. Cheap and idempotent, so every tool calls it.
 */
async function prepareTab(tabId, { needsScripts = true, skipDialogCheck = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const settings = await getSettings();

  // A native JS dialog (alert/confirm/beforeunload) pauses the renderer, so
  // every page-side call would hang until timeout with no explanation. Name it
  // up front, and tell the agent the one call that answers it.
  if (!skipDialogCheck) {
    const dlg = cdp.pendingDialog(tabId);
    if (dlg) {
      throw new Error(
        `a ${dlg.type}() dialog is open: "${fmt.truncate(dlg.message, 120)}" — ` +
          `answer it with browser_act action:"dialog" accept:true (OK/Leave) or accept:false (Cancel/Stay) before continuing`
      );
    }
  }

  const url = tab.url || tab.pendingUrl || '';
  const check = checkUrlAllowed(url, settings);
  if (!check.allowed) throw new Error(check.reason);

  if (needsScripts) await frames.ensureInjected(tabId);
  // Mark the page itself as agent-driven. A tab group's colour only shows in
  // the tab strip, so once you are looking at a page there was nothing to tell
  // an agent's tab from your own. Re-applied here rather than tracked: a
  // navigation throws the old document away along with the border, and this
  // runs on every page-touching call anyway.
  if (needsScripts && settings.showAgentBadge !== false) {
    frames
      .sendToTab(tabId, 'agent_frame', { on: true, label: agentFrameLabel(tabId) })
      .catch(() => {});
  }
  if (settings.useDebugger) {
    recorder.ensureRecording(tabId).catch(() => {});
    // Page must be enabled before a dialog can open, or the opening event —
    // the only record one exists — never fires.
    cdp.enableDomain(tabId, 'Page').catch(() => {});
  }

  return { tab, settings };
}

/** Current page metadata from the main frame, for result headers. */
async function pageMeta(tabId) {
  // A native JS dialog pauses the renderer, so the content script cannot
  // answer — return what the tabs API gives us instead of hanging.
  if (cdp.pendingDialog(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return { url: tab?.url || '', title: tab?.title || '' };
  }
  try {
    return await frames.sendToTab(tabId, 'pageInfo', {});
  } catch {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return { url: tab?.url || '', title: tab?.title || '' };
  }
}

/**
 * Capture a snapshot, run an action, and describe what changed.
 *
 * The before-snapshot is only taken when the tab already has one stored, so the
 * very first action on a tab does not pay for it.
 */
/** A delta is a convenience. Past this, it is cheaper to let the model ask. */
const DELTA_BUDGET_MS = 3000;

async function withDelta(tabId, fn, { quiet = false } = {}) {
  // When the action began, so a navigation that commits during it — however
  // late — is attributable to it via the `navCommits` record.
  const startedAt = Date.now();
  // Tab ids before the action, so one that appears during it can be reported.
  // A click on a `target="_blank"` link otherwise looks like it did nothing:
  // no error, no delta, and the thing the agent wanted sitting in a tab it was
  // never told about. That is most of commerce and search results.
  const before = await tabIdSet();
  // The tab's own URL before the action, so a same-tab navigation counts as a
  // change even when the diff below cannot see it (see the fallback near the
  // return).
  const beforeUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url;

  const result = await fn({ startedAt });
  let changed;

  const opened = await newTabsSince(before);
  // Inside a batch every step but the last runs quiet: its delta would be
  // discarded with the intermediate result, and on a large app building it
  // costs more than the action did. The navigation and new-tab checks below
  // are cheap and stay on — they are what the next step needs to know.
  if (!quiet) changed = await deltaFor(tabId);
  // A same-tab navigation is a real change even when the diff missed it: a
  // cross-origin click lands the new document after the settle window, so the
  // snapshot above runs before its content script is ready and throws, leaving
  // `changed` empty. Without this a click that navigated is reported as "no page
  // change detected" — the exact false negative the settling note exists to
  // avoid, and worst on the most common click of all. The commit record is
  // preferred over comparing the tab's URL: a URL read back here can still be
  // the *old* one for a navigation that has started but not committed, which is
  // how a verified-live fix regressed into the same false negative it fixed.
  if (!changed) {
    const nav = navSince(tabId, startedAt);
    if (nav) {
      changed = `navigated to ${fmt.shortUrl(nav.url)}`;
    } else {
      const after = await chrome.tabs.get(tabId).catch(() => null);
      const afterUrl = after?.pendingUrl || after?.url;
      if (afterUrl && beforeUrl && afterUrl !== beforeUrl) {
        changed = `navigated to ${fmt.shortUrl(afterUrl)}`;
      }
    }
  }
  if (opened.length) {
    const list = opened.map((t) => `tab ${t.id} (${fmt.shortUrl(t.url || t.pendingUrl || '')})`).join(', ');
    const note = `opened ${list} — the click targeted a new tab; pass that tabId to act on it`;
    changed = changed ? `${note}\n${changed}` : note;
  }

  return { result, changed, startedAt };
}

/** The interactive-tree diff since the last stored snapshot, or undefined. */
async function deltaFor(tabId) {
  try {
    // Must use the same shape as a plain browser_snapshot: this both reads and
    // replaces the stored baseline, and a baseline captured under a different
    // budget or scope would make the next mode:"diff" report the mismatch as
    // page changes. Only the diff is returned, so the full read costs nothing
    // in tokens.
    const settings = await getSettings();

    // On a large app the tree can take longer to build than the action itself
    // took to perform — a click in Gmail should not cost 45 seconds because we
    // volunteered a diff nobody asked for. Race it and drop it if slow.
    const { text } = await Promise.race([
      snapshotText(tabId, { mode: 'interactive', maxChars: settings.maxSnapshotChars }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('delta budget exceeded')), DELTA_BUDGET_MS)),
    ]);

    const diff = fmt.diffSnapshot(tabId, text);
    if (!diff.unchanged && !diff.isFirst) {
      return diff.replaced ? 'page changed substantially — snapshot for detail' : `changes:\n${diff.text}`;
    }
  } catch (err) {
    // Either the page is mid-navigation, or it is too big to diff cheaply.
    // Say so for the latter, so the omission is not mistaken for "nothing
    // changed". Never fail the action over a diff.
    if (/delta budget/.test(err.message)) {
      return 'page too large to diff quickly — call browser_snapshot if you need to see the result';
    }
  }
  return undefined;
}

/**
 * Refuse to change what is on screen in a window a human is using.
 *
 * Relocating the tab is the answer almost every time, and this is what happens
 * when it did not work. The tempting fallback is to activate the tab where it
 * is — the call succeeds, the agent gets on with it — and that is precisely the
 * failure worth refusing over: the tab in front of someone can change while they
 * are typing into it, which sends the next keystrokes of whatever they were
 * writing, password included, to a page an agent chose.
 *
 * A window that holds only agents — the shared agent window, or one opened for
 * this session — is fine: nobody is typing into it, so switching its visible
 * tab is invisible. A stopped call is recoverable and says what to do. A stolen
 * keystroke is not recoverable and says nothing at all. `soloWindow: false`
 * turns the whole thing off for anyone who wants an agent in their own window
 * on purpose.
 */
async function assertAgentWindow(tabId, label, what) {
  if (!label) return; // the side panel is a human, driving their own window
  const settings = await getSettings();
  if (settings.soloWindow === false) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active) return;

  const agentWindow = await windows.agentWindowIdFor(label);
  if (agentWindow === tab.windowId) return;

  const err = new Error(
    `refusing to ${what} tab ${tabId}: window ${tab.windowId} is one the user is working in, and bringing a tab ` +
      'to the front there changes what they are looking at — possibly mid-keystroke. ' +
      'Give this session a window of its own with browser_window action:"new", which moves its tabs across, ' +
      'or pass an explicit tabId for a tab it already owns.'
  );
  err.obRefuse = true;
  throw err;
}

/**
 * Make a tab the visible one in its window — and, only if the user has opted
 * in, raise that window.
 *
 * This is the single place a window can be brought to the front from an agent
 * call, and by default it never is. `select` and `focus` used to focus the
 * window as a matter of course; in practice that was the agent window jumping
 * over whatever the person was reading. Showing a human a tab is a thing the
 * human does — the side panel's tab rows raise the window on click — not a
 * thing an agent does to them. `test/run.mjs` asserts the guard stays.
 */
async function showTab(tabId, settings) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (settings.raiseWindowOnSelect === true) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return `tab ${tabId} is now showing and its window was brought to the front (raiseWindowOnSelect is on)`;
  }
  const wins = await windows.listWindows().catch(() => []);
  const win = wins.find((w) => w.windowId === tab.windowId) || { windowId: tab.windowId };
  return `tab ${tabId} is now the visible tab in ${windows.windowName(win)}; the window was not raised`;
}

/** Ids of every open tab, for spotting ones an action creates. */
async function tabIdSet() {
  try {
    return new Set((await chrome.tabs.query({})).map((t) => t.id));
  } catch {
    return null; // never let bookkeeping break an action
  }
}

async function newTabsSince(before) {
  if (!before) return [];
  try {
    return (await chrome.tabs.query({})).filter((t) => !before.has(t.id));
  } catch {
    return [];
  }
}

/** Build the merged snapshot text for a tab across all its frames. */
async function snapshotText(tabId, opts) {
  const { mode = 'interactive', selector, viewportOnly, maxChars = 8000, includeFrames = true } = opts;

  // An outline is a different rendering of the interactive tree, not a
  // different walk — so the page-side cache serves both from one build.
  const wire = mode === 'outline' ? 'interactive' : mode;
  const { frames: results, failed } = await frames.broadcast(
    tabId,
    'snapshot',
    { mode: wire, selector, viewportOnly, maxChars },
    { includeSubframes: includeFrames }
  );

  if (!results.length) {
    throw new Error(
      failed[0]?.error || 'could not read the page — it may still be loading. Try browser_wait for:"load".'
    );
  }

  const main = results.find((r) => r.frame.index === 0) || results[0];
  if (main.result.error) throw new Error(main.result.error);

  const sections = [];
  let budget = maxChars;
  let refCount = 0;
  // Two independent ways to lose content: the page was too big to walk, or the
  // walked tree was too big to render within maxChars. Both must be reported —
  // a partial page that looks complete is worse than an obvious error.
  let truncated = results.some((r) => r.result.truncated);

  for (const { frame, result } of results) {
    if (result.error || budget <= 0) {
      if (budget <= 0) truncated = true;
      continue;
    }

    if (mode === 'text') {
      if (result.text) sections.push(frame.index === 0 ? result.text : `\n--- iframe ${frame.index} ---\n${result.text}`);
      continue;
    }

    const nodes = frames.qualifyRefs(result.nodes || [], frame.index);
    if (!nodes.length) continue;

    const rendered =
      mode === 'outline' ? fmt.renderOutline(nodes, { maxChars: budget }) : fmt.renderTree(nodes, { maxChars: budget });
    refCount += rendered.refCount || 0;
    if (rendered.truncated) truncated = true;
    if (!rendered.text) continue;

    budget -= rendered.text.length;
    sections.push(
      frame.index === 0
        ? rendered.text
        : `\n[iframe ${frame.index}] ${fmt.shortUrl(frame.url)}\n${indent(rendered.text)}`
    );
  }

  return { text: sections.join('\n'), truncated, refCount };
}

function indent(text, pad = '  ') {
  return text.split('\n').map((l) => pad + l).join('\n');
}

/** Give the page a moment to react before we look at the result of an action. */
function settle(ms = 250) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// Tool handlers
// -----------------------------------------------------------------------------

const HANDLERS = {
  /**
   * Internal, sent by the hub when an MCP client disconnects. Not an MCP tool —
   * the server rejects names it does not publish, so this cannot be invoked by
   * a model, only by the hub that observed the socket close.
   */
  __session_end: (args) => endSession(args._session),

  /**
   * Internal: this browser's windows, for the hub's cross-browser chooser.
   *
   * Choosing a browser and then choosing a window is two questions for one
   * decision — nobody thinks "the work browser, then its second window", they
   * think "that window over there". So the hub asks every browser for this and
   * offers one combined list, where picking a window names its browser
   * implicitly. Deliberately small: enough for a human to recognise a window,
   * and nothing more, since this is paid for once per browser per chooser.
   */
  async __window_list() {
    const wins = await windows.listWindows();
    return {
      windows: wins.map((w) => ({
        windowId: w.windowId,
        focused: w.focused,
        // The role, so the hub's chooser can say "the agent window" rather than
        // leaving a human to guess which id is which.
        agent: !!w.agent,
        own: w.own || null,
        tabs: w.tabs.length,
        titles: w.tabs
          .slice(0, 3)
          .map((t) => (t.title || t.url || '').replace(/\s+/g, ' ').slice(0, 28))
          .filter(Boolean),
      })),
    };
  },

  /**
   * Internal, like `__session_end`: every workstream label the browser still
   * knows about.
   *
   * The hub allocates session names, but its record of which are taken is
   * process memory — so a hub owner that restarts starts counting from the top
   * of the list again and hands the first name straight back out. If the
   * previous holder's tab group is still on screen (it exited without a clean
   * socket close, or auto-close is off) the new session lands in it, inheriting
   * a stranger's tabs. The browser is the only durable record of what is in
   * use, so the hub asks it on connect.
   *
   * Storage bookkeeping is included alongside live groups: a session whose
   * group the user dissolved by hand still has tabs it opened, and its name is
   * still spoken for.
   */
  async __session_list() {
    const names = new Set((await groups.list()).map((g) => g.sessionId).filter(Boolean));
    for (const key of [CREATED_TABS_KEY]) {
      try {
        for (const label of Object.keys((await chrome.storage.session.get(key))[key] || {})) {
          names.add(label);
        }
      } catch {
        /* bookkeeping only; live groups are the important half */
      }
    }
    return { names: [...names] };
  },

  /**
   * Internal, developer installs only: reload the extension so edits under
   * `extension/` take effect. Not an MCP tool — the server never publishes it,
   * so a model cannot call it; a developer's own script on the hub can, which
   * replaces the chrome://extensions round trip that every edit used to need.
   * A store install has an `update_url` and refuses; there is nothing to
   * reload from disk there.
   */
  async __reload() {
    if (chrome.runtime.getManifest().update_url) {
      throw new Error('reload is only available for an unpacked (developer) install');
    }
    setTimeout(() => chrome.runtime.reload(), 150);
    return 'reloading the extension';
  },

  // ---------------------------------------------------------------- tabs ----
  async browser_tabs(args) {
    const action = args.action || 'list';

    switch (action) {
      case 'list': {
        // An agent is shown its own tabs in full and everyone else as counts;
        // the side panel (no session) and an explicit `windowId` get a window
        // in full. See `fmt.renderTabs` for why.
        const sessionId = sessionIdOf(args);
        const tabs = await chrome.tabs.query(args.windowId != null ? { windowId: args.windowId } : {});
        const [wins, agentGroups, bound] = await Promise.all([
          windows.listWindows(),
          groups.list(),
          sessionId ? windows.boundWindowId(sessionId) : null,
        ]);
        return fmt.renderTabs(tabs, wins, agentGroups, { sessionId, boundWindowId: bound, windowId: args.windowId ?? null });
      }

      case 'new': {
        const url = normalizeUrl(args.url || 'about:blank');
        const settings = await getSettings();
        if (url !== 'about:blank') {
          const check = checkUrlAllowed(url, settings);
          if (!check.allowed) throw new Error(check.reason);
        }
        // An explicit windowId wins; otherwise the session's own window, which
        // is the whole point of binding one. Asking here — before the tab
        // exists — is what stops a "which window?" question from arriving after
        // a tab has already been opened in the wrong one.
        const sessionId = sessionIdOf(args);
        const windowId = args.windowId ?? (await windows.ensureWindow(sessionId, settings)) ?? undefined;

        // Background by default: opening ten tabs should not yank focus ten times.
        // Placement is verified rather than assumed — see `openInWindow`, which
        // also covers the case where the session's window was made moments ago
        // and is not yet ready to be created into.
        // Opening in the foreground is this session's business inside its own
        // window and nobody else's anywhere else. Downgraded rather than
        // refused — the tab is still opened, it just does not jump in front of
        // whoever is there — and said out loud, because silently ignoring what
        // was asked for is its own kind of wrong.
        let active = args.background === false;
        let downgraded = '';
        if (active && sessionId && settings.soloWindow !== false) {
          if ((await windows.agentWindowIdFor(sessionId)) !== windowId) {
            active = false;
            downgraded = ` (opened in the background: window ${windowId} is one the user is working in)`;
          }
        }

        const tab = await openInWindow({ url, active }, windowId);
        // Group before waiting for load, so the tab is visibly labelled the
        // moment it appears rather than after the page settles. An explicit
        // `group` splits the session's own tabs into a named sub-group.
        let grouped = '';
        if (sessionId && settings.groupTabs !== false) {
          const ok = await groups.assign(tab.id, sessionId, workstreamOf(args), clientOf(args)).catch(() => null);
          if (ok) grouped = args.group ? ` in your group "${args.group}"` : ' (yours)';
        }
        // Recorded against the *session*, not the group. An agent is told to
        // use one group per task, so a session routinely spreads its tabs
        // across several named groups — keying this on the group would mean
        // cleanup almost never matched anything.
        await rememberCreatedTab(sessionId, tab.id);
        await rememberSessionTab(args, tab.id);

        if (url !== 'about:blank') await waitForLoad(tab.id, 15000).catch(() => {});
        const meta = await pageMeta(tab.id).catch(() => ({ url }));
        return `opened tab ${tab.id}${grouped}${downgraded}\n${fmt.pageHeader(meta, tab.id)}`;
      }

      case 'group': {
        if (!args.group) throw new Error('pass `group` — the sub-group label to put these tabs under.');
        if (!groups.isSupported()) throw new Error('this Chrome build does not support tab groups');
        const sessionId = sessionIdOf(args);
        if (!sessionId) throw new Error('grouping tabs through MCP requires a session identity.');
        const ids = args.tabIds?.length ? args.tabIds : [await resolveTab(args)];
        await assertNotForeign(ids, sessionId);
        for (const id of ids) await claimTab(id, sessionId, args.group, clientOf(args));
        const done = await groups.assignMany(ids, sessionId, args.group, clientOf(args));
        return `grouped ${done.length} tab(s) into your group "${args.group}" (shown as "${groups.titleFor(sessionId, args.group)}")`;
      }

      case 'ungroup': {
        if (!args.group) throw new Error('pass `group` — the sub-group to release.');
        const ok = await groups.release(sessionIdOf(args), args.group);
        return ok ? `released your group "${args.group}" (tabs stay open)` : `you have no group named "${args.group}"`;
      }

      case 'close_group': {
        if (!args.group) throw new Error('pass `group` — the sub-group to close.');
        const n = await groups.closeWorkstream(sessionIdOf(args), args.group);
        return n ? `closed ${n} tab(s) in your group "${args.group}"` : `you have no group named "${args.group}"`;
      }

      case 'close': {
        // Explicit ids are checked as a batch before anything closes: a model
        // passing ids it read off a listing must not be able to close another
        // agent's tabs — or the user's — one call at a time.
        const ids = args.tabIds?.length ? args.tabIds : [await resolveTab(args, { create: false })];
        await assertNotForeign(ids, sessionIdOf(args));
        await chrome.tabs.remove(ids);
        for (const id of ids) fmt.clearSnapshot(id);
        return `closed tab(s): ${ids.join(', ')}`;
      }

      case 'select': {
        const tabId = await resolveTab(args, { create: false });
        // Asking for a tab to be shown is not authority to change what is on
        // screen in a window a human is using. `resolveTab` will normally have
        // moved this tab home already, so this only bites when that failed.
        await assertAgentWindow(tabId, sessionIdOf(args), 'select');
        const settings = await getSettings();
        const shown = await showTab(tabId, settings);
        return `${shown}\n${fmt.pageHeader(await pageMeta(tabId), tabId)}`;
      }

      case 'reload': {
        const ids = args.tabIds?.length ? args.tabIds : [await resolveTab(args, { create: false })];
        await assertNotForeign(ids, sessionIdOf(args));
        await Promise.all(ids.map((id) => chrome.tabs.reload(id)));
        await Promise.all(ids.map((id) => waitForLoad(id, 20000).catch(() => {})));
        for (const id of ids) fmt.clearSnapshot(id);
        return `reloaded tab(s): ${ids.join(', ')}`;
      }

      case 'duplicate': {
        const tabId = await resolveTab(args, { create: false });
        // Unfocused, and claimed: a duplicate is a new tab of this session's,
        // and one that popped to the front would be the one interruption left.
        const tab = await chrome.tabs.duplicate(tabId);
        if (tab?.id != null) {
          await chrome.tabs.update(tab.id, { active: false }).catch(() => {});
          await claimTab(tab.id, sessionIdOf(args), workstreamOf(args), clientOf(args)).catch(() => {});
          await rememberCreatedTab(sessionIdOf(args), tab.id);
        }
        return `duplicated tab ${tabId} as ${tab.id}`;
      }

      default:
        throw new Error(`unknown tabs action: ${action}`);
    }
  },

  // ------------------------------------------------------------ navigate ----
  async browser_navigate(args) {
    const tabId = await resolveTab(args);

    // A dialog already open on this tab would make the navigation hang; a
    // beforeunload raised by the navigation would stall it with no record.
    // Enable Page first so either one is seen, and refuse to navigate into one.
    const preDlg = cdp.pendingDialog(tabId);
    if (preDlg) {
      throw new Error(
        `a ${preDlg.type}() dialog is open: "${fmt.truncate(preDlg.message, 120)}" — ` +
          `answer it with browser_act action:"dialog" accept:true (OK/Leave) or accept:false (Cancel/Stay) before navigating`
      );
    }
    cdp.enableDomain(tabId, 'Page').catch(() => {});

    const target = String(args.url || '').trim();
    const timeout = args.timeout ?? 30_000;

    if (target === 'back' || target === 'forward') {
      await chrome.tabs[target === 'back' ? 'goBack' : 'goForward'](tabId);
    } else if (target === 'reload') {
      await chrome.tabs.reload(tabId);
    } else {
      const url = normalizeUrl(target);
      const settings = await getSettings();
      const check = checkUrlAllowed(url, settings);
      if (!check.allowed) throw new Error(check.reason);
      await chrome.tabs.update(tabId, { url });
    }

    fmt.clearSnapshot(tabId);
    // The screenshot mapping belonged to the page we are leaving; drop it so a
    // stray space:"image" click cannot convert against the old page. The
    // freshness check in imageToViewport is the backstop, this is the tidy path.
    clearCaptureGeometry(tabId);
    clearMarks(tabId);

    const waitUntil = args.waitUntil || 'load';
    if (waitUntil !== 'none') {
      await waitForLoad(tabId, timeout).catch((err) => {
        // A load timeout is worth reporting but not worth throwing away the
        // page we did get — many sites never fully quiesce.
        logActivity({ tool: 'browser_navigate', ok: true, note: err.message });
      });
      if (waitUntil === 'networkidle') await waitForNetworkIdle(tabId, Math.min(timeout, 10_000));
    }

    await prepareTab(tabId);
    const meta = await pageMeta(tabId);

    const notes = [];
    if (meta.hasCaptcha) {
      notes.push('NOTE: a CAPTCHA is present on this page. It must be solved by a human — this tool cannot and will not bypass it.');
    }
    // The page tried to keep us. Answering that is the point of the setting,
    // but it discarded whatever the old page held unsaved, so say so.
    const left = cdp.takeAutoDismissed(tabId);
    if (left) {
      notes.push(
        `NOTE: answered ${left === 1 ? 'a' : `${left}`} "Leave site?" prompt${left === 1 ? '' : 's'} to get here — ` +
          'the previous page had unsaved changes and they were discarded. ' +
          'Set autoConfirmLeave:false in the extension options to be asked instead.'
      );
    }

    return [fmt.pageHeader(meta, tabId), ...notes].join('\n');
  },

  // ------------------------------------------------------------ snapshot ----
  async browser_snapshot(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId);

    const settings = await getSettings();
    const mode = args.mode || 'interactive';
    const maxChars = args.maxChars ?? settings.maxSnapshotChars;

    if (args.frames !== false) await frames.refreshFrameOffsets(tabId);

    const { text, truncated, refCount } = await snapshotText(tabId, {
      mode: mode === 'diff' ? 'interactive' : mode,
      selector: args.selector,
      viewportOnly: args.viewportOnly,
      maxChars,
      includeFrames: args.frames !== false,
    });

    const meta = await pageMeta(tabId);
    const header = fmt.pageHeader(meta, tabId);

    if (mode === 'diff') {
      const diff = fmt.diffSnapshot(tabId, text);
      return `${header}\n${diff.text}`;
    }

    // The cheap first look at a big page: where things are and how to scope to
    // them, so the next call reads one region instead of paging through all.
    if (mode === 'outline') {
      const body = text.trim()
        ? text
        : '(no landmarks — this page has no structure to outline; use mode:"interactive", viewportOnly:true)';
      const hint =
        `${refCount} control${refCount === 1 ? '' : 's'} on the page · next: browser_snapshot selector:"<one of the selectors above>", ` +
        'or viewportOnly:true for what is on screen';
      return [header, body, hint].join('\n');
    }

    // Only a full-page interactive read is a valid diff baseline. Storing a
    // scoped or text-mode read would make the next mode:"diff" report the
    // difference in scope as though the page had changed.
    if (mode === 'interactive' && !args.selector && !args.viewportOnly) {
      fmt.storeSnapshot(tabId, text);
    }

    const notes = [];
    if (meta.hasCaptcha) notes.push('NOTE: a CAPTCHA is present — a human must solve it.');

    if (meta.dialog) {
      const name = meta.dialog.name ? `"${meta.dialog.name}"` : 'unnamed';
      notes.push(
        `NOTE: a${meta.dialog.modal ? ' modal' : 'n open'} dialog is present (${name}). ` +
          `It is usually what you want to act on — scope to it with selector:${JSON.stringify(meta.dialog.selector)}.`
      );
    }

    if (truncated) {
      notes.push(
        `NOTE: output truncated — this page is larger than the ${maxChars}-character budget, so content below is missing. ` +
          'Scope with selector:"<css>", or raise maxChars. Anything late in the page (dialogs, footers, modals) is the first to be cut.'
      );
      // Save the round trip the note would otherwise cost: a truncated read of
      // the whole page carries the whole page's outline, so the next call can
      // scope to the right region straight away. A scoped read is already
      // scoped; the outline would just repeat the choice.
      if (!args.selector) {
        const outline = await snapshotText(tabId, {
          mode: 'outline',
          maxChars: 1500,
          includeFrames: args.frames !== false,
        }).catch(() => null);
        if (outline?.text?.trim()) {
          notes.push(`Outline of the whole page — pick a selector and re-snapshot:\n${outline.text}`);
        }
      }
    }

    if (!text.trim()) {
      notes.push(
        'The page produced an empty tree. It may still be rendering (try browser_wait), or its content may be inside a canvas — try browser_screenshot.'
      );
    }

    return [header, text, ...notes].filter(Boolean).join('\n');
  },

  // ---------------------------------------------------------------- find ----
  async browser_find(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId);

    const { frames: results } = await frames.broadcast(tabId, 'find', {
      query: args.query,
      limit: args.limit ?? 10,
      interactiveOnly: args.interactiveOnly !== false,
      selector: args.selector,
    });

    const all = [];
    let truncated = false;
    let scoped = 0;
    for (const { frame, result } of results) {
      // A frame that does not contain the selector simply has nothing to say.
      if (result.error) continue;
      scoped++;
      if (result.truncated) truncated = true;
      for (const hit of result.results || []) {
        all.push({ ...hit, ref: frames.formatRef(frame.index, hit.ref), frameIndex: frame.index });
      }
    }

    // But if *no* frame contained it, the search never ran, and saying "no
    // matches" would send the agent looking for a different query instead of a
    // different selector.
    if (args.selector && !scoped) {
      throw new Error(
        `selector not found in any frame: ${args.selector} — take a browser_snapshot to see the current structure, ` +
          'or drop the selector to search the whole page'
      );
    }

    all.sort((a, b) => b.score - a.score);

    const top = all.slice(0, args.limit ?? 10);
    const lines = [
      fmt.pageHeader(await pageMeta(tabId), tabId),
      fmt.renderFindResults(top, args.query),
    ];

    // Without this, a search that missed because the page was too big to read
    // in full is indistinguishable from one that genuinely found nothing.
    if (truncated) {
      lines.push(
        'NOTE: this page is large enough that part of it was not read, so there may be matches beyond what is listed. ' +
          'Re-run with selector:"<css>" scoped to the region you care about — a dialog selector from browser_info is ' +
          'usually the right one.'
      );
    }

    return lines.join('\n');
  },

  // ----------------------------------------------------------------- act ----
  async browser_act(args) {
    const tabId = await resolveTab(args);
    const action = args.action;

    // Answer a native JS dialog. This must not trip the pending-dialog precheck
    // in prepareTab, and it needs no coordinates, scripts, or foregrounding —
    // the renderer is paused by the dialog anyway.
    if (action === 'dialog') {
      if (typeof args.accept !== 'boolean') {
        throw new Error('action:"dialog" needs accept: true (OK/Leave) or accept: false (Cancel/Stay); pass promptText for prompt() dialogs.');
      }
      await prepareTab(tabId, { needsScripts: false, skipDialogCheck: true });
      await cdp.handleDialog(tabId, { accept: args.accept, promptText: args.promptText });
      const meta = await pageMeta(tabId).catch(() => ({}));
      return fmt.actionResult(`dialog ${args.accept ? 'accepted' : 'dismissed'}`, { meta, tabId });
    }

    // Guided "Sign in with Google": enumerate accounts and stop for the human to
    // choose, or select an already-chosen account; never a password, never an
    // unconfirmed consent. All the gating is in oauth.googleDecision.
    if (action === 'google_login') {
      return googleLogin(tabId, args);
    }

    const { settings } = await prepareTab(tabId);

    // These are handled entirely in the page; no trusted event needed.
    const IN_PAGE = ['focus', 'blur', 'scroll_to', 'select_option', 'check', 'uncheck', 'clear', 'submit'];
    if (IN_PAGE.includes(action)) {
      const route = args.ref ? await frames.routeRef(tabId, args.ref) : { frameId: 0, localRef: undefined };
      let expected = null;
      const { changed } = await withDelta(
        tabId,
        async ({ startedAt }) => {
          const r = await frames.sendToFrame(tabId, route.frameId, 'act', {
            action,
            ref: route.localRef,
            value: args.value,
          });
          if (r.error) throw new Error(r.error);
          await awaitSettled(tabId, startedAt);
          if (args.expect) expected = await expectAfter(tabId, args.expect);
          return r;
        },
        { quiet: args._quiet }
      );
      return finishAction(`${action} ok`, { changed, expected, meta: await pageMeta(tabId), tabId });
    }

    if (action === 'scroll') {
      return scrollAction(tabId, args);
    }

    // CDP input is addressed to a render target, not to the globally focused
    // Chrome window. Do not activate the tab or raise its window here: doing so
    // interrupts the person using the browser and is unnecessary for the same
    // direct Input.dispatch* path used by Claude-in-Chrome. Outcome reporting
    // below says when the page did not produce a verifiable change.
    const target = await locateTarget(tabId, args);

    if (target.obstructed && !args.force) {
      throw new Error(
        `${args.ref || 'target'} is covered by ${target.obstructedBy}. ` +
          `Dismiss the overlay (cookie banner, modal, sticky header) first, or pass force:true to click through it.`
      );
    }
    if (target.disabled && !args.force) {
      throw new Error(`${args.ref} is disabled. Pass force:true to click it anyway.`);
    }

    if (settings.highlightActions && args.ref) {
      const route = await frames.routeRef(tabId, args.ref);
      frames.sendToFrame(tabId, route.frameId, 'highlight', { ref: route.localRef, label: action }).catch(() => {});
    }

    // Send the pointer to the same top-level point the trusted click will land
    // on. Hover leaves no mark of its own, so it moves the cursor without a
    // ripple; every other pointer action rings on contact. This is the only
    // feedback a coordinate click gets, since there is no element to outline.
    showCursor(tabId, settings, {
      x: target.point.x,
      y: target.point.y,
      action,
      label: cursorLabel(action, target.name),
      click: action !== 'hover',
    });

    let expected = null;
    const { changed, result: settled } = await withDelta(tabId, async ({ startedAt }) => {
      const { x, y } = target.point;
      const opts = { modifiers: args.modifiers || [] };

      switch (action) {
        case 'click':
          await cdp.click(tabId, x, y, opts);
          break;
        case 'double_click':
          await cdp.doubleClick(tabId, x, y, opts);
          break;
        case 'right_click':
          await cdp.click(tabId, x, y, { ...opts, button: 'right' });
          break;
        case 'middle_click':
          await cdp.click(tabId, x, y, { ...opts, button: 'middle' });
          break;
        case 'hover':
          await cdp.hover(tabId, x, y, opts);
          break;
        case 'drag': {
          const dest = args.toRef
            ? (await locateTarget(tabId, { ref: args.toRef })).point
            : args.space === 'image' && args.to
              ? await imageToViewport(tabId, args.to)
              : { x: args.to?.[0], y: args.to?.[1] };
          if (dest.x == null) throw new Error('drag needs a destination: pass `to` [x,y] or `toRef`.');
          // Carry the pointer to where it is being dropped, then ring there.
          showCursor(tabId, settings, { x: dest.x, y: dest.y, action: 'drop', label: 'drop', click: true });
          await cdp.drag(tabId, { x, y }, dest, opts);
          break;
        }
        default:
          throw new Error(`unknown action: ${action}`);
      }
      // Wait for the page to react — or to prove it will not — instead of a
      // fixed sleep. Hover gets a shorter idle window: a menu that is going to
      // open does so at once, and no change is its normal outcome.
      const settled = await awaitSettled(tabId, startedAt, action === 'hover' ? { idle: 100, max: 300 } : {});
      if (args.expect) expected = await expectAfter(tabId, args.expect);
      return settled;
    }, { quiet: args._quiet });

    const label = args.ref
      ? `dispatched ${action} ${args.ref}${target.name ? ` ("${fmt.truncate(target.name, 40)}")` : ''}`
      : `dispatched ${action} at ${Math.round(target.point.x)},${Math.round(target.point.y)}`;

    // A click that changed nothing is ambiguous, and the possibilities need
    // opposite responses: wait, read the text, or try something else.
    // "Nothing" includes a delta that is only the focus ring moving, which is
    // what a click on a dead button produces. Hover is excluded — no change is
    // its normal outcome. The settle watched the page while the click landed,
    // so its verdict says which case this is; no second probe is needed.
    //
    // A native dialog is checked first: it pauses the renderer, and it is the
    // one reaction the settle cannot see.
    const dlg = cdp.pendingDialog(tabId);
    const nothingHappened = !changed || fmt.isFocusOnly(changed);
    const note = nothingHappened && action !== 'hover' && !dlg && !args._quiet ? settleVerdict(settled) : null;

    let label2 = label;
    if (dlg) {
      // The action itself opened a native dialog. The renderer is paused now;
      // say what it is and how to answer it instead of leaving the next call
      // to hang on it.
      label2 += `\nNOTE: a ${dlg.type}() dialog is open: "${fmt.truncate(dlg.message, 120)}" — ` +
        `answer it with browser_act action:"dialog" accept:true (OK/Leave) or accept:false (Cancel/Stay)`;
    }

    // The focus churn is replaced rather than appended: it is noise, and the
    // note carries the one fact worth having. pageMeta is dialog-aware and
    // falls back to tab metadata when the renderer is paused.
    return finishAction(label2, { changed: note || changed, expected, meta: await pageMeta(tabId), tabId });
  },

  // --------------------------------------------------------------- input ----
  async browser_input(args) {
    const tabId = await resolveTab(args);
    const { settings } = await prepareTab(tabId);

    const summary = [];

    let expected = null;
    let settled = null;
    const { changed } = await withDelta(tabId, async ({ startedAt }) => {
      // 1. Batch field fill. Grouped by frame so each frame gets one round trip.
      if (args.fields?.length) {
        const byFrame = new Map();
        for (const field of args.fields) {
          const route = await frames.routeRef(tabId, field.ref);
          const list = byFrame.get(route.frameId) || [];
          list.push({ ...field, ref: route.localRef, publicRef: field.ref });
          byFrame.set(route.frameId, list);
        }

        for (const [frameId, fields] of byFrame) {
          const { results } = await frames.sendToFrame(tabId, frameId, 'fill', { fields });
          results.forEach((r, i) => {
            const ref = fields[i].publicRef;
            if (r.ok) summary.push(`${ref} = ${JSON.stringify(r.value)}`);
            else summary.push(`${ref} FAILED: ${r.error}`);
          });
        }

        const failures = summary.filter((s) => s.includes('FAILED'));
        if (failures.length === args.fields.length) {
          throw new Error(`every field failed:\n${failures.join('\n')}`);
        }
      }

      // 2. Free-text typing, as trusted keystrokes.
      if (args.text != null) {
        if (args.ref) {
          const route = await frames.routeRef(tabId, args.ref);
          const target = await frames.sendToFrame(tabId, route.frameId, 'resolve', { ref: route.localRef });
          if (target.error) throw new Error(target.error);
          // Click to focus rather than calling .focus(), so that the page sees
          // the same event sequence a user would produce.
          await cdp.click(tabId, target.point.x, target.point.y);
          await settle(80);
          if (settings.highlightActions) {
            frames.sendToFrame(tabId, route.frameId, 'highlight', { ref: route.localRef, label: 'type' }).catch(() => {});
          }
          showCursor(tabId, settings, { x: target.point.x, y: target.point.y, action: 'type', label: 'type', click: true });
        }
        await cdp.typeText(tabId, args.text, { delay: args.delay ?? 0, newline: args.newline });

        // Confirm the text actually landed. Keystrokes go to whatever has
        // focus, so if focusing failed they are silently swallowed and the call
        // still looks like it worked — which is worse than an error, because
        // the caller carries on believing the field is filled.
        let landed = null;
        if (args.ref) {
          const route = await frames.routeRef(tabId, args.ref);
          landed = await frames
            .sendToFrame(tabId, route.frameId, 'readValue', { ref: route.localRef })
            .catch(() => null);
        }

        if (landed && landed.value !== undefined && !valueContains(landed.value, args.text)) {
          throw new Error(
            `typing did not reach ${args.ref} — it now reads ${JSON.stringify(fmt.truncate(landed.value, 60))}. ` +
              'The field may be read-only, or another element took focus. Try browser_act focus first, or pass force:true.'
          );
        }

        summary.push(`typed ${JSON.stringify(fmt.truncate(args.text, 60))}`);
      }

      // 3. Explicit key presses.
      if (args.keys?.length) {
        if (args.ref && args.text == null) {
          // `text` clicks its ref to focus; keys have to as well, or a chord
          // goes wherever focus happened to already be.
          const route = await frames.routeRef(tabId, args.ref);
          const target = await frames.sendToFrame(tabId, route.frameId, 'resolve', { ref: route.localRef });
          if (target.error) throw new Error(target.error);
          await cdp.click(tabId, target.point.x, target.point.y);
          await settle(80);
        } else if (!args.ref && args.text == null && !args.fields?.length) {
          // Nothing in this call established focus. Dispatching blind is how
          // "Control+a" ends up selecting the whole document instead of a
          // field — which reports success and then quietly corrupts whatever
          // the caller does next. Refuse and name the problem instead.
          const active = await frames.sendToFrame(tabId, 0, 'activeElement', {}).catch(() => null);
          if (active && active.focused === false) {
            throw new Error(
              `nothing has focus (activeElement is <${active.tag || 'body'}>), so ` +
                `${args.keys.join(', ')} would go to the page rather than a field. ` +
                'Pass ref: the field you mean — keys now focus it first.'
            );
          }
        }

        for (const key of args.keys) {
          await cdp.pressKey(tabId, key);
          await settle(40);
          summary.push(`dispatched ${key}`);
        }
      }

      if (args.submit) {
        await cdp.pressKey(tabId, 'Enter');
        summary.push('dispatched Enter');
      }

      // Typing fires input events the tree counts as activity, so a field
      // that took the text settles the moment it goes quiet — typically well
      // under the 300ms this used to sleep unconditionally.
      settled = await awaitSettled(tabId, startedAt);
      if (args.expect) expected = await expectAfter(tabId, args.expect);
    }, { quiet: args._quiet });

    if (!summary.length) {
      throw new Error('nothing to do — pass `fields`, `text`, or `keys`.');
    }

    let done = summary.join('\n');
    if (!changed && settled?.navigated) {
      done += `\nnavigated to ${fmt.shortUrl(settled.navigated.url)}`;
    } else if (
      !changed && !settled?.mutated && !args._quiet &&
      ((args.text != null && !args.ref) || args.keys?.length || args.submit)
    ) {
      done += '\nUNVERIFIED: the keystrokes were dispatched, but no target value or page change could be read back. ' +
        'Pass ref when typing, or verify the expected result with browser_wait/snapshot.';
    }

    // macOS foot-gun: Ctrl+letter is not the editing accelerator here — Ctrl+A
    // is caret-to-line-start, so a model reaching for select-all/bold/copy with
    // Control gets a silent no-op. When that is exactly what just happened
    // (nothing changed, on macOS, a Control+letter was sent), name it and point
    // at the fix, rather than leaving the caller to rediscover it click by click.
    if (cdp.IS_MAC && !changed && !settled?.mutated && args.keys?.length) {
      const ctrlAccel = args.keys.find((k) => /^(control|ctrl)\+[a-z]$/i.test(String(k).trim()));
      if (ctrlAccel) {
        const asMod = String(ctrlAccel).trim().replace(/^(control|ctrl)/i, 'Mod');
        done += `\nnote: on macOS ${ctrlAccel} is not the editing accelerator (Ctrl+letter ≠ select-all/bold/copy). ` +
          `Use ${asMod} — "Mod" is Cmd here — if you meant the shortcut.`;
      }
    }
    return finishAction(done, { changed, expected, meta: await pageMeta(tabId), tabId });
  },

  // ---------------------------------------------------------- screenshot ----
  async browser_screenshot(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId, { needsScripts: !!args.ref || !!args.selector || !!args.marks });

    const format = args.format || 'jpeg';
    const quality = args.quality ?? 70;
    const maxWidth = args.maxWidth ?? 1280;

    // Magnify: re-rasterize the framed area at N× so tiny text/icons are legible
    // (the Claude-in-Chrome "zoom in to inspect" behaviour), clamped to a sane
    // range. Only worthwhile above 1; below it just downscales, which maxWidth
    // already does. When magnifying, the maxWidth downscale would immediately
    // undo the enlargement, so lift its ceiling by the same factor (bounded, so
    // a huge region can't blow up the payload).
    const magnify = Math.min(Math.max(Number(args.magnify) || 1, 1), 8);
    const effectiveMaxWidth = magnify > 1 ? Math.min(Math.round(maxWidth * magnify), 4096) : maxWidth;

    if (args.animate) {
      return captureAnimation(tabId, { ...args, format, quality, maxWidth });
    }

    // Where the pointer is, so the model can confirm it — both numerically (a
    // reported [x,y]) and visually (the arrow in the shot). The position is the
    // last point an action drove the cursor to; null until this session has
    // acted on the tab, since there is no meaningful pointer before then.
    const settings = await getSettings();
    const pointer =
      settings.showCursor === false
        ? null
        : ((await chrome.storage.session.get(CURSOR_POS_KEY))[CURSOR_POS_KEY] || {})[tabId] || null;

    let clip;
    if (args.mode === 'element' || args.ref || args.selector) {
      const target = await locateTarget(tabId, args);
      const r = target.rect;
      // A little padding gives visual context for what surrounds the element.
      const pad = 8;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 };
    } else if (args.mode === 'region' && args.region) {
      const [x, y, width, height] = args.region;
      clip = { x, y, width, height };
    }

    // Set-of-Marks: paint a numbered badge on every clickable element, so the
    // model reading the image clicks a number (browser_act mark:N) that resolves
    // to a real ref — the whole coordinate-space problem below simply does not
    // arise, because no pixel is ever passed back. Only for a whole-viewport
    // shot: a clip frames one thing, and badges over it would be noise.
    let markTable = null;
    const doMarks = args.marks && !clip;
    if (doMarks) {
      try {
        const got = await frames.sendToTab(tabId, 'markBoxes', { viewportOnly: true });
        markTable = (got?.marks || []).map((m, i) => ({ n: i + 1, ...m }));
        if (markTable.length) await frames.sendToTab(tabId, 'drawMarks', { marks: markTable });
      } catch {
        // Marks are an aid, not the capture. A page that refuses the overlay
        // still gets its screenshot — just without badges.
        markTable = null;
      }
    }

    // Put the arrow back at its remembered point before capturing, so the
    // pointer is reliably in the shot even after a worker teardown or a fresh
    // navigation dropped the overlay. Silent — no ripple, no label; nothing
    // happened, the pointer is simply where it was. Awaited (unlike the action
    // path, where the visual must not add latency): a still capture can spend
    // one round-trip to guarantee the arrow is painted. Skipped for element
    // reads, where a cursor over the framed element would be noise, not signal.
    const drawPointer = pointer && args.mode !== 'element' && !args.ref && !args.selector;
    if (drawPointer) {
      await frames
        .sendToTab(tabId, 'cursor', { x: pointer.x, y: pointer.y, action: '', click: false })
        .catch(() => {});
    }

    let base64;
    try {
      base64 = await cdp.captureScreenshot(tabId, {
        format,
        quality,
        fullPage: args.mode === 'full_page',
        clip,
        scale: magnify,
      });
    } finally {
      // Clear the badges before anything else reads the page, whether or not the
      // capture threw — a leftover overlay would sit on top of the real UI.
      if (markTable?.length) await frames.sendToTab(tabId, 'clearMarks', {}).catch(() => {});
    }

    const resized = await downscale(base64, format, quality, effectiveMaxWidth);
    const meta = await pageMeta(tabId).catch(() => ({}));

    // The image has been through two independent rescalings — the device pixel
    // ratio at capture, then the downscale to maxWidth — so its dimensions say
    // nothing about the CSS-pixel space that `region` and every coordinate
    // argument use. captureGeometry derives the factor from the image against
    // what it covered, and says so when the mapping is not 1:1.
    const geometry = {
      mode: args.mode || 'viewport',
      clip,
      meta,
      image: { width: resized.width, height: resized.height },
      pointer,
    };
    const line = fmt.captureGeometry(geometry);

    // Tell the model where its pointer is in page CSS px — the reliable channel,
    // since the arrow in the image can be clipped or (after a teardown) missing.
    // Flag when a clip does not contain the point, so "I see no cursor" reads as
    // "it is off-frame" rather than "the tool is broken".
    const pointerInFrame =
      pointer &&
      (!clip ||
        (pointer.x >= clip.x &&
          pointer.y >= clip.y &&
          pointer.x <= clip.x + clip.width &&
          pointer.y <= clip.y + clip.height));
    const pointerLine = pointer
      ? `\npointer at [${pointer.x},${pointer.y}]${pointerInFrame ? '' : ' (outside this frame)'}`
      : '';

    // Remember how this image maps to the page, and tell the model the one call
    // that clicks a point it reads off the image — the extension does the factor
    // math so a vision model does not have to. This is what makes coordinate
    // clicking reliable for local models that only have the picture to go on.
    const mapping = fmt.captureMapping(geometry);
    await saveCaptureGeometry(tabId, mapping, meta);

    // With badges on the shot, the number IS the way to click — resolving to a
    // ref, so no image↔CSS factor is ever in play. The legend names each badge
    // so the model can pick "Bold" by its number without reading tiny digits off
    // a downscaled JPEG. The image-space coordinate hint would only compete with
    // it, so it is suppressed whenever marks are present.
    let marksText = '';
    if (markTable) {
      await saveMarks(tabId, markTable, meta);
      if (markTable.length) {
        const legend = markTable.map((m) => `${m.n} ${m.label}`).join(' · ');
        marksText = `\n${markTable.length} marks · click one with browser_act action:"click" mark:N\n${legend}`;
      } else {
        marksText = '\nmarks:true found no clickable elements in view';
      }
    }
    const hint = markTable?.length
      ? ''
      : mapping
        ? '\n→ to click a spot in this image: browser_act action:"click" coordinate:[imageX,imageY] space:"image"'
        : '';

    // Nudge toward element mode when a chart/image dominates a wide-angle shot.
    // The failure this heads off is a model reading a value off a graphic that
    // the viewport shot rendered small and blurry (or a region shot clipped),
    // when framing it whole and crisp is one call away. Only on the modes that
    // did not already target an element, and only when the graphic is a real
    // chunk of the picture — a favicon-sized icon is not worth a suggestion.
    let nudge = '';
    if (!clip && args.mode !== 'element') {
      const visual = await probeVisual(tabId, meta).catch(() => null);
      if (visual) nudge = `\n↳ a <${visual.tag}> fills much of this shot — browser_screenshot mode:"element" selector:"${visual.tag}" reads it whole and crisp`;
    }

    return {
      text: `${fmt.pageHeader(meta, tabId)}\n${line}${pointerLine}${hint}${marksText}${nudge}`,
      images: [{ data: resized.data, mimeType: format === 'png' ? 'image/png' : 'image/jpeg' }],
    };
  },

  // --------------------------------------------------------------- zoom ----
  async browser_zoom(args) {
    // Reuse the screenshot pipeline so framing, pointer mapping, marks, and
    // image-space clicks behave identically. The public tool is separate so a
    // model can discover zoom without carrying it as a hidden screenshot flag.
    return HANDLERS.browser_screenshot({ ...args, magnify: args.magnify ?? 2 });
  },

  // ---------------------------------------------------------------- wait ----
  async browser_wait(args) {
    const timeout = args.timeout ?? 15_000;
    const kind = args.for;

    // A job is a batch already running somewhere; it needs no tab of its own.
    if (kind === 'job') return collectJob(args, timeout);

    const tabId = await resolveTab(args);
    const result = await waitCondition(tabId, { for: kind, value: args.value, timeout });

    if (kind === 'network_idle') {
      return result.ok
        ? `network idle\n${fmt.pageHeader(await pageMeta(tabId), tabId)}`
        : `still had in-flight requests after ${timeout}ms — the page may poll continuously, which is normal for some apps`;
    }

    if (result.error) {
      // Surface what the page *does* say, so a wrong expectation is diagnosable
      // without a second call.
      const meta = await pageMeta(tabId);
      throw new Error(
        `${result.error} while waiting for ${kind}="${args.value ?? ''}".\nCurrently: ${fmt.pageHeader(meta, tabId)}`
      );
    }

    return fmt.actionResult(`condition met after ${result.ms ?? 0}ms`, { meta: await pageMeta(tabId), tabId });
  },

  // ---------------------------------------------------------------- eval ----
  async browser_eval(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId);

    const world = args.world || 'main';
    const timeout = args.timeout ?? 10_000;

    // Everything goes through CDP, including the isolated world.
    // chrome.scripting.executeScript cannot help here: running an arbitrary
    // code *string* needs eval or new Function, and MV3's extension CSP forbids
    // both — the call silently produced null. The debugger is not bound by that.
    const contextId = await resolveEvalContext(tabId, world, args.frameId);

    const evaluate = (expression) =>
      cdp.send(tabId, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout,
        userGesture: true,
        ...(contextId ? { contextId } : {}),
      });

    // `ref` used to be accepted and then ignored entirely, so code written
    // against it failed with "element is not defined" — a parameter that reads
    // as if it does something and does not. It now binds the element by the
    // selector the registry already stores, which is the only handle the page's
    // own world can resolve.
    let preamble = '';
    if (args.ref) {
      const route = await frames.routeRef(tabId, args.ref);
      const target = await frames.sendToFrame(tabId, route.frameId, 'resolve', {
        ref: route.localRef,
        scroll: false,
      });
      if (target.error) throw new Error(target.error);
      if (!target.selector) {
        throw new Error(`${args.ref} cannot be addressed from page script — drop ref and query for it directly.`);
      }
      preamble = `const element = document.querySelector(${JSON.stringify(target.selector)});\n`;
    }

    const wrap = (body) => `(async () => { ${preamble}${body} })()`;
    const hasReturn = /\breturn\b/.test(args.code);

    let response = await evaluate(wrap(hasReturn ? args.code : `return (${args.code})`));

    // The expression form cannot hold multi-statement code: `return (const x =
    // 1; x)` is a syntax error. Retry it as a plain statement body.
    //
    // This retry used to test `exceptionDetails.text`, which for a compile
    // error is only ever "Uncaught" — the message is in `exception.description`.
    // So it never fired, and every multi-statement snippet came back as a bare
    // SyntaxError despite the tool advertising that it accepts a function body.
    let statementForm = false;
    if (response.exceptionDetails && isSyntaxError(response.exceptionDetails)) {
      statementForm = true;
      response = await evaluate(wrap(args.code));
    }

    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || 'script threw');
    }

    const value = response.result?.value;

    // A statement body runs its last expression and throws the value away, so
    // code that reads like it returns something yields undefined instead.
    // Saying so beats letting the caller conclude the page holds nothing.
    if (statementForm && !hasReturn && value === undefined) {
      return (
        'undefined — this ran as a statement body, not a single expression, so the last value was discarded. ' +
        'Add an explicit `return`.'
      );
    }

    return renderEvalResult(value);
  },

  // ------------------------------------------------------------- inspect ----
  async browser_inspect(args) {
    const tabId = await resolveTab(args);
    const what = args.what;
    const limit = args.limit ?? 50;

    switch (what) {
      case 'console': {
        await prepareTab(tabId, { needsScripts: false });
        const entries = recorder.getConsole(tabId, {
          filter: args.filter, level: args.level, limit, since: args.since,
          includePrevious: args.includePrevious,
        });
        return withHistoryNote(fmt.renderConsole(entries), tabId, args, 'console');
      }

      case 'network': {
        await prepareTab(tabId, { needsScripts: false });
        const entries = recorder.getNetwork(tabId, {
          filter: args.filter, limit, since: args.since, includePrevious: args.includePrevious,
        });
        return withHistoryNote(fmt.renderNetwork(entries), tabId, args, 'network');
      }

      case 'request_body': {
        if (!args.requestId) throw new Error('pass requestId (the #id from browser_inspect what:"network").');
        const entry = recorder.getRequest(tabId, args.requestId);
        const body = await recorder.getResponseBody(tabId, args.requestId);
        return [
          entry ? `${entry.method} ${entry.url} -> ${entry.status ?? '?'}` : `request ${args.requestId}`,
          entry?.postData ? `request body:\n${entry.postData}` : '',
          body.error ? body.error : `response body:\n${body.body}`,
        ].filter(Boolean).join('\n\n');
      }

      case 'cookies': {
        const tab = await chrome.tabs.get(tabId);
        const cookies = await chrome.cookies.getAll({ url: tab.url });
        if (!cookies.length) return 'no cookies for this URL';
        return cookies
          .slice(0, limit)
          .map((c) => {
            const flags = [c.httpOnly && 'httpOnly', c.secure && 'secure', c.sameSite].filter(Boolean).join(' ');
            return `${c.name} = ${fmt.truncate(c.value, 80)}  [${c.domain}${c.path}]${flags ? ` ${flags}` : ''}`;
          })
          .join('\n');
      }

      case 'storage': {
        await prepareTab(tabId);
        const store = await frames.sendToTab(tabId, 'storage', {});
        const render = (label, obj) => {
          const keys = Object.keys(obj || {});
          if (!keys.length) return `${label}: empty`;
          return `${label}:\n${keys.slice(0, limit).map((k) => `  ${k} = ${obj[k]}`).join('\n')}`;
        };
        return `${render('localStorage', store.local)}\n${render('sessionStorage', store.session)}`;
      }

      case 'downloads': {
        const items = await chrome.downloads.search({ limit, orderBy: ['-startTime'] });
        if (!items.length) return 'no downloads';
        return items
          .map((d) => `${d.state} ${d.filename || d.url} ${d.bytesReceived ? `${Math.round(d.bytesReceived / 1024)}KB` : ''}`)
          .join('\n');
      }

      case 'frames': {
        await prepareTab(tabId);
        const list = await frames.listFrames(tabId);
        return list
          .map((f) => `${f.index === 0 ? 'main' : `f${f.index}`}  ${fmt.shortUrl(f.url)}${f.errorOccurred ? ' (load error)' : ''}`)
          .join('\n');
      }

      case 'page_info': {
        await prepareTab(tabId);
        const meta = await pageMeta(tabId);
        const lines = [fmt.pageHeader(meta, tabId), `readyState: ${meta.readyState}`];
        if (meta.meta?.description) lines.push(`description: ${fmt.truncate(meta.meta.description, 200)}`);
        if (meta.counts) {
          lines.push(`links ${meta.counts.links} · forms ${meta.counts.forms} · images ${meta.counts.images} · iframes ${meta.counts.iframes}`);
        }
        if (meta.hasCaptcha) lines.push('CAPTCHA present — needs a human');
        // Where the pointer is, without paying ~20x for a screenshot — the
        // last point an action drove the cursor to on this tab.
        const pointer = ((await chrome.storage.session.get(CURSOR_POS_KEY))[CURSOR_POS_KEY] || {})[tabId];
        if (pointer) lines.push(`pointer at [${pointer.x},${pointer.y}]`);
        // The running build, so "did my reload take effect?" is one call, not
        // an inference from whether a new output line showed up.
        const mf = chrome.runtime.getManifest();
        lines.push(`extension: ${mf.name} v${mf.version_name || mf.version}`);
        return lines.join('\n');
      }

      default:
        throw new Error(`unknown inspect target: ${what}`);
    }
  },

  // --------------------------------------------------------------- batch ----
  async browser_batch(args) {
    const steps = args.steps || [];
    if (!steps.length) throw new Error('batch needs at least one step');

    // Hand back a job id now and run in the background. The MCP round trip is
    // the only thing an agent cannot overlap with anything else; this makes a
    // long flow on one tab overlap with reading another, or with thinking.
    if (args.async) {
      const session = sessionIdOf(args);
      const { id } = jobs.startJob(
        { session, tool: 'browser_batch', steps: steps.length },
        (progress) => runBatch({ ...args, async: false }, progress)
      );
      return (
        `${id} started — ${steps.length} step${steps.length === 1 ? '' : 's'} running in the background. ` +
        `Collect it with browser_wait for:"job" value:"${id}" (progress is reported if it is not done yet); ` +
        'every other tool stays available meanwhile.'
      );
    }

    return runBatch(args);
  },

  // -------------------------------------------------------------- upload ----
  async browser_upload(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId);
    const route = args.ref ? await frames.routeRef(tabId, args.ref) : { frameId: 0, localRef: undefined };
    const target = await frames.sendToFrame(tabId, route.frameId, 'uploadTarget', { ref: route.localRef });

    let how;
    if (!target.error) {
      // An input already in the DOM — fill it directly, no click needed, so
      // nothing else on the page is disturbed.
      if (!target.multiple && args.paths.length > 1) {
        throw new Error('that input accepts one file, but several paths were given');
      }
      await cdp.setFileInput(tabId, target.selector, args.paths);
      how = 'direct';
    } else {
      // No input exists yet. Most modern uploaders create one only when their
      // button is clicked, so click it with the native picker intercepted.
      if (!args.ref) {
        throw new Error(
          `${target.error} and no ref was given. Pass ref: the upload button, so the input can be created and intercepted.`
        );
      }

      // Re-locate on every attempt rather than closing over one point: the
      // retry exists because the page was still settling, and a settling page
      // is exactly the one whose buttons have moved by the second try.
      await cdp.uploadViaFileChooser(
        tabId,
        async () => {
          const point = await locateTarget(tabId, args);
          await cdp.click(tabId, point.point.x, point.point.y);
        },
        args.paths
      );
      how = 'via file picker';
    }

    await settle(600);
    const meta = await pageMeta(tabId);
    const attached = `attached ${args.paths.length} file(s) (${how})`;
    return fmt.actionResult(attached, { meta, tabId });
  },

  // -------------------------------------------------------------- window ----
  async browser_window(args) {
    const label = sessionIdOf(args);

    // Window selection is handled before anything touches a tab. It has to be:
    // this is the call an agent makes *because* it has no window yet, and
    // resolving a tab first would either open one in the wrong window or throw
    // the very question this call exists to answer.
    if (args.action) {
      switch (args.action) {
        case 'list': {
          const wins = await windows.summary();
          const bound = label ? await windows.boundWindowId(label) : null;
          const home = wins.find((w) => w.windowId === bound);
          return [
            `${wins.length} window${wins.length === 1 ? '' : 's'}:`,
            ...wins.map((w, i) => {
              // Who is already working here matters more than anything else on
              // the line: it is the difference between an empty window and one
              // another agent is mid-task in.
              const who = w.sessions.length
                ? `  · agents: ${w.sessions.map((s) => (s === label ? `${s} (you)` : s)).join(', ')}`
                : '';
              return windows.describeWindow(w, i + 1) + who;
            }),
            label
              ? bound == null
                ? `You ("${label}") have no window yet — the first tab you open goes to the agent window, or bind one with ` +
                  'action:"use" windowId:<id>.'
                : `You ("${label}") work in ${windows.windowName(home || { windowId: bound })}; tabs you open go there. ` +
                  'Nothing you do brings that window in front of the user.'
              : '',
          ].filter(Boolean).join('\n');
        }

        case 'use': {
          // `browser` alone is a complete answer: the hub bound it before this
          // call was routed here, and which window to use inside it is a
          // separate question this browser can still ask for itself.
          if (args.windowId == null) {
            if (args.browser != null) {
              return `you ("${label}") work in browser "${args.browser}" now. Pass windowId too to pin a window.`;
            }
            throw new Error('pass `windowId` — which window this session should work in.');
          }
          const id = await windows.use(label, args.windowId);
          const moved = await rehomeSession(label, id);
          const win = (await windows.listWindows()).find((w) => w.windowId === id) || { windowId: id };
          return (
            `you ("${label}") now work in ${windows.windowName(win)}. Your tabs open there, in your own group.` +
            (moved ? ` Moved the ${moved} tab(s) you already had into it.` : '')
          );
        }

        // The answer to "the agent keeps stealing the window I am working in".
        // Sharing a window is not a thing that can be done politely: trusted
        // input needs a foreground tab, only one tab per window is foreground,
        // so every click is the view changing under whoever else is there.
        case 'new': {
          const id = await windows.createFor(label);
          const moved = await rehomeSession(label, id);
          return (
            `opened a window (id ${id}) for you ("${label}") alone. Your tabs go there, and nothing you do ` +
            'brings it in front of the user.' +
            (moved ? ` Moved the ${moved} tab(s) you already had into it.` : '')
          );
        }

        case 'pick': {
          const res = await windows.pick(label);
          const moved = await rehomeSession(label, res.windowId);
          const followed = moved ? ` Moved the ${moved} tab(s) you already had into it.` : '';
          if (!res.asked) return `only one window is open; you ("${label}") work in window ${res.windowId}.${followed}`;
          return (
            `the user chose window ${res.windowId} (${res.tabCount} tab(s)); you ("${label}") work there now.` +
            followed +
            (res.skipped ? ` ${res.skipped} window(s) could not show the prompt.` : '')
          );
        }

        default:
          throw new Error(`unknown window action: ${args.action}. Use "list", "new", "use", "pick", "browsers", "connect", "disconnect", or "remotes".`);
      }
    }

    const tabId = await resolveTab(args);
    await prepareTab(tabId, { needsScripts: false });
    const done = [];

    const PRESETS = {
      mobile: { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
      tablet: { width: 820, height: 1180, mobile: true, deviceScaleFactor: 2 },
      desktop: { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
      wide: { width: 1920, height: 1080, mobile: false, deviceScaleFactor: 1 },
    };

    if (args.preset || args.width || args.height) {
      const preset = PRESETS[args.preset] || PRESETS.desktop;
      const metrics = {
        width: args.width ?? preset.width,
        height: args.height ?? preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
      };
      await cdp.setDeviceMetrics(tabId, metrics);
      done.push(`viewport ${metrics.width}x${metrics.height}${metrics.mobile ? ' (mobile)' : ''}`);
    }

    if (args.colorScheme) {
      await cdp.setColorScheme(tabId, args.colorScheme);
      done.push(`color-scheme ${args.colorScheme}`);
    }
    if (args.zoom) {
      await chrome.tabs.setZoom(tabId, args.zoom);
      done.push(`zoom ${args.zoom}x`);
    }
    if (args.userAgent) {
      await cdp.setUserAgent(tabId, args.userAgent);
      done.push('user-agent overridden');
    }
    if (args.throttle) {
      await cdp.setThrottle(tabId, args.throttle);
      done.push(`network ${args.throttle}`);
    }
    if (args.focus) {
      await assertAgentWindow(tabId, sessionIdOf(args), 'focus');
      const settings = await getSettings();
      done.push(await showTab(tabId, settings));
    }

    if (args.state) {
      const { windowId } = await chrome.tabs.get(tabId);
      await chrome.windows.update(windowId, { state: args.state });
      done.push(
        args.state === 'minimized'
          ? 'minimized (OpenBrowser will not raise it automatically; verify state-changing input because sites may throttle minimized pages)'
          : args.state
      );
    }

    if (!done.length) {
      throw new Error(
        'nothing to change — pass preset, width/height, colorScheme, zoom, userAgent, throttle, state, or focus.'
      );
    }

    await settle(300);
    return fmt.actionResult(done.join(', '), { meta: await pageMeta(tabId), tabId });
  },

  // --------------------------------------------------------------- macro ----
  async browser_macro(args) {
    switch (args.action) {
      case 'list': {
        const all = await macros.list();
        if (!all.length) return 'no saved macros. Save one with action:"save".';
        return all.map((m) => `${m.name} — ${m.description || `${m.steps.length} steps`}`).join('\n');
      }

      case 'show': {
        const macro = await macros.get(args.name);
        if (!macro) throw new Error(`no macro named "${args.name}"`);
        return `${macro.name} — ${macro.description || ''}\n${JSON.stringify(macro.steps, null, 2)}`;
      }

      case 'save': {
        if (!args.name) throw new Error('macro needs a name');
        if (!args.steps?.length) throw new Error('macro needs steps');
        await macros.save(args.name, { description: args.description, steps: args.steps });
        return `saved macro "${args.name}" (${args.steps.length} steps)`;
      }

      case 'delete':
        await macros.remove(args.name);
        return `deleted macro "${args.name}"`;

      case 'run': {
        const macro = await macros.get(args.name);
        if (!macro) {
          const available = (await macros.list()).map((m) => m.name).join(', ');
          throw new Error(`no macro named "${args.name}". Available: ${available || '(none)'}`);
        }
        const steps = macros.substitute(macro.steps, args.vars || {});
        const tabId = args.tabId ?? (await activeTabId());
        return runSteps(
          steps.map((s) => ({ ...s, args: { tabId, ...s.args } })),
          { stopOnError: true }
        );
      }

      default:
        throw new Error(`unknown macro action: ${args.action}`);
    }
  },
};

// -----------------------------------------------------------------------------
// Supporting implementation
// -----------------------------------------------------------------------------

/**
 * Scroll the viewport, or the scrollable region under a target.
 *
 * Targeting matters: dispatching the wheel event over a specific element scrolls
 * that element's own scroll container, which is how you reach the inside of a
 * modal, a virtualised list, or a code editor rather than the page behind it.
 */
async function scrollAction(tabId, args) {
  const amount = args.amount ?? 400;
  const direction = args.direction || 'down';
  const deltas = {
    down: [0, amount], up: [0, -amount],
    right: [amount, 0], left: [-amount, 0],
  };
  const [dx, dy] = deltas[direction] || deltas.down;

  // Default to the middle of the viewport when no target is given.
  let x = 400;
  let y = 300;
  if (args.ref || args.coordinate) {
    const target = await locateTarget(tabId, args);
    x = target.point.x;
    y = target.point.y;
  }

  const startedAt = Date.now();
  await cdp.scroll(tabId, x, y, dx, dy);
  // Lazy-loading pages react to a scroll; most pages do not. Either way this
  // returns as soon as the page has said which.
  await awaitSettled(tabId, startedAt, { idle: 150, max: 500 });
  return fmt.actionResult(`scrolled ${direction} ${Math.abs(dy || dx)}px`, {
    meta: await pageMeta(tabId),
    tabId,
  });
}

/**
 * The body of browser_batch, shared by the synchronous call and a background
 * job. `onStep` reports progress for `browser_wait for:"job"`.
 */
async function runBatch(args, onStep) {
  const steps = args.steps || [];

  // Fan the same steps across several tabs, concurrently.
  if (args.parallel?.length) {
    const runs = await Promise.allSettled(
      args.parallel.map((tabId) =>
        serializeTabMutation(tabId, () =>
          runSteps(
            steps.map((s) => ({ ...s, args: { ...s.args, tabId } })),
            { ...args, _mutationLockHeld: true, onStep }
          )
        )
      )
    );
    return runs
      .map((run, i) => {
        const tabId = args.parallel[i];
        if (run.status === 'fulfilled') return `--- tab ${tabId} ---\n${run.value.text ?? run.value}`;
        return `--- tab ${tabId} FAILED ---\n${run.reason?.message || run.reason}`;
      })
      .join('\n\n');
  }

  // When every mutating step names the same tab, hold its queue for the whole
  // batch. Locking each step separately lets another agent navigate or type
  // between "open composer" and "fill composer", which is still a race even
  // though each individual click is serialized correctly.
  const mutationTabs = flattenSteps(steps)
    .filter((step) => TAB_MUTATIONS.has(step.tool))
    .map((step) => step.args?.tabId ?? args.tabId);
  const explicitTabs = [...new Set(mutationTabs.filter((id) => id != null))];
  if (mutationTabs.length && explicitTabs.length === 1 && mutationTabs.every((id) => id === explicitTabs[0])) {
    const tabId = explicitTabs[0];
    return serializeTabMutation(tabId, () => runSteps(steps, { ...args, _mutationLockHeld: true, onStep }));
  }

  return runSteps(steps, { ...args, onStep });
}

/** Every tool step in a plan, groups flattened. */
function flattenSteps(steps, out = []) {
  for (const step of steps || []) {
    if (Array.isArray(step?.steps)) flattenSteps(step.steps, out);
    else if (step) out.push(step);
  }
  return out;
}

/**
 * Run a step list: in order, with `when`/`unless`/`repeat` control flow, and
 * only the last step paying for a page delta. The planning lives in batch.js
 * (pure, tested); this binds it to dispatch and to the page.
 */
async function runSteps(steps, { stopOnError = true, returnEach = false, onStep, ...batchArgs } = {}) {
  // A batch almost always runs against one tab, so `tabId` and `group` on the
  // batch itself act as defaults for every step. Writing them once is the shape
  // people reach for first, and repeating them on each step is easy to get
  // subtly wrong — a single step missing its tabId silently drove a different
  // tab. A step that sets its own still wins.
  const defaults = {};
  if (batchArgs.tabId != null) defaults.tabId = batchArgs.tabId;
  if (batchArgs.group) defaults.group = batchArgs.group;
  if (batchArgs._session) defaults._session = batchArgs._session;
  if (batchArgs._client) defaults._client = batchArgs._client;
  if (batchArgs._mutationLockHeld) defaults._mutationLockHeld = true;

  return runPlan(steps, {
    defaults,
    stopOnError,
    returnEach,
    onStep,
    run: (tool, args) => dispatch(tool, args),
    test: (cond, args) => checkCondition(args, cond),
  });
}

/** Answer a step condition (`when`, `unless`, `repeat.until`) right now. */
async function checkCondition(args, cond) {
  if (['network_idle', 'time', 'job'].includes(cond.for)) {
    throw new Error(`"${cond.for}" cannot be a step condition — use text, no_text, selector, no_selector, url, ref_gone or load`);
  }
  const tabId = await resolveTab(args);
  await prepareTab(tabId);
  const r = await frames.sendToTab(tabId, 'check', { for: cond.for, value: cond.value });
  if (r.error) throw new Error(r.error);
  return r.ok;
}

/**
 * Block until a condition holds. Shared by browser_wait and by `expect`, so
 * the two speak one vocabulary.
 */
async function waitCondition(tabId, { for: kind, value, timeout = 15_000 }) {
  if (kind === 'network_idle') {
    // Idle is measured from the recorder's buffer, so capture has to be
    // running before we can conclude anything from it being quiet.
    await prepareTab(tabId, { needsScripts: false });
    const idle = await waitForNetworkIdle(tabId, timeout);
    return idle ? { ok: true } : { ok: false, error: `still had in-flight requests after ${timeout}ms` };
  }
  await prepareTab(tabId);
  return frames.sendToTab(tabId, 'wait', { for: kind, value, timeout });
}

/**
 * Verify an action in the same call.
 *
 * "Did my click work?" used to be its own round trip — act, then wait, then
 * snapshot — and a model turn sits between each. `expect` folds the wait into
 * the action: the tool blocks until the condition holds (default 5s, shorter
 * than browser_wait's 15s because this is a check, not a load) and reports a
 * verdict with the result. A failed expectation is an error, so a batch stops
 * on it — that is what makes it a verification gate rather than a note.
 */
async function expectAfter(tabId, expect) {
  if (!expect || typeof expect !== 'object' || !expect.for) {
    throw new Error('expect needs {for, value} — the same shape as browser_wait, e.g. expect:{for:"text", value:"Order placed"}');
  }
  if (['job', 'time'].includes(expect.for)) {
    throw new Error(`expect cannot use "${expect.for}" — use text, no_text, selector, no_selector, url, ref_gone, load or network_idle`);
  }
  const timeout = expect.timeout ?? 5000;
  const r = await waitCondition(tabId, { ...expect, timeout }).catch((err) => ({ ok: false, error: err.message }));
  if (r.error && r.ok === undefined) return { ok: false, error: r.error, timeout, cond: expect };
  return { ...r, timeout, cond: expect };
}

/**
 * Compose an action result, honouring an `expect` verdict: appended when met,
 * thrown when not — with everything the model needs to recover, including the
 * fact that the action itself *was* dispatched.
 */
function finishAction(summary, { changed, expected, meta, tabId }) {
  if (expected && !expected.ok) {
    throw new Error(
      `${summary.split('\n')[0]} — the action was dispatched, but ${fmt.expectLine(expected)}.` +
        `${changed ? `\n${changed}` : ''}\nCurrently: ${fmt.pageHeader(meta, tabId)}`
    );
  }
  const text = expected ? `${summary}\n${fmt.expectLine(expected)}` : summary;
  return fmt.actionResult(text, { changed, meta, tabId });
}

/** `browser_wait for:"job"`: list this session's jobs, or collect one. */
async function collectJob(args, timeout) {
  const session = sessionIdOf(args);
  if (!args.value) {
    const list = jobs.listJobs(session);
    return list.length ? list.map(jobs.describeJob).join('\n') : 'no jobs for this session — start one with browser_batch async:true';
  }
  const job = jobs.getJob(String(args.value), session);
  if (!job) {
    throw new Error(
      `no job "${args.value}" for this session — browser_wait for:"job" with no value lists them. ` +
        'A job is forgotten ten minutes after it finishes, or when the extension restarts.'
    );
  }
  const done = await jobs.waitForJob(job, timeout);
  if (done.status === 'running') {
    return `${jobs.describeJob(done)} — still running after ${timeout}ms; call again to keep waiting, or carry on with other work`;
  }
  if (done.status === 'failed') throw new Error(`${jobs.describeJob(done)}:\n${done.error}`);
  const r = done.result;
  const text = typeof r === 'string' ? r : r?.text ?? '';
  return { text: `${jobs.describeJob(done)}\n\n${text}`, ...(r?.images?.length ? { images: r.images } : {}) };
}

/**
 * Per-tab record of the last screenshot's coordinate mapping, so a later
 * `browser_act coordinate:[…] space:"image"` can convert image pixels back to
 * the viewport. Lives in session storage because the service worker is torn
 * down between the capture and the click, and is keyed by tab because two tabs
 * captured at different scales must not share a factor.
 */
function captureKey(tabId) {
  return `ob_capture_${tabId}`;
}

async function clearCaptureGeometry(tabId) {
  try {
    await chrome.storage.session.remove(captureKey(tabId));
  } catch {
    /* nothing to clear, or session storage gone with the worker — either way
       a load below returns null and image-space clicks report "take one first" */
  }
}

/**
 * Remember how the just-captured image maps to the page, stamped with the URL
 * and viewport it was taken against so a later click can tell whether the image
 * still describes the page.
 *
 * A null mapping (no viewport, so no honest factor) must *clear* the record, not
 * leave the previous one in place — otherwise a click that reads pixels off the
 * unmapped image would be converted with a stale factor from an earlier,
 * differently-sized shot, and land somewhere plausible but wrong with no error.
 */
async function saveCaptureGeometry(tabId, mapping, meta) {
  if (!mapping) {
    await clearCaptureGeometry(tabId);
    return;
  }
  try {
    await chrome.storage.session.set({
      [captureKey(tabId)]: {
        ...mapping,
        url: meta?.url || '',
        vw: meta?.viewport?.w || 0,
        vh: meta?.viewport?.h || 0,
        ts: Date.now(),
      },
    });
  } catch {
    /* session storage unavailable (rare); image-space clicks will just report
       "take a screenshot first" until the next capture succeeds */
  }
}

async function loadCaptureGeometry(tabId) {
  try {
    const key = captureKey(tabId);
    const got = await chrome.storage.session.get(key);
    return got[key] || null;
  } catch {
    return null;
  }
}

/**
 * The last `marks:true` screenshot's number→ref table, so a later
 * `browser_act mark:N` resolves the badge the model saw back to a real element.
 * Same store, key shape and lifetime as the capture geometry above, and stamped
 * with the URL and viewport it was taken against for the same freshness reason:
 * a badge number means nothing once the page it was painted on has changed.
 */
function marksKey(tabId) {
  return `ob_marks_${tabId}`;
}

async function clearMarks(tabId) {
  try {
    await chrome.storage.session.remove(marksKey(tabId));
  } catch {
    /* nothing to clear, or the worker took session storage with it */
  }
}

async function saveMarks(tabId, marks, meta) {
  if (!marks?.length) {
    await clearMarks(tabId);
    return;
  }
  try {
    await chrome.storage.session.set({
      [marksKey(tabId)]: {
        marks, // [{ n, ref, box, label }]
        url: meta?.url || '',
        vw: meta?.viewport?.w || 0,
        vh: meta?.viewport?.h || 0,
        ts: Date.now(),
      },
    });
  } catch {
    /* session storage unavailable; mark clicks will report "take a shot first" */
  }
}

async function loadMarks(tabId) {
  try {
    const key = marksKey(tabId);
    const got = await chrome.storage.session.get(key);
    return got[key] || null;
  } catch {
    return null;
  }
}

/**
 * Resolve `browser_act mark:N` to the ref that badge N stood for, refusing
 * rather than guessing when there is no fresh table to read it against — the
 * same "an error beats a silent wrong click" stance as image-space coordinates.
 */
async function markToRef(tabId, n) {
  const record = await loadMarks(tabId);
  const meta = record ? await pageMeta(tabId).catch(() => null) : null;
  const d = fmt.markDecision(record, meta, n);
  if (d.ref) return d.ref;
  if (d.clear) await clearMarks(tabId);
  if (d.error === 'no-record') {
    throw new Error(
      'mark:N needs a recent browser_screenshot marks:true of this tab to resolve against — ' +
        'take one first, or use a ref from browser_snapshot.'
    );
  }
  if (d.error === 'navigated' || d.error === 'resized') {
    throw new Error(
      `the page ${d.error === 'navigated' ? 'navigated' : 'was resized'} since that screenshot, so its badges no ` +
        'longer map to it — take a fresh browser_screenshot marks:true before clicking with mark.'
    );
  }
  throw new Error(`no badge ${n} in the last marks screenshot (it had 1–${d.max}) — re-shoot with marks:true if the page changed.`);
}

/**
 * Invert an image-pixel coordinate to a viewport CSS-pixel click point using
 * the mapping saved by the last screenshot of this tab.
 *
 * `originX/Y` place the captured region within the page (a `region` shot starts
 * at its own offset), and `scale` undoes both rescalings at once. A full_page
 * capture is document-space, so its inverted point is shifted by the *current*
 * scroll — read now, not at capture time, since the page may have moved.
 *
 * The mapping describes one specific image. If the page navigated or the window
 * resized since it was taken, image pixels no longer correspond to anything, so
 * this refuses rather than clicking somewhere plausible — the same "an error
 * beats a silent wrong click" stance the whole coordinate story rests on.
 */
async function imageToViewport(tabId, [imgX, imgY]) {
  const g = await loadCaptureGeometry(tabId);
  if (!g) {
    throw new Error(
      'space:"image" needs a recent browser_screenshot of this tab to convert from — ' +
        'take one first, or drop space:"image" to pass viewport CSS pixels directly.'
    );
  }

  const meta = await pageMeta(tabId).catch(() => null);
  if (meta) {
    const vw = meta.viewport?.w;
    const vh = meta.viewport?.h;
    const navigated = g.url && meta.url && g.url !== meta.url;
    const resized = g.vw && vw && (g.vw !== vw || g.vh !== vh);
    if (navigated || resized) {
      await clearCaptureGeometry(tabId);
      throw new Error(
        `the page ${navigated ? 'navigated' : 'was resized'} since that screenshot, so its ` +
          'pixels no longer map to it — take a fresh browser_screenshot before clicking with space:"image".'
      );
    }
  }

  let x = g.originX + imgX / g.scale;
  let y = g.originY + imgY / g.scale;

  if (g.mode === 'full_page') {
    x -= meta?.scroll?.x || 0;
    y -= meta?.scroll?.y || 0;
  }

  return { x, y };
}

/**
 * Work out where to click, from either a ref or explicit coordinates.
 * Refreshes iframe offsets first so refs inside frames resolve correctly.
 */
async function locateTarget(tabId, args) {
  // A badge number from the last marks screenshot is just a ref the model did
  // not have to read: resolve it to that ref and fall through to the ref path,
  // so the click gets clickPoint's obstruction probe and fresh box like any
  // other, not a stale coordinate baked in when the badge was painted.
  if (typeof args.mark === 'number') {
    args = { ...args, ref: await markToRef(tabId, args.mark), mark: undefined };
  }
  if (args.coordinate) {
    // Coordinates read straight off a screenshot are in *image* pixels, which
    // the two rescalings (device pixel ratio, then the maxWidth downscale) put
    // in neither the viewport nor the document coordinate space browser_act
    // otherwise speaks. `space:"image"` says "these came off the last capture"
    // and inverts them here, so a vision model — local ones especially — can
    // click what it sees without doing the factor math itself and landing at
    // half the intended offset, silently. Default stays CSS px.
    if (args.space === 'image') {
      return { point: await imageToViewport(tabId, args.coordinate), rect: null };
    }
    return { point: { x: args.coordinate[0], y: args.coordinate[1] }, rect: null };
  }
  if (args.selector && !args.ref) {
    return locateSelector(tabId, args.selector, args);
  }
  // `mode:"element"` with nothing to aim at means "frame the main graphic" — the
  // one thing a screenshot is usually for. Auto-target the largest chart/image
  // so a model that only knows it wants "the chart" does not have to name it.
  if (args.mode === 'element' && !args.ref) {
    return locateSelector(tabId, VISUAL_SELECTOR, { ...args, _auto: true });
  }
  if (!args.ref) {
    throw new Error('pass either `ref` (preferred), `selector`, or `coordinate`.');
  }

  const route = await frames.routeRef(tabId, args.ref);
  if (route.frameIndex !== 0) await frames.refreshFrameOffsets(tabId);

  const target = await frames.sendToFrame(tabId, route.frameId, 'resolve', { ref: route.localRef });
  if (target.error) throw new Error(target.error);

  return {
    point: target.point,
    rect: target.rect,
    name: target.name,
    disabled: target.disabled,
    obstructed: target.point.obstructed,
    obstructedBy: target.point.obstructedBy,
  };
}

/** What "the graphic on this page" means when a model does not name one. */
const VISUAL_SELECTOR = 'canvas, svg, img, video';

/**
 * Frame an element by CSS selector, across every frame, in top-level viewport
 * coordinates — the fallback-free way to capture a chart/canvas/svg/image that
 * has no ref. Returns the same `{point, rect, selector}` shape as `locateTarget`
 * so the screenshot, act and scroll paths treat a selector and a ref alike.
 *
 * The winner is the largest matching box anywhere on the page: a selector like
 * "svg" or "canvas" is deliberately broad, and the one the model means is almost
 * always the biggest. Offsets are refreshed first so an iframe target's rect is
 * placed correctly, exactly as the ref path does.
 */
async function locateSelector(tabId, selector, args = {}) {
  await frames.refreshFrameOffsets(tabId).catch(() => {});
  const scroll = args.scroll !== false;
  const { frames: results } = await frames.broadcast(tabId, 'resolveSelector', { selector, scroll });

  const matches = [];
  for (const { result } of results) {
    if (!result) continue;
    // An invalid selector fails identically in every frame; surface it once.
    if (result.error) throw new Error(result.error);
    if (result.found && result.rect) matches.push(result);
  }
  if (!matches.length) {
    // The auto-target path guessed a selector the model never typed, so its
    // failure has to name the real remedy rather than the guess.
    if (args._auto) {
      throw new Error(
        'mode:"element" found no chart, canvas, image or video to frame on this page. Pass a selector ' +
          '(e.g. selector:"svg"), or use mode:"viewport" / mode:"region" instead.'
      );
    }
    throw new Error(
      `no visible element matched selector ${JSON.stringify(selector)} — take a browser_snapshot to check the ` +
        'structure, or fall back to mode:"region" with pixel coordinates if the target has no stable selector'
    );
  }
  matches.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  const best = matches[0];
  return { point: best.point, rect: best.rect, selector: best.selector, tag: best.tag };
}

/**
 * The largest graphic on the page, but only when it is big enough that framing
 * it on its own would actually help — otherwise null. Non-throwing and never
 * scrolls: it runs after a screenshot purely to decide whether to suggest
 * element mode, so it must not move the page or fail the capture it annotates.
 */
async function probeVisual(tabId, meta) {
  const { frames: results } = await frames
    .broadcast(tabId, 'resolveSelector', { selector: VISUAL_SELECTOR, scroll: false })
    .catch(() => ({ frames: [] }));

  let best = null;
  for (const { result } of results) {
    if (!result?.found || !result.rect) continue;
    const area = result.rect.w * result.rect.h;
    if (!best || area > best.rect.w * best.rect.h) best = result;
  }
  if (!best) return null;

  // Worth a suggestion only if it is both sizeable in absolute terms and a real
  // share of the viewport — the threshold a decorative icon never clears and a
  // chart always does.
  const vp = meta?.viewport;
  const area = best.rect.w * best.rect.h;
  const bigEnough = best.rect.w >= 180 && best.rect.h >= 140 && area >= 40_000;
  const dominant = vp?.w && vp?.h ? area >= vp.w * vp.h * 0.12 : true;
  return bigEnough && dominant ? best : null;
}

/** Read the Google sign-in page across every frame and merge to one view. */
async function readGoogleAccounts(tabId) {
  await frames.refreshFrameOffsets(tabId).catch(() => {});
  const { frames: results } = await frames.broadcast(tabId, 'googleAccounts', {});
  return oauth.mergeGoogleFrames(results.map((r) => r.result));
}

/**
 * Guided Google sign-in. The router is the only place a decision becomes a
 * trusted click, and it only ever acts on a `click`/`allow` verdict from
 * `oauth.googleDecision` — every stop (password, unconfirmed consent, no
 * chosen account, unknown page) returns as guidance, never as an action.
 */
async function googleLogin(tabId, args) {
  await prepareTab(tabId, { needsScripts: true });
  const view = await readGoogleAccounts(tabId);
  const decision = oauth.googleDecision({
    stage: view.stage,
    accounts: view.accounts,
    account: args.account,
    consent: args.consent,
  });

  const meta = await pageMeta(tabId).catch(() => ({}));

  if (decision.do === 'list' || decision.do === 'stop') {
    return `${decision.message}\n${fmt.pageHeader(meta, tabId)}`;
  }

  // A vetted click: an explicitly chosen account, or a confirmed consent grant.
  const spot = decision.do === 'allow' ? view.allow : decision.account;
  if (!spot?.point) {
    return `Could not locate the ${decision.do === 'allow' ? 'Allow button' : 'account row'} to click.\n${fmt.pageHeader(meta, tabId)}`;
  }

  const label = decision.do === 'allow' ? 'Allow' : decision.account.email;
  const { changed } = await withDelta(tabId, async () => {
    showCursor(tabId, await getSettings(), { x: spot.point.x, y: spot.point.y, action: 'click', label, click: true });
    await cdp.click(tabId, spot.point.x, spot.point.y);
    await settle(400);
  });

  const after = await readGoogleAccounts(tabId).catch(() => ({ stage: 'unknown' }));
  const next =
    after.stage === 'password'
      ? ' Now at the password step — sign in yourself; I will not type a password.'
      : after.stage === 'consent'
        ? ' Now at the consent step — confirm with the user, then call this action with consent:true.'
        : after.stage === 'chooser'
          ? ' Still on the account chooser.'
          : '';
  return fmt.actionResult(`${decision.do === 'allow' ? 'granted access' : `selected ${label}`}.${next}`, {
    changed,
    meta: await pageMeta(tabId),
    tabId,
  });
}

/**
 * Did typed text land? Compared loosely on purpose: rich editors reflow
 * newlines, trim whitespace, and strip characters the field does not accept, so
 * an exact match would produce false alarms. Matching a healthy prefix of the
 * alphanumeric content catches the real failure — nothing arrived at all.
 */
function valueContains(actual, expected) {
  const strip = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = strip(expected);
  const got = strip(actual);
  if (!want) return true;
  return got.includes(want.slice(0, Math.min(want.length, 24)));
}

function normalizeUrl(url) {
  const trimmed = String(url).trim();
  if (!trimmed) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  // Bare domains are far more common than relative paths in agent input.
  return `https://${trimmed}`;
}

/** Resolve once the tab reports `complete`, or on timeout. */
function waitForLoad(tabId, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`page did not finish loading within ${timeout}ms`)),
      timeout
    );

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    // It may already be done — check after registering, to avoid a race.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish(resolve);
    }).catch(() => finish(reject, new Error('tab disappeared while loading')));
  });
}

/**
 * Wait until no new requests have started for a quiet period.
 *
 * Absolute "zero in-flight" never happens on apps with polling or open
 * websockets, so we look for quiet rather than silence.
 */
async function waitForNetworkIdle(tabId, timeout = 10_000, quietMs = 700) {
  const started = Date.now();
  let lastCount = -1;
  let quietSince = Date.now();

  while (Date.now() - started < timeout) {
    const count = recorder.getNetwork(tabId, { limit: 500 }).length;
    if (count !== lastCount) {
      lastCount = count;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return true;
    }
    await settle(150);
  }
  return false;
}

/**
 * Pick the execution context for browser_eval.
 *
 * Returns undefined for a main-world evaluation in the top frame, which is the
 * common case and needs no context at all.
 *
 * Frame targeting maps a Chrome extension frameId onto a CDP frame id by URL,
 * because the two numbering schemes are unrelated and nothing bridges them
 * directly. That is unambiguous unless a page embeds the same URL in two
 * iframes, in which case the first match wins.
 */
/**
 * Mention buffered entries from a page this tab has navigated away from.
 *
 * They are excluded by default because attributing another site's errors to the
 * current page is worse than silence. But a login or redirect chain is a real
 * thing to debug, so the history has to stay reachable — hence one line saying
 * it exists and how to ask for it.
 */
function withHistoryNote(rendered, tabId, args, kind) {
  if (args.includePrevious) return rendered;
  const before = recorder.previousPageCounts(tabId)[kind];
  if (!before) return rendered;
  return `${rendered}\n(${before} earlier ${kind} entr${before === 1 ? 'y' : 'ies'} from a page this tab has ` +
    'navigated away from — pass includePrevious:true to see them)';
}

/**
 * A compile error reports "Uncaught" as its `text`; the actual message is on
 * the exception. Both have to be checked or syntax errors look like anything
 * else.
 */
function isSyntaxError(detail) {
  return /SyntaxError/.test(`${detail.text || ''} ${detail.exception?.description || ''}`);
}

async function resolveEvalContext(tabId, world, extensionFrameId) {
  if (world !== 'isolated' && !extensionFrameId) return undefined;

  await cdp.enableDomain(tabId, 'Page');
  const { frameTree } = await cdp.send(tabId, 'Page.getFrameTree');

  let cdpFrameId = frameTree.frame.id;

  if (extensionFrameId) {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    const wanted = all?.find((f) => f.frameId === extensionFrameId);
    if (!wanted) throw new Error(`frame ${extensionFrameId} not found. Use browser_inspect what:"frames" to list them.`);

    const flatten = (node, out = []) => {
      out.push(node.frame);
      for (const child of node.childFrames || []) flatten(child, out);
      return out;
    };
    const match = flatten(frameTree).find((f) => f.url === wanted.url);
    if (!match) throw new Error(`frame ${extensionFrameId} (${wanted.url}) is no longer attached`);
    cdpFrameId = match.id;
  }

  if (world !== 'isolated') {
    // Main world in a named frame: evaluate against that frame's own context.
    const { executionContextId } = await cdp.send(tabId, 'Page.createIsolatedWorld', {
      frameId: cdpFrameId,
      worldName: 'openbrowser-main-proxy',
      grantUniveralAccess: true, // CDP's own spelling; grants access to the real window
    });
    return executionContextId;
  }

  const { executionContextId } = await cdp.send(tabId, 'Page.createIsolatedWorld', {
    frameId: cdpFrameId,
    worldName: 'openbrowser-isolated',
  });
  return executionContextId;
}

function renderEvalResult(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 20_000 ? `${json.slice(0, 20_000)}\n… truncated (${json.length} chars)` : json;
  } catch {
    return String(value);
  }
}

/**
 * Downscale a screenshot in the service worker.
 *
 * A 2560-wide retina capture costs roughly four times the tokens of a 1280-wide
 * one and carries no extra readable information, so this is always worth doing.
 */
async function downscale(base64, format, quality, maxWidth) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes]));

  if (bitmap.width <= maxWidth) {
    return { data: base64, width: bitmap.width, height: bitmap.height };
  }

  const scale = maxWidth / bitmap.width;
  const width = maxWidth;
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({
    type: format === 'png' ? 'image/png' : 'image/jpeg',
    quality: quality / 100,
  });
  const buffer = await blob.arrayBuffer();
  return { data: toBase64(new Uint8Array(buffer)), width, height };
}

function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // avoid blowing the argument limit on large images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Record a short animation of the tab as a GIF. */
async function captureAnimation(tabId, args) {
  const frameCount = Math.min(args.animate.frames ?? 12, 60);
  const intervalMs = Math.max(args.animate.intervalMs ?? 400, 100);
  const width = Math.min(args.maxWidth ?? 640, 800); // GIFs get large quickly

  const bitmaps = [];
  for (let i = 0; i < frameCount; i++) {
    const shot = await cdp.captureScreenshot(tabId, { format: 'png' });
    const bytes = Uint8Array.from(atob(shot), (c) => c.charCodeAt(0));
    bitmaps.push(await createImageBitmap(new Blob([bytes])));
    if (i < frameCount - 1) await settle(intervalMs);
  }

  const gif = await encodeGif(bitmaps, { width, delayMs: intervalMs });
  for (const bitmap of bitmaps) bitmap.close();

  return {
    text: `recorded ${frameCount} frames over ${((frameCount * intervalMs) / 1000).toFixed(1)}s`,
    images: [{ data: gif, mimeType: 'image/gif' }],
  };
}
