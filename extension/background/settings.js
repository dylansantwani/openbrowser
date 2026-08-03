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
