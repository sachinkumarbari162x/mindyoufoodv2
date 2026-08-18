/* ============================================================
   HOURS — the weekly pattern, and the days that break it
   ------------------------------------------------------------
   Everything on this page writes to the SAME two tables the slot
   engine reads, so what she sees here and what a visitor is
   offered cannot drift apart.
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import * as week from "../week.js";
import * as editor from "../hours-editor.js";
import * as masthead from "../masthead.js";
import * as calendar from "../calendar.js";
import { start, fill, markSource, $ } from "../page.js";

function paint(data) {
  week.draw($("[data-week]"), data.rules);

  // fill() leaves the empty state alone when there is nothing, which
  // is right everywhere else — but here a removed exception must
  // actually disappear rather than linger from the last render.
  const host = $('[data-list="exceptions"]');
  if (host && !(data.exceptions || []).length) {
    host.innerHTML = `<p class="empty">No one-offs. Every day follows the pattern above.</p>`;
  }
  fill("exceptions", data.exceptions, rows.exception);
}

async function reload() {
  const { data, live } = await api.hours();
  masthead.setCounts(data.counts);
  paint(data);
  markSource(live);
  /* The month follows the week. A pattern and its consequences
     showing two different answers on one screen is the fastest way
     to stop trusting either. */
  calendar.refresh();
}

start("hours", api.hours, paint).then(() => {
  calendar.mount();
  editor.render($("[data-editor]"));

  editor.mount($("[data-editor]"), {
    onAddBands: async (payload) => {
      await api.addBands(payload);
      await reload();
    },
    onCloseDate: async (payload) => {
      await api.addException(payload);
      await reload();
    },
  });

  /* One delegated listener for both kinds of removal — the week and
     the exception list are re-rendered wholesale after every change,
     so per-element handlers would need re-binding each time. */
  document.addEventListener("click", async (e) => {
    const band = e.target.closest("[data-drop-band]");
    const exc = e.target.closest("[data-drop-exception]");
    if (!band && !exc) return;

    const btn = band || exc;
    btn.disabled = true;
    try {
      if (band) await api.dropBand(band.dataset.dropBand);
      else await api.dropException(exc.dataset.dropException);
      await reload();
    } catch {
      btn.disabled = false;
      // Nothing changed, so say nothing changed. A row that quietly
      // stays put after a click reads as success.
      if (exc) exc.textContent = "Try again";
    }
  });
});
