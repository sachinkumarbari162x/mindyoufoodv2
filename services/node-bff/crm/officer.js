/* ============================================================
   HER ASSISTANT — the deterministic one
   ------------------------------------------------------------
   Item 1. Reads the practice, applies the job description in
   duties.js, and returns the list of things needing her.

   NO MODEL IS CALLED HERE. Not "no model by default" — none. This
   is arithmetic over live state: a duty is satisfied or it is
   not, and the answer is the same every time anybody asks.

   It is separate from crm/assistant.js, which is the one that
   words a briefing and drafts client messages using a model.
   They are two different jobs and they are two different files:

     officer.js     what needs doing            no model, ever
     assistant.js   how the day reads in prose  model, guarded

   The distinction is the whole architecture in miniature. If the
   provider is down, this still works — and this is the half she
   opens the CRM to see.
   ============================================================ */
"use strict";

const data = require("../data-client");
const hours = require("../rules/hours");
const orchestrator = require("../orchestrator");
const { DUTIES, ALL_CLEAR, ORDER } = require("./duties");

/* One pass over the practice. Everything the duties can ask about
   is gathered here, once, so a duty is a pure function of state and
   cannot go off and make a query of its own. */
async function gather() {
  const [held, today, slots, missed, hoursOut, staff, unrecorded] = await Promise.all([
    data.crm.consultations("held").catch(() => null),
    data.crm.consultations("today").catch(() => null),
    data.crm.slots({ days: 14, limit: 40 }).catch(() => null),
    data.crm.knowledge().catch(() => null),
    data.crm.hours().catch(() => null),
    data.crm.staff().catch(() => null),
    data.crm.unrecorded().catch(() => null),
  ]);

  const now = Date.now();
  const waiting = (held?.consultations || []).map((c) => ({
    name: c.name?.split(" ")[0] || "Someone",
    holdExpiresAt: c.holdExpiresAt,
  }));

  return {
    waiting,
    expiringSoon: waiting.filter(
      (w) => w.holdExpiresAt && Date.parse(w.holdExpiresAt) - now < 12 * 3600e3
    ),
    today: (today?.consultations || []).map((c) => ({
      name: c.name?.split(" ")[0] || "Someone",
      at: c.startAt ? new Date(c.startAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "",
    })),
    freeSlots: (slots?.slots || []).length,
    /* Sessions that have been and gone with nothing said about them.
       Names are carried, not just the count — "Aisha and two others"
       is a task she can act on; "3 sessions" is a number she has to
       go and investigate. */
    unrecorded: (unrecorded?.sessions || []).map((c) => ({
      name: c.name?.split(" ")[0] || "Someone",
      startAt: c.startAt,
    })),
    missed: (missed?.unrecognised || []).filter((m) => !m.resolved).length,
    overlappingBands: countNoEffect(hoursOut?.rules || []),
    // Null rather than false when it could not be read: "we do not
    // know" and "she has not set it up" are different, and only one
    // of them is worth putting on her list.
    totpEnrolled: staff?.staff ? !!staff.staff.totpConfirmedAt : null,
    breakerOpen: orchestrator.breakerState().open,
    presence: hours.presence(),
  };
}

/** Bands that sit entirely inside another band on the same weekday.
    Saved, legal, and changing nothing a visitor is offered. */
function countNoEffect(rules) {
  let n = 0;
  for (const a of rules) {
    for (const b of rules) {
      if (a.id === b.id || a.weekday !== b.weekday) continue;
      if (b.startsMin <= a.startsMin && b.endsMin >= a.endsMin && (b.endsMin - b.startsMin) > (a.endsMin - a.startsMin)) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * The list, most urgent first.
 *
 * Every duty is evaluated every time. There is no caching and no
 * incremental update, because the whole promise of a derived list
 * is that it is true at the moment it is read.
 */
async function tasks() {
  const state = await gather();

  const out = [];
  for (const duty of DUTIES) {
    let hit = null;
    try {
      hit = duty.check(state);
    } catch (err) {
      /* One duty throwing must not cost her the other seven. A
         broken duty is a bug to fix, not a reason for the panel to
         go blank. */
      console.warn(`[bff] duty ${duty.id} failed: ${err.message}`);
    }
    if (hit) out.push({ id: duty.id, title: duty.title, ...hit });
  }

  out.sort((a, b) => (ORDER[a.urgency] ?? 9) - (ORDER[b.urgency] ?? 9));

  return {
    status: 200,
    body: {
      tasks: out,
      clear: out.length === 0 ? ALL_CLEAR : null,
      // Counted separately so the icon can carry a number without
      // the panel having to be open.
      urgent: out.filter((t) => t.urgency === "now").length,
      office: state.presence.label,
    },
  };
}

module.exports = { tasks };
