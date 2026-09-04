/**
 * Options page controller.
 *
 * Settings are read once into the form and written back on save. Nothing is
 * applied live except the port, which needs a reconnect — the service worker
 * handles that when it sees the port change.
 */

const $ = (sel) => document.querySelector(sel);

/** Fields that map straight to a settings key, by input type. */
const NUMBER_FIELDS = ['port', 'maxSnapshotChars', 'consoleBufferSize', 'networkBufferSize'];
const BOOLEAN_FIELDS = [
  'autoConnect',
  'useDebugger',
  'showCursor',
  'highlightActions',
  'showAgentBadge',
  'soloWindow',
  'chooseWindow',
  'groupTabs',
  'closeTabsOnSessionEnd',
  'autoConfirmLeave',
  'captureBodies',
  'agentWindowPool',
  'raiseWindowOnSelect',
  'emulateFocus',
  'logActivity',
];
const LIST_FIELDS = ['allowlist', 'blocklist'];
/** Plain text fields. Empty is meaningful — it means "generate a name for me". */
const TEXT_FIELDS = ['browserName'];

/** Per-field bounds, so an out-of-range value is caught before it is saved. */
const NUMBER_BOUNDS = {
  port: { min: 1024, max: 65535 },
  maxSnapshotChars: { min: 1000, max: 200000 },
  consoleBufferSize: { min: 50, max: 5000 },
  networkBufferSize: { min: 50, max: 5000 },
};

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
  for (const key of TEXT_FIELDS) $(`#${key}`).value = settings[key] ?? '';
  for (const key of BOOLEAN_FIELDS) $(`#${key}`).checked = !!settings[key];
  for (const key of LIST_FIELDS) $(`#${key}`).value = (settings[key] || []).join('\n');
  syncDependencies();
}

/**
 * Show the relationship the prose used to only describe: "Ask which window"
 * does nothing while agents get their own background window, so it is dimmed and
 * made inert then. A dependency you can see beats one buried three lines into a
 * help paragraph nobody reads.
 */
function syncDependencies() {
  const soloOn = $('#soloWindow').checked;
  const row = $('#chooseWindow-row');
  const control = $('#chooseWindow');
  row.classList.toggle('is-disabled', soloOn);
  control.disabled = soloOn;
}

/**
 * Check number fields against their bounds. Returns a human message for the
 * first problem, or null. Catching this before save is the point: the input's
 * min/max are advisory, and a positive-but-out-of-range port (70000) was being
 * saved silently and then failing to bind with nothing naming why.
 */
function validate() {
  for (const key of NUMBER_FIELDS) {
    const raw = $(`#${key}`).value.trim();
    if (raw === '') continue; // empty keeps the current value; not an error
    const value = Number(raw);
    const { min, max } = NUMBER_BOUNDS[key] || {};
    if (!Number.isFinite(value) || (min != null && value < min) || (max != null && value > max)) {
      const label = $(`label[for="${key}"] strong`)?.textContent || key;
      return `${label} must be between ${min?.toLocaleString()} and ${max?.toLocaleString()}.`;
    }
  }
  return null;
}

function collect() {
  const patch = {};

  for (const key of NUMBER_FIELDS) {
    const raw = $(`#${key}`).value.trim();
    if (raw === '') continue;
    const value = Number(raw);
    const { min, max } = NUMBER_BOUNDS[key] || {};
    // validate() has already run on the save path; clamp defensively so a
    // reset-then-save or an edge case can never persist a nonsense value.
    if (Number.isFinite(value) && (min == null || value >= min) && (max == null || value <= max)) {
      patch[key] = value;
    }
  }
  // Trimmed, because " work" and "work" would be two different browsers to
  // anyone reading a chooser and the same one to the person who typed it.
  for (const key of TEXT_FIELDS) patch[key] = $(`#${key}`).value.trim();
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
  // Optional-chained so the page also renders under `npm run preview`, where
  // Chrome defines a bare `window.chrome` with none of the extension APIs.
  $('#version').textContent = `v${chrome.runtime?.getManifest?.().version ?? '—'}`;

  try {
    const status = await call('get_status');
    populate(status.settings);
    renderStatus(status.bridge);
  } catch (err) {
    $('#live-status-text').textContent = `unavailable (${err.message})`;
  }

  $('#soloWindow').addEventListener('change', syncDependencies);

  const portError = $('#port-error');
  const clearError = () => { portError.hidden = true; portError.textContent = ''; };
  for (const key of NUMBER_FIELDS) $(`#${key}`).addEventListener('input', clearError);

  $('#save').addEventListener('click', async () => {
    const problem = validate();
    if (problem) {
      portError.textContent = problem;
      portError.hidden = false;
      return;
    }
    clearError();
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
    clearError();
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

  chrome.runtime?.onMessage?.addListener((msg) => {
    if (msg?.type === 'bridge_status') renderStatus(msg.status);
  });
})();
