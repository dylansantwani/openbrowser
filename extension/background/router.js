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
import { encodeGif } from './gif.js';
import { getSettings, checkUrlAllowed } from './settings.js';

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
    const result = await handler(args);
    logActivity({ tool, args, ok: true, ms: Date.now() - started });
    return normalize(result);
  } catch (err) {
    logActivity({ tool, args, ok: false, error: err.message, ms: Date.now() - started });
    throw err;
  } finally {
    // One place rather than every input path: this runs whichever way the call
    // left, including the error paths, and a call that never borrowed focus
    // costs nothing here. `browser_tabs`/`browser_window` are excluded because
    // being asked to focus a tab is the whole point of those two — handing it
    // straight back would undo what was requested.
    if (tool !== 'browser_tabs' && tool !== 'browser_window' && borrowedFocus.size) {
      for (const windowId of [...borrowedFocus.keys()]) releaseForeground(windowId);
    }
  }
}

/** Tools may return a string or {text, images}; MCP wants the latter shape. */
function normalize(result) {
  if (typeof result === 'string') return { text: result };
  return result;
}

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
  const label = args.group || args._session;
  let tabId;

  if (args.tabId != null) {
    try {
      await chrome.tabs.get(args.tabId);
      tabId = args.tabId;
    } catch {
      throw new Error(`tab ${args.tabId} no longer exists. Use browser_tabs action:"list" to see open tabs.`);
    }
    // Naming a tab explicitly is how you hand one of your own pages to an
    // agent, and from that point it is part of the session's work — so it joins
    // the session's group like everything else it touches. See `claimTab`.
    await claimTab(tabId, label);
  } else {
    tabId = await sessionTabId(args);
    if (tabId == null) {
      if (!create && label) {
        throw new Error(
          `"${label}" has no open tab, so there is nothing to act on — pass tabId, ` +
            'or see what is open with browser_tabs action:"list".'
        );
      }
      tabId = await openSessionTab(args);
    }
  }

  await rememberSessionTab(label, tabId);
  noteAgentLabel(tabId, label);
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
async function claimTab(tabId, label) {
  if (!label) return; // the side panel is a human driving their own tabs

  // Naming a tab used to be the documented way to *override* this check, back
  // when the alternative was an agent stuck with no tab at all. It is not any
  // more — a session that wants a tab opens one — so the override has become
  // nothing but the one thing the hard rule forbids: two agents on one tab,
  // where a navigate for a fresh page wipes out another session's work mid-task.
  const owner = await groups.workstreamFor(tabId);
  if (owner && owner !== label) {
    throw new Error(
      `tab ${tabId} belongs to workstream "${owner}", not "${label}" — refusing to take over another session's tab. ` +
        'Open your own with browser_tabs action:"new".'
    );
  }

  // A session works in one window. An explicit `tabId` is the one way a tab
  // from somewhere else enters the picture, and leaving it there quietly breaks
  // that invariant: resolution is window-scoped, so the very next call with no
  // `tabId` would silently move to a different tab, in a different window, than
  // the one just worked on. Both ways of restoring the invariant are honest;
  // which applies depends on whether the session has committed to a window yet.
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    let bound = await windows.boundWindowId(label);

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
          ? await windows.bind(label, tab.windowId)
          : await windows.createFor(label);
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
  await groups.assign(tabId, label).catch(() => {});
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
  const label = args.group || args._session;
  if (!label) return activeTabId(); // side panel: the window the human is in

  const settings = await getSettings();
  const windowId = await windows.ensureWindow(label, settings);

  const tab = await openInWindow({ url: 'about:blank', active: false }, windowId);
  await claimTab(tab.id, label);
  await rememberCreatedTab(args._session || label, tab.id);
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
async function rehomeSession(label, windowId) {
  if (!label || windowId == null) return 0;
  const settings = await getSettings();
  if (settings.groupTabs === false) return 0;
  return groups.moveTo(label, windowId).catch(() => 0);
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

chrome.tabs.onRemoved.addListener((tabId) => agentLabels.delete(tabId));

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

const rememberCreatedTab = (label, tabId) => remember(CREATED_TABS_KEY, label, tabId, 64);
const rememberSessionTab = (label, tabId) => remember(RECENT_TABS_KEY, label, tabId, 16);

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
async function endSession(label) {
  if (!label) return 'no session label';

  // Forget the session either way. Its bookkeeping must not outlive it even
  // when auto-close is off, or a later session inherits stale tab ids.
  const forget = async (key) => {
    try {
      // Through the same queue as `remember`: a session ending while two others
      // are opening tabs is the ordinary case, and an unguarded read-modify-write
      // here would erase their bookkeeping on the way out.
      return await mutateStored(key, (all) => {
        const ids = all[label] || [];
        delete all[label];
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
  await windows.unbind(label);

  // Take the border off every tab this session touched. Tabs it merely adopted
  // are the ones that matter — those are the user's own, they outlive the
  // session, and a stale "an agent is driving this" border on a tab nothing is
  // driving is worse than no border at all. Tabs about to be closed below cost
  // nothing to clear first.
  for (const tabId of new Set([...ids, ...recent])) {
    agentLabels.delete(tabId);
    frames.sendToTab(tabId, 'agent_frame', { on: false }).catch(() => {});
  }

  const settings = await getSettings();
  if (settings.closeTabsOnSessionEnd === false) {
    // Ungroup instead, so a finished session leaves no label behind to block
    // whoever comes next.
    await groups.release(label).catch(() => {});
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
      if (await groups.workstreamFor(tabId)) closable.push(tabId);
    } catch {
      /* already gone */
    }
  }

  if (closable.length) await chrome.tabs.remove(closable).catch(() => {});

  // Anything still carrying this session's label — a tab dragged out and back,
  // or one whose close failed — is released rather than left owned by a session
  // that no longer exists.
  await groups.release(label).catch(() => {});

  return closable.length
    ? `session "${label}" ended; closed ${closable.length} tab(s) it opened`
    : `session "${label}" ended; nothing to close`;
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
  const label = args.group || args._session;
  if (!label) return null; // the side panel drives the active tab, as a human expects

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
  const boundWindow = await windows.boundWindowId(label);

  const candidates = [
    ...(await groups.tabsFor(label, boundWindow ?? undefined)),
    ...(await recallTabs(RECENT_TABS_KEY, label)),
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

async function withDelta(tabId, fn) {
  // Tab ids before the action, so one that appears during it can be reported.
  // A click on a `target="_blank"` link otherwise looks like it did nothing:
  // no error, no delta, and the thing the agent wanted sitting in a tab it was
  // never told about. That is most of commerce and search results.
  const before = await tabIdSet();

  const result = await fn();
  let changed;

  const opened = await newTabsSince(before);
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
      changed = diff.replaced ? 'page changed substantially — snapshot for detail' : `changes:\n${diff.text}`;
    }
  } catch (err) {
    // Either the page is mid-navigation, or it is too big to diff cheaply.
    // Say so for the latter, so the omission is not mistaken for "nothing
    // changed". Never fail the action over a diff.
    if (/delta budget/.test(err.message)) {
      changed = 'page too large to diff quickly — call browser_snapshot if you need to see the result';
    }
  }
  if (opened.length) {
    const list = opened.map((t) => `tab ${t.id} (${fmt.shortUrl(t.url || t.pendingUrl || '')})`).join(', ');
    const note = `opened ${list} — the click targeted a new tab; pass that tabId to act on it`;
    changed = changed ? `${note}\n${changed}` : note;
  }

  return { result, changed };
}

/**
 * Make a tab foreground before dispatching trusted input at it.
 *
 * A backgrounded tab silently drops `Input.dispatchMouseEvent` and
 * `Input.dispatchKeyEvent`: the compositor is not processing input for a hidden
 * tab, so the events land nowhere. Nothing errors. The click reports success,
 * the page never sees it, and the agent carries on believing it clicked —
 * which is the single worst failure this project can produce, in its most-used
 * tool.
 *
 * Reproduced with `document.visibilityState === 'hidden'`: a click on a planted
 * button left it untouched for seven seconds, then fired instantly once the tab
 * was activated.
 *
 * Screenshots and the accessibility tree work fine on hidden tabs, so only the
 * input paths need this. The cost is real — parallel work cannot type into
 * several tabs at once, because only one tab per window can be foreground — but
 * serialising input is strictly better than dropping it.
 *
 * `active` is necessary and not sufficient, which is the part that took longest
 * to see. A tab is `active` in a window that is minimized, and `active` in a
 * window another window completely covers, and Chrome calls the document hidden
 * in both — so the check that matters is the page's own `visibilityState`, and
 * the only thing that can answer it is the page. Without that round trip the
 * minimized case is not merely unhandled, it is *advertised*: `browser_window
 * state:"minimized"` says automation keeps running, and every click after it
 * silently lands nowhere.
 *
 * @param {number} tabId
 * @param {string} [label] the session, for the shared-window advice
 * @returns {Promise<string|null>} something the caller should tell the model
 */
async function ensureForeground(tabId, label) {
  let note = null;
  try {
    let tab = await chrome.tabs.get(tabId);

    // Activating a tab is invisible inside a window that holds nothing but this
    // session's work, and is somebody's view being taken anywhere else. So the
    // tab comes home before it is activated, rather than the window being
    // switched around whoever is in it. `ownWindowId` is the only thing that
    // can tell the two cases apart — a window id says nothing about who else is
    // in it — and it answers null for a window the session merely landed in,
    // including a binding written before this distinction existed.
    const relocated = await relocateToOwnWindow(tab, label);
    if (relocated) tab = relocated;

    // Relocation is best-effort; this is not. If the tab could not be brought
    // home, the call stops here rather than switching tabs under whoever is in
    // that window.
    await assertOwnWindow(tab.id, label, 'foreground');

    const win = await chrome.windows.get(tab.windowId).catch(() => null);

    // Restoring a minimized window is not focus theft — a minimized window is
    // one nobody is looking at, and leaving it minimized means the action does
    // nothing at all.
    if (win?.state === 'minimized') {
      await chrome.windows.update(tab.windowId, { state: 'normal' }).catch(() => {});
      await settle(150);
    }

    if (!tab.active) {
      // Sharing a window with the person using the browser. Activating is still
      // the only way to make the click land, so this is said rather than
      // avoided — once per session per window, because it is advice, and advice
      // repeated on every click is just cost.
      if (win?.focused && label) note = sharedWindowNote(label, tab.windowId);

      // Remember what the human was looking at, so it can be put back. Only the
      // first steal in a burst is recorded: a run of twenty clicks should return
      // to the tab you were on before the first one, not to tab nineteen.
      if (!borrowedFocus.has(tab.windowId)) {
        const [wasActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        if (wasActive && wasActive.id !== tabId) {
          borrowedFocus.set(tab.windowId, { previousTabId: wasActive.id, agentTabId: tabId });
        }
      }

      await chrome.tabs.update(tabId, { active: true });
      // The compositor needs a moment before it will accept input.
      await settle(120);
    }

    return (await hiddenTabWarning(tabId, tab.windowId)) || note;
  } catch (err) {
    // The refusal is the one error here that must reach the caller. Everything
    // else is best-effort: if the tab cannot be activated the input may still
    // land, and failing the action would turn a maybe into a definite no.
    if (err?.obRefuse) throw err;
    return note;
  }
}

/**
 * Bring a tab into the window this session owns, so activating it disturbs
 * nobody.
 *
 * Only ever moves *to* a window opened for the session, never into one someone
 * else is in, and does nothing at all when the tab is already home — which is
 * the common case, so the common case costs one storage read.
 *
 * The whole workstream travels, not just this tab. Moving one tab and leaving
 * its siblings is the drift that reads, from inside an agent, as being told it
 * works in one window while demonstrably acting in another.
 *
 * `soloWindow: false` opts out of all of it: someone who deliberately keeps an
 * agent in their own window to watch it has asked for the tab switching too.
 */
async function relocateToOwnWindow(tab, label) {
  if (!label || tab.active) return null;

  const settings = await getSettings();
  if (settings.soloWindow === false) return null;

  let own = await windows.ownWindowId(label);
  if (own === tab.windowId) return null;
  if (own == null) own = await windows.createFor(label);
  if (own == null || own === tab.windowId) return null;

  try {
    await rehomeSession(label, own);
    const now = await chrome.tabs.get(tab.id);
    if (now.windowId !== own) await chrome.tabs.move(tab.id, { windowId: own, index: -1 });
    await tidyBlankTabs(own, tab.id);
    return await chrome.tabs.get(tab.id);
  } catch {
    // Better to click in the wrong window than not to click at all.
    return null;
  }
}

/**
 * Refuse to change what is on screen in a window this session does not own.
 *
 * Relocating the tab is the answer almost every time, and this is what happens
 * when it did not work. The tempting fallback is to activate the tab where it
 * is — the call succeeds, the agent gets on with it — and that is precisely the
 * failure worth refusing over: the tab in front of someone can change while they
 * are typing into it, which sends the next keystrokes of whatever they were
 * writing, password included, to a page an agent chose.
 *
 * A stopped call is recoverable and says what to do. A stolen keystroke is not
 * recoverable and says nothing at all. `soloWindow: false` turns the whole thing
 * off for anyone who wants an agent in their own window on purpose.
 */
async function assertOwnWindow(tabId, label, what) {
  if (!label) return; // the side panel is a human, driving their own window
  const settings = await getSettings();
  if (settings.soloWindow === false) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active) return;

  const own = await windows.ownWindowId(label);
  if (own === tab.windowId) return;

  const err = new Error(
    `refusing to ${what} tab ${tabId}: window ${tab.windowId} is not this session's, and bringing a tab ` +
      'to the front there changes what the user is looking at — possibly mid-keystroke. ' +
      'Give this session a window of its own with browser_window action:"new", which moves its tabs across, ' +
      'or pass an explicit tabId for a tab it already owns.'
  );
  err.obRefuse = true;
  throw err;
}

/** `${label}:${windowId}` already told. In-memory: a repeat costs one line. */
const sharedWindowTold = new Set();

function sharedWindowNote(label, windowId) {
  const key = `${label}:${windowId}`;
  if (sharedWindowTold.has(key)) return null;
  sharedWindowTold.add(key);
  return (
    `NOTE: this session shares window ${windowId} with the user, so every click has to pull ` +
    'their view to its tab. browser_window action:"new" gives it a window of its own.'
  );
}

/**
 * Ask the page whether it is actually visible, after everything above has tried
 * to make it so.
 *
 * Best-effort by design: a tab with no content script cannot answer, and that
 * has always been a case where the input may still land. Silence is read as
 * "probably fine" rather than escalated, because the alternative — raising the
 * window — is the exact interruption the caller is trying to avoid, and this
 * would do it on every page the scripts have not reached yet.
 *
 * A confirmed hidden tab is reported instead of fixed, for the same reason. The
 * fix is a human uncovering a window; saying which window, and that the input
 * probably went nowhere, is worth more than a click that lies about landing.
 */
async function hiddenTabWarning(tabId, windowId) {
  // A native JS dialog pauses the renderer, so the content script cannot answer
  // and `sendToTab` has no timeout — asking here would hang the call outright.
  // `pageMeta` guards the same way for the same reason.
  if (cdp.pendingDialog(tabId)) return null;

  let state;
  try {
    state = (await frames.sendToTab(tabId, 'visibility', {}))?.visibility;
  } catch {
    return null;
  }
  if (state !== 'hidden') return null;
  return (
    `WARNING: tab ${tabId} is hidden — window ${windowId} is covered by another window or off-screen, ` +
    'and Chrome drops trusted input into hidden tabs, so this action probably did not reach the page. ' +
    'Ask the user to uncover that window, or move this session with browser_window action:"new".'
  );
}

/** windowId -> {previousTabId, agentTabId} while the agent has focus on loan. */
const borrowedFocus = new Map();
const focusTimers = new Map();

/**
 * Give the tab back.
 *
 * Input has to be dispatched at a foreground tab — a hidden one drops mouse and
 * key events on the floor, which is why `ensureForeground` exists at all. But
 * *keeping* the foreground afterwards is not part of that requirement, and a
 * background job stealing the tab you are reading, in the window you are
 * working in, is the tool interrupting you to do something you asked it to do
 * quietly.
 *
 * Debounced, because a burst of clicks would otherwise flip the view back and
 * forth on every one. Restored only if the agent's tab is still the active one:
 * if you switched tabs yourself in the meantime, that is your decision and this
 * must not overrule it.
 */
function releaseForeground(windowId, delay = 700) {
  clearTimeout(focusTimers.get(windowId));
  focusTimers.set(
    windowId,
    setTimeout(async () => {
      focusTimers.delete(windowId);
      const borrowed = borrowedFocus.get(windowId);
      if (!borrowed) return;
      const settings = await getSettings();
      if (settings.restoreFocusAfterInput === false) {
        borrowedFocus.delete(windowId);
        return;
      }
      borrowedFocus.delete(windowId);
      try {
        const [nowActive] = await chrome.tabs.query({ active: true, windowId });
        // Moved on already, or the human took over — either way, leave it.
        if (!nowActive || nowActive.id !== borrowed.agentTabId) return;
        await chrome.tabs.get(borrowed.previousTabId);
        await chrome.tabs.update(borrowed.previousTabId, { active: true });
      } catch {
        /* the tab or window went away; nothing to put back */
      }
    }, delay)
  );
}


/**
 * Tell "the app has not reacted yet" from "the click went nowhere".
 *
 * Both look identical from the outside — no delta, no error — and they need
 * opposite responses. Several clicks on Meta's "Create post" registered but did
 * not navigate and needed a second attempt, which is indistinguishable from a
 * click that missed unless something reports the difference.
 */
async function settlingNote(tabId) {
  const result = await frames.sendToTab(tabId, 'settling', { ms: 500 }).catch(() => null);
  if (!result) return null;
  return result.mutated
    ? 'no diff yet, but the page is still changing — browser_wait or snapshot again in a moment'
    : 'no change detected — the click may have missed, or this control does nothing on its own';
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
  const { mode = 'interactive', selector, viewportOnly, maxChars = 20000, includeFrames = true } = opts;

  const { frames: results, failed } = await frames.broadcast(
    tabId,
    'snapshot',
    { mode, selector, viewportOnly, maxChars },
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

    const rendered = fmt.renderTree(nodes, { maxChars: budget });
    if (rendered.truncated) truncated = true;
    if (!rendered.text) continue;

    budget -= rendered.text.length;
    sections.push(
      frame.index === 0
        ? rendered.text
        : `\n[iframe ${frame.index}] ${fmt.shortUrl(frame.url)}\n${indent(rendered.text)}`
    );
  }

  return { text: sections.join('\n'), truncated };
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
  __session_end: (args) => endSession(args._session || args.group),

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
    const names = new Set((await groups.list()).map((g) => g.name));
    for (const key of [CREATED_TABS_KEY, RECENT_TABS_KEY]) {
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

  // ---------------------------------------------------------------- tabs ----
  async browser_tabs(args) {
    const action = args.action || 'list';

    switch (action) {
      case 'list': {
        // `windowId` used to be accepted here and silently dropped, so two
        // different windows returned byte-identical listings — an agent
        // checking where it was got the same answer whatever it asked.
        const label = args.group || args._session;
        const tabs = await chrome.tabs.query(args.windowId != null ? { windowId: args.windowId } : {});
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const workstreams = await groups.list();
        const bound = label ? await windows.boundWindowId(label) : null;

        const scope = args.windowId != null ? ` in window ${args.windowId}` : '';
        const lines = [
          `${tabs.length} tab(s)${scope}:`,
          fmt.renderTabs(tabs, active?.id, workstreams, { boundWindowId: bound, label }),
        ];
        if (workstreams.length) {
          lines.push(
            '',
            'workstreams:',
            ...workstreams.map(
              (w) => `  ${w.name} (${w.color}) — window ${w.windowId}, ${w.tabIds.length} tab(s): ${w.tabIds.join(', ')}`
            )
          );
        }
        // Said once, plainly, rather than left to be inferred from the tags: a
        // workstream group can sit in a window the session no longer works in.
        if (label) {
          lines.push(
            '',
            bound == null
              ? `"${label}" has no window bound yet — the next tab it opens will settle it, or bind one now with browser_window action:"use" windowId:<id>.`
              : `"${label}" works in window ${bound}; tabs it opens go there.`
          );
        }
        return lines.join('\n');
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
        const sessionLabel = args.group || args._session;
        const windowId = args.windowId ?? (await windows.ensureWindow(sessionLabel, settings)) ?? undefined;

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
        if (active && settings.soloWindow !== false) {
          if ((await windows.ownWindowId(sessionLabel)) !== windowId) {
            active = false;
            downgraded = ` (opened in the background: window ${windowId} is not this session's)`;
          }
        }

        const tab = await openInWindow({ url, active }, windowId);
        // Group before waiting for load, so the tab is visibly labelled the
        // moment it appears rather than after the page settles. An explicit
        // `group` wins over the session label, letting an agent split its own
        // work into named sub-workstreams.
        let grouped = '';
        const label = args.group || args._session;
        if (label && settings.groupTabs !== false) {
          const ok = await groups.assign(tab.id, label).catch(() => null);
          if (ok) grouped = ` in "${label}"`;
        }
        // Recorded against the *session*, not the group. An agent is told to
        // use one group per task, so a session routinely spreads its tabs
        // across several named groups — keying this on the group would mean
        // cleanup almost never matched anything.
        await rememberCreatedTab(args._session || label, tab.id);

        if (url !== 'about:blank') await waitForLoad(tab.id, 15000).catch(() => {});
        const meta = await pageMeta(tab.id).catch(() => ({ url }));
        return `opened tab ${tab.id}${grouped}${downgraded}\n${fmt.pageHeader(meta, tab.id)}`;
      }

      case 'group': {
        if (!args.group) throw new Error('pass `group` — the workstream label to put these tabs under.');
        if (!groups.isSupported()) throw new Error('this Chrome build does not support tab groups');
        const ids = args.tabIds?.length ? args.tabIds : [await resolveTab(args)];
        const done = await groups.assignMany(ids, args.group);
        return `grouped ${done.length} tab(s) into "${args.group}"`;
      }

      case 'ungroup': {
        if (!args.group) throw new Error('pass `group` — the workstream to release.');
        const ok = await groups.release(args.group);
        return ok ? `released workstream "${args.group}" (tabs stay open)` : `no workstream named "${args.group}"`;
      }

      case 'close_group': {
        if (!args.group) throw new Error('pass `group` — the workstream to close.');
        const n = await groups.closeWorkstream(args.group);
        return n ? `closed ${n} tab(s) in workstream "${args.group}"` : `no workstream named "${args.group}"`;
      }

      case 'close': {
        const ids = args.tabIds?.length ? args.tabIds : [await resolveTab(args, { create: false })];
        await chrome.tabs.remove(ids);
        for (const id of ids) fmt.clearSnapshot(id);
        return `closed tab(s): ${ids.join(', ')}`;
      }

      case 'select': {
        const tabId = await resolveTab(args, { create: false });
        // Asking for a tab to be brought forward is not authority to bring a
        // *window* forward that belongs to somebody else. `resolveTab` will
        // normally have moved this tab home already, so this only bites when
        // that failed.
        await assertOwnWindow(tabId, args.group || args._session, 'select');
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return `tab ${tabId} is now active\n${fmt.pageHeader(await pageMeta(tabId), tabId)}`;
      }

      case 'reload': {
        const ids = args.tabIds?.length ? args.tabIds : [await resolveTab(args, { create: false })];
        await Promise.all(ids.map((id) => chrome.tabs.reload(id)));
        await Promise.all(ids.map((id) => waitForLoad(id, 20000).catch(() => {})));
        for (const id of ids) fmt.clearSnapshot(id);
        return `reloaded tab(s): ${ids.join(', ')}`;
      }

      case 'duplicate': {
        const tabId = await resolveTab(args, { create: false });
        const tab = await chrome.tabs.duplicate(tabId);
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

    const { text, truncated } = await snapshotText(tabId, {
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

    const { settings } = await prepareTab(tabId);

    // These are handled entirely in the page; no trusted event needed.
    const IN_PAGE = ['focus', 'blur', 'scroll_to', 'select_option', 'check', 'uncheck', 'clear', 'submit'];
    if (IN_PAGE.includes(action)) {
      const route = args.ref ? await frames.routeRef(tabId, args.ref) : { frameId: 0, localRef: undefined };
      const { result, changed } = await withDelta(tabId, async () => {
        const r = await frames.sendToFrame(tabId, route.frameId, 'act', {
          action,
          ref: route.localRef,
          value: args.value,
        });
        if (r.error) throw new Error(r.error);
        await settle(150);
        return r;
      });
      return fmt.actionResult(`${action} ok`, { changed, meta: await pageMeta(tabId), tabId });
    }

    if (action === 'scroll') {
      return scrollAction(tabId, args);
    }

    // Everything below needs a real pointer event at a real coordinate — and a
    // hidden tab drops those on the floor. Foreground it before locating the
    // target, since becoming visible can change layout.
    const fgNote = await ensureForeground(tabId, args.group || args._session);

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

    const { changed } = await withDelta(tabId, async () => {
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
            : { x: args.to?.[0], y: args.to?.[1] };
          if (dest.x == null) throw new Error('drag needs a destination: pass `to` [x,y] or `toRef`.');
          await cdp.drag(tabId, { x, y }, dest, opts);
          break;
        }
        default:
          throw new Error(`unknown action: ${action}`);
      }
      // Clicks commonly start a navigation; give it a chance to commit.
      await settle(action === 'hover' ? 120 : 350);
    });

    const label = args.ref ? `${action} ${args.ref}${target.name ? ` ("${fmt.truncate(target.name, 40)}")` : ''}` : `${action} at ${Math.round(target.point.x)},${Math.round(target.point.y)}`;

    // A click that changed nothing is ambiguous, and the two possibilities need
    // opposite responses: wait, or try something else. "Nothing" includes a
    // delta that is only the focus ring moving, which is what a click on a dead
    // button produces. Hover is excluded — no change is its normal outcome.
    //
    // A native dialog is the third possibility, and it must be checked before
    // the settling probe: the dialog pauses the renderer, so the probe's
    // content-script call would hang forever instead of reporting anything.
    const dlg = cdp.pendingDialog(tabId);
    const nothingHappened = !changed || fmt.isFocusOnly(changed);
    const note = nothingHappened && action !== 'hover' && !dlg ? await settlingNote(tabId) : null;

    let label2 = fgNote ? `${label}\n${fgNote}` : label;
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
    return fmt.actionResult(label2, { changed: note || changed, meta: await pageMeta(tabId), tabId });
  },

  // --------------------------------------------------------------- input ----
  async browser_input(args) {
    const tabId = await resolveTab(args);
    const { settings } = await prepareTab(tabId);
    // Keystrokes are dropped by a hidden tab exactly as clicks are — but only
    // keystrokes. Filling fields goes through the content script, which writes
    // the DOM directly and works perfectly on a tab nobody can see. Measured,
    // not assumed: a field set on a tab reporting `visibilityState: "hidden"`
    // reads back correctly, while a trusted click on the same tab is dropped
    // without an error.
    //
    // So this is deferred to the moment something actually needs the tab in
    // front, rather than paid on the way in. A form fill — the most common
    // thing this tool does — now disturbs nothing at all. Memoised, because
    // several branches below can each be the first to need it, and lazy rather
    // than a precomputed flag so a future CDP path cannot forget to ask.
    let fgNote = null;
    let foregrounded = false;
    const foreground = async () => {
      if (foregrounded) return;
      foregrounded = true;
      fgNote = await ensureForeground(tabId, args.group || args._session);
    };

    const summary = [];

    const { changed } = await withDelta(tabId, async () => {
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
        await foreground();
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
        await foreground();
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
          summary.push(`pressed ${key}`);
        }
      }

      if (args.submit) {
        await foreground();
        await cdp.pressKey(tabId, 'Enter');
        summary.push('pressed Enter');
      }

      await settle(300);
    });

    if (!summary.length) {
      throw new Error('nothing to do — pass `fields`, `text`, or `keys`.');
    }

    // Appended after the "did anything happen at all?" check below, so a note
    // can never stand in for work and turn an empty call into a successful one.
    const done = fgNote ? `${summary.join('\n')}\n${fgNote}` : summary.join('\n');
    return fmt.actionResult(done, { changed, meta: await pageMeta(tabId), tabId });
  },

  // ---------------------------------------------------------- screenshot ----
  async browser_screenshot(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId, { needsScripts: !!args.ref });

    const format = args.format || 'jpeg';
    const quality = args.quality ?? 70;
    const maxWidth = args.maxWidth ?? 1280;

    if (args.animate) {
      return captureAnimation(tabId, { ...args, format, quality, maxWidth });
    }

    let clip;
    if (args.mode === 'element' || args.ref) {
      const target = await locateTarget(tabId, args);
      const r = target.rect;
      // A little padding gives visual context for what surrounds the element.
      const pad = 8;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 };
    } else if (args.mode === 'region' && args.region) {
      const [x, y, width, height] = args.region;
      clip = { x, y, width, height };
    }

    const base64 = await cdp.captureScreenshot(tabId, {
      format,
      quality,
      fullPage: args.mode === 'full_page',
      clip,
    });

    const resized = await downscale(base64, format, quality, maxWidth);
    const meta = await pageMeta(tabId).catch(() => ({}));

    // The image has been through two independent rescalings — the device pixel
    // ratio at capture, then the downscale to maxWidth — so its dimensions say
    // nothing about the CSS-pixel space that `region` and every coordinate
    // argument use. captureGeometry derives the factor from the image against
    // what it covered, and says so when the mapping is not 1:1.
    const line = fmt.captureGeometry({
      mode: args.mode || 'viewport',
      clip,
      meta,
      image: { width: resized.width, height: resized.height },
    });

    return {
      text: `${fmt.pageHeader(meta, tabId)}\n${line}`,
      images: [{ data: resized.data, mimeType: format === 'png' ? 'image/png' : 'image/jpeg' }],
    };
  },

  // ---------------------------------------------------------------- wait ----
  async browser_wait(args) {
    const tabId = await resolveTab(args);
    const timeout = args.timeout ?? 15_000;
    const kind = args.for;

    if (kind === 'network_idle') {
      // Idle is measured from the recorder's buffer, so capture has to be
      // running before we can conclude anything from it being quiet.
      await prepareTab(tabId, { needsScripts: false });
      const idle = await waitForNetworkIdle(tabId, timeout);
      return idle
        ? `network idle\n${fmt.pageHeader(await pageMeta(tabId), tabId)}`
        : `still had in-flight requests after ${timeout}ms — the page may poll continuously, which is normal for some apps`;
    }

    await prepareTab(tabId);
    const result = await frames.sendToTab(tabId, 'wait', { for: kind, value: args.value, timeout });

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

    // Fan the same steps across several tabs, concurrently.
    if (args.parallel?.length) {
      const runs = await Promise.allSettled(
        args.parallel.map((tabId) => runSteps(steps.map((s) => ({ ...s, args: { ...s.args, tabId } })), args))
      );
      return runs
        .map((run, i) => {
          const tabId = args.parallel[i];
          if (run.status === 'fulfilled') return `--- tab ${tabId} ---\n${run.value}`;
          return `--- tab ${tabId} FAILED ---\n${run.reason?.message || run.reason}`;
        })
        .join('\n\n');
    }

    return runSteps(steps, args);
  },

  // -------------------------------------------------------------- upload ----
  async browser_upload(args) {
    const tabId = await resolveTab(args);
    await prepareTab(tabId);
    // Only one of the two paths below needs a visible tab, and which one it is
    // is not known until the page has been asked whether a file input exists.
    // Foregrounding up front paid that cost every time for the sake of the
    // branch that is taken less often — `setFileInput` writes the input through
    // CDP without a pointer event anywhere near it.
    let fgNote = null;

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

      // This branch clicks the trigger, so now the tab has to be in front.
      fgNote = await ensureForeground(tabId, args.group || args._session);

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
    return fmt.actionResult(fgNote ? `${attached}\n${fgNote}` : attached, { meta, tabId });
  },

  // -------------------------------------------------------------- window ----
  async browser_window(args) {
    const label = args.group || args._session;

    // Window selection is handled before anything touches a tab. It has to be:
    // this is the call an agent makes *because* it has no window yet, and
    // resolving a tab first would either open one in the wrong window or throw
    // the very question this call exists to answer.
    if (args.action) {
      switch (args.action) {
        case 'list': {
          const wins = await windows.summary();
          const bound = label ? await windows.boundWindowId(label) : null;
          return [
            `${wins.length} window(s):`,
            ...wins.map((w, i) => {
              // Who is already working here matters more than anything else on
              // the line: it is the difference between an empty window and one
              // another agent is mid-task in.
              const who = w.sessions.length
                ? `  ← ${w.sessions.map((s) => (s === label ? `${s} (you)` : s)).join(', ')}`
                : '';
              return windows.describeWindow(w, i + 1) + who;
            }),
            bound == null
              ? `"${label || 'this session'}" has no window yet — bind one with action:"use" windowId:<id>, ` +
                'or action:"pick" to let the user choose in the browser.'
              : `"${label}" works in window ${bound}.`,
          ].join('\n');
        }

        case 'use': {
          // `browser` alone is a complete answer: the hub bound it before this
          // call was routed here, and which window to use inside it is a
          // separate question this browser can still ask for itself.
          if (args.windowId == null) {
            if (args.browser != null) {
              return `"${label}" works in browser "${args.browser}" now. Pass windowId too to pin a window.`;
            }
            throw new Error('pass `windowId` — which window this session should work in.');
          }
          const id = await windows.use(label, args.windowId);
          const moved = await rehomeSession(label, id);
          return (
            `"${label}" will work in window ${id}. Its tabs open there, in their own group.` +
            (moved ? ` Moved ${moved} tab(s) it already had into window ${id}.` : '')
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
            `opened window ${id} for "${label}" alone. Its tabs go there, and activating them ` +
            'no longer pulls the user out of what they are doing.' +
            (moved ? ` Moved ${moved} tab(s) it already had into it.` : '')
          );
        }

        case 'pick': {
          const res = await windows.pick(label);
          const moved = await rehomeSession(label, res.windowId);
          const followed = moved ? ` Moved ${moved} tab(s) it already had into window ${res.windowId}.` : '';
          if (!res.asked) return `only one window is open; "${label}" will work in window ${res.windowId}.${followed}`;
          return (
            `the user chose window ${res.windowId} (${res.tabCount} tab(s)); "${label}" works there now.` +
            followed +
            (res.skipped ? ` ${res.skipped} window(s) could not show the prompt.` : '')
          );
        }

        default:
          throw new Error(`unknown window action: ${args.action}. Use "list", "new", "use", or "pick".`);
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
      await assertOwnWindow(tabId, args.group || args._session, 'focus');
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      done.push('focused');
    }

    if (args.state) {
      const { windowId } = await chrome.tabs.get(tabId);
      await chrome.windows.update(windowId, { state: args.state });
      // This used to claim a minimized window "still accepts debugger input, so
      // nothing about the run changes". Half of that is true and the half that
      // is not is the expensive half: snapshots and screenshots do keep working,
      // but every tab in a minimized window is `hidden`, and Chrome drops
      // trusted input into hidden tabs. So the tool was recommending a state in
      // which every subsequent click silently landed nowhere.
      //
      // `ensureForeground` now un-minimizes before dispatching input, which
      // makes the recommendation safe and also makes it partly self-cancelling
      // — worth saying, since "minimized" that quietly un-minimizes on the next
      // click is otherwise a surprise.
      done.push(
        args.state === 'minimized' ? 'minimized (reads continue; input un-minimizes it)' : args.state
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

  await cdp.scroll(tabId, x, y, dx, dy);
  await settle(200);
  return fmt.actionResult(`scrolled ${direction} ${Math.abs(dy || dx)}px`, {
    meta: await pageMeta(tabId),
    tabId,
  });
}

/** Run a step list sequentially, returning the last result (or all of them). */
async function runSteps(steps, { stopOnError = true, returnEach = false, ...batchArgs } = {}) {
  const outputs = [];

  // A batch almost always runs against one tab, so `tabId` and `group` on the
  // batch itself act as defaults for every step. Writing them once is the shape
  // people reach for first, and repeating them on each step is easy to get
  // subtly wrong — a single step missing its tabId silently drove a different
  // tab. A step that sets its own still wins.
  const defaults = {};
  if (batchArgs.tabId != null) defaults.tabId = batchArgs.tabId;
  if (batchArgs.group) defaults.group = batchArgs.group;
  if (batchArgs._session) defaults._session = batchArgs._session;

  for (const [i, step] of steps.entries()) {
    if (step.tool === 'browser_batch') {
      throw new Error('batch cannot nest — flatten the inner steps into this one list');
    }
    try {
      const result = await dispatch(step.tool, { ...defaults, ...(step.args || {}) });
      outputs.push({ i, tool: step.tool, ok: true, text: result.text ?? '', images: result.images });
    } catch (err) {
      outputs.push({ i, tool: step.tool, ok: false, text: err.message });
      if (stopOnError) {
        const trail = outputs.map((o) => `${o.ok ? '✓' : '✗'} ${o.tool}${o.ok ? '' : `: ${o.text}`}`).join('\n');
        throw new Error(`step ${i + 1} (${step.tool}) failed: ${err.message}\n\nsteps run:\n${trail}`);
      }
    }
  }

  const images = outputs.flatMap((o) => o.images || []);

  if (returnEach) {
    return {
      text: outputs.map((o) => `[${o.i + 1}] ${o.tool}${o.ok ? '' : ' FAILED'}\n${o.text}`).join('\n\n'),
      ...(images.length ? { images } : {}),
    };
  }

  // Default: the trail plus the final result. The intermediate steps are almost
  // never interesting once they succeeded, but knowing they ran is.
  const trail = outputs.map((o) => `${o.ok ? '✓' : '✗'} ${o.tool}`).join(' → ');
  const last = outputs[outputs.length - 1];
  return { text: `${trail}\n\n${last?.text ?? ''}`, ...(images.length ? { images } : {}) };
}

/**
 * Work out where to click, from either a ref or explicit coordinates.
 * Refreshes iframe offsets first so refs inside frames resolve correctly.
 */
async function locateTarget(tabId, args) {
  if (args.coordinate) {
    return { point: { x: args.coordinate[0], y: args.coordinate[1] }, rect: null };
  }
  if (!args.ref) {
    throw new Error('pass either `ref` (preferred) or `coordinate`.');
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
