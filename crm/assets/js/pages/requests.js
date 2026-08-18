/* ============================================================
   REQUESTS — the queue that is actually blocked on her
   ------------------------------------------------------------
   The only page in the CRM where something is waiting. Accept
   and decline happen on the row; nothing opens a detail view.
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import * as masthead from "../masthead.js";
import { start, fill, setTally, markSource, $ } from "../page.js";
import { esc } from "../format.js";

function paint(data) {
  fill("waiting", data.waiting, rows.request);
  setTally("waiting", data.waiting.length);
}

async function reload() {
  const { data, live } = await api.requests();
  masthead.setCounts(data.counts);
  paint(data);
  markSource(live);
}

start("requests", api.requests, paint).then((data) => {
  const auto = $("[data-auto-accept]");
  if (auto && data.settings) auto.checked = !!data.settings.autoAccept;

  /* One delegated listener rather than a handler per button: the
     list is re-rendered wholesale after every action, and per-row
     listeners would need re-binding each time. */
  /* ============================================================
     OFFERING A TIME TO SOMEBODY WHO ASKED FOR ONE
     ------------------------------------------------------------
     A review request arrives with no hour on it — the client is
     asking, she is offering — so "Accept" would be accepting
     nothing. This opens her real free hours inside the row and
     one of them becomes the appointment.

     THE SAME SLOTS A VISITOR IS OFFERED, from the same engine.
     Anything else and she could put a review on an hour the front
     desk is about to sell to a stranger.

     INSIDE THE ROW, NOT IN A DIALOGUE. She is triaging a list;
     a modal would take the list away and make her remember which
     one she was answering.
     ============================================================ */
  document.addEventListener("click", async (e) => {
    const offer = e.target.closest("[data-offer]");
    if (offer) {
      const row = offer.closest("[data-review]");
      const host = row?.querySelector("[data-slots]");
      if (!host) return;

      /* A second press closes it. The button is the toggle, so
         there is nothing extra to find in order to change her
         mind. */
      if (!host.hidden) { host.hidden = true; offer.textContent = "Offer a time"; return; }

      offer.disabled = true;
      offer.textContent = "Reading your week…";
      try {
        const { slots } = await api.freeSlots();
        host.innerHTML = slots.length
          ? slots.slice(0, 12).map((s) =>
              `<button class="btn slot" type="button" data-pick-slot="${esc(s.startAt)}">${esc(s.label)}</button>`
            ).join("")
          : `<p class="empty">No free hours in the next three weeks. Open Hours to add some.</p>`;
        host.hidden = false;
        offer.textContent = "Close";
      } catch {
        offer.textContent = "Could not read your week";
      } finally {
        offer.disabled = false;
      }
      return;
    }

    const slot = e.target.closest("[data-pick-slot]");
    if (slot) {
      const row = slot.closest("[data-review]");
      if (!row) return;
      slot.disabled = true;
      slot.textContent = "Booking…";
      try {
        await api.scheduleConsultation(row.dataset.review, { startAt: slot.dataset.pickSlot });
        await reload();
      } catch (err) {
        /* The one refusal worth naming: the hour filled between
           this list being drawn and her tapping it. Everything
           else is "try again". */
        slot.disabled = false;
        slot.textContent = err.code === "slot_taken" ? "Just taken — pick another" : "Try again";
      }
      return;
    }

    const btn = e.target.closest("[data-accept], [data-decline]");
    if (!btn) return;

    btn.disabled = true;
    try {
      if (btn.dataset.accept) await api.accept(btn.dataset.accept);
      else await api.decline(btn.dataset.decline);
      await reload();
    } catch {
      // Nothing changed, so say so. A row that quietly stays put
      // after a click reads as success and is worse than an error.
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });

  auto?.addEventListener("change", (e) => {
    api.saveSettings({ autoAccept: e.target.checked }).catch(() => {
      e.target.checked = !e.target.checked;
    });
  });
});
