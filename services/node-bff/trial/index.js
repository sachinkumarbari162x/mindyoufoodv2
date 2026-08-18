/* ============================================================
   TRIAL — the prototype's own back end
   ------------------------------------------------------------
   Everything in here serves trial/, and nothing in here is part
   of the system. It exists so the assessment record and the
   consultation room can be judged with real-looking data before
   either is committed to a schema.

   IT REFUSES TO RUN ANYWHERE BUT LOOPBACK. The trial pages have
   no login, and the people endpoint returns real names, dates of
   birth and phone numbers. On a public interface that would be a
   client list served to strangers, so the gate is not a
   convenience — see `allowed` below.
   ============================================================ */
"use strict";

const crypto = require("node:crypto");
const data = require("../data-client");

/* ---- who may reach the trial at all ----------------------------
   Loopback, plus a token if one is configured. Both, not either:
   the token stops another user on the same machine wandering in,
   and the loopback check stops the whole thing existing publicly.

   TRIAL_ENABLED must be set to turn any of it on. A prototype that
   is off by default cannot be left on by accident. */
function allowed(req, ip) {
  if (process.env.TRIAL_ENABLED !== "1") return { ok: false, why: "trial is off" };

  const loopback =
    ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
  if (!loopback) return { ok: false, why: "trial is loopback only" };

  const want = (process.env.TRIAL_TOKEN || "").trim();
  if (want) {
    const got = new URL(req.url, "http://x").searchParams.get("k") || "";
    // Constant-time, because it is a secret comparison and doing it
    // the lazy way here would be a bad habit to keep.
    const a = Buffer.from(got.padEnd(want.length).slice(0, want.length));
    const b = Buffer.from(want);
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, why: "wrong trial token" };
  }

  return { ok: true };
}

/* ============================================================
   TEST CLIENTS
   ------------------------------------------------------------
   Invented, and obviously so — the names are not close to real
   ones and the addresses are all on example.test, which cannot
   receive mail. They exist to exercise the form rather than to
   look plausible in a screenshot.

   Chosen to make the calculated fields do different things:
   two sexes, ages from 24 to 61, and a spread of countries so
   the dialling codes and timezones are not all identical.
   ============================================================ */
const TEST_CLIENTS = [
  {
    name: "Test · Meera Raghavan",
    email: "meera.test@example.test",
    dob: "1991-04-18",
    phone: "+919812345001",
    country: "IN",
    note: "PCOS, vegetarian, shift worker — the common case.",
  },
  {
    name: "Test · Arif Suleiman",
    email: "arif.test@example.test",
    dob: "1964-11-02",
    phone: "+971501230002",
    country: "AE",
    note: "61, type 2 diabetes, Gulf expat on an Indian number.",
  },
  {
    name: "Test · Divya Nair",
    email: "divya.test@example.test",
    dob: "2001-08-27",
    phone: "+919812345003",
    country: "IN",
    note: "24, athlete, high protein target.",
  },
  {
    name: "Test · Harpreet Gill",
    email: "harpreet.test@example.test",
    dob: "1978-01-09",
    phone: "+447700900004",
    country: "GB",
    note: "Hypothyroid, UK-based, weight regain after a previous diet.",
  },
  {
    name: "Test · Sana Qureshi",
    email: "sana.test@example.test",
    dob: "1996-06-30",
    phone: "+966501230005",
    country: "SA",
    note: "IBS, food intolerances, fasting practices to plan around.",
  },
  {
    name: "Test · Rohan Bhatt",
    email: "rohan.test@example.test",
    dob: "1985-03-14",
    phone: "+919812345006",
    country: "IN",
    note: "Hypertension, eats out most days, no cooking access.",
  },
];

/** Real people first, then the invented ones, each flagged so the
    interface can say which is which. Nobody should have to guess
    whether a name on screen belongs to a person. */
async function people() {
  const out = await data.crm.people().catch(() => null);

  const real = (out?.people || []).map((p) => ({
    name: p.name,
    email: p.email,
    dob: p.dob || null,
    phone: p.phone || null,
    country: p.country || null,
    real: true,
  }));

  const test = TEST_CLIENTS.map((p) => ({ ...p, real: false }));

  return { people: [...test, ...real], counts: { real: real.length, test: test.length } };
}

/* ============================================================
   SIGNALLING FOR THE TRIAL ROOM
   ------------------------------------------------------------
   Server-sent events downward, POST upward — the design the
   architecture doc argues for, built small so the argument can
   actually be checked rather than taken on trust.

   Rooms are in memory and vanish on restart, which is correct for
   a trial and would be wrong in the system: there, the state
   machine belongs in Postgres so a restart mid-consultation does
   not lose which side had started it.
   ============================================================ */
const rooms = new Map(); // id -> { state, peers: Map<who, res>, startedAt }

/* ---- and the half that is remembered ---------------------------
   THE SOCKETS STAY IN MEMORY; THE FACTS DO NOT. An open HTTP
   response is not a thing a database can hold, so the peer map
   above is unavoidably in this process. Everything else — who
   arrived, who started it, when it ended, and how the media
   travelled — is written to crm.room_sessions and
   crm.room_participants, where it survives a restart and can be
   counted afterwards.

   Every call is best-effort. A consultation must never fail
   because a bookkeeping write did. */
function remember(fn, ...args) {
  return data.crm[fn](...args).catch((err) => {
    console.warn(`[trial] room ${fn} not recorded: ${err.message}`);
    return null;
  });
}

function room(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { state: "waiting", peers: new Map(), startedAt: null });
  }
  return rooms.get(id);
}

/** Push one event to everybody in the room except, optionally, the
    sender — signalling is a conversation between two sides and an
    offer echoed back to its author is noise. */
function fanout(id, event, payload, except) {
  const r = rooms.get(id);
  if (!r) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [who, res] of r.peers) {
    if (who === except) continue;
    try { res.write(line); } catch { r.peers.delete(who); }
  }
}

/** GET — the client holds this open and the server writes to it. */
function stream(req, res, roomId, who, meta = {}) {
  const r = room(roomId);

  /* Recorded on arrival rather than on departure. A client who
     joins and is never seen again is exactly the case worth having
     a row for, and a write that only happens on a clean exit is a
     write that misses it. */
  if (who === "host" || who === "client") {
    remember("roomJoin", {
      room: roomId,
      side: who,
      userAgent: meta.userAgent || "",
      ipHash: meta.ipHash || "",
      source: "trial",
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    /* Nagle would sit on a 40-byte signalling message waiting for
       company, which is exactly the wrong trade for a handshake. */
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");

  /* ============================================================
     ONE SCREEN AT A TIME
     ------------------------------------------------------------
     A consultation link opened in two places is two of the same
     person in the room: two cameras, two microphones, and a
     negotiation between three parties that were designed as two.
     It is also how a forwarded link becomes somebody quietly
     sitting in on an appointment.

     NEWEST WINS, rather than refusing the second. Strict refusal
     reads better as a rule and fails badly in practice: a browser
     that crashed, a phone that slept, a train tunnel - each leaves
     a connection the server still believes in, and the real client
     is then locked out of their own appointment with no way back.
     Evicting the older one gives the same guarantee, only one
     screen live at any moment, and recovers by itself.

     The evicted screen is TOLD before it is closed. A frozen
     picture with no explanation is worse than a refusal.
     ============================================================ */
  const already = r.peers.get(who);
  if (already && already !== res) {
    try {
      already.write(`event: evicted\ndata: ${JSON.stringify({ who })}\n\n`);
      already.end();
    } catch { /* already gone, which is the same outcome */ }
    r.peers.delete(who);
  }

  r.peers.set(who, res);

  // Whoever just arrived needs the state as it already is, not as it
  // will be at the next transition.
  res.write(`event: state\ndata: ${JSON.stringify({ state: r.state, startedAt: r.startedAt })}\n\n`);
  fanout(roomId, "peer", { who, present: [...r.peers.keys()] });

  /* A comment every 25 seconds. Proxies and phone radios drop an
     idle connection well before a consultation is over. */
  const beat = setInterval(() => {
    try { res.write(": beat\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(beat);
    /* Only if this is still the live one. An evicted connection
       closing must not delete the screen that replaced it, which
       would leave the room believing nobody is there while somebody
       is looking straight at it. */
    if (r.peers.get(who) !== res) return;
    r.peers.delete(who);
    fanout(roomId, "peer", { who, left: true, present: [...r.peers.keys()] });
    if (who === "host" || who === "client") {
      remember("roomLeave", { room: roomId, side: who, connection: "" });
    }
  });
}

/** POST — an offer, an answer, a candidate, or a state change. */
function post(roomId, body) {
  const r = room(roomId);
  const kind = String(body?.kind || "");

  if (kind === "start" || kind === "end") {
    /* THE STATE MACHINE IS THE SERVER'S. In the real system this
       checks her session; here it checks the claimed side, which is
       enough to demonstrate that the client cannot start a room by
       asking nicely. */
    if (body.who !== "host") return { ok: false, error: "only the host may do that" };
    r.state = kind === "start" ? "live" : "ended";
    r.startedAt = kind === "start" ? new Date().toISOString() : r.startedAt;
    fanout(roomId, "state", { state: r.state, startedAt: r.startedAt });
    remember("roomState", { room: roomId, state: r.state, by: body.by || "host" });
    return { ok: true, state: r.state };
  }

  /* HOW IT TRAVELLED. Reported by the browser once the connection
     settles, because only the browser can see whether the chosen
     candidate pair went direct or through a relay. This is the
     count that turns "roughly one call in seven needs TURN" from an
     estimate into a measurement. */
  if (kind === "connection") {
    remember("roomLeave", {
      room: roomId,
      side: body.who,
      connection: String(body.connection || ""),
    });
    return { ok: true };
  }

  if (["offer", "answer", "candidate", "chat"].includes(kind)) {
    fanout(roomId, kind, body, body.who);
    return { ok: true };
  }

  return { ok: false, error: "unknown kind" };
}

/** What has happened lately, for the trial's own inspection. */
async function sessions() {
  const out = await data.crm.rooms({ limit: 50 }).catch(() => null);
  return { sessions: out?.sessions || [] };
}

module.exports = { allowed, people, stream, post, sessions, TEST_CLIENTS };
