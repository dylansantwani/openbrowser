/* OpenBrowser showcase site */

(function () {
  "use strict";

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasIO = "IntersectionObserver" in window;
  const root = document.documentElement;

  /* An IntersectionObserver can be registered and still never fire — a
     background tab, a prerender, a hidden webview. Every scroll-triggered
     effect below therefore records that it saw at least one callback, and
     `bailOut` runs if none of them did. Without it the page renders blank. */
  let ioFired = false;
  const seen = () => { ioFired = true; };

  /* ---------- scroll progress + nav state ---------- */
  const progress = document.getElementById("progress");
  const nav = document.getElementById("nav");

  function onScroll() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    progress.style.width = max > 0 ? (window.scrollY / max) * 100 + "%" : "0%";
    nav.classList.toggle("scrolled", window.scrollY > 16);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- mobile menu ---------- */
  const burger = document.getElementById("nav-burger");
  const menu = document.getElementById("mobile-menu");

  burger.addEventListener("click", () => {
    const open = burger.getAttribute("aria-expanded") === "true";
    burger.setAttribute("aria-expanded", String(!open));
    menu.hidden = open;
  });

  menu.addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      menu.hidden = true;
      burger.setAttribute("aria-expanded", "false");
    }
  });

  /* ---------- scroll-to buttons ---------- */
  document.querySelectorAll("[data-scroll]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.querySelector(btn.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth" });
    });
  });

  /* ---------- reveal on scroll ---------- */
  const revealables = document.querySelectorAll(".reveal");
  if (hasIO && !prefersReduced) {
    const io = new IntersectionObserver(
      (entries) => {
        seen();
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in-view");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -5% 0px" }
    );
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("in-view"));
  }

  /* ---------- stat counters ---------- */
  const stats = document.querySelectorAll(".stat-num");

  function finalValue(el) {
    const parent = el.parentElement;
    const target = parseInt(parent.dataset.count, 10) || 0;
    return (target ? target.toLocaleString() : "0") + (parent.dataset.suffix || "");
  }

  function animateStat(el) {
    const target = parseInt(el.parentElement.dataset.count, 10) || 0;
    const dur = 1100;
    const start = performance.now();

    function tick(now) {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        el.textContent = Math.round(target * eased).toLocaleString();
        requestAnimationFrame(tick);
      } else {
        el.textContent = finalValue(el);
      }
    }
    requestAnimationFrame(tick);
  }

  if (hasIO && !prefersReduced) {
    const statIo = new IntersectionObserver(
      (entries) => {
        seen();
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          animateStat(entry.target);
          statIo.unobserve(entry.target);
        });
      },
      { threshold: 0.5 }
    );
    stats.forEach((el) => statIo.observe(el));
  } else {
    stats.forEach((el) => { el.textContent = finalValue(el); });
  }

  /* ---------- hero typewriter ----------
     Lines are token arrays so [refs] can be highlighted as they are typed.
  */
  const mockCode = document.getElementById("mock-code");
  const mockFoot = document.getElementById("mock-foot");

  const REF = "c-ref";
  const DIM = "c-dim";

  const snapshotLines = [
    [['"Sign in · Example" · 1280x800 · 6 refs', DIM]],
    [["banner"]],
    [['  link "Example" '], ["[e1]", REF], [" /"]],
    [["main"]],
    [['  heading "Sign in" h1']],
    [["  form"]],
    [['    textbox "Email" '], ["[e2]", REF], [" required"]],
    [['    password "Password" '], ["[e3]", REF], [" required"]],
    [['    checkbox "Remember me" '], ["[e4]", REF], [" unchecked"]],
    [['    button "Sign in" '], ["[e5]", REF]],
    [['  link "Forgot your password?" '], ["[e6]", REF], [" /reset"]]
  ];

  /* Flatten to a per-character stream, so typing is a single index. */
  const chars = [];
  snapshotLines.forEach((line, i) => {
    line.forEach(([text, cls]) => {
      for (const ch of text) chars.push([ch, cls || ""]);
    });
    if (i < snapshotLines.length - 1) chars.push(["\n", ""]);
  });

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Render the first `n` characters, coalescing runs that share a class. */
  function render(n, caret) {
    let html = "";
    let runCls = null;
    let run = "";

    const flush = () => {
      if (!run) return;
      html += runCls
        ? '<span class="' + runCls + '">' + escapeHtml(run) + "</span>"
        : escapeHtml(run);
      run = "";
    };

    for (let i = 0; i < n; i++) {
      const [ch, cls] = chars[i];
      if (cls !== runCls) { flush(); runCls = cls; }
      run += ch;
    }
    flush();

    if (caret) html += '<span class="mock-caret visible" aria-hidden="true"></span>';
    mockCode.innerHTML = html;
  }

  let typed = false;

  function typeSnapshot() {
    if (typed) return;
    typed = true;

    if (prefersReduced) {
      render(chars.length, false);
      mockFoot.classList.add("is-ready");
      return;
    }

    let i = 0;
    (function step() {
      i = Math.min(i + 2, chars.length);
      render(i, true);
      if (i < chars.length) {
        setTimeout(step, 16);
      } else {
        render(chars.length, true);
        setTimeout(() => mockFoot.classList.add("is-ready"), 260);
      }
    })();
  }

  const mock = document.getElementById("mock");
  if (hasIO) {
    new IntersectionObserver(
      (entries, obs) => {
        seen();
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          typeSnapshot();
          obs.disconnect();
        });
      },
      { threshold: 0.25 }
    ).observe(mock);
  } else {
    typeSnapshot();
  }

  /* ---------- failsafe ----------
     If nothing has intersected shortly after load, the observers are not
     going to fire. Show the page rather than leaving it blank, and settle
     every scroll-driven effect on its finished state.
  */
  setTimeout(function bailOut() {
    if (ioFired) return;
    root.classList.remove("js-reveal");
    revealables.forEach((el) => el.classList.add("in-view"));
    stats.forEach((el) => { el.textContent = finalValue(el); });
    if (!typed) {
      typed = true;
      render(chars.length, false);
    }
    mockFoot.classList.add("is-ready");
  }, 1200);

  /* ---------- install tabs ---------- */
  const tabs = document.querySelectorAll(".tab");
  const panes = document.querySelectorAll(".code-pane");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      panes.forEach((p) => p.classList.toggle("active", p.dataset.pane === tab.dataset.tab));
    });
  });

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const codeEl = document.getElementById(btn.dataset.copy);
      if (!codeEl) return;

      const label = btn.querySelector("span");
      const original = label.textContent;
      label.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(() => {
        label.textContent = original;
        btn.classList.remove("copied");
      }, 1600);

      const text = codeEl.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(codeEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("copy");
        sel.removeAllRanges();
      }
    });
  });

  /* ---------- active nav link ---------- */
  const sections = document.querySelectorAll("main section[id]");
  const navLinks = document.querySelectorAll(".nav-links a");

  if (hasIO && navLinks.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((a) => {
            a.classList.toggle("current", a.getAttribute("href") === "#" + entry.target.id);
          });
        });
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    sections.forEach((s) => spy.observe(s));
  }
})();
