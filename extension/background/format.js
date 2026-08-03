/**
 * Turning structured page data into the text a model actually reads.
 *
 * Every byte here is a token someone pays for, on every step of every task, so
 * the format is optimised hard:
 *
 *   - Two-space indentation carries the tree structure. No box drawing, no
 *     repeated keys, no JSON punctuation.
 *   - Fields are positional: `role "name" [ref] states`. A model infers that
 *     grammar from two lines and never needs it explained.
 *   - Anything derivable is omitted. No `visible: true`, no empty arrays, no
 *     coordinates unless coordinates are the point.
 *
 * For reference, the same login page costs roughly 180 tokens here versus
 * ~4,000 as a raw a11y JSON dump and ~1,500 as a screenshot.
 */

/** Snapshot text per tab, so `mode: "diff"` has something to compare against. */
const lastSnapshots = new Map();

// -----------------------------------------------------------------------------
// Page header
// -----------------------------------------------------------------------------

/** One compact line of context: where we are and what state the viewport is in. */
export function pageHeader(meta, tabId) {
  const url = shortUrl(meta.url);
  const parts = [url];
  if (meta.title && !titleIsRedundant(meta.title, url)) parts.push(`"${truncate(meta.title, 80)}"`);
  parts.push(`tab ${tabId}`);

  if (meta.viewport) parts.push(`${meta.viewport.w}x${meta.viewport.h}`);

  // Scroll position only matters when the page is actually scrolled.
  if (meta.scroll?.y > 0) {
    const pct = meta.scroll.maxY > 0 ? Math.round((meta.scroll.y / meta.scroll.maxY) * 100) : 0;
    parts.push(`scrolled ${pct}%`);
  }

  return parts.join(' · ');
}

function titleIsRedundant(title, url) {
  const host = url.split('/')[0].replace(/^www\./, '');
  return title.toLowerCase().replace(/\s+/g, '') === host.toLowerCase().replace(/[.\s]/g, '');
}

export function shortUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let path = u.pathname === '/' ? '' : u.pathname;
    let query = u.search;
    // Long query strings are almost always tracking parameters.
    if (query.length > 60) query = `${query.slice(0, 57)}...`;
    if (path.length > 80) path = `${path.slice(0, 77)}...`;
    return `${host}${path}${query}`;
  } catch {
    return truncate(url, 100);
  }
}

// -----------------------------------------------------------------------------
// Tree rendering
// -----------------------------------------------------------------------------

/**
 * Render an a11y node tree.
 * @returns {{text: string, refCount: number, truncated: boolean}}
 */
export function renderTree(nodes, { maxChars = 20000, indent = '  ' } = {}) {
  const lines = [];
  let refCount = 0;
  let chars = 0;
  let truncated = false;

  const walk = (list, depth) => {
    for (const node of list) {
      if (truncated) return;

      const line = renderNode(node, indent.repeat(depth));
      if (line !== null) {
        if (chars + line.length > maxChars) {
          truncated = true;
          return;
        }
        lines.push(line);
        chars += line.length + 1;
        if (node.ref) refCount++;
      }

      if (node.children?.length) {
        walk(node.children, line === null ? depth : depth + 1);
      }
    }
  };

  walk(nodes, 0);

  return { text: lines.join('\n'), refCount, truncated };
}

/** `role "name" [ref] state1 state2` — omitting every part that adds nothing. */
function renderNode(node, pad) {
  const parts = [];

  // Plain text lines drop the role entirely; the quotes are noise there too.
  if (node.role === 'text') {
    if (!node.name) return null;
    return pad + node.name;
  }

  // A generic container with no name is pure structure. Emitting it would cost
  // a line for zero information, so collapse it and let children re-parent.
  if (node.role === 'generic' && !node.name && !node.ref) return null;

  parts.push(node.role);
  if (node.name) parts.push(`"${node.name}"`);
  if (node.ref) parts.push(`[${node.ref}]`);

  if (node.value) parts.push(`=${JSON.stringify(node.value)}`);
  if (node.href) parts.push(node.href);
  if (node.src) parts.push(node.src);

  if (node.state?.length) parts.push(node.state.join(' '));

  return pad + parts.join(' ');
}

// -----------------------------------------------------------------------------
// Diffing
// -----------------------------------------------------------------------------

export function storeSnapshot(tabId, text) {
  lastSnapshots.set(tabId, text);
}

/**
 * Line-level diff against the previous snapshot of this tab.
 *
 * A set difference rather than a proper LCS. It is the right trade here: the
 * question a model asks after clicking something is "what appeared and what
 * went away", not "what moved". Set difference answers that in a fraction of
 * the output, and moved-but-unchanged lines correctly show as no change.
 */
export function diffSnapshot(tabId, text) {
  const previous = lastSnapshots.get(tabId);
  storeSnapshot(tabId, text);

  if (previous === undefined) {
    return { text, isFirst: true };
  }
  if (previous === text) {
    return { text: '(no change since last snapshot)', unchanged: true };
  }

  const before = new Map();
  for (const line of previous.split('\n')) {
    before.set(line, (before.get(line) || 0) + 1);
  }

  const added = [];
  const afterCounts = new Map();
  for (const line of text.split('\n')) {
    afterCounts.set(line, (afterCounts.get(line) || 0) + 1);
    const remaining = before.get(line) || 0;
    if (remaining > 0) before.set(line, remaining - 1);
    else added.push(line);
  }

  const removed = [];
  for (const [line, count] of before) {
    for (let i = 0; i < count; i++) removed.push(line);
  }

  const out = [];
  if (added.length) out.push('+ ' + added.join('\n+ '));
  if (removed.length) out.push('- ' + removed.join('\n- '));

  // A diff nearly as large as the page itself means the page was replaced
  // wholesale; showing the new page beats a wall of +/- lines. The size floor
  // matters: on a short page the `+ `/`- ` prefixes alone can make a two-line
  // diff "bigger" than the page, which is not a wholesale replacement.
  const diffText = out.join('\n');
  if (text.length > 400 && diffText.length > text.length * 0.8) {
    return { text, replaced: true };
  }

  return { text: diffText || '(no change since last snapshot)', unchanged: !diffText };
}

export function clearSnapshot(tabId) {
  lastSnapshots.delete(tabId);
}

// -----------------------------------------------------------------------------
// Other result shapes
// -----------------------------------------------------------------------------

export function renderFindResults(results, query) {
  if (!results.length) {
    return `No matches for "${query}". Try browser_snapshot to see what is actually on the page.`;
  }

  const lines = results.map((r) => {
    const parts = [r.role];
    if (r.name) parts.push(`"${truncate(r.name, 80)}"`);
    parts.push(`[${r.ref}]`);
    if (r.value) parts.push(`=${JSON.stringify(truncate(r.value, 40))}`);
    if (r.href) parts.push(r.href);
    if (r.state?.length) parts.push(r.state.join(' '));
    // Position disambiguates repeated labels ("Add to cart" x12) better than
    // anything else available, and it is only a handful of tokens.
    if (r.rect) parts.push(`@${r.rect.x},${r.rect.y}`);
    return parts.join(' ');
  });

  return lines.join('\n');
}

export function renderTabs(tabs, activeTabId, workstreams = []) {
  if (!tabs.length) return 'No tabs open.';

  // tabId -> workstream label, so each row says which job owns it.
  const owner = new Map();
  for (const w of workstreams) {
    for (const id of w.tabIds) owner.set(id, w.name);
  }

  return tabs
    .map((t) => {
      const marks = [];
      if (t.id === activeTabId) marks.push('active');
      if (t.audible) marks.push('audio');
      if (t.discarded) marks.push('discarded');
      if (t.status === 'loading') marks.push('loading');
      const suffix = marks.length ? ` (${marks.join(', ')})` : '';
      const stream = owner.has(t.id) ? `  [${owner.get(t.id)}]` : '';
      return `${t.id}  ${shortUrl(t.url || t.pendingUrl || 'about:blank')}  "${truncate(t.title || '', 60)}"${suffix}${stream}`;
    })
    .join('\n');
}

export function renderConsole(entries) {
  if (!entries.length) {
    return 'No console output captured. Capture starts when a tab is first used — reload the page and retry if you expected output from page load.';
  }
  return entries
    .map((e) => {
      const level = e.level === 'log' ? '' : `${e.level.toUpperCase()} `;
      const src = e.source ? ` (${e.source})` : '';
      return `${level}${truncate(e.text, 500)}${src}`;
    })
    .join('\n');
}

export function renderNetwork(entries) {
  if (!entries.length) {
    return 'No requests captured. Capture starts when a tab is first used — reload the page to record its load.';
  }
  return entries
    .map((e) => {
      const status = e.failed ? `ERR ${e.error || ''}` : e.status ?? 'pending';
      const size = e.size ? ` ${formatBytes(e.size)}` : '';
      const time = e.ms ? ` ${e.ms}ms` : '';
      const cached = e.fromCache ? ' cached' : '';
      // The id is included so browser_inspect what:"request_body" can target it.
      return `${status} ${e.method} ${shortUrl(e.url)}${size}${time}${cached}  #${e.id}`;
    })
    .join('\n');
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Say what a returned screenshot maps to in page coordinates.
 *
 * Every other tool here speaks CSS pixels, but the image handed back has been
 * through two independent rescalings — the device pixel ratio at capture, then
 * the downscale to `maxWidth` — so a coordinate measured off the image is in
 * neither space. Reading a control's position off a screenshot and passing it
 * to `browser_act` therefore clicked the wrong place, silently, and the old
 * one-line result gave no hint why. This is the one place the tools actively
 * misled rather than merely failing.
 *
 * The factor is derived from the image against the region it covers, not
 * computed from the pixel ratio, so it stays correct on any display.
 *
 * @param {object} p
 * @param {string} p.mode viewport | full_page | element | region
 * @param {{x:number,y:number,width:number,height:number}} [p.clip] CSS-px capture region
 * @param {object} p.meta page metadata (viewport, scroll)
 * @param {{width:number,height:number}} p.image the image actually returned
 */
export function captureGeometry({ mode, clip, meta = {}, image }) {
  const line = `${mode} screenshot, ${image.width}x${image.height}`;
  const viewport = meta.viewport || {};

  let covered;
  if (clip) {
    covered = {
      x: Math.round(clip.x),
      y: Math.round(clip.y),
      w: Math.round(clip.width),
      h: Math.round(clip.height),
    };
  } else if (mode === 'full_page') {
    covered = { x: 0, y: 0, w: viewport.w, h: (viewport.h || 0) + (meta.scroll?.maxY || 0) };
  } else {
    covered = { x: 0, y: 0, w: viewport.w, h: viewport.h };
  }

  // With no viewport the mapping cannot be stated honestly, and a guessed one
  // is worse than saying nothing.
  if (!covered.w || !covered.h) return line;

  const scale = image.width / covered.w;
  const at = covered.x || covered.y ? ` at (${covered.x},${covered.y})` : '';
  const sized = `${line} — ${scale.toFixed(2)}x of ${covered.w}x${covered.h} CSS px${at}`;

  // A 1:1 capture of the whole viewport needs no conversion advice.
  if (Math.abs(scale - 1) < 0.005 && !covered.x && !covered.y) return sized;

  const f = scale.toFixed(2);
  const convert =
    covered.x || covered.y
      ? `to convert: page x = ${covered.x} + imageX/${f}, page y = ${covered.y} + imageY/${f}`
      : `to convert: divide image coords by ${f} for page coords`;

  // Full-page captures run past the viewport, so their coordinates are
  // document-space while browser_act expects viewport-space.
  const note =
    mode === 'full_page' ? ' (document coords — subtract the current scroll offset before clicking)' : '';

  return `${sized}\n${convert}${note}`;
}

export function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Standard tail appended after an action, so the model can usually skip a
 * follow-up snapshot. This one habit removes roughly half the round-trips in a
 * typical automation run.
 */
export function actionResult(summary, { meta, tabId, changed } = {}) {
  const lines = [summary];
  if (meta) lines.push(pageHeader(meta, tabId));
  if (changed) lines.push(changed);
  return lines.join('\n');
}

chrome.tabs.onRemoved.addListener((tabId) => lastSnapshots.delete(tabId));

/**
 * Is this delta nothing but the focus ring moving?
 *
 * Clicking anything focusable moves focus, and the tree reports `focused` as a
 * state change — so a click that achieved nothing still comes back with a
 * two-line diff and looks like it did something. Ignoring focus, a delta whose
 * lines pair up exactly is the no-change case wearing a disguise, and it is by
 * far the common one: without this the settling check below would almost never
 * fire on a button, which is precisely where it is needed.
 */
export function isFocusOnly(changed) {
  if (typeof changed !== 'string' || !changed.startsWith('changes:')) return false;

  const lines = changed.split('\n').slice(1).filter((l) => l.trim());
  if (!lines.length) return false;

  const counts = new Map();
  for (const line of lines) {
    const key = line.replace(/^\s*[+-]\s*/, '').replace(/\s*\bfocused\b/, '').trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // Each element appears once added and once removed, identical but for focus.
  return [...counts.values()].every((n) => n % 2 === 0);
}
