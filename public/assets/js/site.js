/* ============================================================
   MIND YOUR FOOD · v2.0.0 — page behaviour
   Vanilla, no dependencies. Everything degrades safely if a
   given element isn't on the page.
   ============================================================ */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;


  /* ----------------------------------------------------------
     1 · NAV — scrolled state, drawer, sliding pill, active link
     ---------------------------------------------------------- */
  (function nav() {
    var nav = $("#nav");
    var links = $("#navLinks");
    var burger = $("#burger");
    var pill = $("#navPill");
    var anchors = $$("[data-nav]");
    if (!nav) return;

    /* --- glass swaps to the page theme once the sheet is under it --- */
    var onScroll = function () {
      nav.classList.toggle("is-scrolled", window.scrollY > window.innerHeight * 0.82);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();

    /* --- mobile drawer --- */
    if (burger && links) {
      var setOpen = function (open) {
        links.classList.toggle("open", open);
        burger.setAttribute("aria-expanded", String(open));
      };

      burger.addEventListener("click", function () {
        setOpen(burger.getAttribute("aria-expanded") !== "true");
      });

      // Close on link tap, on Escape, and on any click outside the bar.
      links.addEventListener("click", function (e) {
        if (e.target.closest("a")) setOpen(false);
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") setOpen(false);
      });
      document.addEventListener("click", function (e) {
        if (!e.target.closest(".nav-glass")) setOpen(false);
      });
    }

    /* --- the pill that slides between links (desktop) --- */
    var movePill = function (el) {
      if (!pill || !el || window.innerWidth <= 860) return;
      pill.style.width = el.offsetWidth + "px";
      pill.style.transform = "translate(" + el.offsetLeft + "px, -50%)";
      pill.classList.add("show");
    };

    var activeLink = function () {
      return $(".nav-links a.active") || anchors[0];
    };

    anchors.forEach(function (a) {
      a.addEventListener("mouseenter", function () { movePill(a); });
    });
    if (links) {
      links.addEventListener("mouseleave", function () { movePill(activeLink()); });
    }

    /* --- highlight the section you're actually looking at --- */
    var sections = anchors
      .map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); })
      .filter(Boolean);

    if (sections.length && "IntersectionObserver" in window) {
      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          anchors.forEach(function (a) {
            var on = a.getAttribute("href") === "#" + entry.target.id;
            a.classList.toggle("active", on);
            if (on) movePill(a);
          });
        });
      }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });

      sections.forEach(function (s) { spy.observe(s); });
    }

    window.addEventListener("resize", function () { movePill(activeLink()); });
  })();


  /* ----------------------------------------------------------
     2 · HERO — parallax lift + fade as the sheet pulls up over it
     ---------------------------------------------------------- */
  (function hero() {
    var inner = $("#heroInner");
    var video = $("#heroVideo");
    if (!inner) return;

    if (!reduceMotion) {
      var ticking = false;
      var frame = function () {
        var p = Math.min(window.scrollY / (window.innerHeight * 0.9), 1);
        inner.style.transform = "translateY(" + (p * -70) + "px) scale(" + (1 - p * 0.05) + ")";
        inner.style.opacity = String(1 - p * 1.15);
        ticking = false;
      };
      window.addEventListener("scroll", function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(frame);
      }, { passive: true });
      frame();
    }

    if (!video) return;

    // Plays at its natural rate — no playbackRate override, no seeking,
    // no frame pinning. The browser's own `loop` handles the repeat.

    // A muted autoplay video can still be blocked; ask once, and stop caring if refused.
    var kick = video.play();
    if (kick && typeof kick.catch === "function") kick.catch(function () { /* browser said no */ });

    if (reduceMotion) {
      video.pause();
      return;
    }

    // Don't burn CPU decoding frames nobody can see.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var p = video.play();
            if (p && typeof p.catch === "function") p.catch(function () { });
          } else {
            video.pause();
          }
        });
      }, { threshold: 0.05 }).observe(video);
    }
  })();


  /* ----------------------------------------------------------
     3 · NUTRIENT COLUMN — on its own clock
     ------------------------------------------------------------
     Deliberately NOT tied to the video. Reading playback position
     meant the reveal inherited every decode hiccup and every loop
     restart, which read as stuttering.

     The rose highlighter runs ONCE, riding the reveal cascade in.
     After that it belongs to the pointer: hover on a mouse, tap to
     pin on touch/pen. It never cycles on its own — a highlight
     strobing through six rows forever is noise, not emphasis.
     ---------------------------------------------------------- */
  (function nutrients() {
    var list = $("#nlList");
    if (!list) return;

    var items = $$(".nl-item", list);
    if (!items.length) return;

    // Claim the list so a second driver (trial.js) stands down.
    list.dataset.bound = "1";

    var bar = $("#nlBar");
    var seenEl = $("#nlSeen");

    /* --- the highlighter: one row at a time, or none at all --- */
    var setCurrent = function (n) {
      items.forEach(function (el, i) {
        el.classList.toggle("is-current", i === n && el.classList.contains("in"));
      });
    };
    var clearCurrent = function () { setCurrent(-1); };

    /* --- pointer control: hover with a mouse, tap-to-pin on touch ---
       Split on pointerType rather than sniffing the device. A mouse
       gets enter/leave hover; touch and pen pin the row on tap and
       hold it until you tap another row or tap away — a touch
       "hover" that vanishes the instant your finger lifts is
       useless on a phone or an iPad. */
    items.forEach(function (el, i) {
      el.addEventListener("pointerenter", function (e) {
        if (e.pointerType === "mouse") setCurrent(i);
      });
      el.addEventListener("pointerleave", function (e) {
        if (e.pointerType === "mouse") clearCurrent();
      });
      el.addEventListener("pointerdown", function (e) {
        if (e.pointerType !== "mouse") setCurrent(i);
      });
    });

    document.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse" && !e.target.closest(".nl-item")) clearCurrent();
    });

    /* --- no motion wanted: show the finished state, pointer still works --- */
    if (reduceMotion) {
      items.forEach(function (el) { el.classList.add("in"); });
      if (seenEl) seenEl.textContent = String(items.length);
      if (bar) bar.style.animation = "none";
      return;
    }

    var STEP = 333;                       // ms between nutrients
    var CYCLE = STEP * items.length;      // one full pass — ~2s over six

    // Hand the cascade length to the CSS animation so the bar and the
    // list can never drift apart.
    if (bar) bar.style.animationDuration = (CYCLE / 1000) + "s";

    var idx = -1;
    var seen = 0;
    var timer = 0;
    var started = false;
    var done = false;

    var stopTimer = function () {
      clearInterval(timer);
      timer = 0;
    };

    var advance = function () {
      idx++;

      // Cascade finished: drop the highlight and hand over to the pointer.
      if (idx >= items.length) {
        clearCurrent();
        done = true;
        stopTimer();
        return;
      }

      var el = items[idx];
      el.classList.add("in");
      seen++;
      if (seenEl) seenEl.textContent = String(seen);
      setCurrent(idx);
    };

    var start = function () {
      if (done || timer) return;
      if (!started) {           // first run only — no dead air up front,
        started = true;         // and re-entering the hero never skips ahead
        advance();
      }
      timer = setInterval(advance, STEP);
      if (bar) bar.style.animationPlayState = "running";
    };

    var stop = function () {
      if (done) return;         // nothing left to pause
      stopTimer();
      if (bar) bar.style.animationPlayState = "paused";
    };

    /* --- only run while the hero is actually on screen --- */
    document.addEventListener("visibilitychange", function () {
      document.hidden ? stop() : start();
    });

    var hero = $("#hero");
    if (hero && "IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          entry.isIntersecting ? start() : stop();
        });
      }, { threshold: 0.02 }).observe(hero);
    }

    start();
  })();


  /* ----------------------------------------------------------
     4 · SCROLL REVEAL
     ---------------------------------------------------------- */
  (function reveal() {
    var items = $$(".reveal");
    if (!items.length) return;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("in"); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (!entry.isIntersecting) return;
        // Slight stagger so a grid lands as a wave, not a slab.
        setTimeout(function () { entry.target.classList.add("in"); }, i * 70);
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

    items.forEach(function (el) { io.observe(el); });
  })();


  /* ----------------------------------------------------------
     5 · NEWSLETTER — weekly myth, double opt-in

     Progressive enhancement over a real <form>. The server does the
     validation that counts; this only exists so the visitor gets an
     answer in place instead of a page navigation.

     Nothing is subscribed here. The endpoint sends a confirmation
     email and the subscription starts when its link is clicked, so
     the success copy says "check your inbox", never "you're in".
     ---------------------------------------------------------- */
  (function () {
    var form = $("#newsletterForm");
    if (!form || !window.fetch) return;

    var input = form.querySelector(".news-input");
    var button = form.querySelector(".news-submit");
    var status = form.querySelector("[data-news-status]");
    var hp = form.querySelector('input[name="company"]');
    var sent = false;

    function report(state, message) {
      status.dataset.state = state;
      status.textContent = message;
    }

    // Validity is only shown once they have left the field — marking
    // the box red while somebody is mid-way through typing is noise.
    input.addEventListener("blur", function () {
      if (input.value && !input.checkValidity()) input.setAttribute("aria-invalid", "true");
    });
    input.addEventListener("input", function () {
      input.removeAttribute("aria-invalid");
      if (status.textContent && !sent) report("", "");
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (sent || button.disabled) return;

      var email = input.value.trim();
      if (!email || !input.checkValidity()) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
        report("error", "Could you check that address? It looks incomplete.");
        return;
      }

      button.disabled = true;
      var original = button.textContent;
      button.textContent = "Sending…";
      report("", "");

      fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          company: hp ? hp.value : "",
          locale: navigator.language
        })
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (r) {
          if (r.ok) {
            // Lock the form: a second submit would only send a second
            // confirmation email to the same address.
            sent = true;
            input.disabled = true;
            button.textContent = "Check your inbox";
            report("ok", r.data.message || "Almost there — check your inbox to confirm.");
          } else {
            button.disabled = false;
            button.textContent = original;
            report("error", r.data.message || "That didn't go through. Try again in a moment?");
          }
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = original;
          report(
            "error",
            "I couldn't reach the mailing list — check your connection and try again."
          );
        });
    });
  })();


  /* ----------------------------------------------------------
     6 · ODDS AND ENDS
     ---------------------------------------------------------- */
  var yr = $("#yr");
  if (yr) yr.textContent = String(new Date().getFullYear());

})();
