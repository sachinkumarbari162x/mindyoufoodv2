/* ============================================================
   HISTORY — every session already answered for
   ------------------------------------------------------------
   Today is a worklist and drops a session the moment she says
   what became of it. That only works if the dealt-with ones are
   somewhere obvious, and this is that somewhere.

   IT IS ALSO WHERE THE BUSINESS QUESTIONS GET SETTLED. "How many
   people did not turn up last quarter" is not a question Today
   can answer and should not try to — the counts live here, over
   ninety days, above the list rather than inside it, because
   they are the reason to open the page.
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import * as historyNav from "../history-nav.js";
import { start, fill, $ } from "../page.js";

/* The four, in the order they matter to her: what went right, then
   the three ways it did not. `no_show` never reaches her eyes. */
const TALLIES = [
  { key: "done", label: "Done" },
  { key: "no_show", label: "Didn’t come" },
  { key: "cancelled", label: "Cancelled" },
  { key: "rescheduled", label: "Rescheduled" },
];

/* Taken from the address bar so a bookmarked or refreshed view comes
   back as she left it. Sanitised there against the list above, and
   again in the BFF before it reaches a query. */
let kind = historyNav.fromUrl();

function paintTallies(tally) {
  const host = $("[data-tallies]");
  if (!host) return;

  const total = TALLIES.reduce((n, t) => n + (tally[t.key] || 0), 0);
  if (!total) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML = TALLIES.map(
    (t) => `
    <div class="tally">
      <b>${tally[t.key] || 0}</b>
      <span>${t.label}</span>
    </div>`
  ).join("");
}

function paint(data) {
  const host = $('[data-list="history"]');
  const list = data.history || [];

  if (!list.length) {
    /* Two different silences, and saying which one it is saves her
       wondering whether the filter is broken. */
    host.innerHTML = kind
      ? `<p class="empty">None of those in the last while.</p>`
      : `<p class="empty">Nothing recorded yet. Sessions appear here once you say how they went.</p>`;
  } else {
    fill("history", list, rows.outcomeRow);
  }

  paintTallies(data.tally || {});
}

async function reload() {
  const { data } = await api.history(kind);
  paint(data);
}

/* The sub-nav owns which view is showing; this page only reacts to
   it. Mounted before the first fetch so the row is on screen while
   the list is still loading. */
historyNav.mount(kind, (picked) => {
  kind = picked;
  reload();
});

start("history", () => api.history(kind), paint);
