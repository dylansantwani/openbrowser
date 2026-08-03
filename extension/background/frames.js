/**
 * Frame discovery, content-script injection, and ref routing.
 *
 * Real sites put the interesting parts inside iframes constantly — payment
 * fields, embedded editors, consent dialogs, chat widgets, ad slots. Automation
 * that only speaks to the top frame fails on all of them, so every operation
 * here is frame-aware by default.
 *
 * Refs carry their frame in the name: `e12` is the main frame, `f2e12` is
 * frame index 2. Encoding it in the ref means a ref stays meaningful across
 * calls without the background keeping a fragile translation table, and it
 * stays readable for whoever is debugging a transcript.
 */

/** tabId -> Map<frameId, index>, so frame indexes stay stable within a tab. */
const frameIndexes = new Map();

const REF_PATTERN = /^(?:f(\d+))?e(\d+)$/;

/** Split a public ref into {frameIndex, localRef}. */
export function parseRef(ref) {
  const match = REF_PATTERN.exec(String(ref).trim());
  if (!match) return null;
  return { frameIndex: match[1] ? Number(match[1]) : 0, localRef: `e${match[2]}` };
}

export function formatRef(frameIndex, localRef) {
  return frameIndex === 0 ? localRef : `f${frameIndex}${localRef}`;
}

function indexMapFor(tabId) {
  let map = frameIndexes.get(tabId);
  if (!map) {
    map = new Map();
    frameIndexes.set(tabId, map);
  }
  return map;
}

/** Stable small index for a frame within a tab. The main frame is always 0. */
function indexForFrame(tabId, frameId) {
  const map = indexMapFor(tabId);
  if (frameId === 0) {
    map.set(0, 0);
    return 0;
  }
  if (map.has(frameId)) return map.get(frameId);
  // Next free index; 0 is reserved for the main frame.
  const used = new Set(map.values());
  let idx = 1;
  while (used.has(idx)) idx++;
  map.set(frameId, idx);
  return idx;
}

function frameIdForIndex(tabId, index) {
  if (index === 0) return 0;
  for (const [frameId, idx] of indexMapFor(tabId)) {
    if (idx === index) return frameId;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Frame enumeration
// -----------------------------------------------------------------------------

/**
 * All frames in a tab that we can plausibly script, main frame first.
 * @returns {Promise<Array<{frameId: number, index: number, url: string, parentFrameId: number}>>}
 */
export async function listFrames(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }
  if (!frames?.length) return [{ frameId: 0, index: 0, url: '', parentFrameId: -1 }];

  return frames
    .filter((f) => /^https?:|^file:|^about:blank/.test(f.url || ''))
    .sort((a, b) => a.frameId - b.frameId)
    .map((f) => ({
      frameId: f.frameId,
      index: indexForFrame(tabId, f.frameId),
      url: f.url,
      parentFrameId: f.parentFrameId,
      errorOccurred: f.errorOccurred,
    }));
}

// -----------------------------------------------------------------------------
// Messaging
// -----------------------------------------------------------------------------

/**
 * Send a command to one frame's content script.
 *
 * Content scripts declared in the manifest only run in pages loaded *after* the
 * extension was installed or reloaded. Tabs that were already open have no
 * script, and the send fails with "Receiving end does not exist". Rather than
 * pushing that onto the caller, we detect it and inject on demand.
 */
export async function sendToFrame(tabId, frameId, cmd, args = {}, { retry = true } = {}) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { cmd, args }, { frameId });
    if (!response) throw new Error('no response from page');
    if (!response.ok) throw new Error(response.error || 'page command failed');
    return response.result;
  } catch (err) {
    const message = err?.message || String(err);

    // A navigation part-way through a call leaves the old document's port dead.
    // Chrome words this three different ways depending on whether the document
    // was discarded, never connected, or stored in the back/forward cache —
    // and the bfcache wording used to fall through to the bottom of this
    // function, so a click that navigated surfaced "The page keeping the
    // extension port is moved into back/forward cache, so the message channel
    // is closed" to the caller. All three mean the same thing and all three are
    // answered the same way: inject into the document that is there now and ask
    // again.
    // "message channel closed" is Chrome's wording when the receiving document
    // goes away part-way through a call — the exact thing a Cloudflare
    // interstitial does, so it surfaced twice in one checkout run.
    const portGone =
      /Receiving end does not exist|Could not establish connection|back\/forward cache|message channel closed/i.test(
        message
      );

    if (retry && portGone) {
      await injectInto(tabId, frameId);
      return sendToFrame(tabId, frameId, cmd, args, { retry: false });
    }
    if (portGone) {
      throw new Error(
        'the page navigated while this call was in flight, so the connection to the previous document closed. ' +
          'Retry against the new page — any refs from before the navigation are stale, so take a fresh snapshot first.'
      );
    }
    if (/Frame with ID .* was removed|No frame with id/i.test(message)) {
      throw new Error('that frame no longer exists — the page navigated; take a fresh snapshot');
    }
    throw new Error(message);
  }
}

/** Convenience: talk to the main frame. */
export function sendToTab(tabId, cmd, args) {
  return sendToFrame(tabId, 0, cmd, args);
}

/** Inject the content scripts into a frame that is missing them. */
export async function injectInto(tabId, frameId = 0) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, frameIds: [frameId] },
      files: ['content/overlay.css'],
    });
  } catch {
    // CSS injection is cosmetic; a failure here must not block the command.
  }

  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ['content/a11y.js', 'content/actions.js', 'content/main.js'],
  });
}

/**
 * Tabs already injected since their last top-level navigation.
 *
 * Injection is idempotent but not free: it round-trips to every frame, and on
 * an app like Gmail that is 13 frames. Doing it before every single tool call
 * added seconds to each one. The manifest already injects on load, so this is
 * only a fallback for tabs that predate the extension — once per navigation is
 * exactly right, and `sendToFrame` still repairs individual frames on demand.
 */
const injectedTabs = new Set();

/** Inject into every frame of a tab. Used when first touching a tab. */
export async function ensureInjected(tabId) {
  if (injectedTabs.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/a11y.js', 'content/actions.js', 'content/main.js'],
    });
  } catch (err) {
    const message = err?.message || String(err);
    if (/Cannot access|chrome:\/\/|extension page|The extensions gallery/i.test(message)) {
      throw new Error(
        'This page cannot be automated — Chrome blocks extensions on browser-internal pages ' +
          '(chrome://, the Web Store, and other extensions\' pages). Navigate somewhere else first.'
      );
    }
    throw new Error(message);
  }
}

/**
 * Run a command in every frame and return the results tagged with frame index.
 * Frames that fail are reported rather than aborting the whole call — a single
 * sandboxed ad iframe should not break a snapshot of the page.
 */
export async function broadcast(tabId, cmd, args = {}, { includeSubframes = true } = {}) {
  const frames = includeSubframes ? await listFrames(tabId) : [{ frameId: 0, index: 0, url: '' }];

  const settled = await Promise.allSettled(
    frames.map(async (frame) => ({
      frame,
      result: await sendToFrame(tabId, frame.frameId, cmd, args),
    }))
  );

  const ok = [];
  const failed = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') ok.push(outcome.value);
    else failed.push({ frame: frames[i], error: outcome.reason?.message || String(outcome.reason) });
  });

  return { frames: ok, failed };
}

/**
 * Ask the top frame to recompute iframe offsets, then give the cascade a beat
 * to reach the leaves. Needed before any coordinate-based action on a target
 * inside an iframe, or the click lands in the wrong place.
 */
export async function refreshFrameOffsets(tabId) {
  try {
    await sendToFrame(tabId, 0, 'broadcastOffsets', {});
    // The cascade is postMessage-based, so it is asynchronous by one task per
    // nesting level. 60ms comfortably covers realistic nesting depths.
    await new Promise((r) => setTimeout(r, 60));
  } catch {
    // Offsets only matter for iframe targets; a failure degrades gracefully to
    // main-frame coordinates.
  }
}

// -----------------------------------------------------------------------------
// Ref routing
// -----------------------------------------------------------------------------

/**
 * Resolve a public ref to the frame that owns it plus the frame-local ref.
 * @returns {Promise<{frameId: number, frameIndex: number, localRef: string}>}
 */
export async function routeRef(tabId, ref) {
  const parsed = parseRef(ref);
  if (!parsed) {
    throw new Error(`"${ref}" is not a valid ref. Refs look like "e12" or "f1e3" and come from browser_snapshot.`);
  }

  const frameId = frameIdForIndex(tabId, parsed.frameIndex);
  if (frameId === null) {
    throw new Error(
      `ref ${ref} points at frame ${parsed.frameIndex}, which is no longer present. Take a fresh snapshot.`
    );
  }

  return { frameId, frameIndex: parsed.frameIndex, localRef: parsed.localRef };
}

/** Rewrite a frame-local tree's refs into public, frame-qualified refs. */
export function qualifyRefs(nodes, frameIndex) {
  if (frameIndex === 0) return nodes;
  const walk = (list) => {
    for (const node of list) {
      if (node.ref) node.ref = formatRef(frameIndex, node.ref);
      if (node.children?.length) walk(node.children);
    }
    return list;
  };
  return walk(nodes);
}

chrome.tabs.onRemoved.addListener((tabId) => frameIndexes.delete(tabId));

// A top-level navigation invalidates every subframe, so old indexes would point
// at frames that no longer exist.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) frameIndexes.delete(tabId);
});
