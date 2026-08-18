/* ============================================================
   THE NSF, BESIDE THE CALL
   ------------------------------------------------------------
   The same form as the assessment page — the same sections, the
   same fields, the same arithmetic, all of it out of
   nsf-form.js — mounted directly into the room's side panel.

   NOT AN IFRAME. A frame here meant a second application booting,
   authenticating, laying itself out and failing on its own
   schedule while somebody was already on the other end of a
   video call. This is a few hundred bytes of markup written into
   a div that is already on the screen.

   PREFILLED FROM THE BOOKING. Name, email and phone are already
   known — they are how the appointment was made — so they arrive
   filled and locked, and the reason for the visit starts as what
   they asked about. She is confirming, not typing.

   IT MUST NEVER TAKE THE CALL DOWN. Every failure in here ends as
   a sentence in the panel. A consultation with notes on the pad
   is a consultation; one that did not happen because a form threw
   is a lost appointment.
   ============================================================ */

import * as api from "./api.js";
import * as nsf from "./nsf-form.js";
import { esc } from "./format.js";

/* Long enough to swallow a burst of typing, short enough that
   nothing is lost if the laptop shuts. The same 400ms the desk
   uses — the pause before a save is a feel, and it should not be
   a different feel in the two places she fills this in. */
const SAVE_MS = 400;

let host = null;
let current = null;      // the open draft
let previous = null;     // the previous VISIT's values, for "change since"
let saveTimer = null;
let readOnly = false;

/* ---- saying so -------------------------------------------------- */

function say(state, text) {
  const el = host?.querySelector("[data-nsf-state]");
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

function fail(message) {
  /* The form is replaced by the reason it is not there. Not a
     spinner that never resolves, and not an empty box: she has to
     know within a second whether to reach for the pad instead. */
  host.innerHTML = `
    <p class="nsf-down">
      <b>The record did not open</b>
      ${esc(message || "Try again in a moment.")} The consultation is unaffected —
      use the pad above, and this visit can be written up afterwards.
      <button class="btn quiet" type="button" data-nsf-retry>Try again</button>
    </p>`;
}

/* ---- painting --------------------------------------------------- */

function render() {
  host.innerHTML = `
    <div class="nsf-bar">
      <span class="nsf-ref">${esc(current.ref)}</span>
      <span class="grow"></span>
      <span class="saved" data-nsf-state data-state="saved">Saved</span>
    </div>
    <div class="nsf-scroll" data-nsf-sections>
      ${nsf.sectionsHTML(current.values, new Set(), current.openSections)}
    </div>`;

  nsf.paintCalcs(host, current.values, previous);

  /* A final version is read-only wherever it is opened. The server
     refuses the write as well — this only spares her typing into a
     box that was going to reject it. */
  if (readOnly) {
    for (const el of host.querySelectorAll("[data-field]")) el.disabled = true;
    say("saved", "Final — read only");
  }
}

/* ---- saving ----------------------------------------------------- */

function touch() {
  if (readOnly) return;
  say("saving", "Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api.saveAssessment(current.id, {
        values: current.values,
        openSections: current.openSections,
        notes: current.notes || "",
      });
      say("saved", "Saved");
      nsf.paintCalcs(host, current.values, previous);
    } catch (err) {
      /* Said, never swallowed. A clinical note that silently failed
         to save is the worst thing this panel can do — and she is
         mid-consultation, so she needs to know now, while she can
         still write it on the pad. */
      say("failed", "Not saved — " + (err.message || "try again"));
    }
  }, SAVE_MS);
}

/* ---- opening ---------------------------------------------------- */

/** What the booking already knows, into the fields that ask for it.
 *
 *  Only ever into EMPTY fields. A draft she has already corrected —
 *  a name spelt properly, a number she was given during the last
 *  call — must not be overwritten by the booking every time the room
 *  is opened. */
function seedFromBooking(b) {
  const v = { ...(current.values || {}) };
  let seeded = false;
  const put = (key, value) => {
    if (value && !v[key]) { v[key] = String(value); seeded = true; }
  };

  put("name", b.name);
  put("email", b.email);
  put("phone", b.phone);
  put("reason", b.focusArea);

  if (seeded) current.values = v;
  return seeded;
}

export async function mount(node, booking) {
  host = node;
  if (!host) return;

  host.innerHTML = `<p class="nsf-wait">Opening the record…</p>`;

  try {
    const opened = await api.openAssessment({
      personId: booking.personId,
      consultationId: booking.id,
    });
    current = opened.assessment;
    readOnly = current.status === "final";

    /* The chain, for one number: what they weighed last visit. It is
       fetched separately and its failure is survivable — the form
       opens either way, and only "change since last" goes missing. */
    try {
      const all = await api.assessments(booking.personId);
      const chain = all.assessments || [];
      current = chain.find((a) => a.id === current.id) || current;
      previous = chain.find((a) => a.visit === current.visit - 1)?.values || null;
    } catch {
      previous = null;
    }

    const seeded = seedFromBooking(booking);
    render();
    if (seeded) touch();
  } catch (err) {
    fail(err.message);
  }
}

/* ---- wiring -----------------------------------------------------
   Bound to the document once, at import, and guarded on `host` —
   the room mounts this panel after a person is chosen, so a
   listener attached at mount time would have to be unbound at
   unmount time, and a form that saves into a closed consultation is
   a bug nobody would find quickly. */

document.addEventListener("input", (e) => {
  if (!current || !host?.contains(e.target)) return;

  const field = e.target.closest("[data-field]");
  if (!field) return;
  current.values = { ...current.values, [field.dataset.field]: field.value };
  touch();
});

document.addEventListener("click", (e) => {
  if (!host?.contains(e.target)) return;

  if (e.target.closest("[data-nsf-retry]")) {
    const b = window.__roomBooking;
    if (b) mount(host, b);
    return;
  }

  const toggle = e.target.closest("[data-toggle]");
  if (toggle && current) {
    const sec = host.querySelector(`[data-sec="${toggle.dataset.toggle}"]`);
    const open = sec.dataset.open !== "true";
    sec.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));

    /* Which sections are open is part of the record, not a browser
       preference: it is how she left the form, and reopening it to
       twelve collapsed sections mid-consultation is a small disaster. */
    current.openSections = [...host.querySelectorAll("[data-sec]")]
      .filter((s) => s.dataset.open === "true")
      .map((s) => s.dataset.sec);
    touch();
  }
});
