/* RETIRED. This module now drives overview-classic.html only —
   nothing links to that page, and index.html is the console. Kept
   because a decision a week old is not a decision yet; see the
   banner in overview-classic.html.
   ============================================================
   OVERVIEW — the hub
   ------------------------------------------------------------
   Every area at once, in ONE request. The point of this page is
   that she can see the state of the whole practice without
   clicking: an overview that showed less than the pages it links
   to would not be worth opening.

   Lists are capped by the API and each panel links through, so
   this stays a digest rather than becoming the old single page
   with more scrolling.

   Requests are actionable here as well as on their own page —
   it is the one thing genuinely blocked on her, and making her
   navigate somewhere else to clear it would be the whole reason
   she stops using the overview.
   ============================================================ */

import * as api from "../api.js";
import * as insights from "../insights.js";
import * as rows from "../rows.js";
import * as week from "../week.js";
import * as subnav from "../subnav.js";
import * as assistant from "../assistant.js";
import * as masthead from "../masthead.js";
import { start, fill, markSource, $ } from "../page.js";

let period = "7d";

function paint(data) {
  insights.draw($("[data-stats]"), data.stats);

  fill("waiting", data.waiting, rows.request);
  fill("today", data.today, rows.session);
  fill("upcoming", data.upcoming, rows.session);
  fill("people", data.people, rows.person);
  fill("messages", data.messages, rows.message);

  week.draw($("[data-week]"), data.rules);
}

async function reload() {
  const { data, live } = await api.overview(period);
  masthead.setCounts(data.counts);
  paint(data);
  markSource(live);
}

start("overview", () => api.overview(period), paint).then(() => {
  // Mounted after the first paint so the spy observes panels that
  // already have their real height — before that every panel is
  // one line tall and they all intersect at once.
  subnav.mount();

  /* Mounted AFTER the page has painted, and never awaited by it.
     The assistant calls a model and can take a second or fail
     outright; the six panels below it are the database and must
     not wait on that to appear. */
  assistant.mount($("[data-assistant]"));

  // The period control lives in the pinned header, so changing the
  // window never means scrolling back up to find it.
  insights.mountPeriods($("[data-periods]"), (next) => {
    period = next;
    reload();
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-accept], [data-decline]");
    if (!btn) return;

    btn.disabled = true;
    try {
      if (btn.dataset.accept) await api.accept(btn.dataset.accept);
      else await api.decline(btn.dataset.decline);
      await reload();
    } catch {
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
});
