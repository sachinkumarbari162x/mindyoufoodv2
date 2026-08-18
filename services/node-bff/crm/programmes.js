/* ============================================================
   PROGRAMMES — the client's half of the plan
   ------------------------------------------------------------
   Two audiences in one file, and the split is the important part:

     her side   starting a programme, stopping one, seeing how it
                is going. Behind her session, like the rest of the
                CRM.

     their side resolving a token, ticking a row, sending a
                weight. PUBLIC, rate-limited, and the only place
                in this system where an unauthenticated caller
                writes anything.

   THE TOKEN IS RETURNED ONCE. Starting a programme hands back the
   URL so she can send it; nothing else in the CRM ever lists it
   again. If it is lost, she stops that programme and starts
   another — which is also what she should do if a phone is.
   ============================================================ */
"use strict";

const data = require("../data-client");
const storage = require("../storage");

const ok = (body) => ({ status: 200, body });

const unavailable = {
  status: 503,
  body: { error: "data_unavailable", message: "The data service is not answering." },
};

const pass = (out) =>
  out
    ? out.ok
      ? null
      : { status: out.status || 400, body: { error: out.error, message: out.message } }
    : unavailable;

/* Where /me/ points. One definition, in config.js — this used to
   carry its own copy of the fallback and there were five of them. */
const { publicBase: base } = require("../config");

/* ---- her side ---------------------------------------------------- */

/** Start it, or hand back the one already running.

    `days` is how long the plan runs — 30, 60 or 90. Go refuses
    anything else; this only supplies the default, so a caller that
    predates the choice still starts a thirty-day programme rather
    than failing.

    MINT-OR-RETURN MEANS THE LENGTH IS SET ONCE. Asking again with a
    different number returns the running programme unchanged, which
    is correct: the window a client has been following for a
    fortnight is not something a second button press should move. */
async function start(planId, days) {
  const out = await data.crm.programmeStart(planId, Number(days) || 30);
  const bad = pass(out);
  if (bad) return bad;
  return ok({
    programme: out.programme,
    url: `${base()}/me/${out.token}`,
  });
}

async function revoke(id) {
  const out = await data.crm.programmeRevoke(id);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

async function list(personId) {
  const out = await data.crm.programmes(personId);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ programmes: out.programmes || [] });
}

async function adherence(programmeId, days) {
  const out = await data.crm.adherence({ programmeId, days: days || 28 });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ adherence: out.adherence || [] });
}

/* HER READ OF THEIR DAYS — the monitor.

   `adherence` above answers "how is it going"; this answers "what
   happened on the fourth", which a tally cannot. Both exist because
   they are different questions, and a page that had only the tally
   would send her back to the client's own link to see a note. */
async function monitorDays(programmeId, days) {
  const out = await data.crm.crmProgrammeDays({ programmeId, days: days || 35 });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ checkins: out.checkins || [] });
}

async function monitorWeights(programmeId) {
  const out = await data.crm.crmProgrammeWeights(programmeId);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ weights: out.weights || [] });
}

async function monitorNotes(programmeId) {
  const out = await data.crm.crmProgrammeNotes(programmeId);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ notes: out.notes || [] });
}

/** Her answer, on a day. `who` comes from the session and never from
    the body — the same rule as a confirmed plan row, and the
    database refuses a practitioner line without it. */
async function reply(body, who) {
  const out = await data.crm.crmProgrammeReply({
    programmeId: body?.programmeId,
    onDate: body?.onDate,
    body: typeof body?.body === "string" ? body.body : "",
    by: who || "",
  });
  const bad = pass(out);
  if (bad) return bad;
  return { status: 201, body: { ok: true, id: out.id } };
}

/* ---- their side, public ------------------------------------------
   Every one of these answers 404 with the same body for every kind
   of failure. A token holder learning that their link was "once
   valid" is a fact about somebody's care. */

const gone = { status: 404, body: { ok: false, reason: "unknown" } };

async function resolve(token) {
  const out = await data.crm.programmeResolve(token);
  if (!out?.ok) return gone;
  /* The window bounds the app's calendar. Listed explicitly like
     every other field here — this function names what leaves, so a
     column added to the Go payload tomorrow does not reach a client
     page by accident. */
  return ok({
    ok: true,
    firstName: out.firstName,
    ref: out.ref,
    startedOn: out.startedOn,
    endsOn: out.endsOn,
    lengthDays: out.lengthDays,
    items: out.items || [],
  });
}

async function days(token) {
  const out = await data.crm.programmeDays(token);
  if (!out?.ok) return gone;
  return ok({ ok: true, checkins: out.checkins || [] });
}

async function checkin(token, body) {
  const out = await data.crm.programmeCheckin(token, {
    itemId: body?.itemId,
    onDate: body?.onDate,
    state: body?.state,
    note: typeof body?.note === "string" ? body.note : "",
  });
  if (!out) return unavailable;
  if (!out.ok) {
    /* A refusal the client can act on — a date out of range, a row
       that is not theirs — is passed through with its sentence. Only
       the token itself is answered vaguely. */
    if (out.status === 404) return gone;
    return { status: out.status || 400, body: { ok: false, reason: out.error, message: out.message } };
  }
  /* The row's own id goes back to the app. A photograph is attached
     to a check-in, and the app cannot know which one it just made
     unless this says so. */
  return { status: 201, body: { ok: true, checkinId: out.checkinId } };
}

/* THE ONLY PUBLIC ROUTE THAT TAKES FREE TEXT. The bounds are all in
   Go — a known programme, a date near today, a length. Nothing is
   added here except the rate limit the route already carries, and
   nothing anywhere formats this string as anything but text. */
async function note(token, body) {
  const out = await data.crm.programmeNoteAdd(token, {
    onDate: body?.onDate,
    body: typeof body?.body === "string" ? body.body : "",
  });
  if (!out) return unavailable;
  if (!out.ok) {
    if (out.status === 404) return gone;
    return { status: out.status || 400, body: { ok: false, reason: out.error, message: out.message } };
  }
  return { status: 201, body: { ok: true, id: out.id } };
}

/* ---- asking to be seen again ------------------------------------
   The one public write that creates something on HER page rather
   than in their own record, which is why it is the most carefully
   bounded of the three. Go keeps it to one open request per
   person; this strips the consultation id on the way out.

   THE ID NEVER REACHES THEM. Their own request is a row in her
   diary, and a token holder who knows its primary key could try it
   against every other route that takes one. They are told there is
   a request and when it is — nothing that identifies the row. */
const forClient = (r) =>
  r ? { status: r.status, startAt: r.startAt, askedAt: r.askedAt, scheduled: !!r.scheduled } : null;

async function reviewAsk(token, body) {
  const out = await data.crm.programmeReviewAsk(token, {
    note: typeof body?.note === "string" ? body.note : "",
  });
  if (!out) return unavailable;
  if (!out.ok) {
    if (out.status === 404) return gone;
    return { status: out.status || 400, body: { ok: false, reason: out.error, message: out.message } };
  }
  return {
    status: out.already ? 200 : 201,
    body: { ok: true, already: !!out.already, request: forClient(out.request) },
  };
}

async function reviewState(token) {
  const out = await data.crm.programmeReviewState(token);
  if (!out?.ok) return gone;
  return ok({ ok: true, request: forClient(out.request) });
}

/** Her answer: a time. Go refuses it on anything that already has
    one, so moving a session stays a reschedule with an outcome
    recorded against it. */
async function schedule(id, body) {
  const out = await data.crm.consultationSchedule(id, {
    startAt: body?.startAt,
    minutes: Number(body?.minutes) || 0,
  });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

async function notes(token) {
  const out = await data.crm.programmeNotes(token);
  if (!out?.ok) return gone;
  return ok({ ok: true, notes: out.notes || [] });
}

/** Their own weights, for the line on Progress. Nothing she measured
    at the consultation comes through here — Go filters to
    source='self', and this adds no fields of its own. */
async function weights(token) {
  const out = await data.crm.programmeWeights(token);
  if (!out?.ok) return gone;
  return ok({ ok: true, weights: out.weights || [] });
}

async function weight(token, body) {
  const out = await data.crm.programmeWeight(token, { kg: Number(body?.kg) });
  if (!out) return unavailable;
  if (!out.ok) {
    if (out.status === 404) return gone;
    return { status: out.status || 400, body: { ok: false, reason: out.error, message: out.message } };
  }
  return { status: 201, body: { ok: true } };
}

/* ---- photographs -------------------------------------------------
   THE BYTES GO TO STORAGE FIRST, THEN THE ROW IS WRITTEN. If the
   store accepts the file and the database call then fails, the worst
   outcome is an orphan file — recoverable, and cheap. Doing it the
   other way round gives a row pointing at nothing, which is a broken
   image in her face and no way to tell which. */
async function photo(token, checkinId, buf, takenAt) {
  if (!token || !checkinId) return gone;

  /* The programme is the folder, so one client's photographs sit
     together and can be removed together when erasure comes. It is
     resolved from the token rather than taken from the request —
     nothing a caller sends chooses where a file lands. */
  const who = await data.crm.programmeResolve(token);
  if (!who?.ok) return gone;

  const kept = await storage.put(buf, `p/${sha8(token)}`);
  if (!kept.ok) {
    return { status: 400, body: { ok: false, reason: "rejected", message: kept.why } };
  }

  const out = await data.crm.programmeMediaAdd(token, {
    checkinId,
    storageKey: kept.key,
    mime: kept.mime,
    bytes: kept.bytes,
    sha256: kept.sha256,
    takenAt: takenAt || null,
  });
  if (!out) return unavailable;
  if (!out.ok) {
    if (out.status === 404) return gone;
    return { status: out.status || 400, body: { ok: false, reason: out.error, message: out.message } };
  }
  return { status: 201, body: { ok: true, id: out.id } };
}

async function photos(token) {
  const out = await data.crm.programmeMedia(token);
  if (!out?.ok) return gone;
  return ok({ ok: true, media: out.media || [] });
}

/** The bytes themselves. Returns a buffer for the caller to write —
    the route sets the headers, because an image is the one response
    in this service that is not JSON. */
async function photoBytes(lookup) {
  if (!lookup?.ok) return null;
  const file = await storage.get(lookup.storageKey);
  if (!file.ok) return null;
  return { body: file.body, mime: file.mime };
}

async function clientPhotoBytes(token, id) {
  return photoBytes(await data.crm.programmeMediaOne(token, id));
}

async function herPhotoBytes(id) {
  return photoBytes(await data.crm.mediaOne(id));
}

async function herPhotos(programmeId) {
  const out = await data.crm.media(programmeId);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ media: out.media || [] });
}

/* A short, stable folder name from the token. Not the token itself:
   a directory listing on the box should not hand somebody a working
   credential, and a hash is enough to group by. */
const sha8 = (s) =>
  require("node:crypto").createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

module.exports = {
  start, revoke, list, adherence, monitorDays, monitorWeights, monitorNotes, reply,
  resolve, days, checkin, weight, weights, note, notes, reviewAsk, reviewState, schedule,
  photo, photos, clientPhotoBytes, herPhotos, herPhotoBytes,
};
