/* ============================================================
   PLAN PUNCTUATION — what may appear in a document that leaves
   ------------------------------------------------------------
   The plan is the one thing she writes that goes somewhere else.
   It is rendered on the client's page, read by a model that turns
   it into rows, and printed. Three destinations, three different
   ideas about what a character means, and the marks below are the
   ones that survive all three unchanged.

   TWO KINDS OF CHARACTER GET HANDLED, AND ONLY ONE IS A REFUSAL.

     SUBSTITUTED, invisibly. A curly quote, an em dash, an
     ellipsis, a non-breaking space — these arrive by the hundred
     when she pastes from Word or from a phone's autocorrect, and
     every one of them MEANS the plain mark it replaced. Turning
     them back costs her nothing and she should never notice. This
     is the case that actually happens.

     DROPPED. Everything else — < > * _ # ` [ ] { } | \ ~ ^ = @ $
     and emoji. None of them belongs in a sentence about food, all
     of them render as literal noise on the client's page, and the
     two angle brackets are the pair that matter most: they are
     the only characters in this system that could ever be read as
     markup somewhere downstream.

   THIS IS A TYPING AID AND NOT A BOUNDARY. It runs in a browser,
   so anything that treats it as protection is wrong: the client's
   page sets `textContent` and never innerHTML, and that is what
   makes the text safe. What this buys is a plan that reads the
   same in her pad, on their phone, and on paper.

   NOTHING ALREADY WRITTEN IS TOUCHED. It cleans what she types
   and what she pastes. A plan loaded from the database is left
   exactly as it was — silently rewriting a document she did not
   open for editing is not a tidy-up, it is a change of record.
   ============================================================ */

/* The marks she may use, in the order the footer says them.
   Letters, digits, spaces and line breaks are not in this list
   because they were never in question. */
export const MARKS = [".", ",", ":", ";", "'", '"', "(", ")", "/", "-", "=", "+", "%", "&", "?", "!"];

/* ============================================================
   WHAT EACH MARK IS FOR, AS THE ASSISTANT READS IT
   ------------------------------------------------------------
   The model turns this text into rows of kind · label · quantity ·
   unit · schedule. Four of these marks are what it has to go on,
   and writing them consistently is worth more than any prompt:

     -   at the start of a line, ONE INSTRUCTION. This is the
         strongest signal in the whole document — a line that
         begins with a dash is a row, and a line that does not is
         prose around it.
     :   label on the left, detail on the right. "Breakfast: two
         eggs" splits cleanly; "Breakfast two eggs" does not.
     ,   items within one instruction.
     ()  detail that is not the instruction — "(about 140g)".
         Anything the model can drop without losing the meaning.
     =   an equivalence, and the reason it was added: "1 cup =
         150 g" gives a quantity and a unit in one phrase, and
         without it she writes "1 cup which is about 150 grams",
         which is a sentence rather than a number.
     /   per, and fractions. "1.2 g/kg", "4/7 days", "1/2 cup".

   Nothing here is a syntax she has to learn. It is how a dietitian
   already writes a plan; the footer just names it so the habit is
   visible, and the shape below is an example rather than a rule.
   ============================================================ */
export const SHAPE = "- Breakfast: two eggs (140 g), 8am";

/** What the strip says at rest. Built from the array above, so the
    line on screen can never fall out of step with the rule. */
export const FOOTER = MARKS.join(" ");

/* ============================================================
   THE LONG VERSION
   ------------------------------------------------------------
   The strip is one line because it is read every day. This is
   what opens under it, and it is read once.

   Each entry is a mark, what it does to the reading, and — where
   it helps — the same instruction written both ways, because
   "use a colon" is advice and "these two lines become different
   rows" is a reason.

   It is written for HER, not for the model. No JSON, no talk of
   parsing, no field names. She is a dietitian who writes plans;
   the only claim being made is that writing them this way makes
   the assistant right more often, which is true and checkable on
   the accuracy line above.
   ============================================================ */
export const GUIDE = [
  {
    mark: "-",
    title: "A dash starts an instruction",
    body:
      "This is the one that matters most. A line beginning with a dash is read " +
      "as one thing to do; a line without one is read as the sentence around it. " +
      "If a row comes back missing, this is almost always why.",
    good: "- Walk 30 minutes after dinner",
    poor: "She should try to walk about half an hour after her evening meal",
  },
  {
    mark: ":",
    title: "A colon splits the when from the what",
    body:
      "Everything left of the colon is read as the occasion, everything right " +
      "of it as the food. Without one, the whole line is a label and the " +
      "schedule column comes back empty.",
    good: "- Breakfast: two eggs and a slice of toast",
    poor: "- Breakfast two eggs and a slice of toast",
  },
  {
    mark: ",",
    title: "A comma separates items in one instruction",
    body:
      "One line, several things, one row. Use a new dashed line when you mean " +
      "a separate instruction she should be able to tick on its own.",
    good: "- Lunch: rice, dal, and a vegetable",
  },
  {
    mark: "( )",
    title: "Brackets hold the detail that is not the instruction",
    body:
      "Anything in brackets is read as a qualifier — an amount, a substitution, " +
      "a note to the client. It never becomes a row of its own.",
    good: "- Mid-morning: almonds (about 15)",
  },
  {
    mark: "=",
    title: "An equals sign gives an amount a second form",
    body:
      "The most useful mark on this list after the dash and the colon. It turns " +
      "a household measure into a number without a sentence around it.",
    good: "- Dinner: one cup rice = 150 g cooked",
    poor: "- Dinner: one cup of rice, which is roughly 150 grams once cooked",
  },
  {
    mark: "/",
    title: "A slash means per, or a fraction",
    body:
      "Read as a ratio wherever it sits between two amounts. Safe in doses, " +
      "in frequencies, and in halves.",
    good: "- Protein 1.2 g/kg · walk 4/7 days · 1/2 cup at night",
  },
  {
    mark: "' \"",
    title: "Straight quotes only",
    body:
      "Curly quotes, em dashes and ellipses are turned back into their plain " +
      "forms as you type. Nothing is lost and you do not have to think about " +
      "it — it is here so the change is not a mystery when you notice it.",
  },
  {
    mark: "· · ·",
    title: "What is removed, and why",
    body:
      "Angle brackets, asterisks, hashes, backticks, braces, emoji and " +
      "invisible characters are dropped. They come in with pasted text, they " +
      "mean nothing in a sentence about food, and they reach the client's page " +
      "as literal clutter. Pasted bullets of any kind become the dash above.",
  },
];

/* One mark in, its plain equivalent out. Written as pairs rather
   than a regex so a reader can see exactly what becomes what. */
const SAME_THING = new Map([
  ["‘", "'"], ["’", "'"],           // ' '  curly singles
  ["‚", "'"], ["‛", "'"],
  ["“", '"'], ["”", '"'],           // " "  curly doubles
  ["„", '"'], ["«", '"'], ["»", '"'],
  ["–", "-"], ["—", "-"], ["−", "-"], // – — −
  ["‑", "-"], ["‒", "-"], ["―", "-"], // non-breaking hyphen, figure dash, horizontal bar
  ["…", "..."],                          // …
  [" ", " "], [" ", " "], [" ", " "], // hard spaces
  ["×", "x"],                            // × as in 3 × a day
  ["⁄", "/"],                            // ⁄
  ["•", "-"], ["·", "-"],           // • ·  bullets she pasted
]);

/* Everything permitted, as a class. Built from MARKS so the two
   cannot disagree: escape each mark, then allow letters (any
   script — names and foods arrive in Devanagari and Arabic),
   marks used in those scripts, digits, spaces and newlines. */
const ESCAPED = MARKS.map((m) => m.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("");
const KEEP = new RegExp(`[\\p{L}\\p{M}\\p{N} \\t\\r\\n${ESCAPED}]`, "u");

/* CHARACTERS THAT ARE THERE BUT CANNOT BE SEEN. Checked before
   anything else, because \p{M} above has to allow combining marks —
   Devanagari matras, Arabic diacritics — and a variation selector is
   also a combining mark. Removing an emoji without this left its
   U+FE0F behind: nothing on screen, a stray byte in the plan, and no
   way for anybody to work out what was wrong with the line.

   The bidi overrides in here are the serious entry. They reorder the
   text that follows them, so a string can be made to DISPLAY in an
   order its characters are not in — which in a document about doses
   is a way to make a plan read differently from what it says.

   These are dropped SILENTLY and never named in the strip. Naming a
   character she cannot see, with a footer that would show a blank,
   explains nothing; and unlike a `#`, she did not press a key for it. */
const INVISIBLE = new RegExp(
  "[" +
  "\\u200B-\\u200F" + // zero-width space, ZWNJ, ZWJ, and the two marks
  "\\u202A-\\u202E" + // bidi embedding and override — see above
  "\\u2060-\\u206F" + // word joiner, invisible operators, deprecated formats
  "\\uFE00-\\uFE0F" + // variation selectors, the emoji leftover
  "\\uFEFF" +         // byte-order mark, pasted from a file
  "]"
);

/**
 * Clean a piece of text.
 *
 * @param  {string} text
 * @return {{text: string, dropped: string[]}}  the cleaned text, and
 *         the distinct characters that were thrown away — substituted
 *         ones are not reported, because nothing was lost.
 */
export function clean(text) {
  const out = [];
  const dropped = new Set();

  /* Spread rather than a plain loop: an emoji is two code units and
     indexing by character would cut it in half, leaving a lone
     surrogate that renders as a black diamond — a worse outcome than
     the emoji it was trying to remove. */
  for (const ch of String(text ?? "")) {
    const swap = SAME_THING.get(ch);
    if (swap !== undefined) { out.push(swap); continue; }
    // Before KEEP, because \p{M} would otherwise let these through.
    if (INVISIBLE.test(ch)) continue;
    if (KEEP.test(ch)) { out.push(ch); continue; }
    dropped.add(ch);
  }

  return { text: out.join(""), dropped: [...dropped] };
}

/* ============================================================
   THE HOUSE BULLET
   ------------------------------------------------------------
   Every list marker becomes "- ", at the start of a line only.

   This is the one substitution that exists for the assistant
   rather than for the printer. A line beginning with a dash is
   the strongest signal the model has that it is looking at one
   instruction, and she pastes lists out of Word and WhatsApp
   carrying four different bullets — •, ·, *, > — none of which
   it recognises and one of which (*) was being dropped entirely,
   silently turning a list into a paragraph.

   Position matters: only at the start of a line, so "7-8am" and
   "1 + 1" in the middle of a sentence are left alone.
   ============================================================ */
const BULLET = /^([ \t]*)[•·*>‣▪–—-]+[ \t]+/;

/** Normalise the list markers in a block of text. */
export function bullets(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(BULLET, "$1- "))
    .join("\n");
}

/* ============================================================
   TIDYING, AND WHY IT IS NOT DONE PER KEYSTROKE
   ------------------------------------------------------------
   Runs of spaces and stacks of blank lines are paste artefacts,
   and they cost the model tokens and clarity both. But collapsing
   them as she types means the second space she presses vanishes
   under her finger — a dropped keystroke with no explanation,
   which is the exact thing the strip under the pad exists to
   avoid.

   So this runs when she leaves the box. By then the thought is
   finished and nothing is being taken out from under her.
   ============================================================ */
export function tidy(text) {
  return bullets(text)
    .replace(/[ \t]+$/gm, "")      // trailing whitespace, invisible and pointless
    .replace(/[ \t]{2,}/g, " ")    // runs of spaces inside a line
    .replace(/\n{3,}/g, "\n\n");   // a blank line between blocks, never four
}

/**
 * Clean a textarea in place, keeping the caret where she left it.
 *
 * THE CARET IS THE WHOLE DIFFICULTY. Replacing `value` sends it to
 * the end, and a pad that jumps to the bottom every time you type an
 * apostrophe is unusable. Cleaning the text BEFORE the caret
 * separately gives its new position exactly, and survives a
 * substitution that changes length — one ellipsis becomes three full
 * stops, so counting removed characters would be two out.
 *
 * @return {string[]} the characters dropped, for whatever wants to say so
 */
export function cleanField(field) {
  /* BULLETS FIRST, AND THE ORDER IS THE WHOLE POINT. `*` and `>` are
     on the drop list, so cleaning before converting deletes the very
     character that identifies the line as a list item — a pasted
     "* two rotis" comes out as " two rotis", which is a paragraph
     with a stray space and reads to the assistant as prose. Convert
     the marker to the house dash while it is still there, then clean
     what is left. */
  const before = field.value;
  const step = clean(bullets(before));
  if (step.text === before) return [];

  const head = clean(bullets(before.slice(0, field.selectionStart))).text.length;
  field.value = step.text;
  field.setSelectionRange(head, head);
  return step.dropped;
}

/**
 * Tidy the whitespace once she has finished typing. Separate from
 * cleanField because it moves text about, and doing that under a
 * live caret is how an editor earns a reputation for fighting back.
 *
 * @return {boolean} whether anything actually moved
 */
export function tidyField(field) {
  const before = field.value;
  const after = tidy(before);
  if (after === before) return false;
  field.value = after;
  return true;
}
