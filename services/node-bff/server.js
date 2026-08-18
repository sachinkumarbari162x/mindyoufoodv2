/* ============================================================
   NODE BFF · HTTP

       POST /api/chat/session   open a conversation
       POST /api/chat/message   { sessionId, text }
       POST /api/chat/action    { sessionId, action: confirm|edit|cancel }
       POST /api/chat/end       drop a session and its PII
       GET  /api/chat/config    hours + focus areas, for first paint
       GET  /api/health         liveness, incl. the AI service

   Zero dependencies, same as the static server it sits behind —
   this box runs one small process and adding a framework to it
   buys nothing (see backend-deploy-target).

   Every response is JSON. Every handler is wrapped, so an
   unexpected throw becomes a 500 with a generic body rather than
   a stack trace on the wire.
   ============================================================ */
"use strict";

const http = require("node:http");
const { config, publicBase, describeBase } = require("./config");
const session = require("./session");
const flow = require("./flow");
const limits = require("./rules/limits");
const hours = require("./rules/hours");
const validate = require("./rules/validate");
const newsletter = require("./newsletter");
const ai = require("./ai-client");
const data = require("./data-client");
const checkout = require("./payments/checkout");
const countries = require("./rules/countries");
const auth = require("./auth/routes");
const orchestrator = require("./orchestrator");
const officer = require("./crm/officer");
const crm = require("./crm/routes");
const assessments = require("./crm/assessments");
const plans = require("./crm/plans");
const programmes = require("./crm/programmes");
const storage = require("./storage");
const assistant = require("./crm/assistant");
const knowledge = require("./rules/knowledge");
const trial = require("./trial");
const roomHub = require("./room");
const clientAccount = require("./client/routes");

const MAX_BODY = 16 * 1024; // a chat turn is never bigger than this

/* ---- helpers ------------------------------------------------- */

function clientIp(req) {
  // Trust the proxy header only when it is actually behind one —
  // otherwise anybody can spoof their way past the rate limiter.
  if (process.env.TRUST_PROXY === "1") {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("malformed JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/* Read a raw binary body. The JSON reader above caps at 16 KB and
   parses; a photograph is neither. Sent as the bare bytes with an
   image Content-Type rather than as multipart or base64: there is no
   form to parse, nothing to decode, and no dependency to add — which
   is the same reasoning that keeps the rest of this service at zero.

   The cap is the storage layer's, asked for rather than repeated, so
   there is one number and it lives with the thing it protects. */
function readBytes(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** An image, which is the only response in this service that is not
    JSON. Private and never cached by anything in between. */
function sendImage(res, mime, buf) {
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": buf.length,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    /* It is a photograph of somebody's dinner in a clinical record.
       Nothing should be able to frame it or script against it. */
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(buf);
}

function send(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The transcript is PII; make sure nothing between here and the
    // browser is tempted to keep a copy.
    "Referrer-Policy": "no-referrer",
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  // No allow-list configured = same-origin only, which is how the
  // static server proxies it in development. Explicit origins are
  // needed only if the site and the BFF are served from different
  // hosts in production.
  if (!config.corsOrigins.length) return true;
  if (!config.corsOrigins.includes(origin)) {
    send(res, 403, { error: "origin not allowed" });
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  return true;
}

/** CRM handlers return {status, body} rather than writing themselves,
    so the routes above stay one line each and the module underneath
    has no idea an HTTP response exists. */
async function crmRoute(res, promise) {
  const out = await promise;
  send(res, out.status, out.body);
}

/** Hours as she would say them, for the audit log to read back. */
function describeBand(body) {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const which = (body?.weekdays || []).map((d) => days[d] || "?").join(", ");
  return `${which} ${hhmm(Number(body?.startsMin))}-${hhmm(Number(body?.endsMin))}`;
}

/* Routes with an id in the path. The table above is exact-match,
   which is the right default — a pattern list that everything falls
   through is how a typo becomes a 200. These two are declared apart
   so it stays obvious that they are the only ones. */
const CRM_ACTIONS = [
  { re: /^\/api\/crm\/bookings\/([\w-]{1,64})\/accept$/, run: (id) => crm.accept(id), log: "booking.accept" },
  /* Putting a time on a request that arrived without one. Audited,
     because it is the moment a client's ask becomes an appointment
     in her diary. Go refuses it on anything already scheduled —
     moving one of those is a reschedule, with an outcome recorded. */
  {
    re: /^\/api\/crm\/consultations\/([\w-]{1,64})\/schedule$/,
    run: (id, body) => programmes.schedule(id, body),
    log: "consultation.schedule",
  },
  { re: /^\/api\/crm\/bookings\/([\w-]{1,64})\/decline$/, run: (id) => crm.decline(id), log: "booking.decline" },
  {
    re: /^\/api\/crm\/bookings\/([\w-]{1,64})\/outcome$/,
    run: (id, body, req) =>
      crm.outcome(id, { ...body, by: auth.current(req)?.email || "unknown" }),
    log: "booking.outcome",
  },
  {
    re: /^\/api\/crm\/assessments\/([\w-]{1,64})\/final$/,
    run: (id) => assessments.final(id),
    log: "assessment.final",
  },
  /* The only route that changes what a finalised assessment says —
     and it does so by writing the next version beside it. */
  {
    re: /^\/api\/crm\/assessments\/([\w-]{1,64})\/amend$/,
    run: (id, body, req) => assessments.amend(id, auth.current(req)?.email),
    log: "assessment.amend",
  },
  /* Send one again after a failure. The client has been calling this
     since the Messages page was built; there was no route behind it,
     because there was nothing to retry. */
  {
    re: /^\/api\/crm\/messages\/([\w-]{1,64})\/retry$/,
    run: (id) => crm.retryMessage(id),
    log: "message.retry",
  },
  /* Handing the plan over. Audited, because it is the moment a
     document stops being hers and starts being the client's — and
     from here it can only be amended, never edited. */
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/issue$/,
    run: (id) => plans.issue(id),
    log: "plan.issue",
  },
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/amend$/,
    run: (id, body, req) => plans.amend(id, auth.current(req)?.email),
    log: "plan.amend",
  },
  /* Minting the client's door. Audited: it is the moment a clinical
     document becomes reachable from the open internet by anybody
     holding a string. */
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/link$/,
    run: (id) => plans.link(id),
    log: "plan.link",
  },
  /* Asking the assistant to read the plan. Audited, because it is
     the moment a client's clinical document is sent to a third
     party — and that is a thing she should be able to see a record
     of, whatever the model then says. */
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/structure$/,
    run: (id) => plans.structure(id),
    log: "plan.structure",
  },
  /* FETCH AND CREATE — the assistant WRITING a first draft from the
     finalised assessment, rather than reading her prose back.

     Audited under its own name, deliberately. `plan.structure` and
     this are both model calls, and conflating them in the log would
     lose the one distinction that matters afterwards: which of a
     client's rows started as her sentences and which started as a
     machine's. If that question is ever asked, it will be asked in
     earnest. */
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/draft$/,
    /* The body carries the shape she chose — how many meals, and
       whether she wants between-meal options. It is hers to decide
       and the model is told so; see from-assessment.js. */
    run: (id, body) => plans.draftFromAssessment(id, body),
    log: "plan.draft_from_assessment",
  },
  /* BUILD. Not audited as a model call, because it is not one — no
     network beyond the database, nothing generative, and no charge
     against the three reads. It reviews the syntax of the text she
     has already accepted and turns it into rows. */
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/build$/,
    run: (id) => plans.build(id),
    log: "plan.build",
  },
  /* Starting a programme. Audited, because it opens a door that
     accepts writes from the open internet for weeks. */
  {
    re: /^\/api\/crm\/plans\/([\w-]{1,64})\/programme$/,
    run: (id, body) => programmes.start(id, body?.days),
    log: "programme.start",
  },

  /* Her answer on a day.

     The programme is in the PATH rather than the body, so the audit
     line above records which client's record was written to — a log
     entry that only says "programme.reply" answers nothing later.

     `by` is taken from the session and never from the body. The
     database refuses a practitioner line with nobody attached. */
  {
    re: /^\/api\/crm\/programmes\/([\w-]{1,64})\/reply$/,
    run: (id, body, req) =>
      programmes.reply({ ...body, programmeId: id }, auth.current(req)?.email),
    log: "programme.reply",
  },
  /* And closing it. Audited for the same reason, from the other
     direction — "when was that link cut off" is a question worth
     being able to answer. */
  {
    re: /^\/api\/crm\/programmes\/([\w-]{1,64})\/revoke$/,
    run: (id) => programmes.revoke(id),
    log: "programme.revoke",
  },
];

/* Removing a band or a one-off. DELETE rather than POST because that
   is what it is, and the id is in the path. */
const CRM_DELETES = [
  { re: /^\/api\/crm\/hours\/rules\/([\w-]{1,64})$/, run: (id) => crm.dropBand(id), log: "hours.drop" },
  { re: /^\/api\/crm\/hours\/exceptions\/([\w-]{1,64})$/, run: (id) => crm.dropException(id), log: "hours.exception.drop" },
  { re: /^\/api\/crm\/phrasings\/([\w-]{1,64})$/, run: (id) => crm.dropPhrasing(id), log: "knowledge.phrasing.drop" },
  /* Undo, and the only route that removes a record of something that
     happened. Audited like the rest — an undo is itself a thing she
     did, and the line stays even though the outcome row does not. */
  { re: /^\/api\/crm\/outcomes\/([\w-]{1,64})$/, run: (id) => crm.undoOutcome(id), log: "booking.outcome.undo" },
  /* Throwing away a row the assistant proposed and she never ruled on.
     Go refuses it for anything she HAS ruled on — see plan_items.go
     for why that restriction is about the accuracy figure. */
  { re: /^\/api\/crm\/plan-items\/([\w-]{1,64})$/, run: (id) => plans.drop(id), log: "plan.item.drop" },
  /* The whole reading at once, when a bad one is easier to clear than
     to correct. Go keeps anything she has ruled on. */
  { re: /^\/api\/crm\/plan-items$/, run: (_x, _b, req) =>
      plans.clear(new URL(req.url, "http://x").searchParams.get("planId") || ""),
    log: "plan.items.clear" },
];

/* Rewriting an answer. PATCH because it replaces one field of an
   existing row, and the topic is in the path. */
const CRM_PATCHES = [
  { re: /^\/api\/crm\/knowledge\/([\w-]{1,40})$/, run: (id, body) => crm.setAnswer(id, body) },
  /* Saving a draft. Refused by Go once the version is final. */
  { re: /^\/api\/crm\/assessments\/([\w-]{1,64})$/, run: (id, body) => assessments.save(id, body) },
  /* Same, for the plan. Refused by Go once it has been issued. */
  { re: /^\/api\/crm\/plans\/([\w-]{1,64})$/, run: (id, body) => plans.save(id, body) },
  /* Her verdict on one proposed row. `by` comes from the session. */
  {
    re: /^\/api\/crm\/plan-items\/([\w-]{1,64})$/,
    run: (id, body, req) => plans.verdict(id, body, auth.current(req)?.email),
  },
];

/** Resolve a session or explain why it is gone. 410 tells the client
    to start a fresh one rather than retry the same dead id. */
function requireSession(body, res) {
  const s = session.get(body.sessionId);
  if (!s) {
    send(res, 410, {
      error: "session_expired",
      message: "That conversation timed out.",
    });
    return null;
  }
  return s;
}

/* ---- routes -------------------------------------------------- */

/** Send a {status, headers, body} the way the auth routes speak. */
function reply(res, out) {
  send(res, out.status, out.body, out.headers);
}

/* The checkout module answers with a flat object — {ok, status,
   …} — because that is what reads well at its own call sites,
   where order() asks view() a question and wants the answer, not
   an HTTP envelope. This puts the envelope on at the boundary
   instead of making every internal caller unwrap one.

   Without it `out.body` was undefined and every checkout route
   returned "Something went wrong at my end" while the database
   work had already committed. */
const asReply = (out) => ({
  status: out.status || (out.ok ? 200 : 400),
  body: out,
});

/* ---- the guard ------------------------------------------------
   Every /api/crm/* route except the auth ones needs a session.

   This is THE security boundary. The CRM's HTML is a shell — every
   figure in it arrives through these routes — so guarding the API
   is what actually closes the door. Guarding the static files is
   only so she is not left staring at an empty page wondering why. */
const OPEN_CRM_ROUTES = new Set([
  "GET /api/crm/auth/me",
  "POST /api/crm/auth/setup",
  "POST /api/crm/auth/login",
  "POST /api/crm/auth/totp",
  "POST /api/crm/auth/enrol",
  "POST /api/crm/auth/logout",
]);

function needsSession(method, pathname) {
  if (!pathname.startsWith("/api/crm/")) return false;
  return !OPEN_CRM_ROUTES.has(`${method} ${pathname}`);
}

/* The raw tables are the OTHER door. A CRM session is not a viewer
   session: whoever can read every row of every table in the system
   should have had to prove it separately, which is what item 8
   asked for and the only reason two doors exist. */
const RAW_TABLES = /^\/api\/db\//;

function needsViewer(pathname) {
  return RAW_TABLES.test(pathname);
}

const routes = {
  "POST /api/chat/session": async (req, res, body, ipHash) => {
    // The real address as well as its hash: the limiter waives
    // loopback, and a hash cannot be compared to 127.0.0.1.
    const rl = limits.perIpSession(ipHash, clientIp(req));
    if (!rl.ok) {
      return send(res, 429, {
        error: "rate_limited",
        message: "That's a lot of new conversations from this connection. Try again in a little while.",
      }, { "Retry-After": String(rl.retryAfter) });
    }

    // A client may hand back an id it already has — reuse it rather
    // than orphaning a half-filled draft on a refresh.
    const existing = session.get(body.sessionId);
    if (existing) {
      /* Something to draw, always. This used to return an envelope
         with no messages and no chips, so a browser reconnecting to
         a live session opened an EMPTY window whenever it had no
         transcript of its own to fill it with. */
      return send(res, 200, flow.resume(existing));
    }

    /* A handoff token from the BMI page. Claimed server-side and
       exactly once, so the figures cannot be forged by editing a
       URL, and a shared link opens a cold desk rather than somebody
       else's measurements. A dead token is not an error: the desk
       simply starts normally. */
    let snapshot = null;
    if (typeof body.handoffToken === "string" && body.handoffToken.length > 8) {
      const claimed = await data.claimHandoff(body.handoffToken.slice(0, 64));
      if (claimed && claimed.ok && claimed.snapshot) snapshot = claimed.snapshot;
    }

    send(res, 200, flow.start(ipHash, {
      locale: typeof body.locale === "string" ? body.locale.slice(0, 20) : "",
      timezone: typeof body.timezone === "string" ? body.timezone.slice(0, 60) : "",
      snapshot,
    }));
  },

  "POST /api/chat/message": async (req, res, body, ipHash) => {
    const s = requireSession(body, res);
    if (!s) return;

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(res, 400, { error: "empty_message" });
    if (text.length > config.limits.messageChars) {
      return send(res, 413, {
        error: "too_long",
        message: `That's longer than I can take in one go (${config.limits.messageChars} characters).`,
      });
    }

    const perSession = limits.perSessionMessage(s.id);
    const perIp = limits.perIpMessage(ipHash);
    if (!perSession.ok || !perIp.ok) {
      const retry = Math.max(perSession.retryAfter, perIp.retryAfter);
      return send(res, 429, {
        error: "rate_limited",
        message: "You're going faster than I can keep up with — give me a few seconds.",
      }, { "Retry-After": String(retry) });
    }

    send(res, 200, await flow.message(s, text, ipHash));
  },

  "POST /api/chat/action": async (req, res, body, ipHash) => {
    const s = requireSession(body, res);
    if (!s) return;
    const act = String(body.action || "");
    if (!["confirm", "edit", "cancel", "form.open", "form.submit", "form.close"].includes(act)) {
      return send(res, 400, { error: "unknown_action" });
    }
    // The form actions carry a payload; the rest ignore it.
    send(res, 200, await flow.action(s, act, ipHash, body));
  },

  "POST /api/chat/end": async (req, res, body) => {
    session.destroy(body.sessionId);
    send(res, 200, { ok: true });
  },

  /* The BMI calculator's only call. The BFF does not compute or
     validate the number — Go does both, against the same CHECK
     constraints that guard the table — it exists here so the browser
     talks to one origin and the data service stays on loopback. */
  /* ---- the checkout ----
     Public: reached by a visitor who has typed a name into a form
     and holds an opaque token. Everything they could abuse is
     bounded by that token, which expires with the hour it holds. */
  "POST /api/pay/start": async (req, res, body) =>
    reply(res, asReply(await checkout.start(body && body.consultationId))),

  "POST /api/pay/order": async (req, res, body) =>
    reply(res, asReply(await checkout.order(body && body.token))),

  "POST /api/pay/resume": async (req, res, body) =>
    reply(res, asReply(await checkout.resume(body && body.token))),

  "POST /api/pay/confirm": async (req, res, body) =>
    reply(res, asReply(await checkout.paid({
      token: body && body.token,
      orderId: body && body.orderId,
      paymentId: body && body.paymentId,
      signature: body && body.signature,
      source: "browser",
    }))),

  "POST /api/bmi": async (req, res, body, ipHash) => {
    const rl = limits.take(`bmi:${ipHash}`, 30, 3_600_000);
    if (!rl.ok) {
      return send(res, 429, {
        ok: false,
        error: "rate_limited",
        message: "That's a lot of calculations from this connection. Try again shortly.",
      }, { "Retry-After": String(rl.retryAfter) });
    }
    const out = await data.saveBmi(body);
    if (!out) {
      return send(res, 503, {
        ok: false,
        error: "data_unavailable",
        message: "Couldn't pass your numbers over just now.",
      });
    }
    send(res, out.ok ? 201 : out.status || 400, out);
  },

  /* Not part of the chat, but it belongs on the same origin so the
     marketing page needs no second host and no CORS. Rate-limited on
     the newsletter's own bucket: signing up is not sending a chat
     message, and one should not exhaust the other. */
  "POST /api/newsletter/subscribe": async (req, res, body, ipHash) => {
    const rl = limits.take(`nl:${ipHash}`, 8, 3_600_000);
    if (!rl.ok) {
      return send(res, 429, {
        ok: false,
        error: "rate_limited",
        message: "That's a lot of sign-ups from this connection. Try again a bit later.",
      }, { "Retry-After": String(rl.retryAfter) });
    }
    const out = await newsletter.subscribe(body, ipHash);
    send(res, out.status, out.body);
  },

  /* Everything the first paint needs before a session exists, so the
     invite panel can show real hours rather than hard-coded copy. */
  "GET /api/chat/config": async (req, res) => {
    const presence = hours.presence();
    send(res, 200, {
      office: { open: presence.open, label: presence.label, hoursText: config.practice.hoursText },
      focusAreas: validate.FOCUS_AREAS.map((f) => f.label),
      modes: validate.MODES.map((m) => m.label),
      maxSlots: config.practice.maxSlots,
      minLeadHours: config.practice.minLeadHours,
      contactEmail: config.practice.contactEmail,
      messageChars: config.limits.messageChars,
    });
  },

  /* ---- the client's own account ----------------------------
     A SECOND DOOR, and not a smaller version of the first. The
     CRM's session is her: it reads every row of every table. This
     one is a client, and everything behind it runs under row-level
     security scoped to that one person — see client/routes.js and
     go-data/client_account.go.

     Not in OPEN_CRM_ROUTES and not guarded by needsSession,
     because these are not /api/crm/* at all. They carry their own
     cookie and each one checks it. */
  "POST /api/client/code": async (req, res, body, ipHash) => {
    // Two limits, deliberately: this one is per connection and
    // stops a script sweeping addresses; the one inside is per
    // address and stops a form being held down.
    const rl = limits.take(`ccode:${ipHash}`, 20, 3_600_000);
    if (!rl.ok) {
      return send(res, 429, { error: "rate_limited", message: "Too many requests. Try again later." },
                  { "Retry-After": String(rl.retryAfter) });
    }
    reply(res, await clientAccount.requestCode(body));
  },
  "POST /api/client/session": async (req, res, body, ipHash) => {
    const rl = limits.take(`csess:${ipHash}`, 30, 3_600_000);
    if (!rl.ok) {
      return send(res, 429, { error: "rate_limited", message: "Too many attempts. Try again later." },
                  { "Retry-After": String(rl.retryAfter) });
    }
    reply(res, await clientAccount.openSession(req, body, ipHash));
  },
  "POST /api/client/session/from-token": async (req, res, body, ipHash) =>
    reply(res, await clientAccount.openFromToken(req, body, ipHash)),
  "GET /api/client/me": async (req, res) => reply(res, await clientAccount.me(req)),
  "POST /api/client/checkin": async (req, res, body) => reply(res, await clientAccount.checkin(req, body)),
  "POST /api/client/review": async (req, res, body) => reply(res, await clientAccount.review(req, body)),
  "POST /api/client/weight": async (req, res, body) => reply(res, await clientAccount.weight(req, body)),
  "POST /api/client/note": async (req, res, body) => reply(res, await clientAccount.note(req, body)),
  "POST /api/client/logout": async (req, res) => reply(res, await clientAccount.logout(req)),

  /* ---- the CRM ---------------------------------------------
     Her back office. Every one of these returns PII with no
     filtering, so the login in front of /crm is the real gate —
     see crm/routes.js. */
  /* The picker's list. Public on purpose: it is the same 74 rows
     every visitor needs to fill in the booking form, it contains
     nothing about her practice, and putting it behind the CRM login
     would mean the front desk could not read its own country list. */
  "GET /api/countries": (req, res) => {
    send(res, 200, { countries: countries.list() });
  },

  /* ---- the door (items 5 & 6) ----------------------------
     These five are the only /api/crm/* routes that answer without
     a session, for the obvious reason. */
  "GET /api/crm/auth/me": async (req, res) => reply(res, await auth.state(req, "crm")),
  "GET /api/crm/auth/viewer": async (req, res) => reply(res, await auth.state(req, "viewer")),
  "POST /api/crm/auth/setup": async (req, res, body) => reply(res, await auth.setup(body)),
  "POST /api/crm/auth/login": async (req, res, body) => reply(res, await auth.login(req, body)),
  "POST /api/crm/auth/totp": async (req, res, body) => reply(res, await auth.totp(req, body)),
  "POST /api/crm/auth/enrol": async (req, res, body) => reply(res, await auth.enrol(req, body)),
  "POST /api/crm/auth/logout": (req, res, body) => reply(res, auth.logout(req, body)),

  /* ---- her assistant, the deterministic one (item 1) -----
     What needs her, derived from live state. No model. */
  "GET /api/crm/officer": (req, res) => crmRoute(res, officer.tasks()),

  /* ---- the master panel (item 13) -----------------------
     Counts, switches and recent turns. Behind the same door as
     everything else in /api/crm/*. */
  "GET /api/crm/bots": async (req, res) => {
    const [stats, switches, recent] = await Promise.all([
      data.crm.botStats(),
      data.crm.botSwitches(),
      data.crm.botTurns({ limit: 40 }),
    ]);
    send(res, 200, {
      // What the orchestrator itself believes, so the panel shows the
      // live breaker rather than a guess reconstructed from the log.
      registry: orchestrator.list(),
      breaker: orchestrator.breakerState(),
      stats: stats?.stats || [],
      reasons: stats?.reasons || {},
      switches: switches?.switches || [],
      turns: recent?.turns || [],
    });
  },

  "POST /api/crm/bots/switch": async (req, res, body) => {
    const bot = String(body?.bot || "");
    const enabled = !!body?.enabled;
    const out = await data.crm.botSwitch(bot, enabled);
    if (!out?.ok) return send(res, 400, { error: out?.error || "failed" });
    auth.record(req, "bot.switch", bot, null, { enabled });
    // Straight away, rather than waiting for the cache to expire —
    // a toggle that takes thirty seconds reads as a broken toggle.
    await orchestrator.refreshSwitches();
    send(res, 200, { ok: true });
  },

  /* ---- what happened after the booking ----
     done, rescheduled, cancelled, no-show. Recorded by her, audited
     like every other change she makes. */
  "GET /api/crm/outcomes": async (req, res) => {
    const [list, stats] = await Promise.all([
      data.crm.outcomes({ limit: 100 }),
      data.crm.outcomeStats(),
    ]);
    send(res, 200, { outcomes: list?.outcomes || [], counts: stats?.counts || {} });
  },

  /* The History page. `kind` filters to one of the four; anything
     else is ignored rather than refused, because a bad filter should
     show her everything, not an error. */
  "GET /api/crm/history": async (req, res) => {
    const kind = new URL(req.url, "http://x").searchParams.get("kind") || "";
    const allowed = ["done", "rescheduled", "cancelled", "no_show"];
    return crmRoute(res, crm.history(allowed.includes(kind) ? kind : ""));
  },

  /* The slot engine, for moving somebody. The SAME hours a visitor is
     offered — so a session cannot be moved onto an hour she is not
     working, or one already taken. */
  "GET /api/crm/free-slots": async (req, res) => {
    /* Each slot arrives carrying its own label — "Thursday 20 Aug ·
       16:00" — so moving somebody is a list of hours to tap, not a
       date picker she has to reason about. */
    const out = await data.crm.slots({ days: 21, limit: 40 });
    send(res, 200, { slots: out?.slots || [] });
  },

  /* ---- the opaque consultation link ----
     PUBLIC, and the only unauthenticated route that touches a
     consultation. It is opened from a WhatsApp message by somebody
     who has proved nothing, so it answers with the least it can:
     that a consultation exists, and when. No name, no email, no
     phone number, no reason for the visit, not even the booking's
     own id.

     Enumeration is not the risk — the token is 192 bits — but the
     limiter is here anyway so a leaked token cannot be used to
     hammer the database, and so this route cannot become a way to
     measure it. */
  /* ---- the client reading their plan ----
     PUBLIC, and the only unauthenticated route in this service that
     returns clinical text. Everything protecting it is in Go: the
     private note is never selected, a draft is never reachable, and
     every kind of failure answers 404 with the same body.

     Rate-limited like the consultation link, so this cannot become a
     way to test tokens at speed. */
  "GET /api/plan": async (req, res) => {
    const token = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) {
      return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    }

    const out = await data.crm.resolvePlanLink(token);
    if (!out?.ok) return send(res, 404, { ok: false, reason: "unknown" });

    send(res, 200, {
      ok: true,
      firstName: out.firstName,
      ref: out.ref,
      body: out.body,
      targets: out.targets || {},
      issuedAt: out.issuedAt,
    });
  },

  /* ============================================================
     THE CLIENT'S PROGRAMME — public, and it accepts writes
     ------------------------------------------------------------
     Everything else public in this system reads. These four take
     rows from somebody holding a string, which is why the guard
     rails are in Go rather than here: a known programme, a row of
     THEIR plan, a date within a fortnight, a weight inside human
     bounds. This layer adds the rate limit and the single vague
     answer for anything to do with the token itself.
     ============================================================ */
  "GET /api/programme": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    return crmRoute(res, programmes.resolve(t));
  },

  "GET /api/programme/media": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    return crmRoute(res, programmes.photos(t));
  },

  "GET /api/programme/days": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    return crmRoute(res, programmes.days(t));
  },

  "POST /api/programme/checkin": async (req, res, body) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    return crmRoute(res, programmes.checkin(t, body));
  },

  /* Something they wanted to say. Rate-limited like the other two
     writes — this one takes free text, so it is the one route where
     a limit is doing real work rather than being consistent. */
  "POST /api/programme/note": async (req, res, body) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    return crmRoute(res, programmes.note(t, body));
  },

  /* ASKING TO BE SEEN AGAIN. Rate-limited like the other writes,
     and the limit is doing real work here: this one puts a line on
     the page she works from, so a stuck finger costs her attention
     rather than a duplicate row in somebody's own record. Go also
     keeps it to one open request per person. */
  "POST /api/programme/review": async (req, res, body) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    return crmRoute(res, programmes.reviewAsk(t, body));
  },

  "GET /api/programme/review": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    return crmRoute(res, programmes.reviewState(t));
  },

  /* What the checkout page may show. Same shape as the other
     public reads: an opaque token in `t`, and an answer that
     contains no id anybody could walk. */
  "GET /api/checkout": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    return reply(res, asReply(await checkout.view(t)));
  },

  "GET /api/programme/weights": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    return crmRoute(res, programmes.weights(t));
  },

  "GET /api/programme/notes": async (req, res) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    return crmRoute(res, programmes.notes(t));
  },

  "POST /api/programme/weight": async (req, res, body) => {
    const t = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    return crmRoute(res, programmes.weight(t, body));
  },

  "GET /api/link": async (req, res) => {
    const token = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) {
      return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    }

    const out = await data.crm.resolveLink(token);
    if (!out?.ok) {
      /* One answer for "never existed" and for "expired". Telling
         them apart would let somebody holding a stale token learn it
         was once real, which is a fact about a client's appointment. */
      return send(res, 404, { ok: false, reason: "unknown" });
    }
    /* consultationId comes back from Go and STOPS HERE. The page
       needs to know there is a consultation and when; it has no
       business knowing which row it is.

       The first name goes through, and nothing else about them. It
       settles "is this mine" before somebody presses Join on a
       video call they were sent a link to — the same thing the plan
       link and the programme app already say. Listed field by field
       rather than spread, so a column added to the Go payload
       tomorrow cannot reach a browser by accident. */
    send(res, 200, {
      ok: true,
      firstName: out.firstName || "",
      startAt: out.startAt,
      status: out.status,
    });
  },

  /* ---- the trial prototype ----
     Off unless TRIAL_ENABLED=1, loopback only, and token-checked
     if TRIAL_TOKEN is set. These return real client names and dates
     of birth, so the gate is the whole point rather than a
     formality — see services/node-bff/trial/index.js. */
  "GET /api/trial/people": async (req, res) => {
    const gate = trial.allowed(req, clientIp(req));
    if (!gate.ok) return send(res, 403, { error: "trial_closed", message: gate.why });
    send(res, 200, await trial.people());
  },

  "GET /api/trial/room": (req, res) => {
    const gate = trial.allowed(req, clientIp(req));
    if (!gate.ok) return send(res, 403, { error: "trial_closed", message: gate.why });
    const q = new URL(req.url, "http://x").searchParams;
    // Held open. Nothing after this writes a normal response.
    trial.stream(req, res, q.get("room") || "trial", q.get("who") || "guest", {
      userAgent: req.headers["user-agent"] || "",
      ipHash: limits.hashIp(clientIp(req)),
    });
  },

  "POST /api/trial/room": (req, res, body) => {
    const gate = trial.allowed(req, clientIp(req));
    if (!gate.ok) return send(res, 403, { error: "trial_closed", message: gate.why });
    const q = new URL(req.url, "http://x").searchParams;
    send(res, 200, trial.post(q.get("room") || "trial", body));
  },

  /* What the room actually did — for looking at after a trial run. */
  "GET /api/trial/sessions": async (req, res) => {
    const gate = trial.allowed(req, clientIp(req));
    if (!gate.ok) return send(res, 403, { error: "trial_closed", message: gate.why });
    send(res, 200, await trial.sessions());
  },

  /* ---- the consulting room ----
     Session-gated by the guard above, so the side is established by
     her cookie rather than by a query parameter. That is what makes
     "only the practitioner may start it" a rule instead of a
     convention — the client's own door is separate and carries a
     token, not a session. */
  "GET /api/crm/room": (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    const id = q.get("room") || "";
    if (!id) return send(res, 400, { error: "no_room" });
    // Held open. Nothing after this writes a normal response.
    roomHub.stream(req, res, id, "host", {
      consultationId: id,
      userAgent: req.headers["user-agent"] || "",
      ipHash: limits.hashIp(clientIp(req)),
    });
  },

  "POST /api/crm/room": (req, res, body) => {
    const q = new URL(req.url, "http://x").searchParams;
    const id = q.get("room") || "";
    if (!id) return send(res, 400, { error: "no_room" });
    send(res, 200, roomHub.post(id, "host", { ...body, by: auth.current(req)?.email || "khadija" }));
  },

  /* The client's way in, for her to hand over.
   *
   * MINT-OR-RETURN, so asking twice hands back the same token — the
   * same call the WhatsApp and email senders make. One link per
   * consultation is the whole point: a client holding two URLs has
   * no way to tell which one is real.
   *
   * SESSION-GATED, and it is the only place a token is ever shown to
   * anybody. That is not a contradiction of "the link never appears
   * in the page" — the rule is about the PUBLIC site, where a token
   * in the markup would be readable by whoever found the page. Here
   * it is behind her cookie, and she is the person whose job is to
   * send it.
   *
   * The full URL is built here rather than in the browser, because
   * the public origin is a deployment fact and the CRM should not be
   * guessing it from location.host — on this box that would produce
   * a localhost link she then mails to somebody. */
  "POST /api/crm/consultation-link": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    const id = q.get("id") || "";
    if (!id) return send(res, 400, { error: "no_consultation" });

    const minted = await data.crm.mintLink(id).catch(() => null);
    if (!minted?.ok) return send(res, 502, { error: "not_minted" });

    const base = publicBase();
    send(res, 200, {
      ok: true,
      url: `${base}/c/${minted.token}`,
      expiresAt: minted.expiresAt || null,
    });
  },

  /* ---- the assessment record ----
     Session-gated by the guard above, like everything under
     /api/crm/. `by` is taken from the signed-in session rather than
     the request body — who wrote a clinical note is not something
     the browser gets to assert. */
  "GET /api/crm/assessments": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, assessments.list(q.get("personId") || ""));
  },

  "GET /api/crm/assessment": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, assessments.one(q.get("id") || ""));
  },

  "POST /api/crm/assessments": async (req, res, body) =>
    crmRoute(res, assessments.open(body, auth.current(req)?.email)),

  /* ---- the care plan ----
     The same shape and the same gate. Authorship comes from the
     cookie here too: a plan carries her name to the client, and the
     browser does not get to put it there. */
  "GET /api/crm/plans": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, plans.list(q.get("personId") || ""));
  },

  "GET /api/crm/plan": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, plans.one(q.get("id") || ""));
  },

  "POST /api/crm/plans": async (req, res, body) =>
    crmRoute(res, plans.open(body, auth.current(req)?.email)),

  "GET /api/crm/plan-items": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, plans.items(q.get("planId") || ""));
  },

  /* How often the assistant reads her writing correctly. The whole
     justification for letting it near this at all. */
  "GET /api/crm/plan-accuracy": async (req, res) => crmRoute(res, plans.accuracy()),

  "GET /api/crm/programmes": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, programmes.list(q.get("personId") || ""));
  },

  "GET /api/crm/media": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, programmes.herPhotos(q.get("programmeId") || ""));
  },

  "GET /api/crm/adherence": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, programmes.adherence(q.get("programmeId") || "", Number(q.get("days")) || 28));
  },

  /* The monitor — the days themselves, and the weights the app sent.
     Behind her session like everything else under /api/crm, and keyed
     by programme id: the client's token stays with the client. */
  "GET /api/crm/programme-days": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, programmes.monitorDays(q.get("programmeId") || "", Number(q.get("days")) || 35));
  },

  "GET /api/crm/programme-weights": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, programmes.monitorWeights(q.get("programmeId") || ""));
  },

  /* Reading them marks them read, in Go, in the same request. */
  "GET /api/crm/programme-notes": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, programmes.monitorNotes(q.get("programmeId") || ""));
  },

  /* ============================================================
     THE CLIENT'S DOOR INTO THE ROOM
     ------------------------------------------------------------
     Not /api/crm/* and deliberately not session-gated — the person
     joining has no account and never will. Their key is the opaque
     token from the message she sent them.

     THE TOKEN IS EXCHANGED FOR THE ROOM ON THE SERVER. The browser
     sends a token and is never told what it resolves to; the
     consultation id stays in this process. A client who cannot
     name the room cannot ask to join a different one.

     Their side is fixed as "client" here rather than read from the
     request, which is what makes "only the practitioner may start
     it" hold — see services/node-bff/room/index.js.
     ============================================================ */
  "GET /api/room": async (req, res) => {
    const token = new URL(req.url, "http://x").searchParams.get("t") || "";
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) {
      return send(res, 429, { error: "busy" }, { "Retry-After": String(rl.retryAfter) });
    }

    const link = await data.crm.resolveLink(token);
    if (!link?.ok || !link.consultationId) {
      return send(res, 404, { error: "unknown", message: "That link is no longer active." });
    }

    // Held open. Nothing after this writes a normal response.
    roomHub.stream(req, res, link.consultationId, "client", {
      consultationId: link.consultationId,
      userAgent: req.headers["user-agent"] || "",
      ipHash: limits.hashIp(clientIp(req)),
    });
  },

  "POST /api/room": async (req, res, body) => {
    const token = new URL(req.url, "http://x").searchParams.get("t") || "";
    const link = await data.crm.resolveLink(token);
    if (!link?.ok || !link.consultationId) {
      return send(res, 404, { error: "unknown" });
    }
    /* "client", always. A start or an end arriving here is refused
       by the hub because of this line, not because the page lacks
       a button. */
    send(res, 200, roomHub.post(link.consultationId, "client", body));
  },

  /* What they thought, from the page they were just on. Token-gated
     like the room itself, and the consultation id is resolved here
     rather than accepted from the body — otherwise anybody could
     leave a review on anybody's appointment. */
  "POST /api/room/rating": async (req, res, body) => {
    const token = new URL(req.url, "http://x").searchParams.get("t") || "";
    const link = await data.crm.resolveLink(token);
    if (!link?.ok || !link.consultationId) return send(res, 404, { error: "unknown" });

    await data.crm.rating({
      consultationId: link.consultationId,
      stars: Number(body?.stars) || null,
      comment: String(body?.comment || "").slice(0, 2000),
    }).catch(() => null);

    // Thanked either way. Somebody who has just given an opinion is
    // not the person to show a storage error to.
    send(res, 200, { ok: true });
  },

  "GET /api/crm/payments": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, crm.payments({ days: q.get("days") || "", limit: q.get("limit") || "" }));
  },

  "GET /api/crm/audit": async (req, res) => {
    const out = await data.crm.auditList({ limit: 100 });
    send(res, 200, { entries: out?.entries || [] });
  },

  "GET /api/crm/overview": (req, res) => crmRoute(res, crm.overview()),
  "GET /api/crm/requests": (req, res) => crmRoute(res, crm.requests()),
  "GET /api/crm/today": (req, res) => crmRoute(res, crm.today()),
  "GET /api/crm/upcoming": (req, res) => crmRoute(res, crm.upcoming()),
  "GET /api/crm/people": (req, res) => crmRoute(res, crm.people()),
  "GET /api/crm/messages": (req, res) => crmRoute(res, crm.messages()),
  "GET /api/crm/hours": (req, res) => crmRoute(res, crm.hours()),
  "GET /api/crm/settings": (req, res) => crmRoute(res, crm.settings()),

  /* One month at a time, named explicitly rather than inferred from
     "now" — the page can look back at March without the server
     having an opinion about which month is interesting. */
  "GET /api/crm/calendar": (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    return crmRoute(res, crm.calendar(q.get("from") || "", q.get("to") || ""));
  },
  "GET /api/crm/countries": (req, res) => crmRoute(res, crm.countries()),

  /* Editing her week. These change what visitors can book from the
     next request onward, with no deploy in the loop. */
  /* Asked as she picks, so Add can be greyed out rather than
     clickable-then-refused. */
  "GET /api/crm/hours/clash": async (req, res) => {
    const q = new URL(req.url, "http://x").searchParams;
    const out = await data.crm.hoursClash({
      weekdays: q.get("weekdays") || "",
      startsMin: q.get("startsMin") || "0",
      endsMin: q.get("endsMin") || "0",
    });
    send(res, 200, { clashes: out?.clashes || [] });
  },

  "POST /api/crm/hours/rules": (req, res, body) => {
    auth.record(req, "hours.add", describeBand(body), null, body);
    return crmRoute(res, crm.addBands(body));
  },
  "POST /api/crm/hours/exceptions": (req, res, body) => {
    auth.record(req, "hours.exception.add", String(body?.date || ""), null, body);
    return crmRoute(res, crm.addException(body));
  },

  /* Her assistant. Read-only: it summarises and drafts, and nothing
     here writes or sends. The model never sees the database — the
     facts are gathered in crm/assistant.js and passed in whole. */
  "GET /api/crm/assist": (req, res) => crmRoute(res, assistant.briefing()),
  "POST /api/crm/assist/ask": (req, res, body) => crmRoute(res, assistant.ask(body.question)),

  /* What the desk says, and how it recognises what was asked. */
  "GET /api/crm/knowledge": (req, res) => crmRoute(res, crm.knowledge()),
  "POST /api/crm/knowledge": (req, res, body) => {
    auth.record(req, "knowledge.topic.add", String(body?.label || ""), null, body);
    return crmRoute(res, crm.addTopic(body));
  },
  "POST /api/crm/phrasings": (req, res, body) => crmRoute(res, crm.addPhrasing(body)),

  /* ---- database viewer -------------------------------------
     Read-only. Go validates the table name against the catalog,
     so nothing here needs to know the schema.

     THIS RETURNS EVERY PIECE OF PII IN THE SYSTEM — names,
     emails, dates of birth, what people are unwell with. It is
     rate-limited like anything else, but the real protection has
     to be the login in front of /crm in production. Do not
     expose this route publicly. */
  "GET /api/db/tables": async (req, res, body, ipHash) => {
    const rl = limits.take(`db:${ipHash}`, 120, 3_600_000);
    if (!rl.ok) return send(res, 429, { error: "rate_limited" }, { "Retry-After": String(rl.retryAfter) });

    const out = await data.dbTables();
    if (!out || !out.ok) return send(res, 503, { error: "data_unavailable" });
    send(res, 200, { tables: out.tables || [] });
  },

  "GET /api/db/rows": async (req, res, body, ipHash) => {
    const rl = limits.take(`db:${ipHash}`, 120, 3_600_000);
    if (!rl.ok) return send(res, 429, { error: "rate_limited" }, { "Retry-After": String(rl.retryAfter) });

    const q = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const out = await data.dbRows({
      schema: q.get("schema"),
      table: q.get("table"),
      limit: q.get("limit"),
      offset: q.get("offset"),
    });
    if (!out) return send(res, 503, { error: "data_unavailable" });
    if (!out.ok) return send(res, out.status || 404, { error: out.error || "not_found" });
    send(res, 200, out);
  },

  /* ============================================================
     HEALTH — PUBLIC, AND THEREFORE THIN
     ------------------------------------------------------------
     This route has no session in front of it, deliberately: a
     monitor that has to log in is a monitor nobody sets up, and
     "is it up" must be answerable when everything else is not.

     WHICH MEANS IT MUST SAY ALMOST NOTHING. It used to return
     `data.health()` whole, and that carried
     "database":"127.0.0.1:5432/myf_trial" — the host, the port and
     the schema name, published to anyone who asked. None of that
     helps a monitor and all of it helps somebody mapping the
     estate before trying anything. The model name went out the
     same way.

     So each upstream is reduced to a boolean and a number here.
     The full readings are still available to her, behind the
     session, at /api/crm/health — see below. */
  "GET /api/health": async (req, res) => {
    const [aiHealth, dataHealth] = await Promise.all([ai.health(), data.health()]);
    send(res, 200, {
      ok: true,
      service: "node-bff",
      uptimeSec: Math.round(process.uptime()),
      /* Up or not, and how quickly. A monitor needs the first and
         graphs the second; neither needs to know where it lives. */
      ai: { ok: !!aiHealth?.ok },
      data: { ok: !!dataHealth?.ok, pingMs: dataHealth?.pingMs ?? null },
      upstream: config.upstream.url ? "configured" : "dry-run",
    });
  },

  /* The same readings, whole, for somebody signed in. Session
     counts and rate-limiter sizes moved here too: they are useful
     when something is wrong and they are also a live measure of
     how much traffic this practice gets, which is nobody else's
     business. */
  "GET /api/crm/health": async (req, res) => {
    const [aiHealth, dataHealth] = await Promise.all([ai.health(), data.health()]);
    send(res, 200, {
      ok: true,
      service: "node-bff",
      uptimeSec: Math.round(process.uptime()),
      ai: aiHealth,
      data: dataHealth,
      upstream: config.upstream.url ? "configured" : "dry-run",
      ...session.stats(),
      rateBuckets: limits.size(),
    });
  },
};

/* ---- server -------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) return;

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const path = req.url.split("?")[0].replace(/\/$/, "") || "/";

  /* ---- the gateway's webhook, before anything parses -----------
     Razorpay signs the RAW BYTES of the body. Reading it as JSON
     and re-serialising changes them — key order, spacing, unicode
     escapes — and the signature stops matching for reasons that
     look like a broken secret. So this route is handled here,
     ahead of readJson, and gets the buffer exactly as it arrived.

     No session: it is called by Razorpay, not by a browser. The
     signature IS the authentication, which is why the handler
     verifies before it believes a single field. */
  if (req.method === "POST" && path === "/api/pay/webhook") {
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 1 << 20) { res.writeHead(413).end(); return; }
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const out = await checkout.webhook(raw, req.headers["x-razorpay-signature"] || "");
      return send(res, out.status || 200, out);
    } catch {
      return send(res, 400, { ok: false, error: "bad_webhook" });
    }
  }

  /* The door, before anything else looks at the request. Checked
     here rather than inside each handler so a route added tomorrow
     is guarded by default — the failure mode of the alternative is
     one forgotten line exposing every client record. */
  if (needsSession(req.method, path) && !auth.current(req, "crm")) {
    return send(res, 401, { error: "sign_in", message: "Sign in to continue." });
  }

  if (needsViewer(path) && !auth.current(req, "viewer")) {
    return send(res, 401, {
      error: "sign_in_viewer",
      message: "The raw tables have their own sign-in.",
    });
  }

  /* ============================================================
     THE THREE ROUTES THAT ARE NOT JSON
     ------------------------------------------------------------
     Handled here, above the dispatcher, because everything below
     reads the body with readJson — and a photograph is neither
     small enough nor text. Kept together so it is obvious that
     these are the only three, and that two of them return bytes.
     ============================================================ */

  /* A CLIENT'S PHOTOGRAPH, from the account panel. Raw image bytes
     as the body, like the token app's — the difference is only who
     is asking: a session cookie here, a token in the URL there.

     Handled before the JSON router because the body is not JSON,
     and reading it as JSON would consume the stream and leave the
     bytes unrecoverable. */
  if (req.method === "POST" && path === "/api/client/photo") {
    const q = new URL(req.url, "http://x").searchParams;
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) {
      return send(res, 429, { error: "rate_limited" }, { "Retry-After": String(rl.retryAfter) });
    }
    let buf;
    try {
      buf = await readBytes(req, storage.MAX_BYTES);
    } catch {
      return send(res, 413, { error: "too_large", message: "That photo is too large." });
    }
    return reply(
      res,
      await clientAccount.media(req, buf, q.get("checkin") || "", q.get("taken") || null)
    );
  }

  // A photograph arriving. Raw image bytes, sent as the body.
  if (req.method === "POST" && path === "/api/programme/photo") {
    const q = new URL(req.url, "http://x").searchParams;
    const rl = limits.perIpSession(limits.hashIp(clientIp(req)), clientIp(req));
    if (!rl.ok) {
      return send(res, 429, { ok: false, reason: "busy" }, { "Retry-After": String(rl.retryAfter) });
    }
    let buf;
    try {
      buf = await readBytes(req, storage.MAX_BYTES);
    } catch {
      return send(res, 413, { ok: false, reason: "too_large", message: "That photo is too large." });
    }
    return crmRoute(
      res,
      programmes.photo(q.get("t") || "", q.get("checkin") || "", buf, q.get("taken") || null)
    );
  }

  // A photograph going back to the client who sent it.
  if (req.method === "GET" && path === "/api/programme/photo") {
    const q = new URL(req.url, "http://x").searchParams;
    const got = await programmes.clientPhotoBytes(q.get("t") || "", q.get("id") || "");
    if (!got) return send(res, 404, { ok: false, reason: "unknown" });
    return sendImage(res, got.mime, got.body);
  }

  /* And going to her. Under /api/crm/, so the session guard above has
     already run — which is the only reason this line is safe. */
  if (req.method === "GET" && path === "/api/crm/photo") {
    const q = new URL(req.url, "http://x").searchParams;
    const got = await programmes.herPhotoBytes(q.get("id") || "");
    if (!got) return send(res, 404, { error: "not_found" });
    return sendImage(res, got.mime, got.body);
  }

  const handler = routes[`${req.method} ${path}`];

  /* Everything below is inside ONE try, including the id-in-path
     matching. It used to sit above the try, so a throw there was
     unhandled and took the whole process down with it — a bad PATCH
     killed the desk rather than returning a 500. Any route that can
     run code belongs where the error handler can see it. */
  try {
    // PATCH carries a body too. Reading it only for POST is what left
    // `body` undefined in the matching below.
    const body =
      req.method === "POST" || req.method === "PATCH" ? await readJson(req) : {};

    if (!handler) {
      const dynamic =
        req.method === "POST"
          ? CRM_ACTIONS
          : req.method === "DELETE"
          ? CRM_DELETES
          : req.method === "PATCH"
          ? CRM_PATCHES
          : [];

      for (const { re, run, log } of dynamic) {
        const m = re.exec(path);
        if (m) {
          /* Recorded before the call, not after. An action that fails
             halfway is exactly the one worth having a line about, and
             "it was attempted" is a more useful record than silence. */
          if (log) auth.record(req, log, m[1], null, body && Object.keys(body).length ? body : null);
          /* `req` goes through so an action can name the person taking
             it. Recording an outcome writes WHO said so into the row
             itself, and reading it off the signed-in session is the
             only way that name can be trusted. */
          return await crmRoute(res, run(m[1], body, req));
        }
      }

      if (req.method === "POST") {
        const m = /^\/api\/crm\/unrecognised\/([\w-]{1,64})\/done$/.exec(path);
        if (m) return await crmRoute(res, crm.missedDone(m[1]));

        const d = /^\/api\/crm\/assist\/draft\/([\w-]{1,64})$/.exec(path);
        if (d) return await crmRoute(res, assistant.draft(d[1]));
      }

      return send(res, 404, { error: "not_found" });
    }

    const ipHash = limits.hashIp(clientIp(req));
    await handler(req, res, body, ipHash);
  } catch (err) {
    if (res.headersSent) return;
    const status = err.status || 500;
    if (status >= 500) console.error("[bff]", req.method, path, err);
    send(res, status, {
      error: status >= 500 ? "internal_error" : err.message,
      message:
        status >= 500
          ? "Something went wrong at my end."
          : err.message,
    });
  }
});

// Sessions and rate buckets both age out on the same timer. unref()
// so this never holds the process open on shutdown.
setInterval(() => {
  session.sweep();
  limits.sweep();
}, config.session.sweepMs).unref();

if (require.main === module) {
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[bff] front desk on http://127.0.0.1:${config.port}`);
    console.log(`[bff] ai: ${config.ai.enabled ? config.ai.url : "disabled"}`);
    console.log(
      `[bff] bookings: ${config.upstream.url || "DRY RUN (set APPOINTMENTS_API_URL to send for real)"}`
    );
    console.log(`[bff] hours: ${config.practice.hoursText}`);
    /* Said out loud at boot, because "is this thing actually emailing
       real clients right now?" must never be a question anybody has
       to read code to answer. */
    console.log(`[bff] ${require("./mail").describe()}`);
    console.log(`[bff] ${require("./whatsapp").describe()}`);
    console.log(`[bff] ${require("./plan-ai").describe()}`);
    console.log(`[bff] ${require("./rules/budget").describe()}`);
    console.log(`[bff] ${storage.describe()}`);

    /* WHERE EVERY LINK WILL POINT. Said out loud for the same
       reason the mail provider is: "will this address work when I
       paste it into WhatsApp" must never be a question anybody has
       to read code to answer. Until PUBLIC_BASE_URL is set, it is
       this machine — which is correct while this machine is where
       the system runs. */
    console.log(`[bff] ${describeBase()}`);

    /* Load the answers she has written before the first visitor
       arrives. Deliberately not awaited by the listen callback — a
       slow database must delay nothing, and flow.js keeps built-in
       answers as a floor if this never lands. */
    knowledge.prime().then((ok) => {
      if (ok) console.log(`[bff] knowledge base: ${knowledge.size} answers loaded`);
    });

    /* The country list, for the same reason and on the same terms.
       Until it lands the desk accepts any country rather than
       telling somebody theirs does not exist. */
    countries.prime().then((ok) => {
      if (ok) console.log(`[bff] countries: ${countries.list().length} loaded`);
    });
  });
}

module.exports = { server };
