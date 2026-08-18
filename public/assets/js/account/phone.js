/* ============================================================
   ACCOUNT · THE PHONE LAYER
   ------------------------------------------------------------
   The behaviour that goes with phone.css: the More sheet, and
   the large title collapsing into the compact bar.

   IT DOES NOTHING ABOVE 900px. The iPad and desktop layouts are
   already right; every listener below either checks the width or
   is attached to something phone.css alone makes visible.

   NO FRAMEWORK, NO GESTURE LIBRARY. A back-swipe that is nearly
   right is worse than none — it fights the browser's own
   navigation gesture on iOS and you end up with two things
   arguing over the same drag. So: taps, and one scroll listener.
   ============================================================ */
(function () {
  "use strict";

  const phone = () => window.matchMedia("(max-width: 900px)").matches;

  /* ---- the More sheet -----------------------------------------
     Built from the sidebar's own buttons rather than written out
     again. Two lists of destinations is two lists that disagree
     the first time one is edited. */

  const sheet = document.getElementById("more-sheet");
  const list = document.getElementById("more-list");
  const tab = document.getElementById("more-tab");

  const CHEV =
    '<span class="chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

  function build() {
    if (!list) return;
    list.innerHTML = "";

    document.querySelectorAll(".acc-nav").forEach((nav) => {
      /* The four that are already tabs are not repeated here, and
         anything the server withheld — Account and Health records
         on a token session — is hidden and stays out. */
      if (nav.hasAttribute("data-tab") || nav.hidden) return;

      const item = document.createElement("button");
      item.type = "button";
      item.className = "sheet-item";
      item.dataset.route = nav.dataset.route;

      const icon = nav.querySelector(".ic");
      item.innerHTML =
        (icon ? `<span class="ic">${icon.innerHTML}</span>` : "") +
        `<span>${nav.textContent.trim()}</span>` +
        CHEV;

      list.appendChild(item);
    });
  }

  function open() {
    if (!sheet) return;
    build();
    sheet.hidden = false;
    /* A frame between display and the class, or the transition has
       nothing to animate from and the sheet simply appears. */
    requestAnimationFrame(() => sheet.classList.add("on"));
  }

  function close() {
    if (!sheet) return;
    sheet.classList.remove("on");
    /* Kept in the DOM until the slide-down has finished. Hiding it
       at once is the difference between a sheet that closes and a
       sheet that vanishes. */
    setTimeout(() => {
      sheet.hidden = true;
    }, 280);
  }

  if (tab) tab.addEventListener("click", open);

  if (sheet) {
    sheet.addEventListener("click", (event) => {
      /* Outside the card closes it — the scrim is the target only
         when the tap missed the card. */
      if (event.target === sheet) return close();

      const item = event.target.closest(".sheet-item");
      if (!item) return;
      close();
      /* The app's own router picks this up from the delegated
         [data-route] listener in app.js; nothing here needs to
         know how a screen is shown. */
    });
  }

  /* Rebuilt whenever the panel redraws, so a nav item hidden by a
     token session never appears in the sheet either. */
  window.addEventListener("account:drawn", build);

  /* ---- the large title collapsing -----------------------------
     iOS fades a compact bar in as the large title leaves. The
     threshold is the title's own position rather than a magic
     number, so it is right on every screen whatever sits above
     the heading. */

  const topbar = document.getElementById("topbar");
  const main = document.getElementById("main");
  let ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;

    requestAnimationFrame(() => {
      ticking = false;
      if (!topbar || !phone()) return;

      const view = document.querySelector(".acc-view:not([hidden])");
      const title = view && view.querySelector(".acc-title");
      if (!title) {
        topbar.classList.remove("on");
        return;
      }

      /* Gone under the bar, rather than merely scrolled a bit. */
      const gone = title.getBoundingClientRect().bottom < 52;
      topbar.classList.toggle("on", gone);
      if (gone && topbar.textContent !== title.textContent) {
        topbar.textContent = title.textContent;
      }
    });
  }

  /* The page scrolls on the window on a phone — .acc-main is not
     the scroller there — so both are listened to and whichever is
     real wins. */
  window.addEventListener("scroll", onScroll, { passive: true });
  if (main) main.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("account:drawn", () => {
    if (topbar) topbar.classList.remove("on");
    onScroll();
  });
})();
