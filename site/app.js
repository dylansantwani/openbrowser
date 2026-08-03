/* OpenBrowser showcase site */

(function () {
  "use strict";

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- scroll progress ---------- */
  const progress = document.getElementById("progress");
  const nav = document.getElementById("nav");

  function onScroll() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    progress.style.width = max > 0 ? (window.scrollY / max) * 100 + "%" : "0%";
    nav.classList.toggle("scrolled", window.scrollY > 24);
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
  if ("IntersectionObserver" in window && !prefersReduced) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("in-view"));
  }

  /* ---------- stat counters ---------- */
  const stats = document.querySelectorAll(".stat-num");

  function animateStat(el) {
    const target = parseInt(el.dataset.count || el.parentElement.dataset.count, 10) || 0;
    const suffix = el.parentElement.dataset.suffix || "";
    const dur = 1400;
    const start = performance.now();

    function tick(now) {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = (target ? target.toLocaleString() : "0") + suffix;
    }
    requestAnimationFrame(tick);
  }

  if ("IntersectionObserver" in window && !prefersReduced) {
    const statIo = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateStat(entry.target);
            statIo.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );
    stats.forEach((el) => statIo.observe(el));
  } else {
    stats.forEach((el) => {
      const target = parseInt(el.parentElement.dataset.count, 10) || 0;
      el.textContent = (target ? target.toLocaleString() : "0") + (el.parentElement.dataset.suffix || "");
    });
  }

  /* ---------- hero typewriter ---------- */
  const mockCode = document.getElementById("mock-code");
  const mockCaret = document.getElementById("mock-caret");
  const mockPill = document.getElementById("mock-pill");
  const mockPillText = document.getElementById("mock-pill-text");

  const snapshotLines = [
    { text: "app.example.com/login · \"Sign in · Example\" · tab 481 · 1280x800", cls: "c-dim" },
    { text: "banner" },
    { text: "  link \"Example\" [e1] /" },
    { text: "main" },
    { text: "  heading \"Sign in\" h1" },
    { text: "  form" },
    { text: "    textbox \"Email\" [e2] required" },
    { text: "    password \"Password\" [e3] required" },
    { text: "    checkbox \"Remember me\" [e4] unchecked" },
    { text: "    button \"Sign in\" [e5]" },
    { text: "  link \"Forgot your password?\" [e6] /reset" }
  ];

  let typed = false;

  function typeSnapshot() {
    if (typed) return;
    typed = true;
    if (prefersReduced) {
      mockCode.innerHTML = snapshotLines
        .map((l) => '<span class="' + (l.cls || "") + '">' + escapeHtml(l.text) + "</span>")
        .join("\n");
      mockCaret.classList.add("visible");
      showPill();
      return;
    }
    mockCaret.classList.add("visible");
    let line = 0;
    let col = 0;

    function typeNext() {
      if (line >= snapshotLines.length) {
        showPill();
        return;
      }
      const current = snapshotLines[line];
      const frag = document.createElement("span");
      if (current.cls) frag.className = current.cls;
      frag.textContent = current.text.slice(0, col);
      mockCode.appendChild(frag);
      col += 1;
      if (col > current.text.length) {
        mockCode.appendChild(document.createTextNode("\n"));
        line += 1;
        col = 0;
      }
      setTimeout(typeNext, 14);
    }
    setTimeout(typeNext, 350);
  }

  function showPill() {
    setTimeout(() => {
      mockPillText.textContent = "356 characters · ~90 tokens";
      mockPill.classList.add("show");
    }, 350);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const mock = document.getElementById("mock");
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && typeSnapshot()),
      { threshold: 0.3 }
    ).observe(mock);
  } else {
    typeSnapshot();
  }

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
      const done = () => {
        label.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          label.textContent = original;
          btn.classList.remove("copied");
        }, 1800);
      };

      done();

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

  if ("IntersectionObserver" in window && navLinks.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            navLinks.forEach((a) => {
              a.style.color = a.getAttribute("href") === "#" + entry.target.id ? "var(--text)" : "";
            });
          }
        });
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    sections.forEach((s) => spy.observe(s));
  }
})();
