/* ============================================================
   API — one endpoint per page
   ------------------------------------------------------------
   Each page makes exactly ONE request and gets everything it
   needs: its own rows, plus the nav counts. Nothing fetches a
   section it is not showing, so opening Settings does not drag
   down three lists nobody asked for.

   Every response carries `counts`, because the nav shows them on
   every page. Bundling them costs a few bytes; a second request
   per page would cost a round trip.

   The routes live in services/node-bff/crm/ and do not exist
   yet. Until they do, each call falls back to the sample and
   reports `live: false`, which the footer states plainly.
   ============================================================ */

import { SAMPLE } from "./sample-data.js";

const BASE = "/api/crm";

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  /* A SESSION THAT HAS ENDED SENDS HER TO THE DOOR.

     Without this, a 401 fell through to the sample fallback below —
     so an expired session showed her a CRM full of invented numbers.
     The footer did say they were not real, which is the only reason
     this was not worse, but a management screen must never answer a
     question about her practice with made-up data because nobody was
     signed in. The page she wanted is remembered, so signing back in
     returns her to it rather than to Overview.

     `replace` rather than `assign`, so Back does not return to the
     page that just failed. */
  if (res.status === 401) {
    const here = location.pathname + location.search;
    location.replace(`./login.html?next=${encodeURIComponent(here)}`);
    // Never resolves: the navigation is already under way, and a
    // rejection here would paint an error over a page that is leaving.
    return new Promise(() => {});
  }

  if (!res.ok) {
    /* The SERVER'S sentence, not the status code.

       This threw `HTTP 409` and every form in the CRM showed exactly
       that — which is how "Monday is already covered at that time"
       reached her as a number. The code is kept alongside for the
       few callers that branch on it. */
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body.error || null;
    throw err;
  }
  return res.json();
}

/** Counts are needed by every page, so the sample supplies them too. */
const sampleCounts = () => ({
  waiting: SAMPLE.waiting.length,
  today: SAMPLE.today.length,
  upcoming: SAMPLE.upcoming.length,
});

/** One fetch, one fallback, one honest flag. */
async function page(path, sample) {
  try {
    return { data: await request(path), live: true };
  } catch {
    return { data: { counts: sampleCounts(), ...sample }, live: false };
  }
}

/* ---- reads · one per page ----------------------------------- */

/** Overview is a SINGLE PASS: the state of every area in one
    response. Lists come back CAPPED — it is a digest, and the panel
    links through to the full page for anything longer. One request
    for the whole hub, not seven. */
export const overview = (period = "7d") =>
  page(`/overview?period=${encodeURIComponent(period)}`, {
    stats: SAMPLE.stats,
    waiting: SAMPLE.waiting,
    today: SAMPLE.today,
    upcoming: SAMPLE.upcoming,
    people: SAMPLE.people.slice(0, 3),
    messages: SAMPLE.messages.slice(0, 3),
    rules: SAMPLE.rules,
    totals: {
      people: SAMPLE.people.length,
      messages: SAMPLE.messages.length,
    },
  });

export const requests = () => page("/requests", { waiting: SAMPLE.waiting });
export const today = () => page("/today", { today: SAMPLE.today });
export const upcoming = () => page("/upcoming", { upcoming: SAMPLE.upcoming });
export const people = () => page("/people", { people: SAMPLE.people });
export const messages = () => page("/messages", { messages: SAMPLE.messages });

/* What came in, what is outstanding, what went back. The sample
   is empty on purpose: an offline CRM inventing payments that do
   not exist is worse than one that shows none. */
export const payments = () => page("/payments", { payments: [], totals: {} });

export const hours = () =>
  page("/hours", { rules: SAMPLE.rules, exceptions: SAMPLE.exceptions });

/** The month behind Hours: her week, the days that break it, and who
    is booked. One call — a calendar built from three would paint
    three times. */
export const calendar = (from, to) =>
  request(`/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

export const settings = () => page("/settings", { settings: SAMPLE.settings });

/* ---- writes -------------------------------------------------- */
/* ---- her week ------------------------------------------------
   Bands are added in BULK — one call carries the list of weekdays —
   because "Tuesdays and Thursdays, 11 to 1" is one decision, and a
   pattern entered a day at a time is one she stops maintaining. */
export const addBands = (payload) => request("/hours/rules", { method: "POST", body: payload });
export const dropBand = (id) => request(`/hours/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
export const addException = (payload) =>
  request("/hours/exceptions", { method: "POST", body: payload });

/* ---- what the desk knows -------------------------------------- */
export const knowledge = () =>
  page("/knowledge", {
    answers: [],
    phrasings: [],
    unrecognised: [],
  });

export const setAnswer = (intent, payload) =>
  request(`/knowledge/${encodeURIComponent(intent)}`, { method: "PATCH", body: payload });
export const addTopic = (payload) => request("/knowledge", { method: "POST", body: payload });
export const addPhrasing = (payload) => request("/phrasings", { method: "POST", body: payload });
export const dropPhrasing = (id) => request(`/phrasings/${encodeURIComponent(id)}`, { method: "DELETE" });
export const missedDone = (id) =>
  request(`/unrecognised/${encodeURIComponent(id)}/done`, { method: "POST" });

/* ---- her assistant -------------------------------------------
   NO SAMPLE FALLBACK, deliberately, and it is the only part of
   this file without one. Everywhere else a fallback shows the
   shape of a page whose API is not up yet, and the footer says
   the numbers are not live. Here the whole output IS a claim
   about her practice — a made-up sentence about who is waiting
   would be indistinguishable from a real one, and she would have
   no way to tell. These throw, and the panel says so. */
export const assist = () => request("/assist");
export const assistAsk = (question) => request("/assist/ask", { method: "POST", body: { question } });
export const assistDraft = (id) =>
  request(`/assist/draft/${encodeURIComponent(id)}`, { method: "POST" });

/* ---- what happened to a session --------------------------------
   NO SAMPLE FALLBACK on the write, and none on history either: a
   made-up "Done" is indistinguishable from a real one, and this is
   the data she will make decisions from. If it cannot be read, the
   page says so. */

/** Record it. Hands back the outcome's id so the row can offer Undo. */
export const outcome = (id, body) =>
  request(`/bookings/${encodeURIComponent(id)}/outcome`, { method: "POST", body });

/** Take back a mis-tap. Refused by the server after five minutes. */
export const undoOutcome = (id) =>
  request(`/outcomes/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Her real free hours, for moving somebody — each one carrying its
    own label, so nothing here has to reason about dates. */
export const freeSlots = () => request("/free-slots");

/** Everything already answered for. `kind` narrows it to one of the
    four; omitted, it is all of them. */
export const history = (kind) =>
  page(`/history${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`, {
    history: [],
    tally: {},
  });

/* ---- the assessment record -------------------------------------
   NO SAMPLE FALLBACK. Everywhere else a fallback shows the shape of
   a page whose API is not up; here an invented weight would be
   indistinguishable from a real one, and this is the record she
   makes clinical decisions from. These throw, and the page says so. */
export const assessments = (personId) =>
  request(`/assessments?personId=${encodeURIComponent(personId)}`);

export const openAssessment = (body) =>
  request("/assessments", { method: "POST", body });

export const saveAssessment = (id, body) =>
  request(`/assessments/${encodeURIComponent(id)}`, { method: "PATCH", body });

export const finaliseAssessment = (id) =>
  request(`/assessments/${encodeURIComponent(id)}/final`, { method: "POST" });

/** The only way to change a finalised version — it writes the next
    one and leaves the previous exactly as it was. */
export const amendAssessment = (id) =>
  request(`/assessments/${encodeURIComponent(id)}/amend`, { method: "POST" });

/* ---- the client's way in ---------------------------------------
   Mint-or-return, so asking twice is the same link. The server
   builds the URL, because the public origin is a deployment fact
   and a browser on this box would guess localhost. */
export const consultationLink = (id) =>
  request(`/consultation-link?id=${encodeURIComponent(id)}`, { method: "POST" });

/* ---- the care plan ---------------------------------------------
   NO SAMPLE FALLBACK, for the same reason the assessment has none:
   an invented plan is indistinguishable from a real one, and this
   is the document that leaves the building. These throw, and the
   page says so. */
export const plans = (personId) =>
  request(`/plans?personId=${encodeURIComponent(personId)}`);

export const plan = (id) => request(`/plan?id=${encodeURIComponent(id)}`);

export const openPlan = (body) => request("/plans", { method: "POST", body });

export const savePlan = (id, body) =>
  request(`/plans/${encodeURIComponent(id)}`, { method: "PATCH", body });

/** Hand it over. From here it can only be amended. */
export const issuePlan = (id) =>
  request(`/plans/${encodeURIComponent(id)}/issue`, { method: "POST" });

/** The only way to change an issued plan — it writes the next one
    and leaves the copy the client is holding alone. */
export const amendPlan = (id) =>
  request(`/plans/${encodeURIComponent(id)}/amend`, { method: "POST" });

/** The client's way in. Mint-or-return, and it follows the plan
    rather than the version — amending does not change the address
    somebody was already given. Refused on a draft. */
export const planLink = (id) =>
  request(`/plans/${encodeURIComponent(id)}/link`, { method: "POST" });

/* ---- what a model thinks the plan says -------------------------
   IT PROPOSES AND NOTHING ELSE. `structure` sends the plan to be
   read and stores what comes back as proposals; not one of them is
   part of the plan until `itemVerdict` says so, with her name
   attached by the server. */
/** GENERATE — the only model call on this page.

    Hands back what the assistant read so the page can lay it out as
    text for her to review. IT WRITES NO ROWS: rows are Build's job,
    from the text she accepts, so nothing exists for wording she
    never agreed to. Capped at three per version. */
export const generatePlan = (id) =>
  request(`/plans/${encodeURIComponent(id)}/structure`, { method: "POST" });

/** FETCH AND CREATE — a first draft, written from the finalised
    assessment.

    THE OTHER DIRECTION FROM GENERATE, and the only place in this
    system where the assistant writes clinical advice rather than
    reading hers back. So: the server picks the assessment (this
    sends no id — the browser does not get to choose which record a
    plan is written from), it must be FINAL, the plan must be a
    draft, and it is capped at three per version on its own budget.

    It writes nothing. What comes back lands in the review panel
    beside whatever is in her pad, exactly like Generate, and no row
    exists until she presses Build afterwards.

    `warnings` carries anything the safety check found — a row that
    collides with a recorded allergy, dietary pattern or dislike. */
export const draftFromAssessment = (id, shape) =>
  request(`/plans/${encodeURIComponent(id)}/draft`, {
    method: "POST",
    /* How many meals she wants, and whether to include
       between-meal options. Hers to decide — see the note on the
       control in plan.html. */
    body: shape || {},
  });

/** BUILD — not a model, and not charged against the three reads.

    It reviews the syntax of the plan text as it stands and turns it
    into rows, reporting any line that looked like an instruction and
    could not be read. */
export const buildPlan = (id) =>
  request(`/plans/${encodeURIComponent(id)}/build`, { method: "POST" });

export const planItems = (planId) =>
  request(`/plan-items?planId=${encodeURIComponent(planId)}`);

/** How often the assistant reads her writing correctly, by model.
    The whole justification for letting one near this. */
export const planAccuracy = () => request("/plan-accuracy");

export const itemVerdict = (id, body) =>
  request(`/plan-items/${encodeURIComponent(id)}`, { method: "PATCH", body });

/** Throw away a row the assistant proposed. Only one she has not
    ruled on — a row she marked wrong is the evidence that it WAS
    wrong, and Go refuses to delete those. */
export const dropPlanItem = (id) =>
  request(`/plan-items/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Clear the whole reading. Go keeps everything she has ruled on,
    and hands back how many of each so the page can say so. */
export const clearPlanItems = (planId) =>
  request(`/plan-items?planId=${encodeURIComponent(planId)}`, { method: "DELETE" });

/* ---- the client working through it -----------------------------
   THE TOKEN COMES BACK ONCE, when the programme starts. Nothing in
   the CRM lists it again — if it is lost she stops that programme
   and starts another, which is also what she should do if a phone
   is lost. */
export const startProgramme = (planId, days = 30) =>
  request(`/plans/${encodeURIComponent(planId)}/programme`, { method: "POST", body: { days } });

export const programmes = (personId) =>
  request(`/programmes?personId=${encodeURIComponent(personId)}`);

export const revokeProgramme = (id) =>
  request(`/programmes/${encodeURIComponent(id)}/revoke`, { method: "POST" });

export const adherence = (programmeId, days = 28) =>
  request(`/adherence?programmeId=${encodeURIComponent(programmeId)}&days=${days}`);

/* ---- watching one go along -------------------------------------
   NO SAMPLE FALLBACK, like the assessment and the plan. An invented
   week of ticks is indistinguishable from a real one, and this is
   the record she would change somebody's plan on the strength of. */

/** Every day, every row — the latest answer for each, with a count
    of how many times it was answered. */
export const programmeDays = (programmeId, days = 35) =>
  request(`/programme-days?programmeId=${encodeURIComponent(programmeId)}&days=${days}`);

/** Only what the app weighed. Her clinic weights are on the
    assessment, and the two are never mixed into one curve. */
export const programmeWeights = (programmeId) =>
  request(`/programme-weights?programmeId=${encodeURIComponent(programmeId)}`);

/** Photographs attached to those days. */
export const media = (programmeId) =>
  request(`/media?programmeId=${encodeURIComponent(programmeId)}`);

/** What they wrote that no row on the plan had a box for. READING
    THEM MARKS THEM READ, in Go, in the same request — so a note is
    new on the visit that first showed it and settled by the next. */
export const programmeNotes = (programmeId) =>
  request(`/programme-notes?programmeId=${encodeURIComponent(programmeId)}`);

/** Her answer, on a day. `by` is added by the server from the
    session — the database refuses a reply with nobody on it. */
export const replyOnDay = (programmeId, onDate, body) =>
  request(`/programmes/${encodeURIComponent(programmeId)}/reply`, {
    method: "POST",
    body: { onDate, body },
  });

/* The bytes come from a plain <img src>, not from fetch — the browser
   caches them, decodes them off-thread, and a grid of forty thumbnails
   costs nothing extra. Behind her session like every other /api/crm
   route, so a signed-out browser gets a 401 rather than a photograph. */
export const photoUrl = (id) => `${BASE}/photo?id=${encodeURIComponent(id)}`;

/** Put a time on a request that arrived without one — a review a
    client asked for from their app. Refused by Go on anything
    already scheduled: moving one of those is a reschedule, and it
    records an outcome. */
export const scheduleConsultation = (id, body) =>
  request(`/consultations/${encodeURIComponent(id)}/schedule`, { method: "POST", body });

export const accept = (id) => request(`/bookings/${encodeURIComponent(id)}/accept`, { method: "POST" });
export const decline = (id) => request(`/bookings/${encodeURIComponent(id)}/decline`, { method: "POST" });
export const retryMessage = (id) => request(`/messages/${encodeURIComponent(id)}/retry`, { method: "POST" });
export const saveSettings = (patch) => request("/settings", { method: "PATCH", body: patch });
export const dropException = (id) => request(`/exceptions/${encodeURIComponent(id)}`, { method: "DELETE" });
