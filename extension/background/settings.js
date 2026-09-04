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

  /**
   * What an agent calls this browser: "work", "personal".
   *
   * Several browsers can share one hub, and a session binds to one of them — so
   * something has to name them, and only a human knows which is which. Empty
   * falls back to a generated `chrome·a3f1`, which is unambiguous but tells you
   * nothing; naming it is what makes `browser:"work"` readable in a prompt and
   * in the chooser.
   */
  browserName: '',

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
   * Show a live pointer that travels to each click and ripples on contact.
   *
   * The trusted click happens off-screen in the background, so without this
   * there is no way to see where the agent is reaching — only boxes blinking on
   * elements after the fact. The cursor is what makes a run legible to a human
   * watching, and it is the one feedback that also covers coordinate clicks,
   * which have no element to outline.
   */
  showCursor: true,

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
   * Give each session a window of its own rather than the one you are in.
   *
   * Trusted input only lands on a *foreground* tab, so an agent has to activate
   * its tab before every click. When its tab is in your window, that activation
   * is the view being pulled out from under you — several times a second during
   * a run, which is what makes working alongside an agent impossible. Restoring
   * focus afterwards does not help; it makes it flicker instead of stick.
   *
   * A window of its own removes the conflict rather than managing it: only one
   * tab per window can be foreground, and a tab that is foreground in an
   * *unfocused* window is still visible, so the agent gets the visibility it
   * needs and you keep the window you were in.
   *
   * Off restores the old behaviour of silently taking the focused window, which
   * is what you want if the reason you are watching is to watch.
   */
  soloWindow: true,

  /** Share one background agent window; tab ownership still stays per session. */
  agentWindowPool: true,

  /**
   * Let `browser_tabs select` / `browser_window focus` raise the agent window
   * over whatever the user is doing.
   *
   * Off, and off on purpose. Those two calls exist so a human can be shown a
   * tab, and for a long time they did that by focusing the window — which, in
   * practice, meant an agent window jumping in front of the page someone was
   * reading, mid-keystroke, several times a run. A tab can be made the visible
   * one *inside* the agent window without the window moving at all, and that
   * is what the calls do now. The person watching brings the window forward
   * themselves — the side panel's tab rows do exactly that on click. Turn this
   * on only if you want agents to be able to take the front of the screen.
   */
  raiseWindowOnSelect: false,

  /**
   * Experimental page-focus emulation. It can help a site whose JavaScript
   * explicitly checks document focus, but it is not documented as a native
   * window-occlusion override and is not required for background CDP input.
   * Leave off unless comparing a reproducible site failure with and without it.
   */
  emulateFocus: false,

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
