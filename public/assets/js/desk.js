/* ============================================================
   CONSULT.HTML — page glue

   One job. The desk itself is receptionist.js; this is the one
   thing that belongs to the page around it: retiring the no-JS
   fallback once the widget is actually up.

   It used to carry the theme toggle too. The public site is
   light-only now — one look for every visitor, and what you see
   while building it is what they see.
   ============================================================ */
"use strict";

(function () {
  /* ---- the fallback ----
     Removed only when the widget has genuinely mounted. Doing it on
     DOMContentLoaded instead would blank the page whenever
     receptionist.js failed to load — which is exactly the case the
     fallback exists for. */
  function retireFallback() {
    const el = document.getElementById("deskFallback");
    if (el) el.remove();
  }

  let waited = 0;
  const poll = setInterval(() => {
    if (window.receptionist) {
      clearInterval(poll);
      retireFallback();
    } else if ((waited += 120) > 6000) {
      // The desk never booted. Leave the fallback in place and say
      // so plainly rather than showing an empty page.
      clearInterval(poll);
      const el = document.getElementById("deskFallback");
      if (el) {
        el.querySelector("h1").textContent = "The front desk isn't available";
        const lead = el.querySelector("p");
        if (lead) {
          lead.innerHTML =
            'Something stopped it loading. Email <a href="mailto:khadija@mindyourfood.co.in?subject=Consultation%20request">khadija@mindyourfood.co.in</a> ' +
            "with your name, what you'd like help with, and two times that suit you — she'll reply personally.";
        }
      }
    }
  }, 120);

})();
