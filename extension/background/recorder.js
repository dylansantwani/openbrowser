/**
 * Passive capture of console output and network activity.
 *
 * The point is to work retroactively. An agent usually only discovers it needs
 * the console *after* something has gone wrong, and by then re-running the
 * failing action may not be possible. So capture starts when a tab is first
 * touched and runs into a bounded ring buffer, and `browser_inspect` reads back
 * over history rather than starting a fresh recording.
 *
 * Bodies are opt-in. Response bodies are big, frequently binary, and pulling
 * them for every request would dwarf everything else this tool sends.
 */

import * as cdp from './cdp.js';
import { getSettings } from './settings.js';

/** tabId -> {console: [], network: Map<requestId, entry>, order: [], epoch } */
const buffers = new Map();

function bufferFor(tabId) {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = { console: [], network: new Map(), order: [], recording: false, epoch: 0 };
    buffers.set(tabId, buf);
  }
  return buf;
}

/**
 * Begin capturing for a tab. Safe to call repeatedly — it is invoked before
 * every tool call on the assumption that most calls are no-ops.
 */
export async function ensureRecording(tabId) {
  const buf = bufferFor(tabId);
  if (buf.recording) return;

  const settings = await getSettings();
  if (!settings.useDebugger) return; // recording rides on the debugger

  try {
    await cdp.enableDomain(tabId, 'Runtime');
    await cdp.enableDomain(tabId, 'Log');
    await cdp.enableDomain(tabId, 'Network');
    buf.recording = true;
  } catch {
    // Attaching is not always possible (DevTools open, restricted page).
    // Recording is a nice-to-have, so degrade silently rather than failing the
    // caller's actual request.
  }
}

export function stopRecording(tabId) {
  buffers.delete(tabId);
}

function push(list, entry, max) {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

// -----------------------------------------------------------------------------
// CDP event handling
// -----------------------------------------------------------------------------

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const buf = buffers.get(tabId);
  if (!buf) return;

  const settings = await getSettings();

  switch (method) {
    // A navigation replaces the page, and everything captured before it belongs
    // to a different site. Reporting it as the current page's output is not a
    // small inaccuracy: it sent an agent chasing Gmail's CORS errors while
    // looking at Hacker News. Entries are stamped rather than dropped, so a
    // redirect or login chain can still be read back on purpose.
    case 'Runtime.executionContextsCleared':
      buf.epoch++;
      break;

    case 'Runtime.consoleAPICalled': {
      push(buf.console, {
        t: Date.now(),
        e: buf.epoch,
        level: normalizeLevel(params.type),
        text: params.args.map(describeRemoteObject).join(' '),
        source: frameOf(params.stackTrace),
      }, settings.consoleBufferSize);
      break;
    }

    case 'Runtime.exceptionThrown': {
      const detail = params.exceptionDetails;
      push(buf.console, {
        t: Date.now(),
        e: buf.epoch,
        level: 'error',
        text: detail.exception?.description || detail.text || 'uncaught exception',
        source: `${detail.url || ''}:${detail.lineNumber ?? ''}`,
      }, settings.consoleBufferSize);
      break;
    }

    case 'Log.entryAdded': {
      // Browser-generated messages: CSP violations, blocked mixed content,
      // failed subresource loads. These explain a lot of "why is the page
      // broken" questions that page JS never logs.
      const entry = params.entry;
      push(buf.console, {
        t: Date.now(),
        e: buf.epoch,
        level: normalizeLevel(entry.level),
        text: entry.text,
        source: entry.source,
        url: entry.url,
      }, settings.consoleBufferSize);
      break;
    }

    case 'Network.requestWillBeSent': {
      buf.network.set(params.requestId, {
        id: params.requestId,
        t: Date.now(),
        e: buf.epoch,
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        requestHeaders: params.request.headers,
        postData: settings.captureBodies ? truncate(params.request.postData, 2000) : undefined,
        status: null,
      });
      buf.order.push(params.requestId);
      trimNetwork(buf, settings.networkBufferSize);
      break;
    }

    case 'Network.responseReceived': {
      const entry = buf.network.get(params.requestId);
      if (!entry) break;
      entry.status = params.response.status;
      entry.mimeType = params.response.mimeType;
      entry.responseHeaders = params.response.headers;
      entry.fromCache = params.response.fromDiskCache || params.response.fromPrefetchCache || false;
      entry.ms = Date.now() - entry.t;
      break;
    }

    case 'Network.loadingFinished': {
      const entry = buf.network.get(params.requestId);
      if (!entry) break;
      entry.size = params.encodedDataLength;
      entry.ms = Date.now() - entry.t;
      entry.done = true;
      break;
    }

    case 'Network.loadingFailed': {
      const entry = buf.network.get(params.requestId);
      if (!entry) break;
      entry.failed = true;
      entry.error = params.errorText;
      entry.canceled = params.canceled;
      entry.done = true;
      break;
    }
  }
});

/** Drop the oldest requests once we exceed the cap. */
function trimNetwork(buf, max) {
  while (buf.order.length > max) {
    buf.network.delete(buf.order.shift());
  }
}

function normalizeLevel(level) {
  if (level === 'warning') return 'warn';
  if (level === 'verbose' || level === 'debug') return 'debug';
  if (level === 'error' || level === 'warn' || level === 'info') return level;
  return 'log';
}

/**
 * Render a CDP RemoteObject as short readable text. We deliberately do not
 * fetch object properties over the wire — `console.log(hugeObject)` would
 * otherwise cost more than everything else combined.
 */
function describeRemoteObject(obj) {
  if (!obj) return 'undefined';
  if (obj.type === 'string') return obj.value;
  if ('value' in obj) return String(obj.value);
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.description) return truncate(obj.description, 500);
  return obj.type;
}

function frameOf(stackTrace) {
  const frame = stackTrace?.callFrames?.[0];
  if (!frame) return undefined;
  const file = (frame.url || '').split('/').pop();
  return file ? `${file}:${frame.lineNumber + 1}` : undefined;
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max)}… (${str.length} chars)` : str;
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

/**
 * How many buffered entries belong to a page this tab has since navigated away
 * from. Reported alongside the results so the history is discoverable rather
 * than merely hidden.
 */
export function previousPageCounts(tabId) {
  const buf = buffers.get(tabId);
  if (!buf) return { console: 0, network: 0 };
  return {
    console: buf.console.filter((e) => e.e !== buf.epoch).length,
    network: [...buf.network.values()].filter((e) => e.e !== buf.epoch).length,
  };
}

export function getConsole(tabId, { filter, level = 'all', limit = 50, since, includePrevious = false } = {}) {
  const buf = buffers.get(tabId);
  if (!buf) return [];

  let entries = buf.console;
  if (!includePrevious) entries = entries.filter((e) => e.e === buf.epoch);
  if (since) entries = entries.filter((e) => e.t > since);
  if (level === 'error') entries = entries.filter((e) => e.level === 'error');
  else if (level === 'warn') entries = entries.filter((e) => e.level === 'error' || e.level === 'warn');
  if (filter) {
    const test = matcher(filter);
    entries = entries.filter((e) => test(e.text));
  }
  return entries.slice(-limit);
}

export function getNetwork(tabId, { filter, limit = 50, since, includePrevious = false } = {}) {
  const buf = buffers.get(tabId);
  if (!buf) return [];

  let entries = [...buf.network.values()];
  if (!includePrevious) entries = entries.filter((e) => e.e === buf.epoch);
  if (since) entries = entries.filter((e) => e.t > since);
  if (filter) {
    const test = matcher(filter);
    entries = entries.filter((e) => test(e.url));
  }
  return entries.slice(-limit);
}

export function getRequest(tabId, requestId) {
  return buffers.get(tabId)?.network.get(requestId) || null;
}

/**
 * Fetch a response body on demand. Only works while the response is still in
 * the network agent's buffer, which in practice means shortly after it loaded.
 */
export async function getResponseBody(tabId, requestId) {
  try {
    const { body, base64Encoded } = await cdp.send(tabId, 'Network.getResponseBody', { requestId });
    return { body: base64Encoded ? '[binary]' : truncate(body, 20_000), base64Encoded };
  } catch (err) {
    return {
      error:
        `response body unavailable (${err.message}). Bodies are evicted quickly — ` +
        `fetch them right after the request, or re-trigger it.`,
    };
  }
}

/** Accept either a plain substring or a /regex/flags literal. */
function matcher(filter) {
  const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(filter);
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1], asRegex[2]);
      return (s) => re.test(s || '');
    } catch {
      /* fall through to substring */
    }
  }
  const lower = filter.toLowerCase();
  return (s) => (s || '').toLowerCase().includes(lower);
}

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));
