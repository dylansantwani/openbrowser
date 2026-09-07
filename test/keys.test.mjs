// Unit tests for key-name normalization (cdp.js) — the pure alias/accelerator
// logic, exercised without a browser. The integration suite (run.mjs) needs a
// live bridge; this does not, so it guards the Mod/Accel token and the
// punctuation aliases on every `npm run test:unit`.
//
// cdp.js registers chrome.debugger/tabs listeners at load and reads navigator
// for IS_MAC, so both are stubbed before import. IS_MAC is fixed at module
// load, so the two platforms are loaded as two module instances via a
// cache-busting query.

const noopEvent = { addListener() {}, removeListener() {} };
const CHROME_STUB = {
  debugger: { onEvent: noopEvent, onDetach: noopEvent },
  tabs: { onRemoved: noopEvent, onUpdated: noopEvent, onActivated: noopEvent },
  storage: {
    onChanged: noopEvent,
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  runtime: { onMessage: noopEvent, getManifest: () => ({ name: 'test', version: '0' }) },
  webNavigation: { onDOMContentLoaded: noopEvent, onCommitted: noopEvent },
  windows: { onRemoved: noopEvent },
};

let failures = 0;
function eq(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

async function loadCdp(platform, tag) {
  globalThis.chrome = CHROME_STUB;
  // Node ships a read-only `navigator` global, so replace it via defineProperty
  // rather than assignment.
  Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true });
  // Cache-bust so each platform is a fresh module instance (IS_MAC/ACCEL are
  // computed once at load).
  return import(`../extension/background/cdp.js?platform=${tag}`);
}

console.log('cdp key normalization\n');

// --- macOS: the accelerator is Meta (Cmd) ---
const mac = await loadCdp('MacIntel', 'mac');
eq(mac.IS_MAC, true, 'IS_MAC is true on MacIntel');
eq(mac.normalizeKeyName('Mod'), 'Meta', 'Mod → Meta on macOS');
eq(mac.normalizeKeyName('mod'), 'Meta', 'mod (lowercase) → Meta on macOS');
eq(mac.normalizeKeyName('Accel'), 'Meta', 'Accel → Meta on macOS');
eq(mac.normalizeKeyName('CmdOrCtrl'), 'Meta', 'CmdOrCtrl → Meta on macOS');
eq(mac.normalizeKeyName('CommandOrControl'), 'Meta', 'CommandOrControl → Meta on macOS');

// --- Windows/Linux: the accelerator is Control ---
const win = await loadCdp('Win32', 'win');
eq(win.IS_MAC, false, 'IS_MAC is false on Win32');
eq(win.normalizeKeyName('Mod'), 'Control', 'Mod → Control off macOS');
eq(win.normalizeKeyName('Accel'), 'Control', 'Accel → Control off macOS');

// --- Punctuation names resolve to their characters (was "unknown key") ---
eq(mac.normalizeKeyName('period'), '.', 'period → .');
eq(mac.normalizeKeyName('comma'), ',', 'comma → ,');
eq(mac.normalizeKeyName('slash'), '/', 'slash → /');
eq(mac.normalizeKeyName('minus'), '-', 'minus → -');
eq(mac.normalizeKeyName('equals'), '=', 'equals → =');
eq(mac.normalizeKeyName('bracketleft'), '[', 'bracketleft → [');

// --- Existing behavior still holds ---
eq(mac.normalizeKeyName('ctrl'), 'Control', 'ctrl → Control (literal, unchanged)');
eq(mac.normalizeKeyName('cmd'), 'Meta', 'cmd → Meta (literal, unchanged)');
eq(mac.normalizeKeyName('esc'), 'Escape', 'esc → Escape');
eq(mac.normalizeKeyName('ENTER'), 'Enter', 'ENTER → Enter (case-insensitive)');
eq(mac.normalizeKeyName('a'), 'a', 'a → a (unmapped single char passes through)');

console.log(`\n${failures ? `FAILED (${failures})` : 'all passed'}`);
process.exit(failures ? 1 : 0);
