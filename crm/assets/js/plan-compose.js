/* ============================================================
   PLAN COMPOSE — rows back into the house line
   ------------------------------------------------------------
   She writes a plan the way anybody writes a plan: prose,
   sentences, whatever came out in the room. The assistant reads
   that into rows. This turns the rows back into TEXT, in the shape
   the strip under the pad describes:

     - Two eggs and a slice of toast (2 eggs), before 9am

   WHY THAT IS WORTH DOING. Two audiences read this plan and they
   read different things. The client's app shows the ROWS — one
   tick each. The plan link shows the TEXT. When the text is prose
   and the rows are structured, the two drift: she edits a sentence
   and the row it came from is still the old instruction. Writing
   the text out from the rows makes one the source of the other,
   and the drift has nowhere to happen.

   IT IS NOT A REWRITE OF HER CLINICAL JUDGEMENT, and the
   distinction matters enough to say twice. Nothing here calls a
   model. It takes rows that already exist — every one of which she
   has read, and most of which she has confirmed — and lays them
   out. It cannot add an instruction, change an amount, or decide
   anything. If a row says two eggs, the line says two eggs.

   AND NOTHING USES IT WITHOUT SHOWING HER FIRST. The page puts the
   result beside what she wrote and she chooses. See plan.html.
   ============================================================ */

/** A number the way somebody writes it, not the way it is stored.
    2 rather than 2.0; 0.5 as "1/2", because half a cup is what a
    person says and 0.5 cup is what a database says. */
function amount(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (n === 0.5) return "1/2";
  if (n === 0.25) return "1/4";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/**
 * One row, as a line of the plan.
 *
 * ORDER IS THE POINT: dash, what to do, how much in brackets, when
 * after a comma. The dash tells the assistant this line is one
 * instruction; the brackets say the amount is a qualifier rather
 * than the instruction; the comma separates the occasion. All three
 * are the marks the strip under the pad names, used the way it says.
 */
/* ============================================================
   A FIELD, MADE SAFE TO PUT IN A LINE
   ------------------------------------------------------------
   The rows come from two places and neither can be trusted to be
   tidy. A model returns what it returns — a label that already
   starts with a dash, a schedule with a trailing comma, a unit
   with a stray colon. And she edits them by hand in the table,
   where nothing stops her typing a comma at the end.

   Either way the line built from them has to be CORRECT BY
   CONSTRUCTION. If a label arrives as "- Breakfast:" the naive
   join produces "- - Breakfast:, 8am", and that is not a
   punctuation preference — the assistant reads a leading dash as
   "this is one instruction", so a doubled one is a line it can no
   longer parse, and the next reading of her own plan comes back
   wrong.

   So every field is stripped of the marks that carry structure
   before it is placed where those marks mean something.
   ============================================================ */
function field(v) {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    /* Leading list markers. Hers or the model's — the line adds its
       own, and two dashes is a broken line rather than an emphatic
       one. */
    .replace(/^[\s\-–—•·*>]+/, "")
    /* Trailing structure. A label ending in ":" would collide with
       the colon the house line uses; one ending in "," would double
       the comma before the schedule. */
    .replace(/[\s,;:.\-]+$/, "")
    .trim();
}

/* TWO SHAPES FOR ONE ROW, and reading only one of them is a bug
   with a very quiet symptom.

   A row straight from the assistant carries `household`, `how`,
   `sets` at the top level — that is what the model's JSON and
   parse.js produce. The same row read back from the database
   carries them inside `detail`, because that is the column they
   live in. This function is handed both: the preview composes from
   the assistant's shape, and "recompose from the table" composes
   from the database's.

   Read only the flat one and every intake instruction vanishes the
   first time she reloads the page — the text still composes, still
   parses, and is quietly missing the half she cares most about.
   This is the same trap `leftovers` documents for line/sourceLine
   further down. */
const detailOf = (it, key) => {
  const flatValue = it[key];
  if (flatValue !== undefined && flatValue !== null && flatValue !== "") return flatValue;
  const d = it.detail;
  return d && typeof d === "object" ? d[key] : undefined;
};

export function line(it) {
  if (!it) return "";
  const label = field(it.label);
  if (!label) return "";

  let out = `- ${label}`;

  const qty = amount(it.quantity);
  const unit = field(it.unit);
  const detail = [qty, unit].filter(Boolean).join(" ");
  if (detail && !saysItAlready(label, it.quantity, qty, unit)) out += ` (${detail})`;

  /* THE HOUSEHOLD MEASURE, IN SQUARE BRACKETS.

     Round brackets already mean "the clinical amount" everywhere in
     this syntax, so the kitchen measure needs its own mark rather
     than a second pair of the same ones — "(150 g) (one katori)" is
     two amounts with nothing saying which is which.

     Left out when it repeats the label: a row reading "Two rotis"
     does not need "[2 rotis]" after it. */
  const household = field(detailOf(it, "household"));
  if (household && !new RegExp(`\\b${escapeRe(household)}\\b`, "i").test(out)) {
    out += ` [${household}]`;
  }

  /* SETS, REPS AND REST, IN BRACES. Only on the rows that have
     them — a walk with "{3 x 10}" after it is a walk somebody will
     stop and puzzle over. */
  const sets = detailOf(it, "sets");
  const reps = detailOf(it, "reps");
  const restSeconds = detailOf(it, "restSeconds");
  const move = [];
  if (sets && reps) move.push(`${sets} x ${field(reps)}`);
  else if (reps) move.push(field(reps));
  if (restSeconds) move.push(`${restSeconds} sec rest`);
  if (move.length) out += ` {${move.join(", ")}}`;

  /* THE SCHEDULE, PHRASE BY PHRASE.

     A recovered schedule is often several phrases joined by commas
     — "bed by eleven, aiming for seven hours" — and testing the
     whole string against the label finds nothing, because the label
     has the same words without the comma. So a row whose label was
     "Bed by eleven aiming for seven hours" came out as

       - Bed by eleven aiming for seven hours, bed by eleven, aiming for seven hours

     which is the kind of line that makes somebody distrust the
     whole feature. Each phrase is now checked on its own and only
     the ones the label does not already say are added. */
  const when = field(it.schedule)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !new RegExp(`\\b${escapeRe(s)}\\b`, "i").test(out))
    .join(", ");

  if (when) out += `, ${when}`;

  /* THE INSTRUCTION LAST, after an em dash.

     Everything before the dash is what and when; everything after
     is how. Kept at the end because it is the part she rewrites
     most — it is where her voice is — and because a parser looking
     for it only has to find the last dash on the line.

     Never a hyphen. The line already starts with one and the
     parser refuses a second, which is exactly the collision this
     avoids. */
  const how = field(detailOf(it, "how"));
  if (how) out += ` — ${how}`;

  return out;
}

/* ============================================================
   IS THE GENERATED PART LEGAL?
   ------------------------------------------------------------
   The check the composer has to pass, written as a function so it
   can be run in a test rather than believed.

   ITS SCOPE IS THE INSTRUCTIONS THIS FILE GENERATED, and only
   those. That is not a hedge — it is the distinction the whole
   feature rests on. A composed plan has two halves:

     generated   headings and instruction lines, built from rows.
                 Every one MUST start with "- " and be well formed,
                 because the assistant reads a leading dash as
                 "this line is one instruction" and the next thing
                 that happens to this text is being read again.

     carried     her own prose, moved through untouched. "Come
                 back in six weeks" has no dash and should not: it
                 is not an instruction and no row will ever be made
                 from it. Demanding a dash there would mean this
                 file rewriting her sentences, which is exactly
                 what it must never do.

   So compose() runs this on the generated half before appending
   the carried half, and callers checking a whole composed plan
   should pass the tail they gave it.
   ============================================================ */
export function check(text, opts = {}) {
  const skip = new Set(
    String(opts.tail || "").split("\n").map((l) => l.trim()).filter(Boolean)
  );
  return checkLines(text, skip);
}

function checkLines(text, skip = new Set()) {
  const bad = [];
  const headings = new Set(GROUPS.map(([, h]) => h));

  for (const raw of String(text || "").split("\n")) {
    const l = raw.trimEnd();
    if (!l.trim()) continue;
    if (headings.has(l.trim())) continue;
    // Her own prose, carried through. Not this file's to judge.
    if (skip.has(l.trim())) continue;

    if (!l.startsWith("- ")) { bad.push(`no leading dash: ${l}`); continue; }
    if (/^-\s*-/.test(l)) { bad.push(`doubled dash: ${l}`); continue; }
    if (l.trim() === "-") { bad.push("a dash with nothing after it"); continue; }
    if (/,\s*$/.test(l) || /:\s*$/.test(l)) { bad.push(`trailing separator: ${l}`); continue; }
    if (/\(\s*\)/.test(l)) { bad.push(`empty brackets: ${l}`); continue; }
  }

  return { ok: bad.length === 0, problems: bad };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* A number as it might already be written in her own words. She
   types "Two eggs"; the row stores 2 and "eggs". Checking only for
   the digit produced "- Two eggs (2 eggs)", which is exactly the
   kind of thing that makes somebody stop pressing a button. */
const AS_WORDS = {
  1: ["one", "a", "an"], 2: ["two"], 3: ["three"], 4: ["four"], 5: ["five"],
  6: ["six"], 7: ["seven"], 8: ["eight"], 9: ["nine"], 10: ["ten"],
  11: ["eleven"], 12: ["twelve", "a dozen"], 15: ["fifteen"], 20: ["twenty"],
  30: ["thirty"], 0.5: ["half"], 0.25: ["quarter"],
};

/**
 * Does the label already carry this amount?
 *
 * BOTH HALVES HAVE TO BE THERE. The unit alone is not enough —
 * "Almonds" contains "almonds", and dropping the bracket there
 * would throw away the fifteen, which is the only part of that row
 * that says anything. So the bracket goes only when the label
 * expresses the number AND the unit, in digits or in words.
 */
function saysItAlready(label, raw, shown, unit) {
  const text = String(label || "");
  if (!unit) return false;
  if (!new RegExp(`\\b${escapeRe(unit)}\\b`, "i").test(text)) return false;
  if (!shown) return true;

  /* THE RAW NUMBER FOR THE WORD LOOKUP, the displayed one for the
     digits. They are not the same thing: `amount(0.5)` is the string
     "1/2", and Number("1/2") is NaN — so looking the words up by the
     display form silently found nothing and "Half a cup of rice"
     came out as "Half a cup of rice (1/2 cup)". */
  const forms = [shown, ...(AS_WORDS[Number(raw)] || [])];
  return forms.some((f) => new RegExp(`\\b${escapeRe(String(f))}\\b`, "i").test(text));
}

/* Her words for the kinds, used as headings. The order is the order
   a day happens in, not the order the model returned — a plan that
   puts sleep between two meals is a plan somebody has to re-sort in
   their head every morning. */
const GROUPS = [
  ["meal", "Food"],
  /* Straight after the meals, because that is where the question
     comes up: somebody reads the four meals, works out the gap
     between two of them, and the answer needs to be the next thing
     on the page. */
  ["filler", "If you are hungry"],
  ["supplement", "Supplements"],
  ["activity", "Movement"],
  ["sleep", "Sleep"],
  ["habit", "Habits"],
  ["other", "Anything else"],
];

/**
 * Every live row, as the body of a plan.
 *
 * @param {object[]} items   rows from the assistant panel
 * @param {object}   opts
 * @param {boolean}  opts.grouped   headings by kind (default true)
 * @param {string}   opts.keep      text to carry through unchanged
 * @returns {string}
 */
export function compose(items, opts = {}) {
  const { grouped = true, keep = "" } = opts;

  /* REJECTED ROWS ARE NOT IN THE PLAN. She said they were wrong, and
     writing them back into the document she is about to issue would
     undo the only decision the panel exists to record. Proposals she
     has not ruled on are left out too — a row nobody has agreed to
     is not an instruction. */
  const live = (items || []).filter(
    (i) => i.status === "confirmed" || i.status === "edited"
  );
  if (!live.length) return "";

  const blocks = [];

  if (grouped) {
    for (const [kind, heading] of GROUPS) {
      const mine = live.filter((i) => i.kind === kind);
      if (!mine.length) continue;
      /* The heading has no colon on purpose. A colon would make the
         assistant read the heading as an instruction with detail
         after it, and it would be right to. */
      blocks.push(`${heading}\n${mine.map(line).join("\n")}`);
    }
  } else {
    blocks.push(live.map(line).join("\n"));
  }

  /* CHECKED BEFORE HER PROSE IS ADDED, so the assertion is about
     what this file generated and nothing else. A failure here means
     the composer has produced a line its own assistant cannot read
     back — worth shouting about in a console, and not worth
     refusing over: she can see the text and is about to choose. */
  const generated = blocks.join("\n\n");
  const verdict = checkLines(generated);
  if (!verdict.ok) {
    console.warn("[plan] composed text is not clean syntax:", verdict.problems);
  }

  /* ANYTHING SHE WROTE THAT IS NOT A ROW SURVIVES. A plan usually
     ends with a sentence that is not an instruction — "come back in
     six weeks", "ring me if the headaches carry on" — and no row
     will ever be made from it. Losing that because a button tidied
     the file would be the worst thing this could do. */
  const tail = String(keep || "").trim();
  return tail ? `${generated}\n\n${tail}` : generated;
}

/**
 * The lines of her text that produced no row.
 *
 * Used to work out what `compose` must carry through: anything the
 * assistant did not turn into an instruction is prose, and prose is
 * hers. Matched on the source line each row recorded, so a sentence
 * is only dropped when something was genuinely read out of it.
 */
export function leftovers(body, items) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");

  /* TWO NAMES FOR ONE NUMBER, and reading only one of them was a
     bug with a very visible symptom.

     A row straight from the assistant calls it `line` — that is the
     field name in the model's own JSON. The same row read back from
     the database calls it `sourceLine`, because that is the column.
     This function is handed both: the preview uses the model's
     rows, the older path used the stored ones.

     Looking only for `sourceLine` meant the model's rows matched
     nothing, every line of her plan counted as prose, and the whole
     original was appended under the generated plan — so accepting
     it left her with the plan written twice, the new version above
     the old one. */
  const used = new Set(
    (items || [])
      .map((i) => (i.sourceLine !== null && i.sourceLine !== undefined ? i.sourceLine : i.line))
      .filter((n) => Number.isInteger(n))
  );

  return lines
    .map((text, i) => ({ text, i }))
    .filter(({ text, i }) => !used.has(i) && text.trim())
    /* A heading she typed — "Breakfast", "Evening" — produced no row
       and is not prose worth keeping either, because compose writes
       its own headings. One word with no verb in it is the test. */
    .filter(({ text }) => text.trim().split(/\s+/).length > 2)
    .map(({ text }) => text.trim())
    .join("\n");
}
