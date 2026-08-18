/* ============================================================
   CRM ROUTES — what the practitioner's pages call
   ------------------------------------------------------------
   One endpoint per page, each answering in a single request:
   the page's own rows plus the nav counts, because the counts
   are shown on every page and a second call for them would be
   a round trip spent on three numbers.

   Kept in its own directory because it is a different audience
   from everything else in the BFF. /api/chat/* is the public
   desk, hardened against strangers; this is her back office and
   returns PII with no filtering. Mixing them in one file makes
   it easy to lose track of which is which.

       GET  /api/crm/overview      the hub — every area, capped
       GET  /api/crm/requests      held, waiting on her
       GET  /api/crm/today         confirmed, today
       GET  /api/crm/upcoming      confirmed, ahead
       GET  /api/crm/people        one row per person
       GET  /api/crm/messages      what the system sent
       GET  /api/crm/hours         the weekly pattern
       GET  /api/crm/settings      the four scheduling numbers
       GET  /api/crm/countries     the dropdown, hers pinned
       POST /api/crm/bookings/:id/accept | /decline

   SECURITY: every one of these returns names, emails, dates of
   birth and health notes. Whatever fronts /crm in production
   must require a login — this module deliberately does not
   pretend to be that gate.
   ============================================================ */
"use strict";

const { config } = require("../config");
const data = require("../data-client");
const mail = require("../mail");
const whatsappSender = require("../whatsapp");

const P = config.practice;

/** The four numbers every offered slot is built from. Read from the
    same config the desk uses, so the CRM cannot show one thing while
    the booking engine does another. */
function settings() {
  return {
    consultMinutes: P.consultMinutes,
    bufferMinutes: P.bufferMinutes,
    maxPerDay: P.maxPerDay,
    minLeadHours: P.minLeadHours,
    autoAccept: false,
  };
}

/** Go is down. Say so rather than returning an empty list — a page
    showing "0 waiting" when the truth is "we cannot tell" is the one
    failure that actually loses a booking. */
const unavailable = {
  status: 503,
  body: { error: "data_unavailable", message: "The data service is not answering." },
};

const ok = (body) => ({ status: 200, body });

/* ---- reads ---------------------------------------------------- */

/* The hub, in ONE round trip from the browser — but two from here,
   run together rather than in sequence. The overview and the week are
   independent queries, so waiting for one before asking for the other
   would add latency for nothing. */
async function overview() {
  const [out, week, sent] = await Promise.all([
    data.crm.overview(),
    data.crm.hours(),
    // Capped hard: this is a digest, and the panel links through.
    data.crm.messages({ limit: 5 }).catch(() => null),
  ]);
  if (!out || !out.ok) return unavailable;
  return ok({
    counts: out.counts,
    stats: stats(out),
    waiting: out.waiting,
    today: out.today,
    upcoming: out.upcoming,
    people: out.people,
    messages: sent?.messages || [],
    rules: week?.ok ? week.rules || [] : [],
    settings: settings(),
  });
}

/** Headline figures, derived rather than stored — they are counts of
    rows that already exist, and a second source for them would be a
    second thing to get out of step. */
function stats(o) {
  const booked = (o.today?.length || 0) + (o.upcoming?.length || 0);
  return [
    { label: "Waiting", value: o.counts?.waiting ?? 0, change: 0, note: "to answer" },
    { label: "Booked", value: booked, change: 0, note: "today and ahead" },
    { label: "Today", value: o.counts?.today ?? 0, change: 0, note: "sessions" },
    { label: "People", value: o.people?.length ?? 0, change: 0, note: "on file" },
  ];
}

async function window_(kind, key) {
  const out = await data.crm.consultations(kind);
  if (!out || !out.ok) return unavailable;
  return ok({ counts: out.counts, [key]: out.consultations });
}

const requests = () => window_("held", "waiting");
const upcoming = () => window_("upcoming", "upcoming");

/** TODAY, PLUS ANYTHING THAT FELL OFF THE END OF AN EARLIER DAY.
 *
 *  A session from yesterday that she never said anything about is
 *  homeless: too old for Today, too past for Upcoming, and with no
 *  outcome to put it in History. It would sit at 'confirmed' forever,
 *  invisible, quietly making every count on the History page wrong.
 *
 *  Today is where it belongs, because Today is the page for things
 *  that still need her — and it leaves the moment she says what
 *  happened, exactly like the rest. */
async function today() {
  const [out, behind] = await Promise.all([
    data.crm.consultations("today"),
    data.crm.unrecorded().catch(() => null),
  ]);
  if (!out || !out.ok) return unavailable;
  return ok({
    counts: out.counts,
    today: out.consultations,
    overdue: behind?.sessions || [],
  });
}

async function people() {
  const [list, counts] = await Promise.all([data.crm.people(), data.crm.consultations("held")]);
  if (!list || !list.ok) return unavailable;
  return ok({ counts: counts?.counts, people: list.people });
}

async function countries() {
  const out = await data.crm.countries();
  if (!out || !out.ok) return unavailable;
  return ok({ countries: out.countries });
}

/** Every email the system has attempted, newest first — sent,
    queued and failed alike. A page that showed only successes would
    be the one place a missing confirmation could hide. */
async function messages() {
  /* This returned [] until crm.messages existed — the page has been
     showing sample rows since it was built. It is real now. */
  const [list, counts] = await Promise.all([
    data.crm.messages({ limit: 100 }),
    data.crm.consultations("held"),
  ]);
  return ok({ counts: counts?.counts, messages: list?.messages || [] });
}

async function hours() {
  const [week, counts] = await Promise.all([
    data.crm.hours(),
    data.crm.consultations("held"),
  ]);
  if (!week || !week.ok) return unavailable;
  return ok({
    counts: counts?.counts,
    rules: week.rules || [],
    exceptions: week.exceptions || [],
  });
}

/** The month behind the Hours page.
 *
 *  Handed over as Go returns it. The BFF adds nothing because there
 *  is nothing to add: which days she works, which days break the
 *  pattern and who is booked are all facts, and a rule applied here
 *  would be a second opinion about a Tuesday. */
async function calendar(from, to) {
  const out = await data.crm.calendar({ from, to });

  /* A REFUSAL IS NOT AN OUTAGE. `null` means the data service did
     not answer; `ok: false` means it answered and said no — and a
     bad date range reported as "the data service is not answering"
     sends her looking at the server for a fault in her own request. */
  if (!out) return unavailable;
  if (!out.ok) {
    return { status: out.status || 400, body: { error: out.error, message: out.message } };
  }
  return ok({ days: out.days || [], timezone: out.timezone });
}

async function settingsRoute() {
  const counts = await data.crm.consultations("held");
  return ok({ counts: counts?.counts, settings: settings() });
}

/* ---- writes ---------------------------------------------------- */

/* Her week. Every one of these changes what visitors can book from the
   next request onward — there is no deploy in the loop, which is the
   whole point. */
async function addBands(body) {
  const out = await data.crm.addBands({
    weekdays: Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [],
    startsMin: Number(body.startsMin),
    endsMin: Number(body.endsMin),
    effectiveFrom: body.effectiveFrom || null,
    effectiveTo: body.effectiveTo || null,
  });
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error, message: out.message } };
  /* `noEffect` rides along when a band she just saved sits inside one
     she already had — legal, saved, and about to change nothing a
     visitor sees. Listed explicitly rather than spread, so this stays
     a decision about what the CRM is told rather than a pipe. */
  return ok({ ok: true, added: out.added, noEffect: out.noEffect || null });
}

/** Record what happened to a consultation. She decides; this only
    writes it down and hands back the sentence the CRM shows. */
async function outcome(id, body) {
  const out = await data.crm.outcome(id, {
    outcome: String(body?.outcome || ""),
    movedTo: body?.movedTo || null,
    note: body?.note || "",
    by: body?.by || "khadija",
  });
  if (!out) return unavailable;
  if (!out.ok) {
    return { status: out.status || 400, body: { error: out.error, message: out.message } };
  }
  /* The id goes back so the CRM can offer "Undo" on the row she just
     tapped. Without it the only way to take back a mis-tap would be a
     confirmation dialog in front of every correct one. */
  return ok({ ok: true, id: out.id });
}

/** HISTORY — every session that has been answered for.
 *
 *  This page exists so Today can stay empty. A session she has dealt
 *  with leaves Today the moment she records it, which means Today
 *  always reads as "what is left" rather than "everything that ever
 *  was" — and the answered ones still have to live somewhere she can
 *  look, because that is where the business questions get settled.
 *
 *  `tally` is the ninety-day count by kind. `counts` is the nav's, and
 *  they are different things kept under different names on purpose. */
async function history(kind) {
  const [list, tally, counts] = await Promise.all([
    data.crm.outcomes({ limit: 200, outcome: kind || "" }),
    data.crm.outcomeStats(),
    data.crm.consultations("held"),
  ]);
  if (!list) return unavailable;
  return ok({
    counts: counts?.counts,
    history: list.outcomes || [],
    tally: tally?.counts || {},
  });
}

/** Take back a mis-tap. Go decides whether it is still allowed — five
    minutes, and only the latest — so this passes the refusal through
    in her words rather than second-guessing it here. */
async function undoOutcome(id) {
  const out = await data.crm.undoOutcome(id);
  if (!out) return unavailable;
  if (!out.ok) {
    return { status: out.status || 400, body: { error: out.error, message: out.message } };
  }
  return ok({ ok: true });
}

async function dropBand(id) {
  const out = await data.crm.dropBand(id);
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error } };
  return ok({ ok: true });
}

async function addException(body) {
  const out = await data.crm.addException({
    onDate: body.onDate,
    kind: body.kind,
    startsMin: body.startsMin === undefined || body.startsMin === null ? null : Number(body.startsMin),
    endsMin: body.endsMin === undefined || body.endsMin === null ? null : Number(body.endsMin),
    reason: body.reason || null,
  });
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error, message: out.message } };
  return ok({ ok: true, id: out.id });
}

async function dropException(id) {
  const out = await data.crm.dropExceptionRow(id);
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error } };
  return ok({ ok: true });
}

/* ---- the knowledge and intelligence base ------------------------
   What the desk says, how people ask, and what it could not place.
   Everything here changes the desk's behaviour within the refresh
   interval — no deploy, no restart. */
async function knowledge() {
  const [k, counts] = await Promise.all([
    /* `all`, because this is the EDITOR — the one place that has to
       see both the desk's answers and the client's. Everywhere else
       says which one it wants, and Go's default is the desk. */
    data.crm.knowledge("all"),
    data.crm.consultations("held"),
  ]);
  if (!k || !k.ok) return unavailable;
  return ok({
    counts: counts?.counts,
    answers: k.answers || [],
    phrasings: k.phrasings || [],
    unrecognised: k.unrecognised || [],
  });
}

async function setAnswer(intent, body) {
  const out = await data.crm.setAnswer(intent, {
    answer: String(body.answer || ""),
    label: body.label ? String(body.label) : "",
  });
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error, message: out.message } };
  return ok({ ok: true });
}

/** A topic she writes herself, from the teach queue. */
async function addTopic(body) {
  const out = await data.crm.addTopic({
    label: String(body?.label || "").slice(0, 80),
    answer: String(body?.answer || ""),
  });
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error, message: out.message } };
  return ok({ ok: true, intent: out.intent, label: out.label });
}

async function addPhrasing(body) {
  const out = await data.crm.addPhrasing({
    intent: String(body.intent || ""),
    phrase: String(body.phrase || ""),
    source: body.source ? String(body.source) : "crm",
  });
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error, message: out.message } };
  return ok({ ok: true, id: out.id });
}

async function dropPhrasing(id) {
  const out = await data.crm.dropPhrasing(id);
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error } };
  return ok({ ok: true });
}

async function missedDone(id) {
  const out = await data.crm.missedDone(id);
  if (!out) return unavailable;
  if (!out.ok) return { status: out.status || 400, body: { error: out.error } };
  return ok({ ok: true });
}

async function decide(id, status) {
  const out = await data.crm.setStatus(id, status);
  if (!out) return unavailable;
  if (!out.ok) {
    return { status: out.status || 400, body: { error: out.error || "failed" } };
  }

  /* ACCEPTING IS WHAT SENDS THE CONFIRMATION.

     Read back rather than trusted from the caller: the email states a
     date and a time to somebody who will plan their day around it, so
     it is written from the row as it actually stands after the status
     change, not from whatever the browser happened to have on screen.

     Declining sends nothing. A refusal by automated email is worse
     than no email — she may want to suggest another time, or say why,
     and that is a note from a person. The system should not get there
     first.

     Awaited, so the CRM can say whether it went; failures never
     propagate, because a confirmed booking with a failed email is a
     row on the Messages page, while a booking that failed BECAUSE of
     an email is a lost client. */
  let email = null;
  let whatsapp = null;

  if (status === "confirmed") {
    const got = await data.crm.consultation(id);
    const c = got?.consultation;

    if (c?.email) {
      email = await mail.bookingConfirmed({
        id,
        personId: c.personId || null,
        name: c.name,
        email: c.email,
        focusArea: c.focusArea,
        mode: c.mode,
        startAt: c.startAt,
      });
    }

    /* AND ON WHATSAPP, which is the channel her clients actually
       read. Independent of the email: a missing phone number must
       not stop the confirmation going out by mail, and a WhatsApp
       failure must not undo an email that already left.

       With no provider configured this prepares a wa.me link rather
       than sending — `needsHand` comes back true and the CRM offers
       her the button. */
    if (c?.phone) {
      whatsapp = await whatsappSender
        .bookingConfirmed({
          id,
          personId: c.personId || null,
          name: c.name,
          phone: c.phone,
          country: c.country,
          startAt: c.startAt,
        })
        .catch((e) => ({ sent: false, why: e.message }));
    }
  }

  return ok({ ok: true, id, status, email, whatsapp });
}

/** Send one again. She presses this on the Messages page after a
    failure — the body is re-rendered from the booking as it stands
    now, so a retry after a reschedule carries the new time. */
async function retryMessage(id) {
  const out = await mail.retry(id);
  return ok({ ok: out.sent, why: out.why || null });
}


/* ---- what came in ---------------------------------------------
   Money is moving now, and she has had no way to look at it. The
   figures come from Postgres rather than from adding up the rows
   this returns — the list is windowed, and a total that counts
   only what fitted on the page is a wrong number that looks
   right. */
async function payments(query) {
  const out = await data.crm.paymentList(query);
  if (!out?.ok) return { status: 503, body: { error: "data_unavailable" } };
  return { status: 200, body: { payments: out.payments, totals: out.totals } };
}

module.exports = {
  payments,
  overview,
  requests,
  today,
  upcoming,
  people,
  messages,
  hours,
  calendar,
  countries,
  settings: settingsRoute,
  accept: (id) => decide(id, "confirmed"),
  decline: (id) => decide(id, "declined"),
  addBands,
  outcome,
  history,
  retryMessage,
  undoOutcome,
  dropBand,
  addException,
  dropException,
  knowledge,
  setAnswer,
  addTopic,
  addPhrasing,
  dropPhrasing,
  missedDone,
};
