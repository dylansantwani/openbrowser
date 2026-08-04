/**
 * Options page controller.
 *
 * Settings are read once into the form and written back on save. Nothing is
 * applied live except the port, which needs a reconnect — the service worker
 * handles that when it sees the port change.
 */

const $ = (sel) => document.querySelector(sel);

/** Fields that map straight to a settings key, by input type. */
const NUMBER_FIELDS = ['port', 'maxSnapshotChars'];
const BOOLEAN_FIELDS = [
  'autoConnect',
  'useDebugger',
  'highlightActions',
  'showAgentBadge',
  'chooseWindow',
  'restoreFocusAfterInput',
  'autoConfirmLeave',
  'captureBodies',
];
const LIST_FIELDS = ['allowlist', 'blocklist'];

function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || 'request failed'));
      resolve(response.result);
    });
  });
}

function populate(settings) {
  for (const key of NUMBER_FIELDS) $(`#${key}`).value = settings[key] ?? '';
  for (const key of BOOLEAN_FIELDS) $(`#${key}`).checked = !!settings[key];
  for (const key of LIST_FIELDS) $(`#${key}`).value = (settings[key] || []).join('\n');
}

function collect() {
  const patch = {};

  for (const key of NUMBER_FIELDS) {
    const value = Number($(`#${key}`).value);
    if (Number.isFinite(value) && value > 0) patch[key] = value;
  }
  for (const key of BOOLEAN_FIELDS) patch[key] = $(`#${key}`).checked;

  for (const key of LIST_FIELDS) {
    patch[key] = $(`#${key}`)
      .value.split('\n')
      .map((line) => line.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
  }

  return patch;
}

function renderStatus(bridge) {
  const el = $('#live-status');
  el.className = `status status--${bridge.status}`;
  $('#live-status-text').textContent =
    bridge.status === 'connected' ? `connected on ${bridge.port}` :
    bridge.status === 'connecting' ? 'connecting…' : 'not connected';
}

function flashSaved() {
  const badge = $('#saved');
  badge.hidden = false;
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => (badge.hidden = true), 1800);
}

(async function init() {
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;

  try {
    const status = await call('get_status');
    populate(status.settings);
    renderStatus(status.bridge);
  } catch (err) {
    $('#live-status-text').textContent = `unavailable (${err.message})`;
  }

  $('#save').addEventListener('click', async () => {
    await call('update_settings', { patch: collect() });
    flashSaved();
    // The port may have changed; show the resulting connection state.
    setTimeout(async () => {
      try {
        renderStatus((await call('get_status')).bridge);
      } catch {
        /* worker restarting */
      }
    }, 900);
  });

  $('#reset').addEventListener('click', async () => {
    populate(await call('reset_settings'));
    flashSaved();
  });

  // Ctrl/Cmd+S is what people reach for on a settings page.
  addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      $('#save').click();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bridge_status') renderStatus(msg.status);
  });
})();
