/**
 * Content-script entry point. Runs in every frame of every page.
 *
 * Responsibilities:
 *   1. Answer requests from the background script (snapshot, find, fill, wait…).
 *   2. Work out where this frame sits inside the top-level viewport, so that
 *      coordinates handed to the debugger land on the right pixel even when the
 *      target is three cross-origin iframes deep.
 */

var OB = globalThis.OB || (globalThis.OB = {});

(() => {
  'use strict';

  // Guard against double injection: the manifest injects us, and the background
  // re-injects into frames that loaded before the extension did.
  if (OB.__mainLoaded) return;
  OB.__mainLoaded = true;

  const { a11y, actions } = OB;

  // ---------------------------------------------------------------------------
  // Frame offset discovery
  // ---------------------------------------------------------------------------

  /**
   * A frame cannot see its own position: `window.frameElement` throws across
   * origins, and there is no API that answers "where am I on the screen".
   *
   * So the parent tells it. Each frame measures its own child iframes, adds its
   * own known offset, and posts the sum to each child. postMessage crosses
   * origins, so the offset cascades all the way down. The top frame seeds the
   * cascade with (0, 0).
   */
  const FRAME_MSG = '__openbrowser_frame_offset__';

  function broadcastOffsets() {
    const self = actions.frameOffset;
    for (const frame of document.querySelectorAll('iframe, frame')) {
      const win = frame.contentWindow;
      if (!win) continue;

      const rect = frame.getBoundingClientRect();
      // The child's viewport starts inside the border, not at the border box.
      let borderLeft = 0;
      let borderTop = 0;
      try {
        const cs = getComputedStyle(frame);
        borderLeft = parseFloat(cs.borderLeftWidth) || 0;
        borderTop = parseFloat(cs.borderTopWidth) || 0;
      } catch {
        /* detached frame; the zero default is fine */
      }

      try {
        win.postMessage(
          {
            [FRAME_MSG]: true,
            x: self.x + rect.left + borderLeft,
            y: self.y + rect.top + borderTop,
          },
          '*'
        );
      } catch {
        /* sandboxed frame that refuses messages — it stays at 0,0 */
      }
    }
  }

  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data[FRAME_MSG] !== true) return;
    // Only our parent can legitimately tell us where we are.
    if (event.source !== parent) return;

    actions.setFrameOffset(Number(data.x) || 0, Number(data.y) || 0);
    broadcastOffsets(); // cascade to our own children
  });

  // ---------------------------------------------------------------------------
  // Command handling
  // ---------------------------------------------------------------------------

  const handlers = {
    ping() {
      return { ok: true, url: location.href, top: window.top === window };
    },

    /** Show/hide the persistent "an agent is driving this tab" border. */
    agent_frame({ on = true, label }) {
      return { shown: actions.agentFrame(on, label) };
    },

    /**
     * Show/hide "an agent wants to work in this window".
     *
     * Returns as soon as it is drawn — the answer comes back separately over
     * chrome.runtime, because the caller is waiting on a human and this reply
     * would otherwise have to be held open for a minute and a half.
     */
    window_pick({ on = true, token, label }) {
      // `token` matters on the way out as much as on the way in: several
      // sessions can have a card up here at once, and clearing must take only
      // the one that belongs to the caller.
      return { shown: actions.windowPick(on, { token, label }) };
    },

    snapshot({ mode = 'interactive', selector, viewportOnly, maxChars = 20000 }) {
      if (mode === 'text') {
        return { text: a11y.pageText(maxChars), ...pageMeta() };
      }
      const { nodes, truncated, error } = a11y.buildTree({ mode, selector, viewportOnly });
      if (error) return { error };
      return { nodes, truncated, ...pageMeta() };
    },

    find({ query, limit, interactiveOnly, selector }) {
      return { ...a11y.findElements(query, { limit, interactiveOnly, selector }), ...pageMeta() };
    },

    /**
     * Locate a ref and report where to click it, in top-level viewport coords.
     * The background needs this before it can dispatch a debugger input event.
     */
    async resolve({ ref, scroll = true }) {
      const el = a11y.resolveRef(ref);
      if (!el) {
        return { error: `ref ${ref} no longer exists — the page changed; take a fresh snapshot` };
      }
      if (scroll) await actions.scrollIntoView(el);

      const point = actions.clickPoint(el);
      if (!point) {
        return { error: `ref ${ref} has no layout box (display:none or zero-size) and cannot be clicked` };
      }

      const rect = el.getBoundingClientRect();
      return {
        point,
        rect: {
          x: Math.round(rect.x + actions.frameOffset.x),
          y: Math.round(rect.y + actions.frameOffset.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        // Lets the background bind this element by selector inside an eval,
        // which is the only way to reach it from the page's own world.
        selector: a11y.cssPath(el),
        tag: el.localName,
        type: el.type || null,
        role: a11y.roleOf(el),
        name: a11y.nameOf(el, a11y.roleOf(el)),
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      };
    },

    /**
     * What holds focus right now.
     *
     * Only interesting for its negative answer: if focus is on the body, a key
     * chord dispatched blind acts on the document instead of a field.
     */
    activeElement() {
      const el = document.activeElement;
      const bare = !el || el === document.body || el === document.documentElement;
      return {
        focused: !bare,
        tag: el ? el.localName : null,
        editable: !bare && (el.isContentEditable || ['input', 'textarea', 'select'].includes(el.localName)),
      };
    },

    /**
     * Is the page still reacting?
     *
     * Watches the mutation counter over a short window. A click that produced
     * no visible change is ambiguous — the app may not have reacted yet, or the
     * click may have gone nowhere — and those need opposite responses. Silence
     * is the one answer that helps with neither.
     */
    async settling({ ms = 500 }) {
      const before = a11y.mutationCount();
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { mutated: a11y.mutationCount() > before };
    },

    /** Read a control's current value, for verifying that typing landed. */
    readValue({ ref }) {
      const el = ref ? a11y.resolveRef(ref) : document.activeElement;
      if (!el) return { error: `ref ${ref} no longer exists` };
      const value = el.isContentEditable ? el.innerText : el.value;
      return { value: value ?? '', focused: el === document.activeElement };
    },

    highlight({ ref, label }) {
      const el = a11y.resolveRef(ref);
      if (el) actions.highlight(el, label);
      return { ok: true };
    },

    /**
     * Move the live cursor to a top-level viewport point. Driven from the
     * background so it tracks the real trusted click, and addressed to the top
     * frame because the point is already in top-level coordinates — a click deep
     * in an iframe still shows the pointer at the right pixel on screen.
     */
    cursor({ x, y, action, label, click, hide }) {
      if (hide) {
        actions.hideCursor();
        return { ok: true };
      }
      return { ok: actions.cursor({ x, y, action, label, click }) };
    },

    fill({ fields }) {
      const results = fields.map((f) => actions.fillField(f.ref, f.value, { clear: f.clear !== false }));
      // The tree cache's event listeners would catch this anyway, but a fill is
      // the one change we make ourselves and know about for certain. Saying so
      // here keeps the guarantee local instead of resting on which events a
      // given framework's setter happens to dispatch.
      a11y.invalidate();
      return { results };
    },

    /** Actions that genuinely do not need a trusted event. */
    async act({ action, ref, value }) {
      const el = ref ? a11y.resolveRef(ref) : document.activeElement;
      if (!el) return { error: `ref ${ref} no longer exists — take a fresh snapshot` };

      // Every branch below changes focus, a value, or the scroll position, all
      // of which the tree reports. Drop the cache up front rather than trusting
      // each branch to emit an event we happen to be listening for.
      a11y.invalidate();

      switch (action) {
        case 'focus':
          el.focus({ preventScroll: false });
          return { ok: true, focused: a11y.nameOf(el, a11y.roleOf(el)) };

        case 'blur':
          el.blur();
          return { ok: true };

        case 'scroll_to':
          return { ok: true, rect: await actions.scrollIntoView(el) };

        case 'select_option':
          return actions.selectOption(el, value);

        case 'check':
        case 'uncheck': {
          const want = action === 'check';
          if (el.checked !== want) el.click();
          return { ok: true, checked: el.checked };
        }

        case 'clear':
          if (el.isContentEditable) {
            el.textContent = '';
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          } else {
            actions.setValue(el, '');
          }
          return { ok: true };

        case 'submit': {
          const form = el.closest('form') || el;
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit?.();
          return { ok: true };
        }

        default:
          return { error: `action "${action}" is not handled in the page context` };
      }
    },

    async wait({ for: kind, value, timeout = 15000 }) {
      switch (kind) {
        case 'text':
          return actions.waitFor(() => actions.textPresent(value), timeout);
        case 'no_text':
          return actions.waitFor(() => !actions.textPresent(value), timeout);
        case 'selector':
          return actions.waitFor(() => {
            const el = document.querySelector(value);
            return el && a11y.isVisible(el) ? { found: true } : false;
          }, timeout);
        case 'no_selector':
          return actions.waitFor(() => !document.querySelector(value), timeout);
        case 'ref_gone':
          return actions.waitFor(() => !a11y.resolveRef(value)?.isConnected, timeout);
        case 'url':
          return actions.waitFor(() => location.href.includes(value) || safeRegex(value)?.test(location.href), timeout);
        case 'load':
          return actions.waitFor(() => document.readyState === 'complete', timeout);
        case 'time': {
          const ms = Math.min(Number(value) || 1000, timeout);
          await new Promise((r) => setTimeout(r, ms));
          return { ok: true, ms };
        }
        default:
          return { error: `unknown wait condition: ${kind}` };
      }
    },

    pageInfo() {
      return {
        ...pageMeta(),
        readyState: document.readyState,
        // Structured metadata is disproportionately useful and nearly free.
        meta: {
          description: metaContent('description') || metaContent('og:description'),
          canonical: document.querySelector('link[rel=canonical]')?.href,
        },
        counts: {
          links: document.links.length,
          forms: document.forms.length,
          images: document.images.length,
          iframes: document.querySelectorAll('iframe').length,
        },
        hasCaptcha: detectCaptcha(),
        dialog: openDialog(),
      };
    },

    /** Page lifecycle diagnostics. Visibility is not an input-delivery verdict. */
    visibility() {
      return { visibility: document.visibilityState, hasFocus: document.hasFocus() };
    },

    storage() {
      const dump = (store) => {
        const out = {};
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            const val = store.getItem(key) ?? '';
            out[key] = val.length > 200 ? `${val.slice(0, 200)}… (${val.length} chars)` : val;
          }
        } catch {
          return { error: 'blocked by site policy' };
        }
        return out;
      };
      return { local: dump(localStorage), session: dump(sessionStorage) };
    },

    /**
     * Find the real <input type=file> behind a ref. Most upload UIs hide the
     * input and show a styled button, so the ref the model picked is usually
     * the button, not the input.
     */
    uploadTarget({ ref }) {
      const el = ref ? a11y.resolveRef(ref) : null;

      const candidates = [
        el?.matches?.('input[type=file]') ? el : null,
        el?.querySelector?.('input[type=file]'),
        el?.closest?.('label')?.control,
        el?.closest?.('form')?.querySelector?.('input[type=file]'),
        el?.parentElement?.querySelector?.('input[type=file]'),
        document.querySelector('input[type=file]'),
      ];

      const input = candidates.find(Boolean);
      if (!input) return { error: 'no file input found on this page' };
      return { ok: true, selector: a11y.cssPath(input), multiple: !!input.multiple };
    },

    broadcastOffsets() {
      if (window.top === window) actions.setFrameOffset(0, 0);
      broadcastOffsets();
      return { ok: true, offset: actions.frameOffset };
    },
  };

  function pageMeta() {
    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: {
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        maxY: Math.max(0, (document.documentElement.scrollHeight || 0) - innerHeight),
      },
      frameOffset: { ...actions.frameOffset },
    };
  }

  /**
   * Report an open dialog, with a selector for scoping to it.
   *
   * When a modal is open it is almost always the only thing that matters, and
   * on a large app it is also the part most likely to be cut off — it gets
   * appended at the end of the document, after everything else has already
   * consumed the read budget. Naming it turns "my controls are missing" into
   * "scope to this selector".
   */
  function openDialog() {
    const candidates = [
      ...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
    ].filter((el) => a11y.isVisible(el) && el.getBoundingClientRect().width > 80);

    if (!candidates.length) return null;

    // Innermost wins: a dialog stacked on a dialog is the active one.
    const el = candidates[candidates.length - 1];
    return {
      name: a11y.nameOf(el, 'dialog') || null,
      modal: el.getAttribute('aria-modal') === 'true' || el.localName === 'dialog',
      selector: a11y.cssPath(el),
      count: candidates.length,
    };
  }

  function metaContent(name) {
    return (
      document.querySelector(`meta[name="${name}"]`)?.content ||
      document.querySelector(`meta[property="${name}"]`)?.content ||
      null
    );
  }

  /**
   * Report CAPTCHA presence so the agent can say "a CAPTCHA is blocking this"
   * instead of silently failing. Solving them is not something this tool does.
   */
  function detectCaptcha() {
    const markers = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[title*="challenge" i]',
      '.g-recaptcha',
      '#cf-challenge-running',
      '[data-sitekey]',
    ];

    // Presence in the DOM is not enough. Invisible reCAPTCHA ships a zero-sized
    // aframe on every page of an enormous number of sites — eBay's own working
    // search results carry one — so matching the selector alone reported "a
    // human must solve this" for pages that were perfectly usable. That is the
    // one wrong answer that makes an agent abandon a page it could have used,
    // so a marker has to actually occupy the screen before it counts.
    for (const sel of markers) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 60 && a11y.isVisible(el)) return true;
      }
    }

    // Wording covers the common bot walls: reCAPTCHA/hCaptcha prompts,
    // Cloudflare, and Imperva's "Pardon Our Interruption" interstitial, which
    // is what eBay serves and which renders no marker element at all.
    return /verify you are human|are you a robot|complete the security check|pardon our interruption/i.test(
      document.body?.innerText?.slice(0, 3000) || ''
    );
  }

  function safeRegex(source) {
    const match = /^\/(.*)\/([gimsuy]*)$/.exec(source);
    if (!match) return null;
    try {
      return new RegExp(match[1], match[2]);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg?.cmd];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(msg.args || {}))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

    return true; // keep the message channel open for the async response
  });

  // Seed the offset cascade. Frames appear and move constantly, so re-run on
  // load and on resize rather than assuming one pass at startup is enough.
  if (window.top === window) {
    const seed = () => {
      actions.setFrameOffset(0, 0);
      broadcastOffsets();
    };
    if (document.readyState === 'loading') {
      addEventListener('DOMContentLoaded', seed, { once: true });
    } else {
      seed();
    }
    addEventListener('load', seed);
    addEventListener('resize', debounce(seed, 200));
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }
})();
