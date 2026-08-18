/* ============================================================
   BUSINESS RULES · FIELD VALIDATION

   Mirrors backend/src/modules/appointments/appointments.schema.js.
   The upstream Zod schema stays the authority — this layer exists
   so the visitor is told about a bad email *in the conversation*,
   while they can still fix it, instead of at submit time when the
   chat has moved on.

   Anything that passes here must also pass upstream. When the two
   disagree, upstream wins and the desk reports its message.
   ============================================================ */
"use strict";

const countries = require("./countries");

const { config } = require("../config");

/* Focus areas are a closed set: they are what the practice
   actually treats, they map to the site's own copy, and they are
   what the practitioner filters her list by. Free text is still
   accepted — it lands in `notes` with the closest match chosen —
   because "my sugar is high" should not be a dead end. */
const FOCUS_AREAS = [
  { id: "pcos", label: "PCOS & hormonal health", match: /pcos|hormon|period|menstru|thyroid|fertilit|menopaus/i },
  { id: "diabetes", label: "Diabetes care", match: /diabet|blood ?sugar|glucose|hba1c|insulin|prediabet/i },
  { id: "gut", label: "Gut health", match: /gut|digest|ibs|bloat|constipat|acid|reflux|microbiom/i },
  { id: "weight", label: "Weight management", match: /weight|obes|fat ?loss|slim|lose|bmi|gain/i },
  { id: "sports", label: "Sports nutrition", match: /sport|athlet|gym|muscle|performance|train|marathon|protein ?goal/i },
  { id: "sustainable", label: "Sustainable transformation", match: /sustain|lifestyle|habit|long ?term|maintain/i },
];

/* How the consultation happens. Order matters: the first match wins,
   so "video call" must meet the video rule before it reaches audio.

   `call` used to live in the video pattern, which was fine when video
   was the only remote option — "call" then meant "not in person". With
   audio added it is ambiguous, and it was booking anyone who said
   "phone call" as a VIDEO call: she would dial a camera at somebody
   expecting the telephone. Bare "call" now matches nothing and the
   desk asks again, which is the honest answer to a genuinely
   ambiguous word.

   Kept in step with the database by hand — 0001_scheduling.sql has the
   matching CHECK. They disagreed once already: `audio` was legal in
   Postgres and unknown here, so the desk quietly recorded the wrong
   mode for anyone who asked for a phone consultation. */
const MODES = [
  { id: "video", label: "Video call", match: /video|zoom|online|virtual|remote|face ?time|meet/i },
  { id: "audio", label: "Phone call", match: /audio|phone|voice|telephone|call me|over the phone/i },
  { id: "in_person", label: "In person", match: /in.?person|clinic|visit|offline|face to face|physical/i },
  { id: "undecided", label: "Undecided", match: /undecided|either|not sure|whichever|don'?t mind|any/i },
];

/* Per-country mobile digit counts, carried over from the v1 form's
   phone check. Kept short on purpose: a wrong length is a typo, and
   a country we do not list is accepted on the generic 6–15 rule
   rather than rejected. */
const PHONE_DIGITS = {
  "+91": [10], "+1": [10], "+44": [10, 11], "+971": [9], "+61": [9],
  "+65": [8], "+966": [9], "+974": [8], "+968": [8], "+973": [8],
  "+49": [10, 11], "+33": [9], "+27": [9], "+60": [9, 10], "+92": [10],
  "+880": [10], "+94": [9], "+977": [10],
};

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

function name(raw) {
  const v = clean(raw);
  if (v.length < 2) return { ok: false, message: "I didn't catch a name there — what should I call you?" };
  if (v.length > 120) return { ok: false, message: "That name is longer than the form allows." };
  // A URL or an email in the name field is a bot, or a confused paste.
  if (/https?:|@|\bwww\./i.test(v)) {
    return { ok: false, message: "That looks like a link rather than a name — just your first name is fine." };
  }
  if (!/[\p{L}]/u.test(v)) return { ok: false, message: "Could you write your name in letters for me?" };
  return { ok: true, value: v };
}

function email(raw) {
  const v = clean(raw).toLowerCase();
  if (!v) return { ok: false, message: "I'll need an email address to send the confirmation to." };
  if (v.length > 254) return { ok: false, message: "That email address is too long." };
  // Deliberately close to the Zod/HTML5 rule — not a full RFC parser.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    return { ok: false, message: `"${raw}" doesn't look like a complete email address — could you check it?` };
  }
  if (/\.(test|invalid|example|local)$/.test(v)) {
    return { ok: false, message: "That address won't receive mail — is there another one she can reach you on?" };
  }
  return { ok: true, value: v };
}

function phone(raw, dial) {
  const v = clean(raw);
  if (!v) return { ok: true, value: undefined }; // optional, per the upstream schema
  const digits = v.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) {
    return { ok: false, message: "That phone number doesn't look complete — could you send it again with the country code?" };
  }
  if (v.length > 20) return { ok: false, message: "That number is longer than the form allows." };

  const code = dial || (/^\+(\d{1,3})/.exec(v) || [])[0];
  const expected = code && PHONE_DIGITS[code];
  if (expected) {
    const local = digits.slice(code.replace("+", "").length);
    if (!expected.includes(local.length)) {
      return {
        ok: false,
        message: `A ${code} number should be ${expected.join(" or ")} digits after the code — I counted ${local.length}.`,
      };
    }
  }
  return { ok: true, value: v };
}

function focusArea(raw) {
  const v = clean(raw);
  if (!v) return { ok: false, message: "What would you like to work on?" };
  const hit = FOCUS_AREAS.find((f) => f.match.test(v) || f.label.toLowerCase() === v.toLowerCase());
  if (hit) return { ok: true, value: hit.label, id: hit.id, matched: true };
  if (v.length > 120) return { ok: false, message: "Could you put that a little more briefly?" };
  // Unmatched but plausible: keep the visitor's own words. The
  // practitioner would rather read "my sugar is high" than a
  // category the desk guessed at.
  return { ok: true, value: v, id: "other", matched: false };
}

function mode(raw) {
  const v = clean(raw);
  if (!v) return { ok: true, value: "undecided", label: "Undecided" };
  const hit = MODES.find((m) => m.match.test(v));
  return hit
    ? { ok: true, value: hit.id, label: hit.label }
    : { ok: true, value: "undecided", label: "Undecided" };
}

/* Date of birth.

   Accepts the ways people actually write it: 1995-06-12, 12/06/1995,
   12 June 1995, June 12 1995. Day-first for the slash form, matching
   the phone rules and the practice's location.

   NOTE: the upstream appointments schema has NO date-of-birth field.
   This is carried to the practitioner inside `notes` rather than by
   widening that contract — see booking.js. */
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function dob(raw, now) {
  const v = clean(raw);
  if (!v) return { ok: false, message: "What's your date of birth?" };

  let y, m, d;
  let hit;

  if ((hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v))) {
    [, y, m, d] = hit.map(Number);
  } else if ((hit = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(v))) {
    d = +hit[1]; m = +hit[2]; y = +hit[3];
    if (y < 100) y += y > 30 ? 1900 : 2000; // "95" → 1995, "05" → 2005
  } else if ((hit = /^(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s+(\d{4})$/i.exec(v))) {
    d = +hit[1]; m = MONTH_NAMES[hit[2].slice(0, 3).toLowerCase()]; y = +hit[3];
  } else if ((hit = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(v))) {
    m = MONTH_NAMES[hit[1].slice(0, 3).toLowerCase()]; d = +hit[2]; y = +hit[3];
  } else {
    return {
      ok: false,
      message: "I couldn't read that as a date — something like 12/06/1995 or 12 June 1995 works.",
    };
  }

  if (!m || m < 1 || m > 12 || !d || d < 1 || d > 31 || !y) {
    return { ok: false, message: "That date doesn't look right — could you check it?" };
  }

  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  // Catches 31 February and friends: the Date rolls over, so the parts
  // no longer match what was written.
  if (parsed.getUTCMonth() + 1 !== m || parsed.getUTCDate() !== d) {
    return { ok: false, message: `There's no ${d}/${m} — could you check that date?` };
  }

  const today = now || new Date();
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;

  if (age < 0 || y > today.getUTCFullYear()) {
    return { ok: false, message: "That date is in the future — could you check it?" };
  }
  if (age > 120) {
    return { ok: false, message: "That would make you over 120 — could you check the year?" };
  }

  /* Under-16s are a safeguarding matter, not a booking one. The desk
     does not take the appointment and does not keep the date; a parent
     or guardian has to make contact. This is a deliberate stop, the
     same shape as the emergency halt. */
  if (age < 16) {
    return {
      ok: false,
      minor: true,
      message:
        "Thank you for telling me. For anyone under 16 she needs a parent or guardian to get in " +
        `touch directly — please ask them to email ${config.practice.contactEmail} and she'll take ` +
        "it from there. I'm not able to take this booking myself.",
    };
  }

  return { ok: true, value: iso, age };
}

/* Country. Free text, because a dropdown of 200 entries is exactly the
   friction the form had — but normalised where it is obvious, so the
   practitioner is not reading "uae", "U.A.E." and "Emirates" as three
   different places. */
const COUNTRY_ALIASES = {
  india: "India", bharat: "India", in: "India",
  uae: "United Arab Emirates", "u.a.e": "United Arab Emirates",
  emirates: "United Arab Emirates", dubai: "United Arab Emirates",
  uk: "United Kingdom", "u.k": "United Kingdom", britain: "United Kingdom",
  england: "United Kingdom", scotland: "United Kingdom", wales: "United Kingdom",
  usa: "United States", us: "United States", "u.s": "United States",
  "u.s.a": "United States", america: "United States",
  ksa: "Saudi Arabia", saudi: "Saudi Arabia",
  qatar: "Qatar", oman: "Oman", bahrain: "Bahrain", kuwait: "Kuwait",
  canada: "Canada", australia: "Australia", singapore: "Singapore",
  germany: "Germany", france: "France", pakistan: "Pakistan",
  bangladesh: "Bangladesh", "sri lanka": "Sri Lanka", nepal: "Nepal",
  malaysia: "Malaysia", "south africa": "South Africa", "new zealand": "New Zealand",
};

function country(raw) {
  const v = clean(raw);
  if (!v) return { ok: false, message: "Which country are you in?" };
  if (v.length > 80) return { ok: false, message: "That's longer than the form allows." };
  if (/\d|@|https?:/.test(v)) {
    return { ok: false, message: "That doesn't look like a country — which one are you in?" };
  }

  /* The real list, from crm.countries. This is the only check that
     counts: whatever passes here is a country Go can resolve to an
     ISO-2 code, so nothing can be accepted now and silently dropped
     at the write. That silent drop is the bug this replaces. */
  const hit = countries.resolve(v);
  if (hit) return { ok: true, value: hit.name, iso2: hit.iso2, normalised: true };

  /* Not on the list. Ask again — but only if we are entitled to.
     Before go-data has answered, `ready()` is false and rejecting
     would tell a visitor their own country does not exist because
     of a cold cache. So the old lenient path stays as the floor. */
  if (countries.ready()) {
    const eg = countries.examples(3).join(", ");
    return {
      ok: false,
      message: `I don't know that one — could you give the country as it's usually written${eg ? ` (${eg}, and so on)` : ""}?`,
    };
  }

  const key = v.toLowerCase().replace(/^the\s+/, "").replace(/[.]$/, "");
  const alias = COUNTRY_ALIASES[key];
  if (alias) return { ok: true, value: alias, normalised: true };

  // Cold cache only: title-case it rather than turning anyone away.
  return {
    ok: true,
    value: v.replace(/\b[\p{L}]/gu, (c) => c.toUpperCase()),
    normalised: false,
  };
}

function notes(raw) {
  const v = clean(raw);
  if (v.length > 2000) return { ok: true, value: v.slice(0, 1997) + "…", truncated: true };
  return { ok: true, value: v };
}

/* Which required fields are still missing, in the order to ask.
   Name first because it makes the rest of the conversation
   human; focus before email because it is the question the
   visitor actually came to answer, and asking for contact details
   first reads like a lead-capture form. Phone and notes are never
   in this list — they are optional upstream, so the desk offers
   them rather than demanding them.

   Consent is NOT here. It is not a field to be collected in
   passing: it is the explicit "yes, send it" on the review card,
   recorded at that moment. A draft is `complete` when it is ready
   to be REVIEWED, not when it is ready to be sent. */
function missing(draft) {
  const gaps = [];
  if (!draft.name) gaps.push("name");
  // focusArea sits second because it is the question the visitor came
  // to answer, and because the upstream schema REQUIRES it — a booking
  // without one is rejected, so it cannot be dropped from this list
  // even though it is not among the fields the brief named.
  if (!draft.focusArea) gaps.push("focusArea");
  if (!draft.email) gaps.push("email");
  if (!draft.dob) gaps.push("dob");
  if (!draft.country) gaps.push("country");
  if (!draft.suggestedSlots || draft.suggestedSlots.length < config.practice.minSlots) gaps.push("slots");
  return gaps;
}

const isComplete = (draft) => missing(draft).length === 0;

module.exports = {
  FOCUS_AREAS, MODES, PHONE_DIGITS, COUNTRY_ALIASES,
  name, email, phone, focusArea, mode, notes, dob, country,
  missing, isComplete, clean,
};
