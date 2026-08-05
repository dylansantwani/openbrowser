/**
 * Service worker entry point.
 *
 * Under MV3 this file runs, gets suspended, and runs again — repeatedly, all
 * day. So it holds no meaningful state of its own: everything durable lives in
 * chrome.storage, and everything transient is rebuilt on demand. Every
 * top-level statement here must be safe to execute many times.
 */

import { Bridge } from './bridge.js';
import { dispatch, onActivity } from './router.js';
import { getSettings, updateSettings, resetSettings, getDefaults } from './settings.js';
import * as cdp from './cdp.js';
import * as macros from './macros.js';

const bridge = new Bridge(dispatch);

// Recent tool calls, for the side panel's activity feed. Deliberately in
// memory: it is a debugging convenience, and losing it on suspend is fine.
const activity = [];
const ACTIVITY_LIMIT = 100;

onActivity((entry) => {
  activity.push({ ...entry, t: Date.now() });
  if (activity.length > ACTIVITY_LIMIT) activity.shift();
  chrome.runtime.sendMessage({ type: 'activity', entry }).catch(() => {});
});

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

async function boot() {
  // Before anything else: a respawned worker that had a live link is
  // reconnecting, not disconnected. Doing this first means the badge and any
  // open UI never flash "not connected" during a routine MV3 recycle.
  await bridge.restore();
  const settings = await getSettings();
  if (settings.autoConnect) bridge.connect();
  updateBadge();
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await boot();
  // Show people what they just installed rather than leaving them to find it.
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// A suspended worker is revived by this alarm, which then re-establishes the
// hub connection. Without it, the extension goes quiet after ~30s idle and
// never comes back until the user clicks something.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ob-reconnect' && bridge.status === 'disconnected') {
    getSettings().then((s) => {
      if (s.autoConnect) bridge.connect();
    });
  }
});

// The worker may have just been respawned by any event at all; make sure the
// connection is live whenever this module evaluates.
boot();

// -----------------------------------------------------------------------------
// Badge
// -----------------------------------------------------------------------------

function updateBadge() {
  const status = bridge.status;
  const config = {
    connected: { text: '', color: '#22c55e' },
    connecting: { text: '···', color: '#eab308' },
    disconnected: { text: '○', color: '#94a3b8' },
  }[status] || { text: '', color: '#94a3b8' };

  chrome.action.setBadgeText({ text: config.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: config.color }).catch(() => {});
  chrome.action
    .setTitle({
      title:
        status === 'connected'
          ? `OpenBrowser · connected on port ${bridge.port}`
          : `OpenBrowser · ${status}`,
    })
    .catch(() => {});
}

bridge.onStatusChange(updateBadge);

// -----------------------------------------------------------------------------
// UI surface
// -----------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/**
 * Messages from the side panel and options page.
 *
 * The panel drives exactly the same `dispatch` that MCP calls go through, so
 * there is no second code path to keep in sync — anything an agent can do, the
 * panel can do, and it behaves identically.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content scripts also post here; those are handled by their own listeners.
  if (!msg?.type) return false;

  const handlers = {
    async get_status() {
      // The options page usually asks the instant it opens, which is often the
      // very event that respawned this worker — so make sure the restored
      // status is in place before answering, or the first paint says "not
      // connected" and corrects itself a moment later.
      await bridge.restore();
      const settings = await getSettings();
      return {
        bridge: bridge.getStatus(),
        settings,
        defaults: getDefaults(),
        activity: activity.slice(-50),
        attachedTabs: cdp.attachedTabs(),
        macros: await macros.list(),
      };
    },

    async connect() {
      await bridge.reconnect();
      return bridge.getStatus();
    },

    async disconnect() {
      bridge.disconnect();
      return bridge.getStatus();
    },

    async update_settings() {
      const settings = await updateSettings(msg.patch || {});
      // Both of these are only ever sent in the hello, so they take effect on a
      // fresh connection and nowhere else. Renaming a browser and having the
      // chooser keep showing the old name would be its own small betrayal.
      const patch = msg.patch || {};
      if ('port' in patch || 'browserName' in patch) await bridge.reconnect();
      return settings;
    },

    async reset_settings() {
      return resetSettings();
    },

    /** The panel's "run a tool" form, and its quick actions. */
    async run_tool() {
      return dispatch(msg.tool, msg.args || {});
    },

    async detach_all() {
      await Promise.all(cdp.attachedTabs().map((tabId) => cdp.detach(tabId)));
      return { detached: true };
    },

    async delete_macro() {
      await macros.remove(msg.name);
      return macros.list();
    },
  };

  const handler = handlers[msg.type];
  if (!handler) return false;

  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

  return true; // async response
});

// -----------------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------------

// Leaving the debugger attached would keep the "being debugged" banner up on a
// tab nobody is driving any more.
chrome.tabs.onRemoved.addListener((tabId) => cdp.detach(tabId));

chrome.runtime.onSuspend.addListener(() => {
  for (const tabId of cdp.attachedTabs()) cdp.detach(tabId);
});
