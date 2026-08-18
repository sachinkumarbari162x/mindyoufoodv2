/* ============================================================
   PARSE — structured plan text back into rows, with no model
   ------------------------------------------------------------
   The second of the two buttons, and the reason the first one has
   to be pressed before it.

     Generate  her prose  -> a model -> structured text she reviews
     Build     that text  -> THIS    -> the rows in the table

   BUILD CALLS NOTHING. Once the text is in the house shape, turning
   it into rows is reading, not guessing — a dash starts an
   instruction, brackets hold the amount, a comma separates the
   occasion. A second model call here would be paying to re-derive
   something the syntax already states, and it would sometimes
   disagree with itself.

   WHICH IS WHY BUILD IS OFF UNTIL GENERATE HAS RUN. It is not an
   arbitrary order: on raw prose this parser finds nothing, because
   there is nothing here that reads prose. Generate is what puts
   the structure in; Build is what trusts it.

   AND SHE CAN EDIT IN BETWEEN. That is the point of the two steps.
   The generated text is hers to correct before any row exists, and
   because the syntax is strict, her corrections parse exactly as
   the model's output did.

   The vocabulary — units, occasions, frequencies, kinds — is NOT
   duplicated here. It comes from recover.js, which is the one
   place in this system that knows what "mid-morning" is.
   ============================================================ */
"use strict";

const {
  findAmount, findSchedule, findKind, findTiming, findGap,
} = require("./recover");

/** Anything before the first row is not a row. Headings are the
    ones compose writes, and anything else with no dash is prose. */
const HEADINGS = new Set([
  "food", "if you are hungry", "supplements", "movement", "sleep",
  "habits", "anything else",
]);

/* An amount in brackets at the end of the instruction: "(2 eggs)",
   "(140 g)", "(1/2 cup)". Compose puts it there and nowhere else, so
   this is the one place it is looked for. */
const BRACKET = /\(([^()]{1,40})\)\s*(?=,|$)/;

/**
 * One line of structured text, as a row.
 *
 * @returns {object|null}  null when the line is not an instruction
 */
function parseLine(text, index, kindHint) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (HEADINGS.has(raw.toLowerCase())) return null;

  /* NO DASH, NO ROW. This is the whole contract between the two
     buttons: Generate guarantees the dash, Build requires it, and a
     line of prose that survived into the text is left alone rather
     than guessed at. */
  if (!/^-[^\S\n]+/.test(raw)) return null;

  let rest = raw.replace(/^-[^\S\n]+/, "").trim();
  if (!rest) return null;

  /* AND ONE DASH ONLY. "- - Two eggs" passed the test above, lost
     its first dash, and became a row labelled "- Two eggs" — an
     instruction that reads wrong on the client's plan and cannot be
     parsed again. Stripping the second dash instead would be worse:
     it would silently accept a line the syntax says is broken, and
     the complaint that names it would never be shown.

     So it is refused here and reported by complaint(). */
  if (/^[-–—•·*>]/.test(rest)) return null;

  /* ---- how it is taken, off the end -----------------------------
     Taken FIRST, before anything else is read, because everything
     below works on what is left and none of it should be hunting
     through an instruction sentence. The order in the line is
     label (amount) [household] {sets}, schedule — how, and this
     unwinds it from the right.

     THE EM DASH IS THE MARK, never a hyphen: the line already opens
     with a hyphen and parseLine refuses a second one, which is the
     collision this stays clear of. */
  let how = "";
  const dash = rest.search(/\s+[—–]\s+/);
  if (dash > 0) {
    how = rest.slice(dash).replace(/^\s*[—–]\s*/, "").trim().slice(0, 200);
    rest = rest.slice(0, dash).trim();
  }

  /* The household measure, in square brackets. */
  let household = "";
  const square = rest.match(/\[([^\]]{1,40})\]/);
  if (square) {
    household = square[1].trim();
    rest = (rest.slice(0, square.index) + rest.slice(square.index + square[0].length))
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /* Sets, reps and rest, in braces: "{3 x 10-12, 60 sec rest}". */
  let sets = null;
  let reps = "";
  let restSeconds = null;
  const braces = rest.match(/\{([^}]{1,60})\}/);
  if (braces) {
    const inside = braces[1];
    const shape = inside.match(/(\d+)\s*[x×]\s*([\d\-–to ]+)/i);
    if (shape) {
      sets = Number(shape[1]);
      reps = shape[2].trim();
    }
    const pause = inside.match(/(\d+)\s*(?:sec|second|s)\b/i);
    if (pause) restSeconds = Number(pause[1]);
    rest = (rest.slice(0, braces.index) + rest.slice(braces.index + braces[0].length))
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /* The amount comes out first, so it cannot be mistaken for part
     of the label — and the brackets are removed with it. */
  let quantity = null;
  let unit = "";
  const inBrackets = rest.match(BRACKET);
  if (inBrackets) {
    const inside = inBrackets[1];
    let found = findAmount(inside);

    /* A NUMBER AND A WORD IS AN AMOUNT, even when the word is not one
       recover.js has heard of.

       findAmount only matches known units, which is right when it is
       hunting through prose — "3 times" must not become an amount.
       But compose puts the amount in brackets and NOTHING ELSE goes
       there, so inside them the question is already settled. Without
       this, "- Vitamin D 60,000 IU (1 dose), weekly" kept the whole
       bracket in its label and the client's plan read "Vitamin D
       60,000 IU (1 dose)". */
    if (!found && /^\s*\d/.test(inside)) {
      const m = inside.match(/^\s*(\d[\d,]*(?:\.\d+)?)\s*(.*?)\s*$/);
      if (m) {
        const n = Number(m[1].replace(/,(?=\d{3}\b)/g, ""));
        if (Number.isFinite(n)) found = { quantity: n, unit: m[2].toLowerCase() };
      }
    }

    if (found) {
      quantity = found.quantity;
      unit = found.unit;
      rest = (rest.slice(0, inBrackets.index) + rest.slice(inBrackets.index + inBrackets[0].length))
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  }

  /* THE LAST COMMA IS THE SCHEDULE — but only when what follows it
     reads like one.

     "Lunch: rice, dal and a vegetable" ends in a comma-separated
     list of foods, and taking "dal and a vegetable" as the occasion
     would be worse than finding no occasion at all. So the tail is
     offered to the same vocabulary that recovers a schedule from
     prose, and kept only if that recognises it. */
  /* IS THIS PHRASE AN OCCASION, OR DOES IT MERELY CONTAIN ONE?

     findSchedule answers the second question — it pulls the time out
     of any sentence that has one. Using it as the test made "Dark
     room, no phone before 9am" into a row labelled "Dark room"
     scheduled "no phone before 9am", because the tail does contain a
     clock time. The instruction lost half of itself.

     So the extracted part has to account for most of the phrase.
     "weekly" and "after dinner" and "before 9am" are entirely
     schedule; "no phone before 9am" is an instruction with a time in
     it, and 10 characters out of 19 is not enough. */
  const isOccasion = (phrase) => {
    const p = String(phrase || "").trim();
    if (!p) return false;
    const found = findSchedule(p);
    return !!found && found.length >= p.length * 0.6;
  };

  let schedule = "";
  let comma = rest.lastIndexOf(",");
  if (comma > 0) {
    const tail = rest.slice(comma + 1).trim();
    if (tail && isOccasion(tail)) {
      /* AND THEN BACKWARDS, WHILE EVERY PHRASE IS STILL AN OCCASION.

         A schedule is very often two phrases — "breakfast, before
         9am", "weekly, Sunday", "after dinner, daily" — and the
         model is told to write them that way. Taking only the last
         comma tore those in half: `- Two eggs (2 eggs), breakfast,
         before 9am` came back as a row labelled "Two eggs ,
         breakfast" scheduled "before 9am". A plan written by
         Generate could not be read by Build without losing the
         occasion off every second row.

         Extending is safe because the test is applied PHRASE BY
         PHRASE. "Lunch: rice, dal and a vegetable, lunch" stops at
         "dal and a vegetable" — which is food, not an occasion — so
         the case the original comment worried about still holds. */
      let at = comma;
      for (;;) {
        const prev = rest.lastIndexOf(",", at - 1);
        if (prev <= 0) break;
        const wider = rest.slice(prev + 1).trim();
        const phrases = wider.split(",").map((p) => p.trim()).filter(Boolean);
        if (!phrases.every(isOccasion)) break;
        at = prev;
      }

      comma = at;
      schedule = rest.slice(comma + 1).trim();
      rest = rest.slice(0, comma).trim();
    }
  }

  /* ` ,` closed up before anything else. Removing "(1 bowl)" from
     "Poha with peanuts (1 bowl), before the shift" leaves a space
     sitting in front of the comma, and that space then survives all
     the way onto the client's plan. */
  const label = rest
    .replace(/\s+([,;:])/g, "$1")
    .replace(/[\s,;:.]+$/, "")
    .trim();
  if (!label) return null;

  /* The heading above it, when there was one — she grouped these by
     kind and that grouping is a statement. Falling back to the
     words in the line itself, and to "other" when neither says. */
  const kind = kindHint || findKind(label) || "other";

  /* TIMING AND THE GAP ARE READ OUT OF HER SENTENCE, not stored
     beside it. She writes "after meals, keep two hours from tea" —
     that sentence is the document and the two fields below are a
     reading of it, recovered by the same module that knows what
     "mid-morning" means. Storing them separately would mean she
     could edit the sentence and leave the fields saying something
     else, which is the worst of both. */
  const searchable = `${how} ${schedule}`;

  return {
    line: index,
    kind,
    label: label.slice(0, 300),
    quantity,
    unit: String(unit || "").slice(0, 24),
    schedule: schedule.slice(0, 80),
    household: household.slice(0, 40),
    how,
    timing: kind === "supplement" ? findTiming(searchable) : "",
    gapMinutes: kind === "supplement" ? findGap(searchable) : null,
    sets,
    reps: String(reps || "").slice(0, 20),
    restSeconds,
  };
}

/** Which kind a heading names, if it is one of ours. */
const HEADING_KIND = {
  food: "meal",
  "if you are hungry": "filler",
  supplements: "supplement",
  movement: "activity",
  sleep: "sleep",
  habits: "habit",
  "anything else": "other",
};

/**
 * A whole plan's text, as rows.
 *
 * @param {string} body
 * @returns {{items: object[], lines: number, skipped: number}}
 */
function parse(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const items = [];
  const problems = [];
  let kindHint = null;

  lines.forEach((text, i) => {
    const flat = text.trim().toLowerCase();

    /* A heading sets the kind for the lines under it, and stops
       applying at a blank line — which is where compose ends a
       block. Without that, prose at the foot of the plan would
       inherit "Sleep" from four lines earlier. */
    if (!flat) { kindHint = null; return; }
    if (HEADINGS.has(flat)) { kindHint = HEADING_KIND[flat] || null; return; }

    const row = parseLine(text, i, kindHint);
    if (row) { items.push(row); return; }

    /* IT SAYS WHAT IT COULD NOT READ, and this is the half that
       makes Build a review rather than a filter.

       Silently dropping a line is the failure that costs a client
       an instruction: she looks at eleven rows, the plan had
       twelve, and nothing anywhere says which one went. So every
       line that did not become a row comes back with the reason,
       and the page lists them.

       Prose is not a problem — a sentence with no dash was never
       meant to be an instruction, and complaining about it would
       train her to ignore the list. Only lines that LOOK like they
       were trying to be rows are reported. */
    const why = complaint(text);
    if (why) problems.push({ line: i, text: text.trim().slice(0, 120), why });
  });

  return { items, lines: lines.length, problems };
}

/** Why a line that looks like an instruction is not one — or null
    when it was never trying to be. */
function complaint(text) {
  const l = String(text || "").trim();

  if (/^[-–—•·*>]/.test(l)) {
    if (/^-\s*-/.test(l)) return "two dashes at the start — one marks an instruction, two cannot be read";
    if (/^[–—•·*>]/.test(l)) return "starts with the wrong mark — an instruction begins with a plain dash";
    if (/^-\s*$/.test(l)) return "a dash with nothing after it";
    if (/^-\S/.test(l)) return "no space after the dash";
    return "could not be read as an instruction";
  }

  /* ============================================================
     A SENTENCE IS PROSE, WHATEVER IS IN IT
     ------------------------------------------------------------
     The two heuristics below were written for SHORT lines that
     look like botched rows — "Breakfast: two eggs", "150 g rice".
     They fired on her writing instead, and the complaint they
     produced was this:

       "no dash — an amount here suggests this was meant to be an
        instruction"

     against

       "Weights are cooked weights unless the line says otherwise.
        Weigh everything for the first two weeks; after that you
        will see 150 g of rice on a plate without a scale."

     which is a paragraph explaining her method, containing an
     example, and not a failed instruction in any sense. She is
     told her own prose is broken, on a page whose whole promise
     is that her prose survives.

     A complaint list that scolds correct writing gets ignored
     within a week, and then the one real complaint in it gets
     ignored too. So the test comes first and it is deliberately
     generous: anything that reads like a sentence is left alone.
     ============================================================ */
  const words = l.split(/\s+/).length;
  const isSentence =
    l.length > 80 || // long enough that no row is this shape
    (/[.!?]$/.test(l) && words > 6) || // ends like a sentence
    /[;:]\s+\w+.*[.!?]/.test(l) || // a clause, then more sentence
    words > 14; // simply too many words to be one instruction

  if (isSentence) return null;

  /* No dash, but it reads like one: a colon early on, or an amount
     with a unit, on a line short enough to have been a row. */
  if (/^[^:]{1,40}:\s*\S/.test(l)) return "no dash — this looks like an instruction but will be read as prose";
  if (/\b\d+(\.\d+)?\s*(g|kg|ml|mg|cup|cups|minutes|mins|eggs|rotis|IU)\b/i.test(l)) {
    return "no dash — an amount here suggests this was meant to be an instruction";
  }

  return null;   // ordinary prose, and hers to keep
}

/**
 * Is there anything here to build?
 *
 * Cheap enough for a button's disabled state, and the same answer
 * `parse` would give — so the button is never enabled over text
 * that would then produce nothing.
 */
function buildable(body) {
  /* `[^\S\n]` and not `\s`, because \s matches a newline: against
     "-\n- " the old pattern found the dash on line one, ran \s+
     across the line break, and matched the dash on line two — so a
     file containing two empty dashes reported itself as buildable
     and Build then found nothing. Whitespace, but on this line. */
  return /^-[^\S\n]+\S/m.test(String(body || ""));
}

module.exports = { parse, parseLine, buildable };
