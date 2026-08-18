/* ============================================================
   NODE BFF · CONFIGURATION
   Every tunable in one place, all env-overridable, all with a
   working local default — the site must run with `node run.js`
   and no .env at all (see build-local-first). Deploy specifics
   belong in the environment, never in this file.
   ============================================================ */
"use strict";

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

/** "2026-10-20:Diwali, 2026-12-25" → dates plus the reasons that were given.
    The reason is optional per entry; an unnamed closure is still a closure. */
function parseClosedDates(raw) {
  const dates = [];
  const names = {};
  for (const entry of String(raw || "").split(",")) {
    const [date, ...rest] = entry.split(":");
    const d = date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    dates.push(d);
    const name = rest.join(":").trim();
    if (name) names[d] = name;
  }
  return { dates, names };
}

const closedDates = parseClosedDates(process.env.PRACTICE_CLOSED_DATES);

const config = {
  port: num(process.env.BFF_PORT, 5502),

  /* ---- the AI service ----
     If it is unreachable the desk does NOT go down: the rule engine
     drives a scripted flow instead. Booking is the job; the LLM is
     the pleasant way through it, not a dependency of it. */
  ai: {
    url: process.env.AI_SERVICE_URL || "http://127.0.0.1:5503",
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 12000),
    enabled: bool(process.env.AI_ENABLED, true),
  },

  /* ---- the existing appointments backend ----
     POST {url}/appointments — the same hardened public endpoint the
     v1 form posts to. The receptionist is a new front door onto the
     unchanged contract, not a second booking system. */
  upstream: {
    url: process.env.APPOINTMENTS_API_URL || "",
    timeoutMs: num(process.env.APPOINTMENTS_TIMEOUT_MS, 15000),
    // With no URL configured the BFF runs in dry-run: it validates and
    // returns a reference, and logs the payload it *would* have sent.
    // That is the default so local work never emails the practitioner.
    source: process.env.APPOINTMENTS_SOURCE || "website-receptionist",
  },

  /* ---- practice hours ----
     The single source of truth for "are we open" and "is that slot
     valid". The client renders these; it never computes them, and it
     never uses the visitor's own clock to decide. */
  practice: {
    timezone: process.env.PRACTICE_TZ || "Asia/Kolkata",
    // 0 = Sunday. Minutes from midnight, local to the practice.
    hours: {
      0: null,
      1: [600, 1140],
      2: [600, 1140],
      3: [600, 1140],
      4: [600, 1140],
      5: [600, 1140],
      6: [600, 1020],
    },
    hoursText: "Mon–Fri 10:00–19:00 · Sat 10:00–17:00 · Sun closed (IST)",
    // Closures the practitioner has already committed to. Either a bare
    // `YYYY-MM-DD`, or `YYYY-MM-DD:Reason` so the desk can say WHY it is
    // shut — "closed for Diwali" is a different sentence to "closed".
    closedDates: closedDates.dates,
    closedDateNames: closedDates.names,
    minLeadHours: num(process.env.MIN_LEAD_HOURS, 12),
    maxHorizonDays: num(process.env.MAX_HORIZON_DAYS, 60),
    maxSlots: 3,
    minSlots: 1,

    /* ---- the consultation itself ----
       Settled 2026-08-12. These three decide the shape of every slot the
       booking engine will ever offer, so they live here rather than being
       implied by whatever the calendar happens to look like. */
    consultMinutes: num(process.env.CONSULT_MINUTES, 60),
    bufferMinutes: num(process.env.CONSULT_BUFFER_MINUTES, 0),
    maxPerDay: num(process.env.CONSULT_MAX_PER_DAY, 3),
    replyWindow: "one working day",
    contactEmail: process.env.PRACTICE_EMAIL || "khadija@mindyourfood.co.in",

    /* WHO THE EMAIL IS FROM, in words. Both appear in every message
       the system sends — the name in the inbox line ("Khadija" rather
       than a bare address, which is the cheapest thing that makes
       mail look like it came from a practice) and both in the
       signature. Here rather than in the templates so two emails can
       never sign off differently. */
    name: process.env.PRACTICE_NAME || "Mind Your Food",
    dietitian: process.env.PRACTICE_DIETITIAN || "Khadija",
  },

  /* ---- sessions ---- */
  session: {
    ttlMs: num(process.env.SESSION_TTL_MS, 45 * 60 * 1000),
    maxTurns: num(process.env.SESSION_MAX_TURNS, 60),
    maxPerIp: num(process.env.SESSION_MAX_PER_IP, 12),
    sweepMs: 60 * 1000,
    // Hard ceiling on live sessions. An in-memory store on a 512 MB
    // Lightsail box needs a bound it cannot be argued out of.
    maxTotal: num(process.env.SESSION_MAX_TOTAL, 5000),
  },

  /* ---- limits ----
     Tuned like the upstream /appointments limiter: generous enough
     for a real person on a shared mobile NAT, tight enough that a
     script cannot mine the LLM. */
  limits: {
    messageChars: 800,
    messagesPerMinute: num(process.env.RL_MSG_PER_MIN, 20),
    messagesPerIpPer10Min: num(process.env.RL_MSG_PER_IP, 120),
    bookingsPerIpPerHour: num(process.env.RL_BOOKINGS_PER_IP, 5),
    sessionsPerIpPerHour: num(process.env.RL_SESSIONS_PER_IP, 20),
  },

  /* ---- privacy ----
     The transcript holds a name, an email, a phone number and health
     context. It is PII, it lives in memory only, and it is dropped
     the moment the booking lands or the session lapses. */
  privacy: {
    logTranscripts: bool(process.env.LOG_TRANSCRIPTS, false),
    ipSalt: process.env.IP_HASH_SALT || "dev-only-salt-change-me",
    policyVersion: process.env.POLICY_VERSION || "2026-08-11",
  },

  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

/* ============================================================
   WHERE A LINK POINTS
   ------------------------------------------------------------
   Every opaque link this system hands out — /c/ for a
   consultation, /p/ for a plan, /me/ for the daily programme —
   is built from this one string.

   IT WAS COPIED INTO FIVE FILES, each with the same fallback to
   the live domain, and that was the bug rather than the value:
   on a laptop every link came out as
   https://mindyourfood.co.in/p/<token>, which is not a page that
   exists yet. She would press "copy", paste it into a browser,
   and get somebody else's website. The token was fine; the host
   was a guess made in five places at once.

   THE DEFAULT IS NOW THIS MACHINE, because that is where the
   system is running until it is not. Production sets
   PUBLIC_BASE_URL and the boot line says which is in force, so
   the answer to "where will this link point" is never inferred
   from an environment variable somebody has to remember to check.

   THE FAILURE MODES ARE ASYMMETRIC and that is why the default
   went this way round. A production box that forgets the variable
   hands out localhost links — obviously broken, caught in the
   first minute, and the boot line says so in capitals. A laptop
   that forgets it hands out live-domain links, which look
   perfectly correct and silently do not work. Loud beats silent.
   ============================================================ */
const PORT = Number(process.env.SITE_PORT) || 5501;

function publicBase() {
  const set = (process.env.PUBLIC_BASE_URL || "").trim();
  if (set) return set.replace(/\/+$/, "");
  return `http://localhost:${PORT}`;
}

/** What the console should say at boot, so it is never a guess. */
function describeBase() {
  const set = (process.env.PUBLIC_BASE_URL || "").trim();
  if (set) return `links: ${publicBase()}`;
  if (process.env.NODE_ENV === "production") {
    return `links: ${publicBase()} — PUBLIC_BASE_URL IS NOT SET AND THIS IS PRODUCTION. ` +
      `Every link handed to a client points at this machine.`;
  }
  return `links: ${publicBase()} (set PUBLIC_BASE_URL for production)`;
}

module.exports = { config, publicBase, describeBase };
