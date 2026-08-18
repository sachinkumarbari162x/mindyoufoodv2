/* ============================================================
   DATA CLIENT — talks to services/go-data

   The BFF owns the rules; Go owns the database. This module is the
   only place in the Node service that knows Postgres exists, and
   even here it only knows it as an HTTP endpoint.

   Everything is best-effort in the same sense as the AI client: if
   the data service is down, the desk still takes bookings. It loses
   the BMI warm-start and the trial mirror, and says so in the log —
   it does not fail the visitor's booking over a trial feature.
   ============================================================ */
"use strict";

const { config } = require("./config");

const BASE = process.env.GO_DATA_URL || "http://127.0.0.1:5504";
const TIMEOUT = Number(process.env.GO_DATA_TIMEOUT_MS) || 6000;

/* The shared secret both services read from the same .env. Go rejects
   every route but /health without it once it is set; unset, both sides
   agree to run open on loopback so a fresh clone still works. Sent on
   every call rather than only on writes — reads return the same PII
   the writes create. */
const TOKEN = (process.env.SERVICE_TOKEN || "").trim();

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/* HAS go-data EVER ANSWERED? Until it has, this process is still
   starting up and the circuit breaker has no business firing.

   It used to. All four services start together, go-data applies
   the schema before it answers anything, and the boot probes in
   rules/knowledge.js and rules/countries.js call straight into
   here — so three failed probes opened the circuit and the CRM
   returned 503 to every request for the next sixty seconds. On a
   loopback database that was invisible: go-data was up in well
   under a second and the probes never failed.

   Against Supabase it happens every single restart. Applying the
   schema means a couple of hundred statements at ~50 ms each, so
   go-data is not answering for the first fifteen-odd seconds, the
   probes exhaust their retries, and a deploy looks like an outage
   that heals itself a minute later.

   The breaker is for a service that WAS working and stopped. That
   is a real signal worth shedding load over. "Has not started
   yet" is not the same thing and must not be treated as it. */
let everReachable = false;

/* `extra` carries per-request headers — today only the client's
   session token, on the account routes. It is a fourth argument
   rather than a property on the body because it is not data: it
   says WHO is asking, and a credential that travels inside the
   payload ends up logged with the payload. */
async function call(path, body, method, extra) {
  if (Date.now() < circuitOpenUntil) return null;

  try {
    const res = await fetch(BASE + path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(extra || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const data = await res.json().catch(() => ({}));
    consecutiveFailures = 0;
    everReachable = true;
    // A 404 from /handoff/claim is a real answer (expired token), not
    // a fault — hand it back rather than swallowing it as an outage.
    if (!res.ok) return { ok: false, status: res.status, ...data };
    return { ok: true, status: res.status, ...data };
  } catch (err) {
    /* Still waiting for the first answer of this process's life:
       report the failure to the caller, but do not shed load over
       it. See everReachable above. */
    if (!everReachable) return null;

    if (++consecutiveFailures >= 3) {
      circuitOpenUntil = Date.now() + 60_000;
      consecutiveFailures = 0;
      console.warn(`[bff] data service unreachable — skipping for 60s: ${err.message}`);
    }
    return null;
  }
}

/** Store a BMI calculation and mint a handoff token. */
const saveBmi = (payload) => call("/bmi", payload);

/** Exchange a handoff token for its snapshot. Single use, server-side. */
const claimHandoff = (token) => call("/handoff/claim", { token });

/** Mirror a confirmed booking into the trial database. */
const saveAppointment = (payload) => call("/appointments", payload);

async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : { ok: false };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/* ---- read-only database browsing -----------------------------
   Every table, and a page of rows from one of them. The table name
   is passed through to Go, which checks it against the catalog
   before building any query — the BFF deliberately keeps no list of
   its own, because two lists drift and only one of them is the one
   guarding the database. */
const dbTables = () => call("/db/tables");

const dbRows = ({ schema, table, limit, offset }) =>
  call(
    "/db/rows?" +
      new URLSearchParams({
        schema: String(schema || ""),
        table: String(table || ""),
        limit: String(limit || 50),
        offset: String(offset || 0),
      })
  );

/* ---- the crm schema ------------------------------------------
   Go owns Postgres, so even registering a visitor goes over HTTP
   with the service token rather than through a second connection
   from here. */
const crm = {
  overview: () => call("/crm/overview"),
  consultations: (status) =>
    call("/crm/consultations?" + new URLSearchParams({ status: status || "" })),
  people: () => call("/crm/people"),
  countries: () => call("/crm/countries"),

  /* ---- the door and the record (items 5 & 6) ----
     Go stores; it never judges. The password check happens in one
     place, auth/crypto.js, and this only moves the strings. */
  staff: (email, role) =>
    call("/crm/staff?" + new URLSearchParams({ ...(email ? { email } : {}), role: role || "crm" })),
  staffCreate: (payload) => call("/crm/staff", payload),
  staffPatch: (id, patch) => call(`/crm/staff/${encodeURIComponent(id)}`, patch, "PATCH"),
  audit: (entry) => call("/crm/audit", entry),
  auditList: (query) => call("/crm/audit?" + new URLSearchParams(query || {})),

  /* ---- the conversation store and the switches (item 13) ---- */
  botTurn: (entry) => call("/crm/bot-turns", entry),
  botTurns: (query) => call("/crm/bot-turns?" + new URLSearchParams(query || {})),
  botStats: () => call("/crm/bot-turns/stats"),
  botSwitches: () => call("/crm/bot-switches"),
  botSwitch: (bot, enabled) => call("/crm/bot-switches", { bot, enabled }),

  /* ---- payments (item 7, test mode only) ---- */
  recordPayment: (payment) => call("/crm/payments", payment),
  /* What came in, what is outstanding, what went back. */
  paymentList: (query) => call("/crm/payments?" + new URLSearchParams(query || {})),

  /** The receipt a payment earns. Idempotent in Go: the browser and
      the webhook both call it and only one document is issued. */
  issueReceipt: (paymentId, description) =>
    call("/crm/invoices", { paymentId, description: description || "" }),
  receipt: (id) => call(`/crm/invoices/${encodeURIComponent(id)}`),

  /* ---- the checkout ----
     mint  : reserve the hour and hand back an opaque token
     resolve: what the checkout page may show (no ids, no email)
     paid  : the hour is theirs — called only after a signature
             has verified in this process */
  checkoutMint: (consultationId) =>
    call(`/crm/consultations/${encodeURIComponent(consultationId)}/checkout`, {}),
  checkoutResolve: (token) => call(`/checkout/${encodeURIComponent(token)}`),
  checkoutPaid: (token, paymentId) =>
    call(`/checkout/${encodeURIComponent(token)}/paid`, { paymentId }),
  /* Taking the hour back after a hold lapsed, if nobody else
     has had it in the meantime. */
  checkoutResume: (token) =>
    call(`/checkout/${encodeURIComponent(token)}/resume`, {}),

  /** Her published week and the days that break it — the SAME two
      tables the slot engine reads, so the Hours page always shows
      what the desk is actually offering from. */
  hours: () => call("/crm/hours"),
  hoursClash: (query) => call("/crm/hours/clash?" + new URLSearchParams(query || {})),
  /* The month: her week, the days that break it, and the diary —
     one call, because a calendar drawing itself from three would
     paint three times. */
  calendar: (query) => call("/crm/calendar?" + new URLSearchParams(query || {})),

  /* ---- what happened after the booking ---- */
  outcome: (id, entry) => call(`/crm/consultations/${encodeURIComponent(id)}/outcome`, entry),
  outcomes: (query) => call("/crm/outcomes?" + new URLSearchParams(query || {})),
  outcomeStats: () => call("/crm/outcomes/stats"),
  /* The undo behind a mis-tap. Go refuses it after five minutes or if
     anything was recorded since — see crmOutcomeUndo. */
  undoOutcome: (id) => call(`/crm/outcomes/${encodeURIComponent(id)}`, undefined, "DELETE"),
  /* Sessions whose hour has gone with nothing said about them — the
     duty that stops the outcome buttons from being optional. */
  unrecorded: () => call("/crm/unrecorded"),

  /* ---- what the system sent ----
     Queue BEFORE the attempt, record the outcome after it. A second
     queue for the same booking and template comes back as
     `duplicate` — the unique index refusing it — which is what makes
     a double-clicked Accept harmless. */
  queueMessage: (entry) => call("/crm/messages", entry),
  messageResult: (id, result) =>
    call(`/crm/messages/${encodeURIComponent(id)}`, result, "PATCH"),
  messages: (query) => call("/crm/messages?" + new URLSearchParams(query || {})),
  message: (id) => call(`/crm/messages/${encodeURIComponent(id)}`),

  /** One booking, for writing an email about it. The window reads
      cannot answer "this one", which is exactly what a confirmation
      needs. */
  consultation: (id) => call(`/crm/consultations/${encodeURIComponent(id)}`),

  /* ---- the opaque link ----
     Mint returns the EXISTING token when there is one, so sending a
     confirmation twice cannot leave somebody holding two links. */
  /* Is this address already on file? A boolean and nothing else —
     see crmPersonExists for why that restraint matters. */
  personExists: (email) =>
    call("/crm/people/exists?" + new URLSearchParams({ email: email || "" })),

  mintLink: (id) => call(`/crm/consultations/${encodeURIComponent(id)}/link`, {}),
  resolveLink: (token) => call(`/link/${encodeURIComponent(token)}`),

  /* ---- the consultation room ----
     The SSE connections cannot live in Postgres — an open HTTP
     response is not a row. These are the facts around them: who
     joined, who started it, and how the media actually travelled. */
  roomJoin: (entry) => call("/crm/rooms/join", entry),
  roomState: (entry) => call("/crm/rooms/state", entry),
  roomLeave: (entry) => call("/crm/rooms/leave", entry),
  rooms: (query) => call("/crm/rooms?" + new URLSearchParams(query || {})),
  rating: (entry) => call("/crm/ratings", entry),

  /* ---- the assessment record ----
     Go owns the versioning and the amend-forward rule; these only
     carry the strings. There is no delete, here or there. */
  assessments: (query) => call("/crm/assessments?" + new URLSearchParams(query || {})),
  assessment: (id) => call(`/crm/assessments/${encodeURIComponent(id)}`),
  assessmentOpen: (entry) => call("/crm/assessments", entry),
  assessmentSave: (id, entry) =>
    call(`/crm/assessments/${encodeURIComponent(id)}`, entry, "PATCH"),
  assessmentFinal: (id) => call(`/crm/assessments/${encodeURIComponent(id)}/final`, {}),
  assessmentAmend: (id, entry) =>
    call(`/crm/assessments/${encodeURIComponent(id)}/amend`, entry),

  /* ---- the care plan ----
     Same six verbs as the assessment. `issue` rather than `final`,
     because a plan is handed to somebody rather than concluded. */
  plans: (query) => call("/crm/plans?" + new URLSearchParams(query || {})),
  plan: (id) => call(`/crm/plan?id=${encodeURIComponent(id)}`),
  planOpen: (entry) => call("/crm/plans", entry),
  planSave: (id, entry) => call(`/crm/plans/${encodeURIComponent(id)}`, entry, "PATCH"),
  planIssue: (id) => call(`/crm/plans/${encodeURIComponent(id)}/issue`, {}),
  planAmend: (id, entry) => call(`/crm/plans/${encodeURIComponent(id)}/amend`, entry),

  /* The client's door into their plan. Mint-or-return, and it
     follows the PLAN rather than the version — so amending does not
     change the address somebody was already given. */
  planLinkMint: (id) => call(`/crm/plans/${encodeURIComponent(id)}/link`, {}),
  resolvePlanLink: (token) => call(`/plan-link/${encodeURIComponent(token)}`),

  /* ---- what a model thinks the plan says ----
     Proposals and her verdict on them. Replaced rather than
     appended, and rows she has already ruled on survive a re-read. */
  planItems: (planId) => call("/crm/plan-items?" + new URLSearchParams({ planId })),
  planItemsRead: (entry) => call("/crm/plan-items", entry),
  /* One of the three model reads, claimed atomically. See
     crmPlanReadClaim — the WHERE clause carries the limit. */
  planReadClaim: (id) => call(`/crm/plans/${encodeURIComponent(id)}/read`, {}),
  /* Its own budget. Claimed BEFORE the model is called, unlike a
     read — see crmPlanDraftClaim in Go. */
  planDraftClaim: (id) => call(`/crm/plans/${encodeURIComponent(id)}/draft`, {}),
  planItemDrop: (id) => call(`/crm/plan-items/${encodeURIComponent(id)}`, undefined, "DELETE"),
  planItemsClear: (planId) =>
    call("/crm/plan-items?" + new URLSearchParams({ planId }), undefined, "DELETE"),
  planItemVerdict: (id, entry) =>
    call(`/crm/plan-items/${encodeURIComponent(id)}`, entry, "PATCH"),
  planItemAccuracy: () => call("/crm/plan-items/accuracy"),

  /* ---- the client working through their plan ----
     Her side mints and revokes; the four below it are the public
     ones, reached from a phone by somebody holding a token. */
  programmeStart: (planId, days) =>
    call(`/crm/plans/${encodeURIComponent(planId)}/programme`, { days: days || 30 }),
  programmeRevoke: (id) => call(`/crm/programmes/${encodeURIComponent(id)}/revoke`, {}),
  programmes: (personId) => call("/crm/programmes?" + new URLSearchParams({ personId: personId || "" })),
  adherence: (query) => call("/crm/adherence?" + new URLSearchParams(query || {})),

  /* Her read of their days. Distinct from programmeDays below, which
     is the client's own and is scoped by a token she does not hold. */
  crmProgrammeDays: (query) => call("/crm/programme/days?" + new URLSearchParams(query || {})),
  crmProgrammeWeights: (programmeId) =>
    call("/crm/programme/weights?" + new URLSearchParams({ programmeId })),
  crmProgrammeNotes: (programmeId) =>
    call("/crm/programme/notes?" + new URLSearchParams({ programmeId })),
  crmProgrammeReply: (entry) => call("/crm/programme/notes", entry),

  /* Something they wanted to say. The second public write path in
     the system, after the check-in. */
  programmeNoteAdd: (token, entry) => call(`/programme/${encodeURIComponent(token)}/note`, entry),
  programmeNotes: (token) => call(`/programme/${encodeURIComponent(token)}/notes`),

  /* Asking to be seen again, and what was already asked. Go keeps
     it to one open request per person — see review_requests.go. */
  programmeReviewAsk: (token, entry) =>
    call(`/programme/${encodeURIComponent(token)}/review`, entry),
  programmeReviewState: (token) =>
    call(`/programme/${encodeURIComponent(token)}/review`),

  /* Her answer: a time on a request that arrived without one. */
  consultationSchedule: (id, entry) =>
    call(`/crm/consultations/${encodeURIComponent(id)}/schedule`, entry),

  programmeResolve: (token) => call(`/programme/${encodeURIComponent(token)}`),
  programmeDays: (token) => call(`/programme/${encodeURIComponent(token)}/days`),
  programmeCheckin: (token, entry) => call(`/programme/${encodeURIComponent(token)}/checkin`, entry),
  programmeWeight: (token, entry) => call(`/programme/${encodeURIComponent(token)}/weight`, entry),
  programmeWeights: (token) => call(`/programme/${encodeURIComponent(token)}/weights`),

  /* ---- photographs ----
     Go records that one exists; the bytes went to the storage seam
     before any of these are called. */
  programmeMediaAdd: (token, entry) => call(`/programme/${encodeURIComponent(token)}/media`, entry),
  programmeMedia: (token) => call(`/programme/${encodeURIComponent(token)}/media`),
  programmeMediaOne: (token, id) =>
    call(`/programme/${encodeURIComponent(token)}/media/one?id=${encodeURIComponent(id)}`),
  media: (programmeId) => call("/crm/media?" + new URLSearchParams({ programmeId })),
  mediaOne: (id) => call("/crm/media/one?" + new URLSearchParams({ id })),

  /* Editing her week. Bands are added in BULK — one call carries the
     list of weekdays — because a pattern entered a day at a time is a
     pattern she stops maintaining, and a stale one means the desk
     offers hours she is not working. */
  addBands: (payload) => call("/crm/hours/rules", payload),
  dropBand: (id) => call(`/crm/hours/rules/${encodeURIComponent(id)}`, undefined, "DELETE"),
  addException: (payload) => call("/crm/hours/exceptions", payload),
  dropExceptionRow: (id) =>
    call(`/crm/hours/exceptions/${encodeURIComponent(id)}`, undefined, "DELETE"),

  /** Times she is genuinely free — her published week, minus days she
      has closed, minus what is already held or confirmed, minus the
      notice period, capped per day. Worked out in Go because only the
      database can answer the "already taken" half; anything computed
      here would be a snapshot that was true a moment ago. */
  slots: ({ days, limit } = {}) =>
    call("/crm/slots?" + new URLSearchParams({ days: String(days || 14), limit: String(limit || 40) })),

  /* The knowledge and intelligence base. Read once at boot and on a
     slow timer — never inside a conversation turn. */
  /* AUDIENCE IS ALWAYS STATED. Go defaults to `desk` when nobody
     says — the safe half — so a caller that forgets gets the front
     desk's answers rather than a client's. Both callers here say
     which they mean, in one word, at the call site. */
  knowledge: (audience) =>
    call("/crm/knowledge?" + new URLSearchParams({ audience: audience || "desk" })),
  addTopic: (payload) => call("/crm/knowledge", payload),
  setAnswer: (intent, payload) =>
    call(`/crm/knowledge/${encodeURIComponent(intent)}`, payload, "PATCH"),
  addPhrasing: (payload) => call("/crm/phrasings", payload),
  dropPhrasing: (id) => call(`/crm/phrasings/${encodeURIComponent(id)}`, undefined, "DELETE"),
  missed: (text) => call("/crm/unrecognised", { text }),
  missedDone: (id) => call(`/crm/unrecognised/${encodeURIComponent(id)}/done`, {}),

  /** The chatbot registering a visitor and holding their slot. */
  register: (payload) => call("/crm/people", payload),
  book: (payload) => call("/crm/consultations", payload),

  /** She accepts or declines. */
  setStatus: (id, status) =>
    call(`/crm/consultations/${encodeURIComponent(id)}/status`, { status }),
};

/* The client account's own calls, kept apart from `crm` because
   they are a different door: `crm` is her, this is them. See
   client/store.js, which is the only caller. */
const client = {
  codeStore: (payload) => call("/client/codes", payload),
  codeGet: (email) => call("/client/codes?" + new URLSearchParams({ email })),
  codeMiss: (id) => call(`/client/codes/${encodeURIComponent(id)}/miss`, {}),
  codeUse: (id, meta) => call(`/client/codes/${encodeURIComponent(id)}/use`, meta || {}),

  session: (token) => call("/client/session", null, "GET", { "X-Client-Session": token }),
  sessionFromToken: (payload) => call("/client/session/from-token", payload),
  revoke: (token) => call("/client/session/revoke", {}, "POST", { "X-Client-Session": token }),

  me: (token) => call("/client/me", null, "GET", { "X-Client-Session": token }),
  weight: (token, payload) => call("/client/weight", payload, "POST", { "X-Client-Session": token }),
  note: (token, payload) => call("/client/note", payload, "POST", { "X-Client-Session": token }),
  media: (token, payload) => call("/client/media", payload, "POST", { "X-Client-Session": token }),
  checkin: (token, payload) => call("/client/checkin", payload, "POST", { "X-Client-Session": token }),
  review: (token, payload) => call("/client/review", payload, "POST", { "X-Client-Session": token }),
};

module.exports = { saveBmi, claimHandoff, saveAppointment, dbTables, dbRows, crm, client, health, BASE };
