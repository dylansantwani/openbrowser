/**
 * In-page actions: geometry, scrolling, form manipulation, and waiting.
 *
 * Division of labour with the background script matters here. Anything that
 * needs a *trusted* event — real clicks, real keystrokes — is done from the
 * background via the Chrome debugger, because sites like Stripe, Google, and
 * most banks explicitly reject `isTrusted: false` events. This file handles
 * everything that does not need trust: finding where a target is, getting it
 * on screen and unobstructed, reading state back, and the value-setting paths
 * where a native setter plus the right event sequence is genuinely equivalent.
 */

var OB = globalThis.OB || (globalThis.OB = {});

(() => {
  'use strict';

  // Re-injection would reset frameOffset below back to 0,0 while the parent's
  // offset cascade is not due to run again until load or resize — every click
  // in this frame would land at the wrong pixel in the meantime. See a11y.js.
  if (OB.__actionsLoaded) return;
  OB.__actionsLoaded = true;

  const { resolveRef, rectOf } = OB.a11y;

  /** This frame's offset within the top-level viewport; see main.js. */
  const frameOffset = { x: 0, y: 0 };

  function setFrameOffset(x, y) {
    frameOffset.x = x;
    frameOffset.y = y;
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  /**
   * Where to click, in top-level viewport coordinates.
   *
   * Returns the element's centre unless something else is on top of it, in
   * which case we probe for an unobstructed point. That single behaviour fixes
   * a large share of "the click did nothing" failures: sticky headers, cookie
   * banners, and floating chat widgets all cover their targets partially.
   */
  function clickPoint(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    if (isPointOn(el, cx, cy)) {
      return { x: cx + frameOffset.x, y: cy + frameOffset.y, obstructed: false };
    }

    // Centre is covered. Sample a grid biased toward the edges, which is where
    // an overlay usually is not.
    const fractions = [0.25, 0.75, 0.15, 0.85, 0.5];
    for (const fy of fractions) {
      for (const fx of fractions) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        if (isPointOn(el, x, y)) {
          return { x: x + frameOffset.x, y: y + frameOffset.y, obstructed: false };
        }
      }
    }

    // Off screen is a different problem from covered, and it needs a different
    // fix — scrolling rather than dismissing an overlay. Reporting it as
    // "covered by unknown" sends the caller chasing an overlay that is not
    // there.
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      return {
        x: cx + frameOffset.x,
        y: cy + frameOffset.y,
        obstructed: true,
        offscreen: true,
        obstructedBy: 'nothing — the element is outside the viewport and could not be scrolled into view',
      };
    }

    const hit = document.elementFromPoint(cx, cy);

    // A decoration sitting on top of its own field is not an obstruction.
    // Placeholder text, floating labels, and character counters all live inside
    // the field's own container and route the click to the control anyway —
    // Facebook's composer placeholder is exactly this. Refusing to click those
    // blocks perfectly ordinary text entry.
    if (isLocalDecoration(hit, el)) {
      return { x: cx + frameOffset.x, y: cy + frameOffset.y, obstructed: false };
    }

    // Genuinely covered. Report the centre plus what is in the way, so the
    // caller can decide between forcing the click and dismissing the overlay.
    return {
      x: cx + frameOffset.x,
      y: cy + frameOffset.y,
      obstructed: true,
      obstructedBy: describe(hit),
    };
  }

  /**
   * Is `hit` a decoration belonging to `target`'s own field, rather than a
   * separate layer covering it?
   *
   * True when the two share a close ancestor and the covering element carries
   * no interactive role of its own. A real blocking overlay — a modal, a cookie
   * banner, a sticky header — is neither.
   */
  function isLocalDecoration(hit, target) {
    if (!hit || hit === target) return false;
    if (hit.matches?.('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="dialog"]')) {
      return false;
    }

    // A shared ancestor within a few hops means same widget. Beyond that, the
    // relationship is too loose to assume the click routes correctly.
    let ancestor = target.parentElement;
    for (let i = 0; i < 3 && ancestor; i++, ancestor = ancestor.parentElement) {
      if (ancestor.contains(hit)) return true;
    }
    return false;
  }

  /** Is (x,y) actually hitting `el` (or something inside it)? */
  function isPointOn(el, x, y) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    let hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === el || el.contains(hit)) return true;

    // Pierce shadow roots — web components report their host, not the inner node.
    let guard = 0;
    while (hit?.shadowRoot && guard++ < 10) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
      if (hit === el || el.contains(hit)) return true;
    }

    // A label covering its own control still routes the click correctly.
    if (hit?.localName === 'label' && (hit.control === el || hit.contains(el))) return true;
    return false;
  }

  function describe(el) {
    if (!el) return 'unknown';
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
    return `<${el.localName}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}>`;
  }

  /**
   * Get an element on screen and settled.
   *
   * `scrollIntoView` with smooth behaviour is a trap in automation: it resolves
   * immediately while the page is still moving, and the subsequent click lands
   * on whatever slid into that spot. We force instant scrolling and then wait
   * for the position to actually stop changing.
   */
  async function scrollIntoView(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await settleScroll(el);
    return rectOf(el);
  }

  /**
   * Wait one frame, or ~one frame's worth of time.
   *
   * requestAnimationFrame does not fire in a background tab, or in any tab the
   * compositor has stopped painting. Awaiting it bare means every action on a
   * background tab hangs forever — which would quietly break the entire
   * parallel-tabs workflow, since those tabs are backgrounded by design.
   */
  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 32);
    });
  }

  async function settleScroll(el, maxWaitMs = 600) {
    const start = performance.now();
    let last = el.getBoundingClientRect().top;
    let stableFrames = 0;

    while (performance.now() - start < maxWaitMs) {
      await nextFrame();
      const now = el.getBoundingClientRect().top;
      if (Math.abs(now - last) < 0.5) {
        if (++stableFrames >= 2) return;
      } else {
        stableFrames = 0;
      }
      last = now;
    }
  }

  // ---------------------------------------------------------------------------
  // Value setting
  // ---------------------------------------------------------------------------

  /**
   * Set an input's value so that React, Vue, Angular, and Svelte all notice.
   *
   * Assigning `.value` directly updates the DOM but bypasses React's value
   * tracker, so React re-renders the old value straight back over it. Calling
   * the *native* setter off the prototype defeats the tracker, and the event
   * pair afterwards is what every framework listens for.
   */
  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    // execCommand is deprecated but remains the only reliable way to produce an
    // undoable, framework-visible edit in a contenteditable region.
    if (!document.execCommand('insertText', false, value)) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    }
  }

  function fillField(ref, value, { clear = true } = {}) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref ${ref} no longer exists — take a fresh snapshot` };

    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true' || value === 'on' || value === 1;
      if (el.checked !== want) el.click(); // click keeps radio-group semantics correct
      return { ok: true, ref, value: el.checked };
    }

    if (el.localName === 'select') {
      return selectOption(el, value);
    }

    if (el.isContentEditable) {
      setContentEditable(el, String(value));
      return { ok: true, ref, value: el.textContent.slice(0, 80) };
    }

    el.focus();
    if (clear) setValue(el, '');
    setValue(el, String(value));
    return { ok: true, ref, value: el.value?.slice(0, 80) };
  }

  /** Match a <select> option by value, then exact label, then substring. */
  function selectOption(el, wanted) {
    const wants = Array.isArray(wanted) ? wanted.map(String) : [String(wanted)];
    const options = [...el.options];
    const chosen = [];

    for (const want of wants) {
      const lower = want.toLowerCase();
      const match =
        options.find((o) => o.value === want) ||
        options.find((o) => o.textContent.trim() === want) ||
        options.find((o) => o.textContent.trim().toLowerCase() === lower) ||
        options.find((o) => o.textContent.trim().toLowerCase().includes(lower));

      if (!match) {
        return {
          ok: false,
          error: `no option matching "${want}". Available: ${options.slice(0, 20).map((o) => o.textContent.trim()).join(' | ')}`,
        };
      }
      match.selected = true;
      chosen.push(match.textContent.trim());
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: chosen.join(', ') };
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  /**
   * Poll for a DOM condition. Uses MutationObserver to react immediately when
   * the page changes, with a slow timer as a backstop for conditions that no
   * mutation triggers (an element scrolling into view, a CSS transition ending).
   */
  function waitFor(predicate, timeout = 15000) {
    return new Promise((resolve) => {
      const started = Date.now();

      const check = () => {
        let result;
        try {
          result = predicate();
        } catch {
          result = false;
        }
        if (result) {
          cleanup();
          resolve({ ok: true, ms: Date.now() - started, value: result === true ? undefined : result });
          return true;
        }
        if (Date.now() - started > timeout) {
          cleanup();
          resolve({ ok: false, ms: Date.now() - started, error: `timed out after ${timeout}ms` });
          return true;
        }
        return false;
      };

      let observer, interval;
      const cleanup = () => {
        observer?.disconnect();
        clearInterval(interval);
      };

      if (check()) return;

      observer = new MutationObserver(() => check());
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      interval = setInterval(check, 250);
    });
  }

  /**
   * Is this text on the page?
   *
   * Accessible names count, not just rendered text. A caller waits for the
   * string the tool just showed it, and snapshot names come from `aria-label`,
   * `title`, `alt` and `placeholder` at least as often as from text nodes —
   * OpenCart's "Add to Cart" is an icon button named by a title attribute, so
   * `browser_find` located it instantly while `browser_wait for:"text"` sat
   * there for the full 25 seconds and timed out. Waiting for something the tool
   * has just displayed must never be the thing that fails.
   */
  function textPresent(needle) {
    const lower = needle.toLowerCase();
    if ((document.body?.innerText || '').toLowerCase().includes(lower)) return true;

    for (const el of document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')) {
      for (const attr of ['aria-label', 'title', 'alt', 'placeholder']) {
        const value = el.getAttribute(attr);
        if (value && value.toLowerCase().includes(lower)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Visual overlay
  // ---------------------------------------------------------------------------

  /**
   * Briefly outline an element that is being acted on. Purely for the human
   * watching the side panel — it makes a long automation run legible instead of
   * pages flickering with no explanation.
   */
  function highlight(el, label) {
    if (!el?.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'ob-highlight';
    box.style.cssText =
      `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    if (label) box.dataset.obLabel = label;
    (document.body || document.documentElement).appendChild(box);
    setTimeout(() => box.remove(), 900);
  }

  /**
   * Show or hide the persistent "an agent is driving this tab" frame.
   *
   * Top frame only: an iframe drawing its own border would put a second box
   * inside the page, and the point is one unmistakable marker per tab.
   *
   * Re-applied by the background on every call rather than tracked, because a
   * navigation replaces the document and takes the frame with it — cheap enough
   * that "just set it again" beats keeping state in sync with the page.
   */
  function agentFrame(on, label = 'OpenBrowser agent') {
    if (window.top !== window) return false;
    const root = document.body || document.documentElement;
    if (!root) return false;

    let box = document.querySelector('.ob-agent-frame');
    if (!on) {
      box?.remove();
      return false;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'ob-agent-frame';
      // The overlay must survive a page that reparents or clears body children.
      root.appendChild(box);
    } else if (box.parentElement !== root) {
      root.appendChild(box);
    }
    if (box.dataset.obAgent !== label) box.dataset.obAgent = label;
    return true;
  }

  OB.actions = {
    clickPoint,
    isPointOn,
    scrollIntoView,
    settleScroll,
    setValue,
    fillField,
    selectOption,
    waitFor,
    textPresent,
    highlight,
    agentFrame,
    setFrameOffset,
    frameOffset,
    describe,
  };
})();
