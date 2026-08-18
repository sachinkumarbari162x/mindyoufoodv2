/* ============================================================
   TODAY — the sessions she is about to run, and what became of them
   ------------------------------------------------------------
   She rings them, so every row carries the way to do it. There
   is no meeting link to hand out and nothing to join.

   TODAY IS A WORKLIST, NOT A LEDGER. A session she has answered
   for leaves the page, so what is left on it is always what is
   left to do. Everything answered for lives on History, where it
   can be counted without getting in her way here.

   THREE RULES RUN THIS PAGE, and they are all the same rule —
   she should be thinking about her practice, not about this
   software:

     · One tap records it. No confirmation dialog: a dialog taxes
       every correct tap to guard against the rare wrong one.
     · Undo instead. It sits on the row for a few seconds, and
       re-recording corrects it after that, so a mis-tap is never
       a dead end and never needs a support conversation.
     · Moving somebody offers HER REAL FREE HOURS as things to
       tap. No date picker, no typing, and no way to land on an
       hour she is not working.
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import { start, fill, setTally, $, $$ } from "../page.js";

/** How long Undo stays on the row before the list moves on. Long
    enough to notice a mistake, short enough that the page does not
    feel stuck mid-action. */
const UNDO_MS = 8000;

/* Her free hours are fetched ONCE and reused. They change rarely
   within a session, and re-fetching per row would put a wait in
   front of an action that should feel instant. */
let slotsOnce = null;
const freeSlots = () => (slotsOnce ||= api.freeSlots().then((r) => r.slots || []));

/** True once she has recorded anything, so an emptied page can say
    "that is everyone" rather than "nothing today", which would be a
    strange thing to read at six in the evening. */
let clearedSome = false;

/* ---- painting --------------------------------------------------- */

function paint(data) {
  const host = $('[data-list="today"]');
  const list = data.today || [];

  if (!list.length) {
    host.innerHTML = clearedSome
      ? `<p class="empty">That is everyone today.</p>`
      : `<p class="empty">Nothing today.</p>`;
  } else {
    fill("today", list, rows.sessionToday);
  }
  setTally("today", list.length);

  /* Earlier days she never closed off. Same row, same four buttons —
     the job is identical, so it should not look like a different one.
     The section shows itself only when it has something in it. */
  const behind = data.overdue || [];
  const panel = $("[data-overdue]");
  if (panel) {
    panel.hidden = !behind.length;
    if (behind.length) fill("overdue", behind, rows.sessionToday);
  }
}

async function refresh() {
  const { data } = await api.today();
  paint(data);
}

/* ---- recording -------------------------------------------------- */

/** Put a sentence on the row without disturbing the rest of the page.
    Used for the two refusals that can actually reach her: an hour
    taken while she was looking at it, and an undo that came too late. */
function warn(row, message) {
  let el = row.querySelector(".row-warn");
  if (!el) {
    el = document.createElement("p");
    el.className = "row-warn";
    row.append(el);
  }
  el.textContent = message;
}

/**
 * Record one, then hand back the chance to take it back.
 *
 * The row is replaced rather than removed, so the page does not jump
 * under her hand the instant she taps — a row that vanishes takes the
 * undo with it, and she is left unsure whether she hit the right one.
 */
async function record(row, id, outcome, movedTo, label) {
  /* Read as TEXT, before the row is rewritten. It used to be carried
     in a data attribute and put back with innerHTML — and an
     attribute decodes when you read it, so `esc()` was undone on the
     way out. A visitor booking under the name "<img src=x onerror=…>"
     would then have run script inside her CRM the moment she tapped
     Done. Nothing a visitor typed goes back through innerHTML. */
  const who = row.querySelector(".who")?.textContent || "";

  $$("button", row).forEach((b) => (b.disabled = true));

  let out;
  try {
    out = await api.outcome(id, { outcome, movedTo });
  } catch (err) {
    $$("button", row).forEach((b) => (b.disabled = false));
    warn(row, err.message || "That did not save — try once more.");
    return;
  }

  clearedSome = true;

  /* The cached hours are now wrong in both directions — a move takes
     one, a cancellation gives one back — so the next "Reschedule to…"
     reads them fresh. Offering an hour that was filled a moment ago is how
     she ends up tapping something the database then refuses. */
  slotsOnce = null;

  const said = rows.ENDING_SAID[outcome] || "Recorded";

  /* The shell is a literal with no interpolation in it; every value
     is written afterwards as text. Anything that came from a visitor
     — or from the server — reaches the page through textContent or
     dataset, neither of which parses markup. */
  row.classList.add("is-said");
  row.innerHTML = `
    <div class="row-main">
      <div class="row-top">
        <span class="who"></span>
        <span class="said"></span>
      </div>
    </div>
    <div class="row-acts">
      <button class="btn quiet" type="button" data-undo="">Undo</button>
    </div>`;

  row.querySelector(".who").textContent = who;
  row.querySelector(".said").textContent = said + (label ? ` — ${label}` : "");
  row.querySelector("[data-undo]").dataset.undo = out.id;

  /* The list is only re-read once the undo window has closed. Doing
     it immediately would pull the row out from under the button. */
  const timer = setTimeout(refresh, UNDO_MS);
  row.dataset.timer = String(timer);
}

/* ---- moving somebody -------------------------------------------- */

/**
 * Show her free hours as things to tap.
 *
 * Nothing is recorded until she picks one, so "Rescheduled" is a question
 * rather than an action — the only one of the four that cannot be
 * answered in a single tap, because a move is not a move until it has
 * somewhere to go.
 */
async function offerSlots(row, id) {
  let panel = row.querySelector(".move-when");
  if (panel) {
    panel.remove(); // tapping Rescheduled again puts it away
    return;
  }

  panel = document.createElement("div");
  panel.className = "move-when";
  panel.innerHTML = `<p class="move-ask">Reschedule to…</p><p class="move-load">Reading your hours…</p>`;
  row.append(panel);

  let slots;
  try {
    slots = await freeSlots();
  } catch {
    panel.querySelector(".move-load").textContent = "Could not read your hours just now.";
    return;
  }

  if (!slots.length) {
    /* An honest empty state that names the fix. "No slots available"
       would leave her wondering whether the software was broken. */
    panel.innerHTML = `
      <p class="move-ask">Reschedule to…</p>
      <p class="move-none">No free hours in the next three weeks. Add some on Hours, then reschedule this.</p>`;
    return;
  }

  panel.innerHTML = `
    <p class="move-ask">Reschedule to…</p>
    <div class="move-slots">
      ${slots
        .slice(0, 12)
        .map(
          (s) =>
            `<button class="btn slot" type="button" data-move-to="${s.startAt}">${s.label}</button>`
        )
        .join("")}
    </div>`;
}

/* ---- one listener for the whole list ----------------------------- */

document.addEventListener("click", async (e) => {
  const row = e.target.closest(".row[data-session], .row.is-said");
  if (!row) return;

  const undo = e.target.closest("[data-undo]");
  if (undo) {
    clearTimeout(Number(row.dataset.timer));
    undo.disabled = true;
    try {
      await api.undoOutcome(undo.dataset.undo);
    } catch (err) {
      warn(row, err.message || "That one has been recorded — record what happened instead.");
      undo.disabled = false;
      return;
    }
    slotsOnce = null; // an undone move gave an hour back
    return refresh();
  }

  const id = row.dataset.session;
  if (!id) return;

  const pick = e.target.closest("[data-outcome]");
  if (pick) {
    return pick.dataset.outcome === "rescheduled"
      ? offerSlots(row, id)
      : record(row, id, pick.dataset.outcome, null);
  }

  const moveTo = e.target.closest("[data-move-to]");
  if (moveTo) {
    return record(row, id, "rescheduled", moveTo.dataset.moveTo, moveTo.textContent.trim());
  }
});

start("today", api.today, paint);
