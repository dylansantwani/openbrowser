/**
 * Which Chrome window a session works in.
 *
 * Tab groups made an agent's tabs legible *within* a window. They do nothing
 * across windows, and a second window is the normal case the moment someone has
 * a work window and a personal one, or a monitor each. Left to itself an agent
 * opened its tabs into whichever window Chrome happened to consider current,
 * which is the one the human was last looking at — so a background job
 * repeatedly shoved tabs into the window you were reading in.
 *
 * So a session picks a window once, up front, and everything it opens goes
 * there. The picking is deliberately a *question* rather than a guess: with two
 * windows open there is no signal that says which one the human meant, and
 * guessing wrong is the failure this whole module exists to stop.
 *
 * Bindings live in `chrome.storage.session` for the usual MV3 reason — the
 * service worker is torn down constantly and this must outlive it — and session
 * storage is exactly the right lifetime, since it is cleared on browser restart,
 * which is when every window id becomes meaningless anyway.
 */

import * as frames from './frames.js';

/** label -> windowId */
const BOUND_KEY = 'sessionWindows';

/**
 * How long the in-browser prompt waits for a human.
 *
 * Under the hub's 120s call timeout, so the agent gets this module's readable
 * "nobody answered" rather than a bare `browser call timed out`.
 */
const PICK_TIMEOUT_MS = 90_000;

/** Pages an extension can never draw on, so they cannot host the prompt. */
const promptable = (tab) => /^https?:|^file:/.test(tab?.url || tab?.pendingUrl || '');

async function readBindings() {
  try {
    return (await chrome.storage.session.get(BOUND_KEY))[BOUND_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * Every change to a shared storage key goes through here, one at a time.
 *
 * `chrome.storage` has no read-modify-write primitive, so the obvious shape —
 * read the map, set your key, write the map back — spans two awaits and loses
 * updates the moment two sessions do it at once. Three agents starting together
 * is not an edge case, it is the reason the hub exists: A reads `{}`, B reads
 * `{}` before A's write lands, B writes `{B}` and A's binding is simply gone.
 *
 * The consequence is not a missing binding, which would be harmless — it is a
 * *wrong* one. A session whose binding vanished asks again, and with a single
 * window open `ensureWindow` answers silently with the focused window, which is
 * where the other agents are already working. That is how three agents end up
 * in one window, each believing it chose.
 *
 * A promise chain is enough because there is exactly one service worker: all
 * calls, from every session, run in this one JS context. It is not enough
 * across worker restarts, but a restart cannot interleave with itself — the old
 * worker is gone before the new one starts.
 */
const writeQueues = new Map();

function mutate(key, fn) {
  const previous = writeQueues.get(key) || Promise.resolve();
  const run = previous.then(async () => {
    let all;
    try {
      all = (await chrome.storage.session.get(key))[key] || {};
    } catch {
      all = {};
    }
    const result = fn(all);
    try {
      await chrome.storage.session.set({ [key]: all });
    } catch {
      /* a lost binding costs one extra question, never a failed call */
    }
    return result;
  });
  // The queue must survive a failed link, or one rejection wedges every later
  // write behind it.
  writeQueues.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

const mutateBindings = (fn) => mutate(BOUND_KEY, fn);

export async function bind(label, windowId) {
  if (!label) return null;
  await mutateBindings((all) => {
    all[label] = windowId;
  });
  return windowId;
}

export async function unbind(label) {
  if (!label) return;
  await mutateBindings((all) => {
    delete all[label];
  });
}

/**
 * The window this session is bound to, or null.
 *
 * Verified against Chrome on every read rather than trusted: the human can
 * close the window a session was working in at any moment, and a stale id turns
 * every later `tabs.create` into an unexplained failure. A window that has gone
 * releases the binding, which sends the session back through the question.
 */
export async function boundWindowId(label) {
  if (!label) return null;
  const id = (await readBindings())[label];
  if (id == null) return null;
  try {
    await chrome.windows.get(id);
    return id;
  } catch {
    await unbind(label);
    return null;
  }
}

/**
 * Normal browser windows, each with the tabs it holds.
 *
 * Filtered here rather than by `getAll({windowTypes})`, which is deprecated —
 * and the filter matters either way: devtools windows and popups are windows as
 * far as Chrome is concerned, and offering someone the choice of putting an
 * agent inside a devtools panel is offering them a mistake.
 */
export async function listWindows() {
  const wins = await chrome.windows.getAll({ populate: true });
  return wins
    .filter((w) => w.type == null || w.type === 'normal')
    .map((w) => ({
      windowId: w.id,
      focused: !!w.focused,
      tabs: w.tabs || [],
    }));
}

/** One line per window: enough for a human to recognise which is which. */
function describe(win, index) {
  const titles = win.tabs
    .slice(0, 4)
    .map((t) => (t.title || t.url || '').replace(/\s+/g, ' ').slice(0, 28))
    .filter(Boolean);
  const more = win.tabs.length > 4 ? `, +${win.tabs.length - 4} more` : '';
  return `  ${index} · window ${win.windowId}${win.focused ? ' (focused)' : ''}  ` +
    `(${win.tabs.length} tab${win.tabs.length === 1 ? '' : 's'}) ${titles.join(', ')}${more}`;
}

/**
 * The question itself.
 *
 * Written to be answered by a *human*, because the model reading it cannot know
 * which window is meant either — its job here is to relay, not to choose. Every
 * option is spelled out as the exact call that takes it, since an agent that has
 * to invent the follow-up call is an agent that guesses a window id.
 */
function chooserError(label, wins) {
  return new Error(
    `${wins.length} browser windows are open — ask the user which one "${label}" should work in. ` +
      'Nothing has been opened yet.\n' +
      wins.map((w, i) => describe(w, i + 1)).join('\n') +
      `\n  ${wins.length + 1} · let the user choose in the browser  →  browser_window action:"pick"\n` +
      'Then call browser_window action:"use" windowId:<id>, or action:"pick" to put the ' +
      'question in every window and wait for a click.'
  );
}

/**
 * The window this session works in, asking if there is any doubt.
 *
 * Throws the chooser rather than picking for you whenever more than one window
 * is open — see the module comment. `chooseWindow: false` in settings is the
 * escape hatch for people running one agent and one window who never want the
 * question.
 *
 * @throws {Error} the chooser, when a human has to decide
 */
export async function ensureWindow(label, settings = {}) {
  if (!label) return null; // the side panel is a human, driving their own window

  const bound = await boundWindowId(label);
  if (bound != null) return bound;

  const wins = await listWindows();

  // No normal window at all — every one closed, or Chrome is showing only a
  // popup. Asking which of nothing to use would be absurd; make one.
  if (!wins.length) {
    const created = await chrome.windows.create({ focused: false });
    return bind(label, created.id);
  }

  if (wins.length === 1 || settings.chooseWindow === false) {
    return bind(label, (wins.find((w) => w.focused) || wins[0]).windowId);
  }

  throw chooserError(label, wins);
}

/**
 * Bind a window the caller named, checking it exists first.
 *
 * The id comes from a model relaying a human's answer, so a wrong one is
 * routine rather than exceptional — the error re-lists the windows so the next
 * attempt has the real ids in front of it.
 */
export async function use(label, windowId) {
  if (!label) throw new Error('only an MCP session can bind a window; the side panel drives the window it is in.');
  try {
    await chrome.windows.get(windowId);
  } catch {
    const wins = await listWindows();
    throw new Error(
      `there is no window ${windowId}. Open windows:\n${wins.map((w, i) => describe(w, i + 1)).join('\n')}`
    );
  }
  await bind(label, windowId);
  return windowId;
}

// -----------------------------------------------------------------------------
// Asking in the browser
// -----------------------------------------------------------------------------

/** token -> {resolve, reject, shown, declined} */
const pending = new Map();

/**
 * In-flight prompts, in storage rather than only in worker memory: token ->
 * `{label, shown, declined, done?, windowId?}`.
 *
 * A pick waits up to 90s on a human, and MV3 will happily tear the worker down
 * in the middle of that — it was observed doing exactly that, with the hub
 * logging a disconnect and reconnect while the prompt sat on screen. The click
 * then arrives at a *fresh* worker whose `pending` map is empty, so the answer
 * is dropped and the call hangs until it times out.
 *
 * Two things follow. The tally of who declined has to live somewhere that
 * survives, which is here. And the promise cannot be resurrected — the call
 * that was waiting on it is already lost — so the *next* attempt reads this
 * record and answers from it instead of asking a question the user already
 * answered.
 *
 * Keyed by token rather than held as a single record, because two sessions can
 * be asking at the same moment. One slot meant the second prompt overwrote the
 * first, and the first session then sat out its whole timeout waiting for an
 * answer that had nowhere to land.
 */
const PICK_KEY = 'windowPickState';

async function readPicks() {
  try {
    return (await chrome.storage.session.get(PICK_KEY))[PICK_KEY] || {};
  } catch {
    return {};
  }
}

const mutatePicks = (fn) => mutate(PICK_KEY, fn);

/**
 * Hold the service worker up while a prompt is on screen.
 *
 * The bridge already pings the hub every 20s, and that was not enough — a
 * WebSocket send does not reliably reset Chrome's idle timer, while an
 * extension API call does. So this calls one, for no reason other than the
 * side effect of being a call. It is the documented MV3 keepalive and it looks
 * exactly as odd as it is.
 */
let keepAliveTimer = null;
const keepAliveHolders = new Set();

function startKeepAlive(token) {
  keepAliveHolders.add(token);
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20_000);
}

/**
 * Reference-counted, because several sessions can be waiting on prompts at
 * once. The first one to finish used to stop the timer for everybody, which
 * left the others exposed to exactly the teardown this exists to prevent.
 */
function stopKeepAlive(token) {
  keepAliveHolders.delete(token);
  if (keepAliveHolders.size || !keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/**
 * The tab that will carry the prompt for a window.
 *
 * The active tab is the right one — it is what the human is looking at — but it
 * is regularly a chrome:// page or the Web Store, where no extension may draw.
 * Falling back to any promptable tab in the same window still puts the question
 * in front of the right person; they just have to glance at a different tab.
 */
function promptTab(win) {
  const active = win.tabs.find((t) => t.active);
  if (promptable(active)) return active;
  return win.tabs.find(promptable) || null;
}

async function clearPrompts(shown, token) {
  await Promise.all(
    shown.map(({ tabId }) =>
      frames.sendToTab(tabId, 'window_pick', { on: false, token }).catch(() => {})
    )
  );
}

/**
 * Put the question in every window and wait for a click.
 *
 * This is the option a human takes when reading window ids off a list is
 * useless to them — which is most people, most of the time. It is opt-in
 * because it draws on whatever page they happen to have open, in every window,
 * and doing that uninvited on the first call of every session would be its own
 * kind of rude.
 */
export async function pick(label, { timeoutMs = PICK_TIMEOUT_MS } = {}) {
  if (!label) throw new Error('only an MCP session can pick a window.');

  // An answer this session already gave, to a prompt whose worker did not live
  // long enough to hear it. Asking again would be asking someone to repeat
  // themselves because we were not listening. Matched on *this session's*
  // label, so a prompt another session has in flight is never consumed here.
  const answered = Object.entries(await readPicks()).find(([, s]) => s.label === label && s.done);
  if (answered) {
    const [token, state] = answered;
    await mutatePicks((all) => {
      delete all[token];
    });
    if (state.done === 'declined') throw declinedError();
    if (state.done === 'chosen' && state.windowId != null) {
      await bind(label, state.windowId);
      return { windowId: state.windowId, asked: true, recovered: true, skipped: 0, tabCount: 0 };
    }
  }

  const wins = await listWindows();
  if (!wins.length) throw new Error('no normal browser windows are open.');
  if (wins.length === 1) {
    await bind(label, wins[0].windowId);
    return { windowId: wins[0].windowId, asked: false };
  }

  const token = crypto.randomUUID();
  const shown = [];
  const unreachable = [];

  for (const win of wins) {
    const tab = promptTab(win);
    if (!tab) {
      unreachable.push(win);
      continue;
    }
    try {
      await frames.ensureInjected(tab.id);
      await frames.sendToTab(tab.id, 'window_pick', {
        on: true,
        token,
        label,
        // Sent so the page can echo it back. The background trusts
        // `sender.tab.windowId` over this, but a message that arrives after the
        // tab moved windows is better answered with something than nothing.
        windowId: win.windowId,
      });
      shown.push({ windowId: win.windowId, tabId: tab.id });
    } catch {
      unreachable.push(win);
    }
  }

  if (!shown.length) {
    throw new Error(
      'could not show the prompt in any window — every one is on a page extensions cannot draw on ' +
        '(chrome://, the Web Store). Open a normal page in the window you want, or pass ' +
        'browser_window action:"use" windowId:<id> using the ids from action:"list".'
    );
  }

  await mutatePicks((all) => {
    all[token] = { label, shown: shown.map((s) => s.windowId), declined: [] };
  });
  startKeepAlive(token);

  const windowId = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(token);
      reject(
        new Error(
          `nobody answered the prompt within ${Math.round(timeoutMs / 1000)}s. ` +
            'It asked in ' + shown.length + ' window(s). Ask the user to click "Use this window", ' +
            'or bind one directly with browser_window action:"use" windowId:<id>.'
        )
      );
    }, timeoutMs);
    pending.set(token, {
      shown,
      declined: new Set(),
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  }).finally(async () => {
    stopKeepAlive(token);
    // Only this session's own cards. Another session may be asking in the same
    // window at the same time, and clearing its prompt would strand it.
    await clearPrompts(shown, token);
    await mutatePicks((all) => {
      delete all[token];
    });
  });

  const chosen = wins.find((w) => w.windowId === windowId);
  return {
    windowId,
    asked: true,
    skipped: unreachable.length,
    tabCount: chosen?.tabs.length ?? 0,
  };
}

/**
 * The human clicked.
 *
 * The binding is written here, before the waiting promise is settled, and
 * whether or not anything is still waiting. An MV3 worker can be torn down
 * while a prompt sits on screen — the click then wakes a *fresh* worker with an
 * empty `pending` map, and the call that opened the prompt is already lost. The
 * answer is not: it is in storage, so the retry that follows finds a bound
 * window and never asks again.
 */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'ob_window_pick') return false;

  const windowId = sender?.tab?.windowId ?? msg.windowId;
  if (windowId == null) return false;

  // Storage first, memory second. The worker answering this may not be the one
  // that asked the question, and the record is the only thing both of them can
  // see. `pending` is then settled if — and only if — we are still the worker
  // that is waiting.
  (async () => {
    if (msg.choice === 'use') {
      await bind(msg.label, windowId);
      await mutatePicks((all) => {
        if (all[msg.token]) all[msg.token] = { ...all[msg.token], done: 'chosen', windowId };
      });
      const entry = pending.get(msg.token);
      if (entry) {
        pending.delete(msg.token);
        entry.resolve(windowId);
      }
      return;
    }

    // Declined. One "not this one" says nothing on its own; only when every
    // window that was asked has refused is there an answer to report.
    //
    // The tally is read and written inside the same queued mutation, so two
    // clicks landing together cannot both read the old count and each conclude
    // they were the first.
    const refusedAll = await mutatePicks((all) => {
      const state = all[msg.token];
      if (!state) return false;
      const declined = [...new Set([...(state.declined || []), windowId])];
      const done = declined.length >= (state.shown || []).length;
      all[msg.token] = { ...state, declined, ...(done ? { done: 'declined' } : {}) };
      return done;
    });

    const entry = pending.get(msg.token);
    if (entry && refusedAll) {
      pending.delete(msg.token);
      entry.reject(declinedError());
    }
  })().catch(() => {
    /* a dropped answer costs one repeated question, never a wrong window */
  });

  return false;
});

function declinedError() {
  return new Error(
    'the user declined every window. Ask them what they want instead — a new window ' +
      '(browser_tabs action:"new" opens one when none is bound), or a specific ' +
      'browser_window action:"use" windowId:<id>.'
  );
}

/**
 * A window the session was using has gone.
 *
 * Cheaper and far less confusing than discovering it on the next `tabs.create`:
 * the binding is dropped here, so the next call asks again instead of failing
 * with a raw Chrome error about an id nothing explains.
 */
chrome.windows.onRemoved.addListener((windowId) => {
  // Through the queue like every other write: this fires while sessions are
  // mid-call, and it used to be the third writer racing the other two.
  mutateBindings((all) => {
    for (const [label, id] of Object.entries(all)) {
      if (id === windowId) delete all[label];
    }
  }).catch(() => {});
});

/** Bound windows, for the side panel and `browser_window action:"list"`. */
export async function summary() {
  const all = await readBindings();
  const wins = await listWindows();
  return wins.map((w) => ({
    ...w,
    sessions: Object.entries(all)
      .filter(([, id]) => id === w.windowId)
      .map(([label]) => label),
  }));
}

export { describe as describeWindow };
