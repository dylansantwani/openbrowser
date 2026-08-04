/**
 * Accessibility tree extraction.
 *
 * This file decides what an AI model sees when it looks at a page, so it is the
 * single biggest lever on both token cost and reliability. Two ideas drive it:
 *
 *  - Show structure and controls, hide chrome. A typical page is 90% wrapper
 *    divs, tracking pixels, and repeated boilerplate. None of that helps a model
 *    decide what to click.
 *  - Give every actionable thing a stable handle. Refs (`e12`) survive minor
 *    re-renders because they are backed by an element reference plus a
 *    re-derivable selector fallback.
 *
 * Loaded as a classic content script into every frame; exports onto a shared
 * `OB` global rather than using modules, because MV3 content scripts are not
 * ES modules.
 */

var OB = globalThis.OB || (globalThis.OB = {});

(() => {
  'use strict';

  /** Tags that never carry meaning for an agent. */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD',
    'BR', 'WBR', 'PARAM', 'SOURCE', 'TRACK',
  ]);

  /** tag -> ARIA role, for the implicit-role cases that actually come up. */
  const IMPLICIT_ROLE = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', IMG: 'img', NAV: 'navigation', MAIN: 'main',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    FORM: 'form', TABLE: 'table', THEAD: 'rowgroup', TBODY: 'rowgroup',
    TR: 'row', TD: 'cell', TH: 'columnheader', UL: 'list', OL: 'list',
    LI: 'listitem', DIALOG: 'dialog', DETAILS: 'group', SUMMARY: 'button',
    PROGRESS: 'progressbar', OPTION: 'option', LABEL: 'label',
    FIELDSET: 'group', LEGEND: 'legend', SEARCH: 'search',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    VIDEO: 'video', AUDIO: 'audio', CANVAS: 'canvas', IFRAME: 'iframe',
  };

  /** <input type> -> role. Anything unlisted falls back to textbox. */
  const INPUT_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file_input',
    search: 'searchbox', email: 'textbox', password: 'password', tel: 'textbox',
    url: 'textbox', number: 'spinbutton', date: 'date', 'datetime-local': 'date',
    month: 'date', week: 'date', time: 'date', color: 'colorpicker', hidden: null,
  };

  /** Roles we always emit a ref for — the model can act on these. */
  const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'textbox', 'searchbox', 'password', 'checkbox', 'radio',
    'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'file_input', 'date',
    'colorpicker', 'treeitem', 'gridcell',
  ]);

  /**
   * Roles that carry meaning with no children and no name — media and embeds,
   * where the element itself is the content. Everything else structural is
   * dropped when empty.
   */
  const MEANINGFUL_WHEN_EMPTY = new Set(['iframe', 'canvas', 'video', 'audio', 'img']);

  /** Structural roles worth keeping for orientation, without a ref. */
  const LANDMARK_ROLES = new Set([
    'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form',
    'search', 'region', 'dialog', 'alertdialog', 'alert', 'status', 'tablist',
    'table', 'list', 'heading', 'article', 'iframe', 'canvas', 'video', 'audio',
  ]);

  // ---------------------------------------------------------------------------
  // Ref registry
  // ---------------------------------------------------------------------------

  /**
   * Refs are handed out per snapshot but deliberately reused: if the same
   * element shows up in the next snapshot it keeps its old ref. That makes
   * `mode:"diff"` genuinely cheap and means a model's plan does not invalidate
   * just because an unrelated part of the page re-rendered.
   */
  const registry = {
    byRef: new Map(),   // "e12" -> {el, selector, role, name}
    byEl: new WeakMap(), // element -> "e12"
    counter: 0,
  };

  function refFor(el, role, name) {
    const existing = registry.byEl.get(el);
    if (existing && registry.byRef.has(existing)) {
      const entry = registry.byRef.get(existing);
      entry.role = role;
      entry.name = name;
      return existing;
    }
    const ref = `e${++registry.counter}`;
    registry.byEl.set(el, ref);
    registry.byRef.set(ref, { el, selector: cssPath(el), role, name });
    return ref;
  }

  /**
   * Resolve a ref back to a live element.
   *
   * Elements get detached constantly on SPA re-renders, so a raw element handle
   * is not enough. When the stored node is gone we re-resolve via the selector
   * captured at snapshot time, which recovers the common case where the page
   * rebuilt the same UI.
   */
  function resolveRef(ref) {
    const entry = registry.byRef.get(ref);
    if (!entry) return null;
    if (entry.el?.isConnected) return entry.el;

    if (entry.selector) {
      try {
        const found = document.querySelector(entry.selector);
        if (found) {
          entry.el = found;
          registry.byEl.set(found, ref);
          return found;
        }
      } catch {
        /* selector no longer parses; fall through */
      }
    }
    return null;
  }

  /**
   * A short, reasonably stable selector. Prefers ids and data-testids, since
   * those survive re-renders; falls back to a bounded ancestor path.
   */
  function cssPath(el, maxDepth = 6) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let node = el;
    let depth = 0;

    while (node && node.nodeType === 1 && depth < maxDepth) {
      if (node.id && isStableToken(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }

      const testid =
        node.getAttribute?.('data-testid') ||
        node.getAttribute?.('data-test-id') ||
        node.getAttribute?.('data-qa');
      if (testid) {
        parts.unshift(`[data-testid="${CSS.escape(testid)}"]`);
        break;
      }

      let part = node.localName;
      const name = node.getAttribute?.('name');
      if (name && isStableToken(name)) {
        part += `[name="${CSS.escape(name)}"]`;
      } else {
        const parent = node.parentNode;
        if (parent) {
          const sibs = [...parent.children].filter((c) => c.localName === node.localName);
          if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  /**
   * Reject generated identifiers. CSS-in-JS and bundlers emit ids like
   * `css-1x2y3z` or `:r7:` that change on every build, so keying on them
   * produces selectors that break immediately.
   */
  function isStableToken(s) {
    if (!s || s.length > 60) return false;
    if (/^[:.]/.test(s)) return false;
    if (/^[0-9]/.test(s)) return false;
    if (/^(css|sc|jsx|emotion|mui|chakra|radix)-[a-z0-9]{4,}$/i.test(s)) return false;
    if (/^[a-f0-9]{8,}$/i.test(s)) return false; // bare hashes
    return true;
  }

  // ---------------------------------------------------------------------------
  // Role, name, and state
  // ---------------------------------------------------------------------------

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();

    if (el.localName === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return type in INPUT_ROLE ? INPUT_ROLE[type] : 'textbox';
    }
    if (el.localName === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (el.isContentEditable) return 'textbox';

    const implicit = IMPLICIT_ROLE[el.tagName];
    if (implicit) return implicit;

    // Divs and spans wired up with handlers are buttons in all but name, and
    // they are extremely common in modern UIs.
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'button';
    return 'generic';
  }

  /**
   * Roles whose accessible name comes from their own text content.
   *
   * This list is the difference between `button "Save"` and a `form` named with
   * all 400 characters it contains. Containers (form, main, navigation, list,
   * table) are deliberately absent: per accname they are named by an explicit
   * label or not at all, and falling back to their text is both wrong and one
   * of the largest sources of wasted tokens in a naive tree.
   */
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'option', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'checkbox', 'radio', 'switch', 'tab', 'treeitem',
    'cell', 'gridcell', 'columnheader', 'rowheader', 'legend', 'label',
    'listitem', 'tooltip', 'status', 'alert',
  ]);

  /** Accessible name, following the parts of accname that matter in practice. */
  function nameOf(el, role) {
    const label = el.getAttribute('aria-label');
    if (label?.trim()) return clean(label);

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
        .join(' ');
      if (text.trim()) return clean(text);
    }

    if (/^(textbox|searchbox|password|checkbox|radio|combobox|spinbutton|slider|file_input|date|colorpicker)$/.test(role)) {
      // Native label association first — it is what a screen reader would use.
      if (el.labels?.length) {
        const text = [...el.labels].map((l) => l.textContent).join(' ');
        if (text.trim()) return clean(text);
      }
      const wrapping = el.closest('label');
      if (wrapping?.textContent?.trim()) return clean(wrapping.textContent);

      const placeholder = el.getAttribute('placeholder');
      if (placeholder?.trim()) return clean(placeholder);

      const name = el.getAttribute('name');
      if (name) return clean(name);
    }

    if (el.localName === 'img') {
      const alt = el.getAttribute('alt');
      if (alt !== null) return clean(alt);
    }

    if (el.localName === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return clean(el.value || type);
      }
    }

    const title = el.getAttribute('title');
    if (title?.trim()) return clean(title);

    // Text content, but only for roles that are named that way, and only from a
    // subtree small enough that the result is a label rather than a paragraph.
    if (NAME_FROM_CONTENT.has(role)) {
      const text = visibleText(el);
      if (text && text.length <= 120) return text;
    }

    // An image-only *control* takes its name from the image. Gated on
    // name-from-content roles, or a `<header>` wrapping a logo ends up named
    // after the logo.
    //
    // Take the first *meaningful* alt rather than the first alt attribute:
    // logos are routinely a decorative `alt=""` icon followed by a wordmark
    // carrying the real name, and `img[alt]` matches the empty one first.
    if (NAME_FROM_CONTENT.has(role)) {
      for (const img of el.querySelectorAll?.('img[alt]') || []) {
        if (img.getAttribute('aria-hidden') === 'true') continue;
        const alt = img.getAttribute('alt');
        if (alt?.trim()) return clean(alt);
      }
    }

    return '';
  }

  function visibleText(el) {
    if (!el.textContent) return '';
    // Cheap guard: skip walking huge subtrees just to throw the result away.
    if (el.textContent.length > 400) return '';

    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.getAttribute?.('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      out += node.nodeValue + ' ';
      if (out.length > 200) break;
    }
    return clean(out);
  }

  function clean(s) {
    return String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  /** Compact state flags. Only emitted when they are true or non-default. */
  function stateOf(el, role) {
    const s = [];

    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.readOnly) s.push('readonly');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');

    if (role === 'checkbox' || role === 'radio' || role === 'switch' ||
        role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      s.push(checked ? 'checked' : 'unchecked');
    }

    const expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) s.push(expanded === 'true' ? 'expanded' : 'collapsed');

    const selected = el.getAttribute('aria-selected');
    if (selected === 'true') s.push('selected');
    if (el.getAttribute('aria-current')) s.push('current');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if (el === document.activeElement) s.push('focused');

    if (role === 'heading') {
      const level = el.getAttribute('aria-level') || (/^H([1-6])$/.exec(el.tagName)?.[1]);
      if (level) s.push(`h${level}`);
    }

    return s;
  }

  /** The current value of a control, when it is short enough to be worth showing. */
  function valueOf(el, role) {
    // A checkbox's value attribute defaults to the literal string "on" and a
    // radio's repeats its own label. The checked/unchecked state already says
    // everything, so emitting these is pure noise on every form in existence.
    if (role === 'checkbox' || role === 'radio' || role === 'switch') return '';
    if (role === 'password') return el.value ? '•••' : '';
    if (role === 'combobox' && el.localName === 'select') {
      return clean(el.selectedOptions?.[0]?.textContent || '');
    }
    if ('value' in el && typeof el.value === 'string') return clean(el.value).slice(0, 80);
    if (el.isContentEditable) return clean(el.textContent).slice(0, 80);
    return '';
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  /**
   * Whether an element is worth reporting. Deliberately more permissive than
   * "would a user see it": elements scrolled out of view still matter, because
   * the agent can scroll to them.
   */
  function isVisible(el) {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute('hidden')) return false;
    if (el.localName === 'input' && el.type === 'hidden') return false;

    // `checkVisibility()` answers display/visibility/opacity/content-visibility
    // in one native call. getComputedStyle forces a style recalculation per
    // element, which on an app the size of Gmail is the single dominant cost of
    // building the tree — tens of seconds versus well under one.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) {
        // `display: contents` reports as not visible, because the element
        // generates no box of its own — but its children render completely
        // normally. React-heavy apps (Facebook, notably) wrap large subtrees in
        // <span style="display:contents">, so rejecting these silently discards
        // most of the page. Pay for one getComputedStyle on the failing path to
        // tell the two cases apart.
        if (getComputedStyle(el).display !== 'contents') return false;
      }
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (cs.opacity === '0') return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Zero-size wrappers are fine if they contain visible children; zero-size
      // leaf controls are not real.
      return el.children.length > 0;
    }
    // A common "visually hidden but screen-reader available" pattern. Those are
    // real controls, so keep them.
    return true;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // ---------------------------------------------------------------------------
  // Tree construction
  // ---------------------------------------------------------------------------

  /**
   * Reuse a built tree until something could have changed it.
   *
   * Multi-step flows read the same unchanged page repeatedly — a find, then a
   * scoped find, then a snapshot to confirm — and every read was a full walk.
   * On Gmail that measured 3.6s, then another 3.6s for the next query against
   * byte-identical DOM.
   *
   * Invalidation is coarse on purpose: anything that could have changed the
   * output drops the whole cache. Serving one stale ref costs far more than any
   * number of rebuilds, and a page busy enough to invalidate on every call is a
   * page whose tree genuinely is changing.
   *
   * A MutationObserver alone is not sufficient, and assuming it is is the
   * subtle way to get this wrong. Several things the tree reports are live
   * properties that mutate no attribute and queue no record: `input.value`
   * (typing does not reflect to the value attribute), `input.checked`, and
   * `document.activeElement`, reported as the `focused` state. A pure-CSS
   * `:hover` reveal changes visibility with no record either. Hence the event
   * listeners alongside the observer — they fire for the extension's own
   * CDP-driven input too, which dispatches genuine events.
   *
   * Focus is the exception that cannot be done with a listener at all: see
   * `activeElement` in the cache below.
   */
  const cache = { key: null, value: null, dirty: true, activeElement: null };

  /**
   * Counts changes as well as flagging them, so a caller can ask "did anything
   * happen while I waited?" — which is how a click that missed is told apart
   * from one the page has simply not finished reacting to.
   */
  let mutations = 0;

  /**
   * Is this record only our own decoration moving?
   *
   * `highlight()` appends a `.ob-highlight` box and removes it 900ms later, so
   * every action the tool takes mutates the DOM twice all by itself. Counting
   * those made the settling check report "the page is still changing" after a
   * click on a button planted to do nothing — the tool's own feedback drowning
   * out the signal it was trying to read.
   */
  /**
   * Everything this tool draws on the page itself. `.ob-agent-frame` is the
   * persistent "an agent is driving this tab" border, re-applied on every call —
   * so leaving it out here would report page activity on every single call and
   * destroy the settling signal outright, which is worse than the highlight bug
   * this function was written for.
   *
   * `.ob-window-pick` is the "which window should I work in?" prompt, and it
   * matters for a second reason: this list is also what keeps our own overlays
   * out of the reported tree. That prompt is the one thing on the page an agent
   * must never be able to see or click — it is the human's answer to a question
   * about the agent, and an agent that could find its buttons in a snapshot
   * could answer on their behalf.
   */
  const OWN_DECORATION = '.ob-highlight, .ob-agent-frame, .ob-window-pick';

  function isDecoration(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el?.closest?.(OWN_DECORATION);
  }

  function isDecorationRecord(record) {
    if (record.type === 'childList') {
      const touched = [...record.addedNodes, ...record.removedNodes];
      return touched.length > 0 && touched.every(isDecoration);
    }
    return isDecoration(record.target);
  }

  /**
   * Called both by the MutationObserver (with records) and by the event
   * listeners below (with an Event). The cache is invalidated either way —
   * being wrong about staleness costs far more than a needless rebuild — but
   * the counter is only for real page activity.
   */
  function invalidate(recordsOrEvent) {
    cache.dirty = true;
    if (!Array.isArray(recordsOrEvent)) {
      mutations++;
      return;
    }
    if (recordsOrEvent.some((record) => !isDecorationRecord(record))) mutations++;
  }

  /** Events that change tree output without necessarily mutating the DOM. */
  const INVALIDATING_EVENTS = ['input', 'change', 'pointerdown', 'pointerup', 'keydown', 'mouseover'];

  let observer = null;
  function watchForChanges() {
    if (observer || !document.documentElement) return;

    observer = new MutationObserver(invalidate);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    // Capture phase, so a page handler calling stopPropagation cannot hide a
    // change from us. Passive, because none of this touches the event.
    for (const type of INVALIDATING_EVENTS) {
      addEventListener(type, invalidate, { capture: true, passive: true });
    }
  }

  /**
   * Drain any mutation records the observer has queued but not yet delivered.
   *
   * Its callback is a microtask, so a caller that mutates the DOM and reads the
   * tree in the same synchronous stretch would otherwise be served the tree
   * from before its own change. `takeRecords` is the synchronous view of that
   * queue, which makes invalidation exact rather than merely eventual.
   */
  function drainPending() {
    // `takeRecords` *removes* what it returns, so the observer callback will
    // never see these. Classifying them here rather than only setting the flag
    // is what keeps the counter honest: drop them and a change that raced a
    // read vanishes from the settling signal, and a click that did work reports
    // that nothing happened — the exact false negative the counter exists to
    // prevent. `invalidate` applies the same decoration test the callback would.
    if (observer) {
      const pending = observer.takeRecords();
      if (pending.length) invalidate(pending);
    }

    // Focus cannot be watched with an event here. When the document does not
    // hold system focus, Chrome updates `document.activeElement` immediately
    // but defers the focus/focusin events until the document is focused again
    // — which for a backgrounded tab may be never. Since parallel agent work
    // means backgrounded tabs are the normal case, a listener would miss every
    // focus change that matters. Comparing the property is one read and exact.
    if (cache.activeElement !== document.activeElement) cache.dirty = true;
  }

  /**
   * Everything that changes what the walk produces. `viewportOnly` is measured
   * against the scroll offset and viewport size, so those belong in the key
   * rather than in the invalidation path — scrolling back reuses the tree.
   */
  function cacheKey(opts) {
    const scope = opts.viewportOnly
      ? `${Math.round(scrollX)},${Math.round(scrollY)},${innerWidth}x${innerHeight}`
      : '';
    return `${opts.mode || 'interactive'} ${opts.selector || ''} ${scope}`;
  }

  /**
   * Walk the DOM (piercing open shadow roots) and produce a node tree.
   *
   * @param {object} opts
   * @param {'interactive'|'full'|'text'} opts.mode
   * @param {string} [opts.selector] scope to a subtree
   * @param {boolean} [opts.viewportOnly]
   * @returns {{nodes: Array, truncated: boolean}}
   */
  function buildTree(opts = {}) {
    watchForChanges();
    drainPending();

    const key = cacheKey(opts);
    if (!cache.dirty && cache.key === key) return cache.value;

    // Clear the flag *before* walking. A mutation that lands mid-walk queues
    // its callback for after we return, so it correctly marks the tree we are
    // about to store as already stale. Clearing afterwards would swallow it.
    cache.dirty = false;
    cache.activeElement = document.activeElement;
    const value = walkTree(opts);
    cache.key = key;
    cache.value = value;
    return value;
  }

  function walkTree(opts = {}) {
    const mode = opts.mode || 'interactive';
    const wantText = mode === 'full' || mode === 'text';
    const viewportOnly = !!opts.viewportOnly;

    let root = document.body || document.documentElement;
    if (opts.selector) {
      const scoped = document.querySelector(opts.selector);
      if (!scoped) return { nodes: [], truncated: false, error: `selector not found: ${opts.selector}` };
      root = scoped;
    }

    const nodes = [];

    /**
     * Safety valves against a pathological page hanging the tab.
     *
     * The node cap used to be 4,000, which sounds generous until you meet a
     * real mail client: Gmail's inbox alone emits more than that in table rows,
     * and the compose dialog it appends afterwards — 87% of the way down the
     * DOM — was silently cut off. Every control the agent actually wanted was
     * beyond the cliff.
     *
     * Now that visibility checks no longer force a style recalc per element,
     * the walk is cheap enough to raise this a long way, and a wall-clock
     * budget is the better backstop anyway: it bounds the thing we actually
     * care about, rather than guessing which node count corresponds to it.
     */
    const startedAt = performance.now();
    let budget = 15000;
    let timedOut = false;

    /** @returns {Array} children emitted for this element */
    function walk(el, depth) {
      if (budget <= 0 || timedOut) return [];
      // Checking the clock on every node would itself be a cost; sampling is
      // plenty to bound a runaway walk.
      if ((budget & 0xff) === 0 && performance.now() - startedAt > 2500) {
        timedOut = true;
        return [];
      }
      if (!(el instanceof Element)) return [];
      if (SKIP_TAGS.has(el.tagName)) return [];
      // Never let the tool's own overlays into the tree it reports.
      if (el.matches?.(OWN_DECORATION)) return [];

      if (!isVisible(el)) return [];

      const role = roleOf(el);
      const interactive = INTERACTIVE_ROLES.has(role) || isClickable(el);
      const landmark = LANDMARK_ROLES.has(role);

      // Recurse first: a wrapper is only worth emitting if it either carries
      // meaning itself or holds more than one meaningful child.
      const kids = [];
      for (const child of childrenOf(el)) {
        kids.push(...walk(child, depth + 1));
      }

      // `alt=""` is the author explicitly saying "this image is decorative".
      // Emitting it costs a line and says nothing.
      if (role === 'img' && !interactive) {
        const alt = el.getAttribute('alt');
        if (alt === '' || el.getAttribute('aria-hidden') === 'true') return kids;
      }

      if (!interactive && !landmark) {
        if (wantText) {
          const own = ownText(el);
          if (own) {
            budget--;
            return [{ role: 'text', name: own, depth, children: kids }];
          }
        }
        return kids; // transparent wrapper — splice children into the parent
      }

      if (viewportOnly && interactive && !inViewport(el)) return kids;

      const name = nameOf(el, role);

      // An empty, unnamed container conveys nothing. The classic case is the
      // stub <ul> that sits under every entry of a nested contents list — on a
      // Wikipedia article that is one blank `list` line per section.
      if (landmark && !interactive && !name && !kids.length && !MEANINGFUL_WHEN_EMPTY.has(role)) {
        return [];
      }

      const node = { role, name, depth, children: kids };

      if (interactive) {
        node.ref = refFor(el, role, name);
        const value = valueOf(el, role);
        if (value) node.value = value;
      }

      const state = stateOf(el, role);
      if (state.length) node.state = state;

      if (role === 'link') {
        const href = el.getAttribute('href');
        if (href) node.href = shortHref(href);
      }
      if (role === 'iframe') {
        node.src = shortHref(el.getAttribute('src') || '');
      }

      budget--;
      return [node];
    }

    // Children first. A scoped container's contents belong at the top level;
    // emitting the container too would add a wrapper line and indent everything
    // under it, which costs tokens on every scoped read.
    for (const child of childrenOf(root)) {
      nodes.push(...walk(child, 0));
    }

    // But a selector that matched a single control yields nothing above, since
    // the match itself is never walked — and an empty tree reads as "not on the
    // page", the opposite of the truth. Fall back to the match itself, which is
    // exactly the case where there is no container content to lose.
    if (!nodes.length && opts.selector) {
      nodes.push(...walk(root, 0));
    }

    return {
      nodes,
      truncated: budget <= 0 || timedOut,
      truncatedBy: budget <= 0 ? 'size' : timedOut ? 'time' : undefined,
    };
  }

  /** Children including open shadow roots and slotted content. */
  function childrenOf(el) {
    if (el.shadowRoot) return [...el.shadowRoot.children, ...el.children];
    return el.children;
  }

  /** Text belonging to this element directly, not to its descendants. */
  function ownText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.nodeValue.trim()) out += node.nodeValue + ' ';
    }
    return clean(out);
  }

  /**
   * Elements that behave like controls without saying so. This catches the
   * `<div class="btn" onclick=...>` pattern that ARIA-innocent sites are full of.
   */
  function isClickable(el) {
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;

    // Everything below is the `cursor: pointer` heuristic. Reading `cursor`
    // needs getComputedStyle, so every cheap disqualifier runs first — on a
    // large page this is the difference between one style recalc per element
    // and one per plausible candidate.
    if (el.children.length > 3) return false;

    // `cursor` inherits, so every span inside a link or button reports pointer
    // too. Those are not separately clickable — treating them as controls burns
    // a ref and a line each and duplicates the real target.
    if (el.closest('a[href], button, [role="button"], [role="link"], label, summary')) return false;

    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.width < 600 && r.height > 0 && r.height < 200)) return false;

    return getComputedStyle(el).cursor === 'pointer';
  }

  function shortHref(href) {
    if (!href) return '';
    if (href.startsWith('javascript:')) return 'js:';
    if (href.startsWith('#')) return href.slice(0, 40);
    try {
      const u = new URL(href, location.href);

      // Same-origin links read better as bare paths; the protocol carries no
      // information either way, and a leading "/" already distinguishes them.
      let out = u.origin === location.origin ? u.pathname : u.host + u.pathname;

      // Query strings on links are overwhelmingly tracking and campaign
      // parameters. Short ones can be meaningful (?q=, ?page=), so keep those
      // and elide the rest — on a link-dense page this alone saves more than
      // everything else in the format put together.
      if (u.search) out += u.search.length <= 32 ? u.search : '?…';

      return out.length > 72 ? out.slice(0, 69) + '…' : out;
    } catch {
      return href.slice(0, 72);
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Rank elements against a natural-language query. Not semantic search — just
   * scored token overlap over role, name, value, and nearby text, which handles
   * "the blue submit button" well enough and costs nothing.
   */
  function findElements(query, { limit = 10, interactiveOnly = true, selector } = {}) {
    const { nodes, truncated, error } = buildTree({ mode: 'interactive', selector });
    // A scoped search whose selector is absent from this frame has not "found
    // nothing" — it has not looked. The caller has to be able to tell those
    // apart, especially when broadcasting across frames.
    if (error) return { results: [], truncated: false, error };

    const flat = [];
    (function flatten(list) {
      for (const n of list) {
        flat.push(n);
        if (n.children?.length) flatten(n.children);
      }
    })(nodes);

    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const scored = [];

    const phrase = query.toLowerCase();

    for (const node of flat) {
      if (interactiveOnly && !node.ref) continue;

      const name = (node.name || '').toLowerCase();
      // The href is in the haystack on purpose — "/login" and "/cart" are
      // legitimate finds — but it must not score like a name. A citation link
      // named "33163088" pointing at search.worldcat.org/oclc/33163088 matched
      // "search" through the URL alone and ranked as high as the actual search
      // box. Split the two: real signals (role/name/value) first, href as the
      // weaker fallback.
      const real = `${node.role} ${name} ${node.value || ''}`.toLowerCase();
      const href = (node.href || '').toLowerCase();
      const realWords = new Set(real.match(/[a-z0-9]+/g) || []);
      const hrefWords = new Set(href.match(/[a-z0-9]+/g) || []);

      let score = 0;
      let hrefOnly = true;
      for (const term of terms) {
        if (realWords.has(term)) {
          score += 2;
          hrefOnly = false;
        } else if (real.includes(term)) {
          score += 0.5;
          hrefOnly = false;
        } else if (hrefWords.has(term)) {
          score += 1;
        } else if (href.includes(term)) {
          score += 0.25;
        } else {
          continue;
        }

        if (name === term) score += 6;
        else if (name.startsWith(term)) score += 3;
        if (node.role === term) score += 2;
      }

      if (score === 0) continue;

      // Whole-phrase hit is the strongest signal available.
      if (name.includes(phrase)) score += 5;

      // Prefer concise names. A long label matching three query terms is
      // usually coincidence; a short one matching three is almost always the
      // thing being asked for.
      if (name.length > 120) score -= 4;
      else if (name.length > 60) score -= 2;

      // An element whose only connection to the query is the URL, with no name
      // of its own, is prose noise — citation links, trackers. Discount it so
      // real controls outrank it, without making "/login" unfindable.
      if (hrefOnly && !name) score *= 0.25;

      if (score > 0) scored.push({ node, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit).map(({ node, score }) => ({
      ref: node.ref,
      role: node.role,
      name: node.name,
      value: node.value,
      href: node.href,
      state: node.state,
      score,
      rect: rectOf(resolveRef(node.ref)),
    }));

    // Truncation has to travel with the results. "No matches" and "no matches
    // in the part of the page I managed to read" call for completely different
    // next moves, and silently conflating them sent this exact search looking
    // for a compose dialog that had been cut off.
    return { results, truncated };
  }

  function rectOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  /** Readable plain text for `mode: "text"`. */
  function pageText(maxChars = 20000) {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    if (!root) return '';
    const text = root.innerText || root.textContent || '';
    return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, maxChars);
  }

  OB.a11y = {
    buildTree,
    invalidate,
    mutationCount: () => mutations,
    findElements,
    resolveRef,
    refFor,
    registry,
    rectOf,
    pageText,
    roleOf,
    nameOf,
    isVisible,
    cssPath,
  };
})();
