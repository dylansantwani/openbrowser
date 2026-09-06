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
// Outline
// -----------------------------------------------------------------------------

/** Roles that anchor an outline line even on a tree built before `sel` existed. */
const OUTLINE_ROLES = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form', 'search',
  'region', 'dialog', 'alertdialog', 'article', 'table', 'tablist', 'iframe',
]);

/**
 * The page as a table of contents.
 *
 * A big page's interactive tree is thousands of characters, most of them links
 * the model will never touch; reading it whole is the largest single token cost
 * of a task and it grows with every page. The outline is the cheap first look
 * instead: every landmark with how many controls it holds and the selector that
 * scopes a snapshot to it, plus the headings in between for orientation. Ten to
 * forty lines for a page whose full tree is four hundred, and the next call can
 * go straight to `selector:"…"` without a round trip to discover it.
 *
 * @returns {{text: string, refCount: number, truncated: boolean}}
 */
export function renderOutline(nodes, { maxChars = 4000, indent = '  ' } = {}) {
  const lines = [];
  let chars = 0;
  let truncated = false;
  let refCount = 0;

  const push = (line) => {
    if (truncated) return;
    if (chars + line.length > maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    chars += line.length + 1;
  };

  const isLandmark = (node) => !node.ref && (node.sel || OUTLINE_ROLES.has(node.role));

  // Controls a landmark holds directly — a nested landmark's controls are its
  // own line's business, so nothing is counted twice and `banner (1 link)` next
  // to its `navigation (12 links)` reads as the two regions they are.
  const countControls = (node, acc) => {
    for (const child of node.children || []) {
      if (child.ref) acc[child.role] = (acc[child.role] || 0) + 1;
      if (!isLandmark(child)) countControls(child, acc);
    }
    return acc;
  };

  const countAll = (list) => {
    for (const node of list) {
      if (node.ref) refCount++;
      if (node.children?.length) countAll(node.children);
    }
  };
  countAll(nodes);

  const walk = (list, depth) => {
    for (const node of list) {
      const pad = indent.repeat(depth);
      if (node.role === 'heading' && node.name) {
        const level = node.state?.find((s) => /^h[1-6]$/.test(s)) || 'heading';
        push(`${pad}${level} "${truncate(node.name, 80)}"`);
        continue;
      }
      if (!isLandmark(node)) {
        if (node.children?.length) walk(node.children, depth);
        continue;
      }
      const counts = countControls(node, {});
      const summary = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([role, n]) => `${n} ${plural(role, n)}`)
        .join(', ');
      const parts = [node.role];
      if (node.name) parts.push(`"${truncate(node.name, 60)}"`);
      if (node.src) parts.push(node.src);
      if (summary) parts.push(`(${summary})`);
      if (node.sel) parts.push(`selector:${JSON.stringify(node.sel)}`);
      push(pad + parts.join(' '));
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);

  return { text: lines.join('\n'), refCount, truncated };
}

function plural(role, n) {
  if (n === 1) return role;
  return /(x|s|ch|sh)$/.test(role) ? `${role}es` : `${role}s`;
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

/**
 * What a window is called in prose. Mirrors `windowName` in windows.js, which
 * cannot be imported here without dragging chrome.* side effects into a module
 * the tests load standalone.
 *
 * @param {{windowId:number, agent?:boolean, own?:string|null, focused?:boolean}} win
 */
export function windowLabel(win) {
  if (win.agent) return `the agent window (id ${win.windowId})`;
  if (win.own) return `${win.own}'s window (id ${win.windowId})`;
  return `window ${win.windowId} (the user's${win.focused ? ', focused' : ''})`;
}

/** One tab, one line: `id  host/path  "title"  marks  [owner]`. */
function tabRow(t, owned, { showOwner = true, self = null } = {}) {
  const marks = [];
  // `active` is Chrome's per-window flag: the tab currently showing in *its*
  // window. It used to be "the tab in the user's focused window", which told an
  // agent about the human's screen and nothing about its own.
  if (t.active) marks.push('active');
  if (t.audible) marks.push('audio');
  if (t.discarded) marks.push('discarded');
  if (t.status === 'loading') marks.push('loading');
  const suffix = marks.length ? `  ${marks.join(', ')}` : '';

  let tag = '';
  if (owned) {
    const isSelf = self && owned.sessionId === self;
    const group = owned.sessionId && owned.workstream !== owned.sessionId ? owned.workstream : null;
    if (isSelf) {
      // Your own rows never repeat your name; only a sub-group is news.
      if (group) tag = `  group: ${group}`;
    } else if (showOwner) {
      tag = `  [${owned.sessionId || owned.workstream}${group ? ` · ${group}` : ''}]`;
    }
  }
  return `  ${t.id}  ${shortUrl(t.url || t.pendingUrl || 'about:blank')}  "${truncate(t.title || '', 60)}"${suffix}${tag}`;
}

/**
 * The tab list.
 *
 * Two audiences, two shapes. A *session* — an agent — is shown its own tabs in
 * full and everything else summarised: which other agents share its window and
 * how many tabs they hold, and how many windows the user has. That is the
 * answer to every question an agent legitimately has ("what am I working on",
 * "where am I", "is anyone else here") without handing it two hundred tab ids
 * that are not its to use. Twenty agents in one browser made the old flat list
 * of every tab both expensive and actively misleading: an agent reading a
 * neighbour's tab id off it is exactly how tabs got taken over.
 *
 * The *side panel* has no session and sees every window in full, tagged with
 * who owns what — a human's view.
 *
 * Either caller can name a `windowId` to see one window in full.
 *
 * @param {Array} tabs Chrome tab objects (with `windowId`, `active`)
 * @param {Array} windows `windows.listWindows()` output: `{windowId, focused, agent, own}`
 * @param {Array} groups `groups.list()` output: `{name, sessionId, tabIds}`
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId] the calling session, if any
 * @param {number|null} [opts.boundWindowId] the window that session works in
 * @param {number|null} [opts.windowId] restrict to this window, in full
 */
export function renderTabs(tabs, windows = [], groups = [], opts = {}) {
  const { sessionId = null, boundWindowId = null, windowId = null } = opts;

  const owner = new Map();
  for (const g of groups) {
    for (const id of g.tabIds) owner.set(id, { workstream: g.name, sessionId: g.sessionId });
  }
  const winById = new Map(windows.map((w) => [w.windowId, w]));
  const winOf = (id) => winById.get(id) || { windowId: id };

  // Insertion order is Chrome's own window order, which is stable across calls
  // — worth keeping, since an agent comparing two listings reads position.
  const byWindow = new Map();
  for (const t of tabs) {
    const id = t.windowId ?? 0;
    if (!byWindow.has(id)) byWindow.set(id, []);
    byWindow.get(id).push(t);
  }

  const out = [];

  // ── One window in full, or the human's full view ─────────────────────────
  if (windowId != null || !sessionId) {
    if (!tabs.length) return windowId != null ? `no tabs in window ${windowId}.` : 'No tabs open.';
    for (const [id, list] of byWindow) {
      const here = [...new Set(list.map((t) => owner.get(t.id)?.sessionId).filter(Boolean))];
      const who = here.length
        ? `  agents: ${here.map((n) => (n === sessionId ? `${n} (you)` : n)).join(', ')}`
        : '';
      const yours = sessionId && boundWindowId === id ? '  ← you work here' : '';
      out.push(`${windowLabel(winOf(id))} · ${list.length} tab${list.length === 1 ? '' : 's'}${who}${yours}`);
      out.push(...list.map((t) => tabRow(t, owner.get(t.id), { self: sessionId })));
    }
    return out.join('\n');
  }

  // ── An agent's own view ──────────────────────────────────────────────────
  const mine = tabs.filter((t) => owner.get(t.id)?.sessionId === sessionId);
  const home = boundWindowId != null ? winOf(boundWindowId) : null;

  out.push(
    home
      ? `You are agent "${sessionId}", working in ${windowLabel(home)}.`
      : `You are agent "${sessionId}". No window is bound yet — the first tab you open settles it.`
  );

  if (mine.length) {
    out.push(`Your tabs (${mine.length}):`);
    out.push(...mine.map((t) => tabRow(t, owner.get(t.id), { self: sessionId })));
  } else {
    out.push('You have no tabs yet. browser_navigate opens one for you; browser_tabs action:"new" opens more.');
  }

  // Everyone else, as counts. Names, so the human's "close meadow's tabs" and
  // the agent's picture of the window agree; no ids, because those tabs are not
  // this agent's to act on and a listing that shows them invites it to.
  const others = new Map();
  for (const t of tabs) {
    const o = owner.get(t.id);
    if (!o?.sessionId || o.sessionId === sessionId) continue;
    const key = `${o.sessionId}|${t.windowId}`;
    others.set(key, (others.get(key) || 0) + 1);
  }
  if (others.size) {
    const inHome = [];
    const elsewhere = [];
    for (const [key, n] of others) {
      const [name, win] = key.split('|');
      const text = `${name} (${n} tab${n === 1 ? '' : 's'})`;
      (Number(win) === boundWindowId ? inHome : elsewhere).push(text);
    }
    if (inHome.length) out.push(`Other agents in your window: ${inHome.join(', ')} — their tabs are not yours to use.`);
    if (elsewhere.length) out.push(`Agents in other windows: ${elsewhere.join(', ')}.`);
  }

  // The user's windows: counted, never listed. An explicit windowId shows one.
  const userWins = [...byWindow.entries()].filter(([id]) => {
    const w = winOf(id);
    return !w.agent && !w.own && id !== boundWindowId;
  });
  if (userWins.length) {
    const parts = userWins.map(([id, list]) => `${windowLabel(winOf(id))} · ${list.length} tab${list.length === 1 ? '' : 's'}`);
    out.push(
      `The user's windows — not yours to act on: ${parts.join('; ')}. ` +
        'To read one, pass windowId:<id>; to drive one of its tabs, pass that tabId explicitly (it then joins your tabs).'
    );
  }

  return out.join('\n');
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
/**
 * The numeric CSS↔image mapping behind `captureGeometry`, factored out so the
 * screenshot's advice and the click-time inversion (`space:"image"` in
 * router.js) can never drift apart — the whole point is that a coordinate read
 * off the image lands where the model expects.
 *
 * `covered` is the CSS-pixel region the image spans; `scale = image / covered`
 * is the factor a caller divides image coords by. Rounding matches the text
 * output exactly, so the two functions agree to the byte and to the pixel.
 *
 * @returns {{scale:number, originX:number, originY:number, coveredW:number,
 *   coveredH:number, mode:string} | null} null when the viewport is unknown.
 */
export function captureMapping({ mode, clip, meta = {}, image }) {
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

  if (!covered.w || !covered.h || !image?.width) return null;

  // One scale for both axes, derived from width. This is correct only while
  // `downscale()` (router.js) rescales by a single width-derived factor and
  // never independently clamps height. If it ever grows a maxHeight cap, the
  // y-axis factor would diverge and this must return {scaleX, scaleY} instead —
  // the round-trip tests in test/run.mjs only exercise the uniform case.
  return {
    scale: image.width / covered.w,
    originX: covered.x,
    originY: covered.y,
    coveredW: covered.w,
    coveredH: covered.h,
    mode,
  };
}

export function captureGeometry({ mode, clip, meta = {}, image }) {
  const line = `${mode} screenshot, ${image.width}x${image.height}`;

  const m = captureMapping({ mode, clip, meta, image });
  // With no viewport the mapping cannot be stated honestly, and a guessed one
  // is worse than saying nothing.
  if (!m) return line;

  const covered = { x: m.originX, y: m.originY, w: m.coveredW, h: m.coveredH };
  const scale = m.scale;
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

/**
 * Resolve a Set-of-Marks badge number against the saved table — the pure core
 * of `router.markToRef`, factored out so its freshness rules can be tested
 * without a browser, exactly as `captureMapping` is.
 *
 * A badge number is a promise the picture made: "click this and hit that
 * element". The promise holds only while the picture still describes the page,
 * so a table taken before a navigation or a resize is refused rather than
 * resolved against a layout that has moved — the same "an error beats a silent
 * wrong click" stance the coordinate story rests on. Returns a tagged result the
 * caller turns into a live ref or a recovery message; never throws.
 *
 * @returns {{ref:string} | {error:'no-record'|'navigated'|'resized'|'no-mark', max?:number, clear?:boolean}}
 */
export function markDecision(record, meta, n) {
  if (!record) return { error: 'no-record' };
  if (meta) {
    const navigated = !!(record.url && meta.url && record.url !== meta.url);
    const resized = !!(record.vw && meta.viewport?.w && (record.vw !== meta.viewport.w || record.vh !== meta.viewport.h));
    if (navigated) return { error: 'navigated', clear: true };
    if (resized) return { error: 'resized', clear: true };
  }
  const marks = record.marks || [];
  const hit = marks.find((m) => m.n === n);
  if (!hit) return { error: 'no-mark', max: marks.length };
  return { ref: hit.ref };
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

/**
 * One line for an `expect` verdict — the action's own verification, so the
 * model does not spend a round trip asking whether its click worked.
 */
export function expectLine(r) {
  const what = r.cond?.value != null ? `${r.cond.for} ${JSON.stringify(String(r.cond.value))}` : r.cond?.for;
  if (r.ok) return `expect ${what}: met${r.ms != null ? ` after ${r.ms}ms` : ''}`;
  return `EXPECT FAILED: ${what} not met after ${r.timeout}ms${r.error && !/timed out/.test(r.error) ? ` (${r.error})` : ''}`;
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
