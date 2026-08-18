/* ============================================================
   BUSINESS RULES · READING AND SUGGESTING TIMES

   Two jobs:

   1. parseSlots(text) — pull proposed times out of ordinary
      English. This is the scripted path, used when the AI service
      is unavailable, and as a cross-check on what the model
      extracted: if the visitor typed a date and the model dropped
      it, the regex still catches it.

   2. suggest(n) — the next few genuinely open windows, offered as
      quick replies. Generated from the same hours table that
      validates them, so the desk can never suggest a slot it will
      then refuse.

   Dates are resolved against the practice's own calendar day, not
   the server's. "Tomorrow" said at 23:00 UTC on a Monday means
   Wednesday in Kolkata, and getting that wrong books the wrong day.
   ============================================================ */
"use strict";

const { config } = require("../config");
const { parts, validateSlot, parseTime, WEEKDAY } = require("./hours");

const DAY_MS = 86400000;
const P = config.practice;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Practice-local calendar date, `offset` days from now. */
function dateAt(offset, now) {
  const p = parts(now);
  const base = Date.parse(`${p.date}T12:00:00Z`) + offset * DAY_MS;
  const d = new Date(base);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function dowOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** Next date (strictly ahead, or today if `includeToday`) on `dow`. */
function nextDow(dow, now, includeToday) {
  const todayDow = dowOf(dateAt(0, now));
  let delta = (dow - todayDow + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return dateAt(delta, now);
}

const DAY_WORDS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** The time expression in a fragment of text, or "". */
function timeIn(t) {
  const m =
    /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(t) ||
    // Bare 24-hour clock: "12:00", "16:30". This is the form the desk
    // itself uses on its quick replies, so without it the desk could
    // not read back a slot it had just offered — the visitor taps
    // "Thursday 13 Aug · 12:00" and the time is silently lost.
    /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(t) ||
    /\b(?:at|around|by)\s+(\d{1,2})(?:[:.](\d{2}))?\b/.exec(t) ||
    /\b(morning|afternoon|evening|noon|midday)\b/.exec(t);
  // Whichever pattern hit, the useful part is the match minus any
  // leading preposition ("at 5" → "5", "5pm" → "5pm", "evening").
  return m ? m[0].replace(/^(at|around|by)\s+/, "").trim() : "";
}

/**
 * Extract up to `maxSlots` proposed times from free text.
 *
 * Parsed clause by clause. "Tuesday at 5pm or Thursday evening" is two
 * proposals with two different times, and reading one time across the
 * whole sentence would put the visitor down for 5pm on both — a slot
 * they never offered, which the practitioner would then confirm.
 *
 * @returns {{slot:object, raw:string}[]}
 */
function parseSlots(text, now) {
  const whole = String(text || "").toLowerCase();
  const found = [];
  const push = (date, time, label, raw) => {
    if (found.length >= P.maxSlots) return;
    if (date && found.some((f) => f.slot.date === date && f.slot.time === time)) return;
    found.push({ slot: { date, time, label }, raw });
  };

  // A time stated once for the whole message ("5pm on tuesday or
  // thursday") still applies to clauses that name no time of their own.
  const fallbackTime = timeIn(whole);

  for (const clause of whole.split(/\s+(?:or|and)\s+|[,;]/).filter((c) => c.trim())) {
    if (found.length >= P.maxSlots) break;
    parseClause(clause, timeIn(clause) || fallbackTime, now, push);
  }

  // Nothing datelike in any clause — fall through to the whole-message
  // rules. These are last-resort readings, so they only run once, and
  // only when clause parsing found nothing at all.
  if (!found.length) {
    parseClause(whole, fallbackTime, now, push);

    // A bare time with no date — a real preference the practitioner
    // can work with, so keep it rather than discarding it.
    if (!found.length && fallbackTime) {
      push(undefined, fallbackTime, `Any day, around ${fallbackTime}`, fallbackTime);
    }

    // Vague-but-usable phrases, recorded in the visitor's own words.
    if (!found.length) {
      const vague =
        /\b(weekday|weekend|week ?ends?|early morning|late evening|after work|lunch ?time|any ?time|flexible|whenever)\b/.exec(
          whole
        );
      if (vague) push(undefined, "", String(text).trim().slice(0, 80), vague[0]);
    }
  }

  return found;
}

function parseClause(t, timeText, now, push) {
  /* Has this clause already produced a calendar date?
     "Thursday 20 August" is ONE date. Rule 2 reads "20 aug" and rule 4
     reads "thursday", and because the two matches do not overlap in the
     text, neither can tell the other has already spoken for the phrase.
     The result was a second slot on the NEXT Thursday — a time the
     visitor never offered, sent to the practitioner as if they had.

     So a weekday name is only a PROPOSAL when nothing else in the same
     clause named a day; beside a date it is describing it. That is safe
     because genuinely separate offers ("20 August or Friday") are split
     on or/and/comma before they reach here, and arrive as two clauses.

     When the two disagree — "Thursday 21 August" where the 21st is a
     Friday — the explicit date wins. It is the more specific of the
     two, and guessing which half of a contradiction was meant is worse
     than taking the one that cannot be ambiguous. */
  let dated = false;
  const take = (date, time, label, raw) => {
    if (date) dated = true;
    push(date, time, label, raw);
  };

  // 1 · explicit ISO
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    take(iso(+m[1], +m[2], +m[3]), timeText, "", m[0]);
  }

  // 2 · "20 aug", "aug 20", "20/08"
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g)) {
    const y = +parts(now).date.slice(0, 4);
    take(iso(y, MONTHS[m[2]], +m[1]), timeText, "", m[0]);
  }
  // "aug 20" — but NOT the "aug 12" inside "13 Aug 12:00", where the
  // number is a clock time that happens to follow a month. That read
  // "Thursday 13 Aug 12:00" as both the 13th and the 12th, and since
  // the 12th was today it came back as "that has already passed" — the
  // desk refusing a slot it had itself just offered.
  for (const m of t.matchAll(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b(?![:.]\d)/g
  )) {
    const y = +parts(now).date.slice(0, 4);
    take(iso(y, MONTHS[m[1]], +m[2]), timeText, "", m[0]);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    // Day-first: the practice is in India and the v1 form was too.
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +parts(now).date.slice(0, 4);
    take(iso(y, +m[2], +m[1]), timeText, "", m[0]);
  }

  // 3 · relative words. Through take() as well: "tomorrow, Thursday"
  // names one day twice, the same way "Thursday 20 August" does.
  if (/\btomorrow\b/.test(t)) take(dateAt(1, now), timeText, "", "tomorrow");
  if (/\bday after tomorrow\b/.test(t)) take(dateAt(2, now), timeText, "", "day after tomorrow");
  if (/\btoday\b/.test(t)) take(dateAt(0, now), timeText, "", "today");

  // Backwards-looking words have to be recognised too, precisely so
  // they can be REJECTED. Left out, "yesterday at 4pm" matched none of
  // the date rules, fell through to the bare-time rule, and was quietly
  // recorded as "any day, around 4pm" — the desk heard something the
  // visitor had not said. A date in the past is caught by validateSlot
  // and comes back as "that has already passed", which is the honest
  // answer to an impossible request.
  // else-if so "day before yesterday" is not ALSO read as bare
  // "yesterday" and rejected twice, for two different dates.
  if (/\bday before yesterday\b/.test(t)) {
    push(dateAt(-2, now), timeText, "", "day before yesterday");
  } else if (/\byesterday\b/.test(t)) {
    push(dateAt(-1, now), timeText, "", "yesterday");
  }

  // 4 · weekday names. ONE matcher for "next X", "last X", "this X" and
  //     bare "X". Handling "last" in a separate pass left the bare rule
  //     free to match the same word, so "last monday" recorded the past
  //     Monday AND next Monday — a future slot the visitor never offered.
  //
  //     Skipped entirely once this clause has named a day: see the note
  //     at the top of the function. The weekday is then a description of
  //     that date, not a second offer.
  if (dated) return;

  for (const m of t.matchAll(
    /\b(next|last|this)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/g
  )) {
    const dow = DAY_WORDS[m[2]];
    const qualifier = (m[1] || "").toLowerCase();

    if (qualifier === "last") {
      // Most recent past occurrence; a full week back if today is it.
      const back = ((dowOf(dateAt(0, now)) - dow + 7) % 7) || 7;
      push(dateAt(-back, now), timeText, "", m[0]);
      continue;
    }

    let date = nextDow(dow, now, false);
    if (qualifier === "next") {
      date = dateAt(Math.round((Date.parse(date) - Date.parse(dateAt(0, now))) / DAY_MS) + 7, now);
    }
    push(date, timeText, "", m[0]);
  }

}

/**
 * Validate a batch of parsed/extracted slots against the hours table.
 * @returns {{accepted:object[], rejected:{message:string}[]}}
 */
function screen(slots, now) {
  const accepted = [];
  const rejected = [];
  for (const s of slots || []) {
    if (accepted.length >= P.maxSlots) break;
    const verdict = validateSlot(s.slot || s, now);
    if (verdict.ok) {
      const dup = accepted.some(
        (a) => a.date === verdict.slot.date && a.time === verdict.slot.time && a.label === verdict.slot.label
      );
      if (!dup) accepted.push(verdict.slot);
    } else if (verdict.reason !== "empty") {
      rejected.push({ message: verdict.message, reason: verdict.reason });
    }
  }
  return { accepted, rejected };
}

/** The next `n` open windows, as quick-reply labels. */
function suggest(n, now) {
  const out = [];
  for (let i = 1; i <= 21 && out.length < (n || 3); i++) {
    const date = dateAt(i, now);
    const dow = dowOf(date);
    const win = P.hours[dow];
    if (!win || P.closedDates.includes(date)) continue;

    // Offer a mid-window time rather than the opening minute: the
    // first slot of the day is the one most likely already taken.
    const hour = Math.floor((win[0] + (win[1] - win[0]) / 2) / 60);
    const label = `${WEEKDAY[dow]} ${date.slice(8)}/${date.slice(5, 7)}, ${hour}:00`;
    out.push({ date, time: `${hour}:00`, label });
  }
  return out;
}

module.exports = { parseSlots, screen, suggest, dateAt, nextDow, parseTime };
