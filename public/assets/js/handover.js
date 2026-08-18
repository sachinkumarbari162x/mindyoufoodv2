/* ============================================================
   HANDOVER — the moment between the desk and the till
   ------------------------------------------------------------
   The visitor presses a button and the browser goes and fetches
   another page. On a good connection that is a blink. On a train
   it is four seconds of a page that looks broken, at the exact
   moment somebody has decided to spend money — which is the worst
   possible time to make them wonder whether it worked.

   So the room stays, and something quiet happens on it while the
   next page loads.

   ---- WHY IT IS AN INLINE SVG AND NOT A GIF OR A CANVAS -------
   It is four elements and one CSS animation on a transform, which
   costs nothing and needs no file to arrive — a spinner that has
   to be downloaded is a spinner that is not there when the
   connection is the problem. It is drawn in the same ink as
   everything else and inherits the page's colour.

   ---- AND WHY IT NEVER LIES ----------------------------------
   It fades in after a beat. If the next page is already there,
   nobody sees it at all, because a loading screen that flashes up
   on a fast connection makes a fast thing feel slow.
   ============================================================ */
(() => {
  "use strict";

  /* Long enough that a quick navigation never shows it. Anything
     under this and the browser has already gone. */
  const PATIENCE = 260;

  let veil = null;

  function build(message) {
    const el = document.createElement("div");
    el.className = "handover";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML = `
      <div class="handover-inner">
        <svg class="handover-mark" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
          <circle class="handover-track" cx="24" cy="24" r="21" fill="none" stroke-width="1"/>
          <circle class="handover-arc"   cx="24" cy="24" r="21" fill="none" stroke-width="1.5"
                  stroke-linecap="round"/>
        </svg>
        <p class="handover-word"></p>
      </div>`;
    /* textContent, not innerHTML — the message is ours today and
       there is no reason to leave a hole where it might not be. */
    el.querySelector(".handover-word").textContent = message;
    return el;
  }

  /**
   * Hold the room while the browser goes somewhere.
   * @param {string} url     where to
   * @param {string} message what to say while waiting
   */
  function go(url, message) {
    if (!url) return;

    const timer = setTimeout(() => {
      veil = build(message || "One moment…");
      document.body.appendChild(veil);
      // A frame later, so the transition has a state to leave from.
      requestAnimationFrame(() => veil.classList.add("is-up"));
    }, PATIENCE);

    /* If the page is restored from the back/forward cache, the
       veil would still be sitting there over a working page. */
    addEventListener("pageshow", (e) => {
      if (e.persisted) {
        clearTimeout(timer);
        veil?.remove();
        veil = null;
      }
    });

    location.assign(url);
  }

  window.handover = { go };
})();
