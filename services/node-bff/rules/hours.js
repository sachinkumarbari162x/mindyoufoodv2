/* ============================================================
   BUSINESS RULES · PRACTICE HOURS AND SLOT VALIDITY

   The one place that answers "are we open" and "can she actually
   see you then". Everything is computed in the practice's own
   timezone via Intl — never in the server's local time, and never
   in the visitor's. A visitor in Dubai proposing "Tuesday 9am"
   means 9am *her* time unless they say otherwise, and the desk
   says so explicitly rather than guessing.

   No dependencies: Intl.DateTimeFormat with a timeZone gives the
   correct wall-clock parts through DST without a tz library.
   ============================================================ */
"use strict";

const { config } = require("../config");

const P = config.practice;
const DAY_MS = 86400000;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: P.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

const SHORT_DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant, in the practice's timezone. */
function parts(at) {
  const out = {};
  for (const p of fmt.formatToParts(at || new Date())) out[p.type] = p.value;
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    minutes: Number(out.hour) % 24 * 60 + Number(out.minute),
    dow: SHORT_DAY[out.weekday],
  };
}

const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function windowFor(dateStr, dow) {
  if (P.closedDates.includes(dateStr)) return null;
  return P.hours[dow] || null;
}

/** Is the desk staffed right now? */
function isOpenNow(at) {
  const p = parts(at);
  const win = windowFor(p.date, p.dow);
  return Boolean(win && p.minutes >= win[0] && p.minutes < win[1]);
}

// How near to closing counts as "about to close". Long enough to be
// honest about, short enough that it is not said all afternoon.
const CLOSING_SOON_MIN = 30;

/** Human presence line for the window header.
 *
 *  `open` and `label` are the original contract and must not change
 *  shape — flow.js reads the "Closed · replies …" prefix back out of
 *  the label. Everything else is additive, and exists so the desk can
 *  say WHICH kind of closed it is: an ordinary evening, a Sunday, or a
 *  named holiday. "We're closed for Diwali" is a different sentence to
 *  "we're closed", and only one of them sounds like a person.
 */
function presence(at) {
  const p = parts(at);
  const open = isOpenNow(at);

  if (open) {
    const closesAt = windowFor(p.date, p.dow)[1];
    const closesInMin = closesAt - p.minutes;
    return {
      open: true,
      label: `Open now · until ${hhmm(closesAt)} IST`,
      kind: closesInMin <= CLOSING_SOON_MIN ? "closing_soon" : "open",
      closesInMin,
      closesAt: hhmm(closesAt),
    };
  }

  const next = nextOpening(at);
  const holiday = P.closedDateNames?.[p.date] || null;

  return {
    open: false,
    label: next ? `Closed · replies ${next.phrase}` : "Closed · she replies personally",
    // A named closure outranks the generic ones — it is the most
    // specific true thing we can say.
    kind: holiday ? "holiday" : P.closedDates.includes(p.date) ? "closed_today" : "closed",
    holiday,
    nextPhrase: next ? next.phrase : null,
  };
}

/** The next moment the desk is staffed, as a friendly phrase. */
function nextOpening(at) {
  const from = at || new Date();
  const p = parts(from);
  for (let i = 0; i < 14; i++) {
    const probe = new Date(from.getTime() + i * DAY_MS);
    const pp = parts(probe);
    const win = windowFor(pp.date, pp.dow);
    if (!win) continue;
    // Today only counts if the window has not already closed.
    if (i === 0 && p.minutes >= win[1]) continue;
    const opensAt = i === 0 ? Math.max(win[0], p.minutes) : win[0];
    const phrase =
      i === 0 ? `from ${hhmm(win[0])} today` : i === 1 ? `tomorrow morning` : `on ${WEEKDAY[pp.dow]}`;
    return { date: pp.date, dow: pp.dow, opensAt, phrase };
  }
  return null;
}

/* ---- slot validation -------------------------------------------
   A suggested slot is one of:
     · a date + a clock time      → fully checkable
     · a date + a part of day     → checkable to the day
     · free text ("weekday eves") → recorded, flagged as vague

   Vague is allowed. The practitioner reads these and picks one;
   forcing a visitor into a datepicker is exactly the friction the
   form had. What is NOT allowed is a slot that is definitely
   unbookable — a Sunday, a closed date, 3am, next year, or two
   hours from now — because confirming one of those wastes a real
   exchange of emails to un-book it. */

const PART_OF_DAY = {
  morning: 660, // 11:00
  afternoon: 900, // 15:00
  evening: 1080, // 18:00
  night: 1290,
  noon: 720,
  midday: 720,
  anytime: null,
  flexible: null,
};

/** Parse "16:00", "4pm", "4.30 pm", "afternoon" → minutes, or null. */
function parseTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  if (Object.prototype.hasOwnProperty.call(PART_OF_DAY, s)) {
    return { minutes: PART_OF_DAY[s], vague: true };
  }

  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2] || 0);
  const mer = m[3];
  if (hour > 23 || min > 59) return null;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;

  // A bare "4" for a consultation means 4pm — nobody books a dietician
  // at 04:00. But this nudge applies ONLY to a bare hour: "03:00" and
  // "3.30" are someone stating a clock time, and quietly turning those
  // into the afternoon would book a slot they never asked for. Written
  // out (m[2] absent) and not zero-padded (m[1] length 1) is the test.
  const bareHour = m[2] === undefined && m[1].length === 1;
  if (!mer && bareHour && hour >= 1 && hour <= 7) hour += 12;

  return { minutes: hour * 60 + min, vague: false };
}

function validateSlot(slot, now) {
  const at = now || new Date();
  const label = (slot.label || "").trim();
  const date = (slot.date || "").trim();
  const time = (slot.time || "").trim();

  if (!date && !time && !label) return { ok: false, reason: "empty", message: "That slot was blank." };

  // No parseable date. Normally this is recorded as-is and the
  // practitioner reads it — but "vague" must not become a laundering
  // route for a day the practice is shut. A slot of
  // {time:"11am", label:"Sunday"} has no date field, took this branch,
  // and was accepted moments after the desk had told the visitor that
  // Sunday is closed. So the free text is checked for a weekday name
  // before it is waved through.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const named = `${label} ${date} ${time}`.toLowerCase();
    for (let d = 0; d < 7; d++) {
      const dayName = WEEKDAY[d].toLowerCase();
      if (!new RegExp(`\\b${dayName}s?\\b`).test(named)) continue;
      if (!P.hours[d]) {
        return {
          ok: false,
          reason: "closed_day",
          message: `${WEEKDAY[d]} is outside consultation hours — ${P.hoursText}.`,
        };
      }
      // Named an open day with a clock time — check the time against it.
      const parsedTime = parseTime(time);
      if (parsedTime && parsedTime.minutes != null && !parsedTime.vague) {
        const win = P.hours[d];
        if (parsedTime.minutes < win[0] || parsedTime.minutes >= win[1]) {
          return {
            ok: false,
            reason: "outside_hours",
            message: `On ${WEEKDAY[d]} she consults ${hhmm(win[0])}–${hhmm(win[1])}. ${hhmm(
              parsedTime.minutes
            )} is outside that.`,
          };
        }
      }
      break;
    }
    return { ok: true, vague: true, slot: { date: date || undefined, time: time || undefined, label: label || undefined } };
  }

  const parsed = parseTime(time);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();

  if (Number.isNaN(dow)) {
    return { ok: false, reason: "bad_date", message: `I couldn't read "${date}" as a date.` };
  }

  const win = windowFor(date, dow);
  if (!win) {
    return {
      ok: false,
      reason: "closed_day",
      message: `${WEEKDAY[dow]} ${date} is outside consultation hours — ${P.hoursText}.`,
    };
  }

  // Lead time and horizon, measured against the practice clock.
  const nowP = parts(at);
  const slotStart = Date.parse(`${date}T00:00:00Z`) + (parsed?.minutes ?? win[0]) * 60000;
  const nowStart = Date.parse(`${nowP.date}T00:00:00Z`) + nowP.minutes * 60000;
  const leadHours = (slotStart - nowStart) / 3600000;

  if (leadHours < 0) {
    return { ok: false, reason: "past", message: `${date} has already passed.` };
  }
  if (leadHours < P.minLeadHours) {
    return {
      ok: false,
      reason: "too_soon",
      message: `She needs at least ${P.minLeadHours} hours' notice — could you suggest something a little later?`,
    };
  }
  if (leadHours / 24 > P.maxHorizonDays) {
    return {
      ok: false,
      reason: "too_far",
      message: `That's further out than she schedules (${P.maxHorizonDays} days). Something sooner?`,
    };
  }

  if (parsed && parsed.minutes != null && !parsed.vague) {
    if (parsed.minutes < win[0] || parsed.minutes >= win[1]) {
      return {
        ok: false,
        reason: "outside_hours",
        message: `On ${WEEKDAY[dow]} she consults ${hhmm(win[0])}–${hhmm(win[1])}. ${hhmm(
          parsed.minutes
        )} is outside that.`,
      };
    }
  }

  return {
    ok: true,
    vague: Boolean(parsed?.vague || parsed == null),
    slot: {
      date,
      time: time || undefined,
      label: label || `${WEEKDAY[dow]} ${date}${time ? ` · ${time}` : ""}`,
    },
  };
}

module.exports = { isOpenNow, presence, nextOpening, validateSlot, parseTime, parts, hhmm, WEEKDAY };
