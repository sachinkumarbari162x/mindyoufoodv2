/* ============================================================
   RECOVER — filling the gaps the model leaves, from her own words
   ------------------------------------------------------------
   The punctuation guidance on the plan page makes the assistant's
   job easier. It does not make it a requirement, and it must not:
   she is a dietitian writing a plan, not a person entering data
   into a form. "Two eggs and toast before nine, then a walk after
   dinner" has no colon, no dash and no line break, and it is a
   perfectly clear instruction that a human reads without effort.

   So this runs AFTER the model and fills only what it left empty:

     quantity + unit   "two eggs"        -> 2 eggs
     schedule          "...after dinner" -> after dinner
     kind              "walk 30 minutes" -> activity

   THREE RULES, AND THEY ARE WHAT MAKE THIS SAFE TO RUN AT ALL.

   1. IT ONLY FILLS BLANKS. If the model gave a value, that value
      stands. This never argues with the model, because a
      disagreement between a regex and a language model is not one
      a regex should win.

   2. IT NEVER INVENTS. Every value it produces is derived from
      words present in her text. It cannot decide a dose, complete
      a sentence or infer an amount that was not written down —
      "a bowl of dal" comes out with no quantity, exactly as it
      went in, because there is no number in it.

   3. IT NEVER MAKES A ROW. Rows come from the model. This edits
      the ones that exist and adds nothing, so the worst case is a
      row that is no better than it was.

   AND IT IS RECORDED. `filled` lists which fields it touched, and
   the model string carries a suffix, so the accuracy figure on the
   plan page compares like with like instead of quietly crediting
   the model for a regex's work.
   ============================================================ */
"use strict";

/** Bumped when the rules below change, so accuracy keeps two
    versions apart instead of averaging them into one number. */
const VERSION = "r1";

/* ---- numbers as she writes them ---------------------------------- */

/* AN ARTICLE IS NOT A QUANTITY, and leaving "a" and "an" out of this
   is the single most important line in the file.

   With them in, "a bowl of dal" came back as 1 bowl — a number she
   never wrote, on a row about how much somebody should eat, and
   indistinguishable on screen from one she did. That is the exact
   failure this module is forbidden to produce. It also broke "half
   an hour", which matched "an hour" and came out as 1.

   The cost is that "walk an hour" yields no number. That is the
   right trade: a blank she can fill is recoverable, and a confident
   wrong number is not. */
const WORD_NUMBER = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  half: 0.5, quarter: 0.25, couple: 2, dozen: 12,
};

/* The units a dietitian actually writes. A closed list on purpose:
   an open one turns the first noun after a number into a unit, so
   "two eggs and three slices" would give unit "eggs" for a row about
   the toast. */
const UNITS = [
  "g", "gram", "grams", "kg", "mg", "mcg", "µg", "ug", "iu",
  "ml", "l", "litre", "litres", "liter", "liters",
  "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon", "teaspoons",
  "bowl", "bowls", "glass", "glasses", "slice", "slices", "piece", "pieces",
  "roti", "rotis", "chapati", "chapatis", "idli", "egg", "eggs", "almond", "almonds",
  "portion", "portions", "serving", "servings", "handful", "handfuls",
  "minute", "minutes", "min", "mins", "hour", "hours", "hr", "hrs",
  "step", "steps", "km", "kcal", "cal", "capsule", "capsules", "tablet", "tablets",
  "sachet", "sachets", "drop", "drops", "scoop", "scoops",
];

const UNIT_RE = UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/**
 * The first amount in a piece of text, as a number and a unit.
 *
 * Ordered from most specific to least, because "1.2 g/kg" must not
 * be read as "1.2 g" — the first pattern that matches wins and the
 * ratio has to be offered the string first.
 */
function findAmount(text) {
  const s = String(text || "");

  /* A ratio: 1.2 g/kg, 30 ml/kg. The unit keeps its denominator,
     because "1.2 g" of protein is a different instruction. */
  let m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_RE})\\s*/\\s*(kg|day|week)\\b`, "i"));
  if (m) return { quantity: Number(m[1]), unit: `${m[2].toLowerCase()}/${m[3].toLowerCase()}` };

  /* A fraction: 1/2 cup, 3/4 litre. Not "4/7 days", which is a
     frequency — see findSchedule, which is offered the text first. */
  m = s.match(new RegExp(`\\b(\\d+)\\s*/\\s*(\\d+)\\s+(${UNIT_RE})\\b`, "i"));
  if (m && Number(m[2]) !== 0) {
    const v = Number(m[1]) / Number(m[2]);
    if (v > 0 && v < 1000) return { quantity: v, unit: m[3].toLowerCase() };
  }

  /* Digits with a unit: 60,000 IU · 30 minutes · 150 g.
     The comma is stripped only between digits, so a list like
     "2, 3 eggs" cannot become 23. */
  m = s.match(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_RE})\\b`, "i"));
  if (m) {
    const n = Number(m[1].replace(/,(?=\d{3}\b)/g, ""));
    if (Number.isFinite(n)) return { quantity: n, unit: m[2].toLowerCase() };
  }

  /* Words with a unit: two eggs, half a cup, half an hour.
     The article between the two is swallowed rather than counted —
     `an?` and not `a` alone, or "half an hour" falls through. */
  const words = Object.keys(WORD_NUMBER).join("|");
  m = s.match(new RegExp(`\\b(${words})\\s+(?:an?\\s+)?(${UNIT_RE})\\b`, "i"));
  if (m) return { quantity: WORD_NUMBER[m[1].toLowerCase()], unit: m[2].toLowerCase() };

  /* A bare number with no unit: "about 15", "aim for 8000".
     Offered last, and the unit stays empty rather than being
     guessed from the next word. */
  m = s.match(/\b(?:about|around|roughly|approx\.?|aim for|up to)\s+(\d[\d,]*(?:\.\d+)?)\b/i);
  if (m) {
    const n = Number(m[1].replace(/,(?=\d{3}\b)/g, ""));
    if (Number.isFinite(n)) return { quantity: n, unit: "" };
  }

  return null;
}

/* ---- when ---------------------------------------------------------
   Ordered by how much it says. "after dinner every day" should come
   back as the frequency AND the occasion where both are present, so
   the phrases are collected and joined rather than first-match-wins. */

const OCCASION = [
  "before breakfast", "after breakfast", "with breakfast",
  "before lunch", "after lunch", "with lunch",
  "before dinner", "after dinner", "with dinner",
  "before bed", "at bedtime", "before sleeping", "on waking", "first thing",
  "mid-morning", "mid morning", "mid-afternoon", "mid afternoon",
  "with meals", "between meals", "on an empty stomach", "with water",
  /* THE HOURS SOMEBODY ON SHIFTS EATS AT. Her clients include nurses
     and people on rotating nights, and "midnight" is as real an
     eating occasion as lunch is — the assessment form asks about
     shift patterns for exactly this reason. Without these, a row
     scheduled "midnight" had no occasion the parser could find and
     the word was absorbed into the label instead. */
  "midnight", "midday", "noon", "overnight", "through the night",
  /* THE DEFINITE ARTICLE IS OPTIONAL IN PRACTICE. "before the shift"
     was here and "before shift" was not, so a row scheduled the
     second way kept its occasion inside the label and reached the
     client with no time on it at all. Both forms, and the mid-shift
     ones a night worker actually uses. */
  "before the shift", "before shift", "pre shift", "pre-shift",
  "after the shift", "after shift", "post shift", "post-shift",
  "during the shift", "mid-shift", "mid shift", "on shift", "on the shift",
  "start of the shift", "end of the shift", "night shift", "day shift",
  "on waking", "after waking", "before waking", "before bed",
  "breakfast", "lunch", "dinner", "supper", "evening", "morning", "afternoon", "night",
];

const FREQUENCY = [
  "every day", "each day", "daily", "twice a day", "three times a day",
  "twice daily", "alternate days", "every other day",
  "once a week", "twice a week", "three times a week", "weekly",
  "on weekdays", "at weekends", "on weekends",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays",
  /* THE SHORT FORMS, because the model writes them and she writes
     them. Without these, "- Strength work, Mon, Thu" kept the days
     in its label and came out with no schedule at all — the row
     said what to do and never said when.

     "sat" and "sun" are ordinary words as well as days, which is
     survivable here: isOccasion() requires the recognised part to
     account for most of the phrase, so a tail like "sat quietly for
     ten minutes" is still read as an instruction rather than as a
     Saturday. */
  "mon", "tue", "tues", "wed", "weds", "thu", "thur", "thurs", "fri", "sat", "sun",
];

const phrase = (list) =>
  new RegExp(`\\b(${list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

const OCCASION_RE = phrase(OCCASION);
const FREQUENCY_RE = phrase(FREQUENCY);

/* A clock time, in the forms people write them: 8am, 7-8am, 8:30,
   before 9am, by 8pm. */
const CLOCK_RE = /\b(?:before|after|by|at|from)?\s*\d{1,2}(?::\d{2})?\s*(?:-\s*\d{1,2}(?::\d{2})?\s*)?(?:am|pm)\b/i;

/* Days out of seven: "4/7 days", "5 days a week". A frequency, and
   it has to be recognised BEFORE findAmount sees the slash. */
const OUT_OF_RE = /\b(\d)\s*\/\s*7\s*(?:days?)?\b|\b(?:on\s+)?(\d|one|two|three|four|five|six|seven)\s+days?\s+a\s+week\b/i;

function findSchedule(text) {
  const s = String(text || "");
  const bits = [];

  const out = s.match(OUT_OF_RE);
  if (out) bits.push(out[0].trim());

  const freq = s.match(FREQUENCY_RE);
  if (freq && !out) bits.push(freq[1].toLowerCase());

  const occ = s.match(OCCASION_RE);
  if (occ) bits.push(occ[1].toLowerCase());

  const clock = s.match(CLOCK_RE);
  if (clock) bits.push(clock[0].trim().toLowerCase());

  /* Dedupe while keeping the order they were found in — "daily after
     dinner" reads better than "after dinner daily", and the order
     above is the order she wrote them in often enough. */
  const seen = new Set();
  const kept = bits.filter((b) => {
    const k = b.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return kept.join(", ").slice(0, 80);
}

/* ---- what sort of thing ------------------------------------------
   Only ever consulted when the model said "other", which is its way
   of saying it did not know. */

/* ORDER IS THE RULE, and habit sits above meal on purpose.

   "Chew slowly at every meal" is a habit, and it contains the word
   "meal" — so a list that checks meal first calls it a meal every
   time. The habit words below are behavioural VERBS, which are
   specific; the meal words are food NOUNS, which turn up inside
   instructions about everything else. The specific list has to go
   first or it never gets a turn.

   Words like "avoid", "reduce" and "cut down" are deliberately NOT
   here: "reduce rice to one cup" is an instruction about a meal,
   and putting them in this list would file half her plan under
   habit. */
/* ============================================================
   HOW SOMETHING IS ACTUALLY TAKEN
   ------------------------------------------------------------
   Three things a plan needs that the fields above do not carry,
   and all three are the difference between an instruction that
   works and one that quietly does not.

   HOUSEHOLD MEASURE. "150 g of rice" is a number nobody has in
   their kitchen at 8am. "One katori" is. Both belong on the row:
   the gram is what she prescribed and what a review is measured
   against, the katori is what gets eaten. This finds the second
   one in her words, so the client's screen can print
   "1 katori (150 g)" without her having to write it twice.

   TIMING. For a supplement, "after breakfast" and "on an empty
   stomach" are not scheduling preferences — iron on a full
   stomach is a fraction of the iron. It is recovered as a
   category so the panel can group and sort by it.

   THE GAP. Iron two hours from tea, calcium apart from iron,
   thyroxine an hour before food. Recovered in minutes so a
   screen can say "2 hours" rather than repeating her sentence.

   ALL THREE ARE RECOVERED FROM HER TEXT, never invented. Same
   rule as everything else here: the text she edits is the
   document, and these are readings of it. */

const HOUSEHOLD = [
  // the Indian kitchen, which is what this practice runs on
  "katori", "katoris", "vati", "wati", "bowl", "bowls",
  "glass", "glasses", "tumbler", "tumblers",
  "ladle", "ladles", "karchi", "serving spoon",
  "fistful", "fistfuls", "handful", "handfuls", "palmful",
  "cup", "cups", "mug", "mugs",
  "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon", "teaspoons",
  "plate", "plates", "quarter plate", "half plate",
  "roti", "rotis", "chapati", "chapatis", "phulka", "phulkas",
  "idli", "idlis", "dosa", "dosas", "slice", "slices",
  "piece", "pieces", "scoop", "scoops",
];

/* Built from the list rather than written out, so adding a word
   above is the whole change. `phrase()` is not reused here because
   this needs the NUMBER in front of the measure captured too — a
   bare "bowl" in a sentence is not an amount. */
/* EVERY PIECE IS String.raw. The second half of this expression was
   an ordinary template literal for its first half-hour, which made
   its trailing \b a BACKSPACE CHARACTER rather than a word boundary
   — so the pattern matched nothing and findHousehold returned "" for
   every input. It is the same trap as the escaped strings in
   index.js's SPACES, and it is invisible on screen. */
const HOUSEHOLD_ALT = HOUSEHOLD.map((h) =>
  h.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
).join("|");

/* "half a glass" before "a glass", or the shorter one wins and the
   half is lost — which is a real instruction becoming twice the
   amount she wrote. */
const HOUSEHOLD_RE = new RegExp(
  String.raw`\b((?:half|quarter)\s+(?:of\s+)?an?|\d+(?:\.\d+)?|½|¼|¾|a|an|one|two|three|four|half|quarter)\s*` +
    "(" + HOUSEHOLD_ALT + ")" + String.raw`\b`,
  "i"
);

/** "one katori", "2 rotis", "half a glass" — or "" if she gave none. */
function findHousehold(text) {
  const m = String(text || "").match(HOUSEHOLD_RE);
  if (!m) return "";
  return `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim();
}

/* WHEN A SUPPLEMENT IS TAKEN, as one of five. The order is the
   order of a meal, so sorting by it puts the plan in the sequence
   somebody actually lives it. Longest phrases first: "before
   bed" must not be read as "before" a meal. */
const TIMINGS = [
  ["bedtime", /\b(at bedtime|before bed|before sleeping|before sleep|last thing at night|at night before)\b/i],
  ["empty_stomach", /\b(empty stomach|on an empty stomach|before food|fasting|first thing|on waking)\b/i],
  ["before_meal", /\b(before (?:a |the |each |every )?meals?|pre[- ]meal|before breakfast|before lunch|before dinner|before eating)\b/i],
  ["after_meal", /\b(after (?:a |the |each |every )?meals?|post[- ]meal|after breakfast|after lunch|after dinner|after food|after eating)\b/i],
  ["with_meal", /\b(with (?:a |the |each |every )?meals?|with food|along with (?:a |the )?meal|with breakfast|with lunch|with dinner)\b/i],
];

/** One of bedtime | empty_stomach | before_meal | after_meal |
    with_meal, or "" when she did not say. */
function findTiming(text) {
  const s = String(text || "");
  for (const [name, re] of TIMINGS) if (re.test(s)) return name;
  return "";
}

/* "two hours from tea", "30 minutes before food", "1 hr apart".
   The number matters more than the thing it is apart from: the
   sentence is kept as written and this is only so a screen can
   say "2 hours apart" in its own words. */
const GAP_RE =
  /\b(\d+(?:\.\d+)?|half|an?|one|two|three|four)\s*(hours?|hrs?|h|minutes?|mins?|m)\b[^.;]{0,30}?\b(?:apart|away|gap|before|after|from)\b/i;

const WORD_NUMBERS = { half: 0.5, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };

/** Minutes, or null. */
function findGap(text) {
  const m = String(text || "").match(GAP_RE);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = WORD_NUMBERS[raw] ?? parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const hours = /^h/i.test(m[2]);
  const minutes = Math.round(hours ? n * 60 : n);
  // A gap over half a day is a misreading, not an instruction.
  return minutes > 0 && minutes <= 720 ? minutes : null;
}

const KIND_WORDS = [
  ["activity", /\b(walk|walking|walks|run|running|jog|jogging|cycle|cycling|gym|exercise|workout|yoga|stretch|swim|swimming|steps|treadmill|climb)\b/i],
  ["sleep", /\b(sleep|sleeping|asleep|bed|bedtime|nap|lights out)\b/i],
  ["supplement", /\b(vitamin|supplement|tablet|capsule|sachet|probiotic|omega|iron|calcium|magnesium|zinc|b12|d3|folate|folic|iu\b|mcg|µg)\b/i],
  ["habit", /\b(chew|chewing|slowly|portion size|weigh yourself|weigh in|record|log|diary|journal|screen|phone at the table|water intake)\b/i],
  ["meal", /\b(breakfast|lunch|dinner|supper|snack|meal|eat|eats|eating|drink|water|tea|coffee|juice|rice|dal|roti|chapati|bread|toast|egg|eggs|fruit|vegetable|veg|salad|milk|curd|yoghurt|yogurt|paneer|chicken|fish|nuts|almond|protein)\b/i],
];

function findKind(text) {
  const s = String(text || "");
  for (const [kind, re] of KIND_WORDS) if (re.test(s)) return kind;
  return null;
}

/* ---- the pass ------------------------------------------------------ */

/**
 * Fill the gaps in the model's rows from her own text.
 *
 * @param {object[]} items  what the model proposed
 * @param {string[]} lines  her plan, split into lines
 * @returns {{items: object[], filled: number}}
 */
function recover(items, lines) {
  let filled = 0;

  /* HOW MANY ROWS CAME OUT OF EACH LINE, and it decides whether the
     line may be used as a source at all.

     "one cup rice with dal and a vegetable half the plate should be
     the vegetable" is one line and two instructions. Reading an
     amount out of the whole line gave the second row — half the
     plate — a quantity of 1 cup, which belongs to the rice. A wrong
     number on a clinical row is exactly the failure this module is
     supposed to be incapable of, and it was there in the first live
     reading.

     So: a shared line is ambiguous about AMOUNTS and only about
     amounts. Where it happens, the label is the only source. */
  const perLine = new Map();
  for (const it of items || []) {
    if (it.line === null || it.line === undefined) continue;
    perLine.set(it.line, (perLine.get(it.line) || 0) + 1);
  }

  const out = (items || []).map((it) => {
    const line = it.line !== null && it.line !== undefined ? lines[it.line] : null;

    /* WHEN and WHAT SORT are properties of the context, so the whole
       line is fair game: "for lunch" governs everything on it, and a
       row cropped down to "Almonds" still happens mid-morning.

       HOW MUCH is a property of one instruction, so it may only come
       off a line that produced one. */
    const context = line ? `${it.label} ${line}` : it.label;
    const amountFrom = line && perLine.get(it.line) === 1 ? `${it.label} ${line}` : it.label;

    const got = [];
    const next = { ...it };

    if (next.quantity === null || next.quantity === undefined) {
      const amount = findAmount(amountFrom);
      if (amount) {
        next.quantity = amount.quantity;
        got.push("quantity");
        /* The unit rides in with the number. Filling a unit from a
           different phrase than the number came from is how "2" and
           "minutes" end up on a row about eggs. */
        if (!next.unit && amount.unit) {
          next.unit = amount.unit;
          got.push("unit");
        }
      }
    } else if (!next.unit) {
      const amount = findAmount(amountFrom);
      // Only if it is the SAME number the model already found.
      if (amount && amount.unit && amount.quantity === next.quantity) {
        next.unit = amount.unit;
        got.push("unit");
      }
    }

    if (!next.schedule) {
      const when = findSchedule(context);
      if (when) {
        next.schedule = when;
        got.push("schedule");
      }
    }

    if (next.kind === "other") {
      const kind = findKind(context);
      if (kind) {
        next.kind = kind;
        got.push("kind");
      }
    }

    if (got.length) {
      filled += 1;
      /* Kept on the row so the panel could mark it, and so a bug in
         here is findable from the data rather than by rerunning a
         model. Go ignores fields it does not know about. */
      next.filled = got;
    }
    return next;
  });

  return { items: out, filled };
}

module.exports = {
  recover, findAmount, findSchedule, findKind,
  findHousehold, findTiming, findGap,
  VERSION,
};
