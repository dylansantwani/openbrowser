/**
 * Persisted settings, with an in-memory cache.
 *
 * The service worker is torn down and restarted constantly under MV3, so
 * anything that must survive that lives in chrome.storage. Reads go through a
 * cache because the router consults settings on every single tool call and
 * awaiting storage each time adds up.
 */

const DEFAULTS = {
  /** Hub port. Must match the MCP server's --port. */
  port: 8848,

  /** Connect to the hub automatically when the browser starts. */
  autoConnect: true,

  /**
   * Sites the agent may drive. Empty means "all sites".
   * Entries are hostname suffixes: "example.com" also matches "app.example.com".
   */
  allowlist: [],

  /**
   * Sites the agent may never drive, checked before the allowlist.
   * Seeded with categories where an automation mistake is expensive and hard to
   * undo. Users can clear this, but it should take a deliberate action.
   */
  blocklist: ['accounts.google.com', 'login.microsoftonline.com'],

  /** Draw an outline on elements as they are acted on. */
  highlightActions: true,

  /**
   * Collect agent-opened tabs into labelled Chrome tab groups, so it is obvious
   * at a glance which tabs belong to which job.
   */
  groupTabs: true,

  /**
   * Ask which window a session should work in, when more than one is open.
   *
   * A tab group only organises tabs inside one window, so without this an
   * agent's first tab lands wherever Chrome considers current — which is the
   * window the human was last looking at. With a work window and a personal
   * one open, that is a coin flip every session.
   *
   * Off means "use the focused window and never ask", which is the right
   * setting for one agent and one window, and the wrong one for anybody who
   * keeps their browsing separate from what the agent is doing. One window
   * open is never a question either way.
   */
  chooseWindow: true,

  /**
   * When an MCP client disconnects, close the tabs that session opened.
   *
   * Only tabs the session created itself are closed — never one it adopted
   * from the user, which would amount to closing your browser tabs because a
   * background job finished.
   */
  closeTabsOnSessionEnd: true,

  /**
   * Attach the Chrome debugger for trusted input events. Without it we fall
   * back to synthetic events, which many sites reject. Costs a visible
   * "debugging this browser" banner on the tab.
   */
  useDebugger: true,

  /**
   * Answer "Leave site? Changes you made may not be saved" automatically.
   *
   * `beforeunload` is not the same kind of question as `confirm()`. A
   * `confirm("Delete this?")` is the page asking something it needs an answer
   * to, and guessing is dangerous — those stay blocking, always. A beforeunload
   * prompt only ever appears *because something is already trying to leave*, so
   * when the agent navigates, the intent to leave is the instruction it was
   * given; answering carries it out rather than deciding anything new.
   *
   * Only tabs the agent drives can reach this: the opening event arrives over
   * the debugger, which is attached to those tabs and no others, so a prompt
   * raised by the user's own browsing is untouched.
   *
   * Set false to have these block like every other dialog and wait for an
   * explicit browser_act action:"dialog".
   */
  autoConfirmLeave: true,

  /**
   * Put the tab back after the agent borrows the foreground.
   *
   * Trusted input can only be dispatched at a foreground tab — a hidden one
   * drops mouse and key events silently — so the agent has to activate its tab
   * to click. Keeping it afterwards is no part of that requirement, and a
   * background job stealing the tab you are reading is the tool interrupting
   * you to do the thing you asked it to do quietly. A tab group does not help:
   * groups share a window, so activating a tab in one pulls you out of another.
   *
   * Restoring is skipped if you switched tabs yourself in the meantime.
   */
  restoreFocusAfterInput: true,

  /**
   * Draw a persistent border and caption on pages an agent is driving.
   *
   * The tab-group colour is only visible in the tab strip; once you are looking
   * at a page there is otherwise nothing to distinguish an agent's tab from one
   * of your own.
   */
  showAgentBadge: true,

  /** Ring buffer sizes for passive capture. */
  consoleBufferSize: 300,
  networkBufferSize: 300,

  /** Record request/response bodies. Off by default — they are large. */
  captureBodies: false,

  /** Default snapshot truncation budget, in characters. */
  maxSnapshotChars: 20000,

  /** Log every tool call to the side panel activity feed. */
  logActivity: true,
};

let cache = null;
let loading = null;

export async function getSettings() {
  if (cache) return cache;
  loading ??= chrome.storage.local.get('settings').then((stored) => {
    cache = { ...DEFAULTS, ...(stored.settings || {}) };
    loading = null;
    return cache;
  });
  return loading;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  cache = { ...current, ...patch };
  await chrome.storage.local.set({ settings: cache });
  return cache;
}

export async function resetSettings() {
  cache = { ...DEFAULTS };
  await chrome.storage.local.set({ settings: cache });
  return cache;
}

export function getDefaults() {
  return { ...DEFAULTS };
}

// Another surface (options page, side panel) may have written settings. Drop
// the cache so the next read picks the change up.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) cache = null;
});

/**
 * Decide whether the agent is allowed to touch a URL.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkUrlAllowed(url, settings) {
  let host;

  // A session that has just started owns exactly one tab and it is blank —
  // that is what opening its own tab in its own window leaves behind. Reaching
  // this with `about:blank` is therefore the *normal* first step of a session,
  // not a mistake, and it deserves the instruction rather than the generic
  // "browser restriction" answer that reads like something went wrong.
  if (url === 'about:blank' || url === '') {
    return {
      allowed: false,
      reason: 'this tab is blank — open a page in it first with browser_navigate url:"…".',
    };
  }

  try {
    const parsed = new URL(url);
    // Browser-internal pages cannot be scripted at all; say so plainly rather
    // than letting the injection fail with something cryptic.
    if (!/^https?:|^file:/.test(parsed.protocol)) {
      return {
        allowed: false,
        reason: `${parsed.protocol} pages cannot be automated (browser restriction). Navigate to an http(s) page first.`,
      };
    }
    host = parsed.hostname;
  } catch {
    return { allowed: false, reason: `not a valid URL: ${url}` };
  }

  const matches = (pattern) => host === pattern || host.endsWith(`.${pattern}`);

  if (settings.blocklist?.some(matches)) {
    return {
      allowed: false,
      reason: `${host} is on the blocklist. Remove it in the extension options if you intend to automate it.`,
    };
  }

  if (settings.allowlist?.length && !settings.allowlist.some(matches)) {
    return {
      allowed: false,
      reason: `${host} is not on the allowlist. Add it in the extension options to allow automation here.`,
    };
  }

  return { allowed: true };
}
