/**
 * Chrome DevTools Protocol wrapper.
 *
 * This is the difference between automation that works and automation that
 * mysteriously does nothing. `element.click()` produces an event with
 * `isTrusted: false`, and payment forms, login pages, drag-and-drop libraries,
 * and canvas apps all check that flag. CDP's Input domain injects events at the
 * browser level, so they are indistinguishable from a real user's.
 *
 * The cost is the "OpenBrowser is debugging this browser" infobar. We attach
 * lazily — only when a tab actually needs trusted input — and detach when the
 * tab goes away, to keep that banner off tabs the agent is merely reading.
 */

import { getSettings } from './settings.js';

/** tabId -> {attached: boolean, domains: Set<string>} */
const sessions = new Map();

/** In-flight attach promises, so concurrent calls do not race. */
const attaching = new Map();

const PROTOCOL_VERSION = '1.3';

/**
 * Ceiling for a full-page capture in device pixels. The capture is one GPU
 * texture, so this is the GPU's max texture size, not a number we chose.
 * 16384 is the common limit (Intel and older NVIDIA); captures beyond it stall
 * for ~15s and die with "Unable to capture screenshot" and no explanation.
 */
const MAX_FULL_PAGE_DEVICE_PX = 16384;

/**
 * Attach the debugger to a tab, if it is not already attached.
 * @returns {Promise<boolean>} false when attaching is not possible
 */
export async function attach(tabId) {
  const existing = sessions.get(tabId);
  if (existing?.attached) return true;
  if (attaching.has(tabId)) return attaching.get(tabId);

  const promise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      sessions.set(tabId, { attached: true, domains: new Set() });
      await emulateFocus(tabId);
      return true;
    } catch (err) {
      const message = err?.message || String(err);

      // Someone else already owns the debugger for this tab. That is usually
      // DevTools being open, and it is a common enough footgun to name it.
      if (/already attached/i.test(message)) {
        // It might be *us*, from a previous service-worker generation.
        if (/another debugger|devtools/i.test(message)) {
          throw new Error(
            'DevTools is open on this tab, which blocks trusted input. Close DevTools, or use a different tab.'
          );
        }
        sessions.set(tabId, { attached: true, domains: new Set() });
        await emulateFocus(tabId);
        return true;
      }

      if (/cannot access|chrome:\/\/|extension/i.test(message)) {
        throw new Error(`Cannot attach to this page (${message}). Browser-internal pages cannot be automated.`);
      }
      throw err;
    } finally {
      attaching.delete(tabId);
    }
  })();

  attaching.set(tabId, promise);
  return promise;
}

/**
 * Optional focus-state emulation for sites whose own logic gates behaviour on
 * document focus. This is not a window-management primitive and is deliberately
 * off by default: CDP does not document it as an occlusion/compositing override,
 * and direct Input.dispatch* already targets background tabs without raising
 * Chrome. Keep it available for controlled A/B diagnosis, not as a hidden
 * prerequisite for input delivery.
 *
 * Direct `chrome.debugger.sendCommand`, not `send()`, to avoid re-entering
 * `attach()` from inside it. Best-effort throughout: a browser too old to know
 * the method, or any other refusal, must never turn a successful attach into a
 * failed one — the tab still works, it just works the way it did before.
 */
async function emulateFocus(tabId) {
  try {
    if ((await getSettings()).emulateFocus === false) return;
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch {
    /* older Chrome, or a race with detach — the attach itself still stands */
  }
}

export async function detach(tabId) {
  if (!sessions.has(tabId)) return;
  sessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* tab already closed */
  }
}

export function isAttached(tabId) {
  return !!sessions.get(tabId)?.attached;
}

export function attachedTabs() {
  return [...sessions.keys()];
}

/** Send a CDP command, attaching first if needed. */
export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    const message = err?.message || String(err);
    // The debugger silently detaches on navigation and on crashes. One retry
    // covers that without papering over real failures.
    if (/not attached|detached/i.test(message)) {
      sessions.delete(tabId);
      await attach(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw new Error(`${method} failed: ${message}`);
  }
}

/** Enable a CDP domain once per tab. */
export async function enableDomain(tabId, domain, params = {}) {
  await attach(tabId);
  const session = sessions.get(tabId);
  if (session.domains.has(domain)) return;
  await send(tabId, `${domain}.enable`, params);
  session.domains.add(domain);
}

// -----------------------------------------------------------------------------
// Mouse input
// -----------------------------------------------------------------------------

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(modifiers = []) {
  return modifiers.reduce((mask, m) => mask | (MODIFIER_BITS[m] || 0), 0);
}

const BUTTON_NAMES = { left: 'left', right: 'right', middle: 'middle' };

/**
 * A full press/release at a point.
 *
 * The `mouseMoved` before pressing is not optional: hover-activated menus,
 * tooltip-gated buttons, and any UI that tracks pointer position need to see
 * the cursor arrive before it clicks, exactly as a real user would.
 */
export async function click(tabId, x, y, { button = 'left', clickCount = 1, modifiers = [], delay = 0 } = {}) {
  const mods = modifierMask(modifiers);
  const btn = BUTTON_NAMES[button] || 'left';
  const base = { x: Math.round(x), y: Math.round(y), button: btn, modifiers: mods, pointerType: 'mouse' };

  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0, force: 0 });
  if (delay) await sleep(delay);

  const buttons = btn === 'left' ? 1 : btn === 'right' ? 2 : 4;
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount, buttons, force: 0.5 });
  await sleep(delay || 20); // a zero-duration press reads as a glitch to some UIs
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount, buttons: 0, force: 0 });
}

export async function doubleClick(tabId, x, y, opts = {}) {
  // Two separate clicks with escalating clickCount, which is what the browser
  // itself produces. Sending clickCount:2 alone does not fire `dblclick`.
  await click(tabId, x, y, { ...opts, clickCount: 1 });
  await sleep(40);
  await click(tabId, x, y, { ...opts, clickCount: 2 });
}

export async function hover(tabId, x, y, { modifiers = [] } = {}) {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    modifiers: modifierMask(modifiers),
    buttons: 0,
    pointerType: 'mouse',
  });
}

/**
 * Drag from one point to another.
 *
 * Interpolated intermediate moves are what make this work with HTML5 drag-and-
 * drop and with libraries like dnd-kit or react-beautiful-dnd: they need to see
 * movement above a threshold to start a drag, and a single jump to the
 * destination reads as a click.
 */
export async function drag(tabId, from, to, { steps = 12, modifiers = [] } = {}) {
  const mods = modifierMask(modifiers);
  const point = (x, y, type, buttons) =>
    send(tabId, 'Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y),
      button: 'left', buttons, force: buttons ? 0.5 : 0, modifiers: mods, pointerType: 'mouse',
    });

  await point(from.x, from.y, 'mouseMoved', 0);
  await point(from.x, from.y, 'mousePressed', 1);
  await sleep(60); // let the drag threshold register

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out so the motion looks human to velocity-sensitive handlers.
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await point(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased, 'mouseMoved', 1);
    await sleep(16);
  }

  await sleep(60);
  await point(to.x, to.y, 'mouseReleased', 0);
}

export async function scroll(tabId, x, y, deltaX, deltaY) {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX,
    deltaY,
    pointerType: 'mouse',
  });
}

// -----------------------------------------------------------------------------
// Keyboard input
// -----------------------------------------------------------------------------

/**
 * Keys that need explicit virtual key codes. Printable characters are handled
 * generically below; these are the ones where CDP needs `code`,
 * `windowsVirtualKeyCode`, and `key` to agree or the page sees nothing.
 */
const KEYS = {
  Enter:      { code: 'Enter',      vk: 13, text: '\r' },
  Tab:        { code: 'Tab',        vk: 9,  text: '\t' },
  Escape:     { code: 'Escape',     vk: 27 },
  Backspace:  { code: 'Backspace',  vk: 8 },
  Delete:     { code: 'Delete',     vk: 46 },
  ArrowUp:    { code: 'ArrowUp',    vk: 38 },
  ArrowDown:  { code: 'ArrowDown',  vk: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home:       { code: 'Home',       vk: 36 },
  End:        { code: 'End',        vk: 35 },
  PageUp:     { code: 'PageUp',     vk: 33 },
  PageDown:   { code: 'PageDown',   vk: 34 },
  Space:      { code: 'Space',      vk: 32, text: ' ', key: ' ' },
  Shift:      { code: 'ShiftLeft',  vk: 16 },
  Control:    { code: 'ControlLeft', vk: 17 },
  Alt:        { code: 'AltLeft',    vk: 18 },
  Meta:       { code: 'MetaLeft',   vk: 91 },
  F1:  { code: 'F1',  vk: 112 }, F2:  { code: 'F2',  vk: 113 },
  F3:  { code: 'F3',  vk: 114 }, F4:  { code: 'F4',  vk: 115 },
  F5:  { code: 'F5',  vk: 116 }, F6:  { code: 'F6',  vk: 117 },
  F7:  { code: 'F7',  vk: 118 }, F8:  { code: 'F8',  vk: 119 },
  F9:  { code: 'F9',  vk: 120 }, F10: { code: 'F10', vk: 121 },
  F11: { code: 'F11', vk: 122 }, F12: { code: 'F12', vk: 123 },
};

/** Aliases people (and models) actually type. */
const KEY_ALIASES = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown', ctrl: 'Control', cmd: 'Meta',
  command: 'Meta', option: 'Alt', spacebar: 'Space', ' ': 'Space',
};

function normalizeKeyName(name) {
  const alias = KEY_ALIASES[name.toLowerCase()];
  if (alias) return alias;
  // Accept any casing for the named keys: "enter", "ENTER", "Enter".
  const exact = Object.keys(KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  return exact || name;
}

/**
 * Press a key or chord: "Enter", "Control+a", "Shift+Tab", "Meta+Shift+p".
 * Modifiers are pressed, the main key is struck, then modifiers are released —
 * the same order a physical keyboard produces.
 */
export async function pressKey(tabId, combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  const keyName = normalizeKeyName(parts.pop() || '');
  const modifiers = parts.map(normalizeKeyName);
  const mods = modifierMask(modifiers);

  for (const mod of modifiers) {
    const def = KEYS[mod];
    if (!def) continue;
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', code: def.code, key: mod,
      windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: mods,
    });
  }

  const def = KEYS[keyName];
  if (def) {
    const key = def.key || keyName;
    // `text` is what turns a key event into an inserted character. Omitting it
    // for chords is deliberate: Control+a should select all, not type "a".
    const text = mods & ~MODIFIER_BITS.Shift ? undefined : def.text;
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      code: def.code, key,
      windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
      modifiers: mods, ...(text ? { text } : {}),
    });
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', code: def.code, key,
      windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: mods,
    });
  } else if (keyName.length === 1) {
    await typeChar(tabId, keyName, mods);
  } else {
    throw new Error(`unknown key: "${combo}"`);
  }

  for (const mod of modifiers.reverse()) {
    const modDef = KEYS[mod];
    if (!modDef) continue;
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', code: modDef.code, key: mod,
      windowsVirtualKeyCode: modDef.vk, nativeVirtualKeyCode: modDef.vk, modifiers: 0,
    });
  }
}

/**
 * Windows virtual key codes for punctuation.
 *
 * Deriving these from `charCodeAt` is a trap that silently corrupts typed text:
 * '.' is charCode 46, which is VK_DELETE, and "'" is 39, which is VK_RIGHT. So
 * every period deleted the character ahead of the caret and every apostrophe
 * moved the caret instead of typing — punctuation just vanished from the input.
 */
const PUNCTUATION_VK = {
  ';': 186, ':': 186,
  '=': 187, '+': 187,
  ',': 188, '<': 188,
  '-': 189, '_': 189,
  '.': 190, '>': 190,
  '/': 191, '?': 191,
  '`': 192, '~': 192,
  '[': 219, '{': 219,
  '\\': 220, '|': 220,
  ']': 221, '}': 221,
  "'": 222, '"': 222,
  ' ': 32,
};

/** Characters produced by shift + a digit key. */
const SHIFTED_DIGITS = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
};

async function typeChar(tabId, char, mods = 0) {
  // Anything outside ASCII — emoji, accents, CJK, typographic dashes — has no
  // meaningful virtual key code. Insert it as text instead of inventing one.
  if (char.codePointAt(0) > 127) {
    await send(tabId, 'Input.insertText', { text: char });
    return;
  }

  let vk;
  let code = '';
  if (/[a-zA-Z]/.test(char)) {
    const upper = char.toUpperCase();
    vk = upper.charCodeAt(0);
    code = `Key${upper}`;
  } else if (/[0-9]/.test(char)) {
    vk = char.charCodeAt(0);
    code = `Digit${char}`;
  } else if (char in SHIFTED_DIGITS) {
    const digit = SHIFTED_DIGITS[char];
    vk = digit.charCodeAt(0);
    code = `Digit${digit}`;
  } else if (char in PUNCTUATION_VK) {
    vk = PUNCTUATION_VK[char];
  } else {
    await send(tabId, 'Input.insertText', { text: char });
    return;
  }

  const withText = !(mods & ~MODIFIER_BITS.Shift); // chords must not insert text

  await send(tabId, 'Input.dispatchKeyEvent', {
    type: withText ? 'keyDown' : 'rawKeyDown',
    key: char, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    modifiers: mods, ...(withText ? { text: char } : {}),
  });
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: char, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods,
  });
}

/**
 * Type a string as real keystrokes.
 *
 * With `delay: 0` we use `Input.insertText`, which is one IPC round trip for
 * the whole string and is dramatically faster. That skips per-key events
 * though, so anything with input masking, character counters, or as-you-type
 * validation needs the slow path — hence the delay parameter.
 *
 * `newline: 'soft'` sends Shift+Enter between lines. In a rich editor a plain
 * Enter opens a new paragraph, which renders as a blank line — so "\n" gives
 * one break, "\n\n" gives three, and exactly one blank line between paragraphs
 * is not reachable at all. Shift+Enter is the break every such editor honours.
 */
export async function typeText(tabId, text, { delay = 0, newline } = {}) {
  if (!text) return;

  if (newline === 'soft' && text.includes('\n')) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await pressKey(tabId, 'Shift+Enter');
      await typeText(tabId, lines[i], { delay });
    }
    return;
  }

  if (delay <= 0) {
    await send(tabId, 'Input.insertText', { text });
    return;
  }

  for (const char of text) {
    if (char === '\n') await pressKey(tabId, 'Enter');
    else if (char === '\t') await pressKey(tabId, 'Tab');
    else await typeChar(tabId, char);
    await sleep(delay);
  }
}

// -----------------------------------------------------------------------------
// Page-level helpers
// -----------------------------------------------------------------------------

/**
 * Screenshot. `fullPage` uses captureBeyondViewport, which grabs the whole
 * scrollable page in one shot without the seams that stitching produces.
 */
export async function captureScreenshot(tabId, { format = 'jpeg', quality = 70, fullPage = false, clip } = {}) {
  const params = { format, ...(format === 'jpeg' ? { quality } : {}) };

  if (clip) {
    params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
  } else if (fullPage) {
    const metrics = await send(tabId, 'Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize;
    // Chrome allocates the capture as one GPU texture; past the max texture
    // size (commonly 16384 device px) it stalls for ~15s and then fails with a
    // bare protocol error that reads like a retryable glitch. Refuse up front
    // with the way out instead.
    const dpr = metrics.cssDeviceScaleFactor || 1;
    if (Math.round(content.height * dpr) > MAX_FULL_PAGE_DEVICE_PX) {
      throw new Error(
        `the page is ${Math.round(content.height).toLocaleString()}px tall — too tall to capture in one image; ` +
          `use mode:"region" over the part you need, or scroll and take viewport shots`
      );
    }
    params.clip = { x: 0, y: 0, width: content.width, height: content.height, scale: 1 };
    params.captureBeyondViewport = true;
  }

  const { data } = await send(tabId, 'Page.captureScreenshot', params);
  return data; // base64
}

/** Listeners waiting on a one-shot CDP event: `${tabId}:${method}` -> Set<fn>. */
const eventWaiters = new Map();

/**
 * Native JS dialogs (alert/confirm/beforeunload/prompt) pause the renderer.
 * They are invisible to the accessibility tree and unclickable by CDP input,
 * so without this every page-side call after one opens hangs until timeout
 * with no explanation. The `Page.javascriptDialogOpening` event is the only
 * record that one exists; `Page.javascriptDialogClosed` clears it.
 */
const dialogs = new Map();

/** The open native dialog on this tab, or null. */
export function pendingDialog(tabId) {
  return dialogs.get(tabId) || null;
}

/** Answer a native JS dialog. accept:true = OK/Leave, false = Cancel/Stay. */
export async function handleDialog(tabId, { accept, promptText } = {}) {
  await enableDomain(tabId, 'Page');
  const params = { accept: !!accept };
  if (promptText !== undefined) params.promptText = promptText;
  await send(tabId, 'Page.handleJavaScriptDialog', params);
  dialogs.delete(tabId);
}

/**
 * "Leave site?" prompts answered for a tab since the last read, so a navigation
 * can say it happened. Auto-answering is defensible; doing it silently is not —
 * a page that refused to be left is worth one line in the result.
 */
const autoDismissed = new Map();

/** Consume the record of auto-answered leave prompts for a tab. */
export function takeAutoDismissed(tabId) {
  const n = autoDismissed.get(tabId) || 0;
  autoDismissed.delete(tabId);
  return n;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    const type = params?.type || 'dialog';
    dialogs.set(source.tabId, { type, message: params?.message || '' });

    // A beforeunload prompt is not a question the page needs answered — it is
    // the page objecting to a departure that has already been asked for. The
    // caller said "go there"; stopping to ask whether it meant it strands the
    // run behind a native box nothing on the page side can reach. `confirm()`
    // and friends are genuine questions and stay blocking below.
    if (type === 'beforeunload') {
      getSettings()
        .then((settings) => {
          if (settings.autoConfirmLeave === false) return;
          autoDismissed.set(source.tabId, (autoDismissed.get(source.tabId) || 0) + 1);
          return handleDialog(source.tabId, { accept: true });
        })
        // Leaving it recorded as pending is the right failure: the next call
        // fails fast and names it rather than hanging on a paused renderer.
        .catch(() => {});
    }
  } else if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(source.tabId);
  }
  const waiters = eventWaiters.get(`${source.tabId}:${method}`);
  if (!waiters) return;
  for (const fn of waiters) fn(params);
});

/** Resolve with the next occurrence of a CDP event on this tab. */
export function once(tabId, method, timeout = 5000) {
  const key = `${tabId}:${method}`;
  return new Promise((resolve, reject) => {
    const set = eventWaiters.get(key) || new Set();
    eventWaiters.set(key, set);

    const cleanup = () => {
      set.delete(handler);
      if (!set.size) eventWaiters.delete(key);
      clearTimeout(timer);
    };
    const handler = (params) => {
      cleanup();
      resolve(params);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${method}`));
    }, timeout);

    set.add(handler);
  });
}

/**
 * Attach files by intercepting the native file picker.
 *
 * Most modern upload UIs do not put an `<input type=file>` in the DOM up front —
 * they create it on demand when their styled button is clicked. There is
 * nothing to target until the click happens, and once it does, the OS file
 * dialog opens and blocks the page.
 *
 * Interception solves both halves: Chrome suppresses the native dialog and
 * hands us the input node instead, which we can then fill directly. This is the
 * only approach that works on Meta Business Suite, Google Drive, and most
 * React drop-zone components.
 *
 * The click is retried once. A first attempt that lands but opens nothing is a
 * transient by nature — the styled button's handler has usually just not
 * attached yet — and it cost two consecutive hard failures on Meta before a
 * page reload made it work.
 *
 * @param {() => Promise<void>} triggerClick performs the click that opens the
 *   picker. Called once per attempt, so it should re-resolve its target rather
 *   than reuse a stale point.
 */
export async function uploadViaFileChooser(tabId, triggerClick, paths, { attempts = 2 } = {}) {
  await enableDomain(tabId, 'Page');
  await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });

  try {
    for (let attempt = 1; ; attempt++) {
      // Start listening before clicking — the event can arrive immediately.
      const opened = once(tabId, 'Page.fileChooserOpened', 8000);
      await triggerClick();

      let event;
      try {
        event = await opened;
      } catch (err) {
        if (attempt < attempts) {
          await sleep(700);
          continue;
        }
        throw new Error(
          `${err.message} after ${attempts} attempts — the click landed but no file picker opened. ` +
            'Take a fresh snapshot and confirm the ref is the control that opens the picker, ' +
            'or wait for the page to finish loading and try again.'
        );
      }

      if (!event.backendNodeId) {
        throw new Error('file chooser opened but Chrome did not identify the input element');
      }
      if (event.mode === 'selectSingle' && paths.length > 1) {
        throw new Error('that control accepts one file, but several paths were given');
      }

      await send(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: event.backendNodeId });
      return true;
    }
  } finally {
    // Always restore, or the user's own clicks stop opening file dialogs.
    await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

/** Attach files to a file input identified by CSS selector. */
export async function setFileInput(tabId, selector, paths) {
  await enableDomain(tabId, 'DOM');
  const { root } = await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`file input not found for selector: ${selector}`);
  await send(tabId, 'DOM.setFileInputFiles', { nodeId, files: paths });
}

export async function setDeviceMetrics(tabId, { width, height, deviceScaleFactor = 1, mobile = false }) {
  await send(tabId, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
}

export async function clearDeviceMetrics(tabId) {
  await send(tabId, 'Emulation.clearDeviceMetricsOverride');
}

export async function setColorScheme(tabId, scheme) {
  await send(tabId, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
}

const THROTTLE_PROFILES = {
  none:    { offline: false, latency: 0,   downloadThroughput: -1,                 uploadThroughput: -1 },
  fast3g:  { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  slow3g:  { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8,   uploadThroughput: (500 * 1024) / 8 },
  offline: { offline: true,  latency: 0,   downloadThroughput: 0,                  uploadThroughput: 0 },
};

export async function setThrottle(tabId, profile) {
  const conditions = THROTTLE_PROFILES[profile];
  if (!conditions) throw new Error(`unknown throttle profile: ${profile}`);
  await enableDomain(tabId, 'Network');
  await send(tabId, 'Network.emulateNetworkConditions', conditions);
}

export async function setUserAgent(tabId, userAgent) {
  await send(tabId, 'Emulation.setUserAgentOverride', { userAgent });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A tab we were driving has gone. Drop our bookkeeping so a later attach to a
// recycled tabId starts clean.
chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId != null) {
    sessions.delete(tabId);
    dialogs.delete(tabId);
    autoDismissed.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  dialogs.delete(tabId);
  autoDismissed.delete(tabId);
});
