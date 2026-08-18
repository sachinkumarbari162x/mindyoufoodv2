/* ============================================================
   FROM ASSESSMENT — writing a first draft, not reading one back
   ------------------------------------------------------------
   ITS OWN FILE BECAUSE IT IS ITS OWN JOB, and the difference is
   not cosmetic. index.js reads Khadija's sentences into rows and
   its prompt says, in capitals, "You are READING, not advising.
   Never add an instruction she did not write." That rule is the
   reason the rest of this system is safe to run.

   This does the opposite thing: it takes the finalised nutrition
   assessment and WRITES a plan she has not written yet. It is the
   only place in the product where the model composes clinical
   advice, so everything about it is arranged to keep that fact
   visible and bounded:

     ONLY FROM A FINALISED ASSESSMENT. A draft assessment is a
     half-finished thought and a plan written from one would be
     confidently wrong. The route refuses anything else.

     IT WRITES ROWS, NOT PROSE. The same JSON contract propose()
     uses, through the same clean() — so the text she ends up
     editing is produced by compose() in the canonical syntax, and
     Build can always parse it. A model emitting free text would
     put her in the position of fixing punctuation the machine
     invented.

     NOTHING IS SAVED. It returns a proposal. It lands in the
     side-by-side preview beside whatever is in her pad, and she
     presses "Use this" or she does not. No row exists until she
     presses Build afterwards, and no client sees anything until
     she presses Issue after that. Three human steps, deliberately.

     WHAT IT IS TOLD IS BOUNDED. brief() below picks the fields
     that bear on what somebody should eat, and it names the ones
     it deliberately leaves out. The whole assessment is not sent:
     her private notes, the referral, the NCPT code and the
     admin section have no bearing on a meal plan and there is no
     reason for them to leave the building.

     AND IT IS CHECKED AFTERWARDS. safety.js re-reads the draft
     against the recorded allergies, pattern and dislikes, because
     a prompt is a request and this is a class of mistake that must
     not depend on one being honoured.
   ============================================================ */
"use strict";

const { KEY, MODEL, clean, askJSON } = require("./index");
const safety = require("./safety");

/* WRITING IS NOT EXTRACTION, so this one is not at zero.

   propose() runs at temperature 0 because reading the same plan
   twice must give the same rows. Here a little variation is the
   point: if the first draft is not right, the second press should
   produce a genuinely different plan rather than the same one with
   a comma moved. Still low — this is a clinical document, not a
   creative one. */
const TEMPERATURE = 0.3;

const SYSTEM = `You are a clinical dietitian's assistant. You are given a
finalised nutrition assessment and you write the FIRST DRAFT of the
client's daily plan. A qualified dietitian reads and edits everything
you write before the client sees any of it.

Return JSON only, shaped:
{"items":[{"kind":"meal","label":"...","quantity":150,"unit":"g","household":"one katori","schedule":"lunch","how":"..."}]}

Rules:
- "kind" is one of: meal, filler, supplement, activity, sleep, habit, other.
- "label" is what to do, in plain words a client will follow.
- "quantity" is a number or null. Use null when there is no sensible
  number — "half the plate" has no number.
- "unit" is a short word or "": "g", "ml", "cup", "chapatis", "minutes".
- "schedule" is when, and it must be SHORT and PLAIN: "breakfast",
  "before 9am", "lunch", "4pm", "daily", "weekly, Sunday",
  "after dinner, daily". Never leave it empty on a meal.

TWO MEASUREMENTS, NOT ONE.
"150 g of rice" is a number nobody has in their kitchen at eight in
the morning. "One katori" is. Give both: "quantity"/"unit" carry the
clinical amount she prescribed and is reviewed against, "household"
carries the same amount as it is served at home.
- "household" is a measure a person owns: "one katori", "two rotis",
  "a glass", "half a plate", "one fistful", "a tablespoon".
- Use the measures this kitchen actually uses. Katori, vati, glass,
  tumbler, ladle, fistful, plate, roti, dosa, idli.
- Leave "household" empty when the clinical amount IS the household
  one — "2 eggs" and "1 banana" need no translation.
- Never let the two disagree. If you cannot convert it honestly,
  leave "household" empty.

HOW IT IS TAKEN, not only what and when.
- "how" is the intake instruction, one short sentence: "chew slowly,
  do not drink water with it", "with the lemon, never with tea",
  "sip through the meal rather than after it", "warm, not from the
  fridge". Leave it empty rather than filling it with padding.
- On a supplement "how" is often the most important field on the row.

SUPPLEMENTS CARRY THEIR TIMING AND THEIR GAP.
- "timing" is one of exactly these five words, or "":
  "empty_stomach", "before_meal", "with_meal", "after_meal", "bedtime".
- "gapMinutes" is a number of minutes this must be kept away from
  the thing before it, or null. Iron two hours from tea, coffee,
  milk or calcium is 120. Calcium and iron an hour apart is 60.
- If two supplements must not be taken together, say so in "how" on
  BOTH of them, and give both a gapMinutes. A client reading only
  one row must still get it right.
- Fat-soluble vitamins (D, E, K, A) go with a meal containing fat.
  Say that in "how" and set timing to "with_meal".

WHAT TO EAT BETWEEN MEALS.
A plan with four meals and nothing in between is a plan that breaks
at 4pm. Give 2 to 4 rows of kind "filler":
- No schedule. A filler is conditional, not timed. Use "schedule"
  for the window it covers if there is one — "between lunch and
  dinner" — or leave it empty.
- Small, real and to hand: a fruit, buttermilk, roasted chana, two
  walnuts, a boiled egg, sprouts.
- They must obey the same pattern, allergies and limits as the
  meals. A filler is not an exception to the plan.
- Say in "how" when to reach for one: "if you are hungry before
  dinner", "on training days only".

MOVEMENT ROWS CARRY THEIR OWN DETAIL.
- "sets" is a number, "reps" is a string because it is often a range:
  "8-12", "10", "to failure".
- "restSeconds" is the rest between sets.
- "how" is the form cue or the caution, in one short sentence:
  "stop if your knee hurts", "keep the back flat", "you should be
  able to hold a conversation".
- Only give sets/reps/rest where they belong. A walk has none.
- Prefer ONE phrase. Use a comma only to join a frequency to a day or
  an occasion — "weekly, Sunday" and "after dinner, daily" are fine;
  "before the shift, around 7pm" is two ways of saying one thing and
  the second is enough. Anything longer belongs in the label.
- Do NOT include a "line" field. This plan came from an assessment,
  not from a line of anybody's text.

What to write:
- A full day of meals in the order they are eaten, using the meal
  pattern and timings the assessment gives. Match the food to what
  they already eat and to what they can cook.
- Their dietary pattern is absolute. A vegetarian plan contains no
  meat, fish or egg. A Jain plan contains no onion, garlic or root
  vegetables.
- Anything in "Allergies" is forbidden, including the obvious forms
  of it: no paneer, curd, butter or ghee in a milk-allergic plan.
- Respect the therapeutic diet and the condition-specific limits.
- If the assessment already contains a meal plan or food
  recommendations written by the dietitian, follow them. They are
  her clinical decisions; you are laying them out, not revising them.
- WHERE THE DIETITIAN AND THE ARITHMETIC DISAGREE, THE DIETITIAN WINS.
  "PRESCRIPTION" is her target and "ESTIMATED REQUIREMENT" is what the
  client burns at maintenance. A weight-loss plan is meant to sit
  below the estimate. Never average the two, and never raise her
  target towards the estimate.
- SUPPLEMENTS ARE NOT OPTIONAL IN EITHER DIRECTION. If
  "DIETITIAN'S SUPPLEMENTS" names anything, every one of them MUST
  appear as a row of kind "supplement", with the dose and frequency
  as written. She has already prescribed them and a draft that
  quietly drops one is worse than a draft with nothing in it. And
  never introduce a supplement she has not named.
- Add movement, sleep and fluid rows where the assessment gives
  something to base them on.

HOW MANY MEALS IS NOT YOURS TO DECIDE.
The request will end with a line beginning "SHAPE:". It says how
many eating occasions the dietitian wants and whether she wants
between-meal options. Produce EXACTLY that many meals — not one
fewer because the assessment only described two, and not one more
because a fifth seemed sensible. She has looked at this person and
chosen the number. If the assessment does not describe enough
occasions to fill it, build the rest from what they already eat.
- Every meal gets its own rows and its own time.
- Number them in the order they are EATEN, which for a night-shift
  worker means the first one is in the evening.
- Between 3 and 6 rows per meal. A meal with one line is a plan
  nobody can follow.

What not to do:
- Never invent a medical fact, a lab value or a diagnosis.
- Never prescribe a medicine or change a dose.
- Never write a calorie or macro figure into a label. The client's
  app shows rows to tick, not arithmetic.
- Never write a row you cannot ground in the assessment.
- No headings, no greetings, no explanations, no encouragement.
  Rows only.`;

/* ONE WORKED EXAMPLE, and it is deliberately a hard one: a
   vegetarian with a milk allergy and a nightshift job. It shows the
   shape of the answer, that the pattern and the allergy are both
   honoured, and that the timings follow the person's actual day
   rather than a textbook one. */
const SHOTS = [
  {
    role: "user",
    content: [
      "PERSON: 34, female. Works nights, sleeps 9am to 4pm.",
      "PATTERN: Vegetarian",
      "ALLERGIES: cow's milk — bloating and cramps",
      "CONDITIONS: PCOS",
      "GOAL: steady energy through the shift, lose 4 kg",
      "TYPICAL DAY: skips breakfast, tea and biscuits at 11pm, rice at 2am",
      "MEALS & TIMING: two meals, both after midnight",
      "NEEDS: 1600 kcal, protein 70 g",
      "DIETITIAN'S PLAN: three eating occasions across the shift, protein at each",
    ].join("\n"),
  },
  {
    role: "assistant",
    content: JSON.stringify({
      items: [
        {
          kind: "meal", label: "Poha with peanuts and sprouts",
          quantity: 200, unit: "g", household: "one katori", schedule: "7pm",
          how: "eat before the shift starts, not on the way in",
        },
        {
          kind: "meal", label: "Two chapatis with dal and a vegetable",
          quantity: 2, unit: "chapatis", household: "", schedule: "midnight",
          how: "half the plate the vegetable, and sit down to it",
        },
        {
          kind: "meal", label: "Roasted chana and a fruit, instead of the biscuits",
          quantity: 30, unit: "g", household: "one fistful", schedule: "3am",
          how: "this is the meal that decides the week — do not skip it",
        },
        {
          kind: "filler", label: "Buttermilk, no salt",
          quantity: 200, unit: "ml", household: "one glass", schedule: "",
          how: "if you are hungry between the shift meals",
        },
        {
          kind: "filler", label: "Two walnuts and a banana",
          quantity: 1, unit: "banana", household: "", schedule: "",
          how: "if the 3am hunger comes early",
        },
        {
          kind: "supplement", label: "Vitamin D 60,000 IU",
          quantity: 60000, unit: "IU", schedule: "weekly, Sunday",
          timing: "with_meal", gapMinutes: null,
          how: "with the meal that has the most fat in it",
        },
        {
          kind: "supplement", label: "Ferrous ascorbate 100 mg",
          quantity: 100, unit: "mg", schedule: "daily",
          timing: "after_meal", gapMinutes: 120,
          how: "keep two hours from tea, coffee and any milk, or most of the iron is lost",
        },
        {
          kind: "habit", label: "Half the plate should be vegetables at both meals",
          quantity: null, unit: "", schedule: "daily",
        },
        {
          kind: "habit", label: "Water", quantity: 2.5, unit: "l",
          household: "ten glasses", schedule: "daily",
          how: "spread across the shift, not all at the end",
        },
        {
          kind: "activity", label: "Walk after waking",
          quantity: 20, unit: "minutes", schedule: "daily",
          how: "you should be able to hold a conversation through it",
        },
        {
          kind: "activity", label: "Squats, wall push-ups and a row",
          quantity: null, unit: "", schedule: "Mon, Thu",
          sets: 3, reps: "10-12", restSeconds: 60,
          how: "stop the set if your form goes, not when it hurts",
        },
        {
          kind: "sleep", label: "Curtains shut and phone away by 9am",
          quantity: 7, unit: "hours", schedule: "daily",
        },
      ],
    }),
  },
];

/* ---- what the model is told --------------------------------------
   PICKED, NOT DUMPED. Everything below bears on what somebody
   should eat. What is deliberately left out, and why:

     private notes        hers, about the client, not for a machine
     referral, NCPT       administrative
     drug allergies       this writes food, and a drug allergy in a
                          food prompt invites the model to comment
                          on medication
     family history       relevant to risk, not to tomorrow's lunch
     phone, email         no reason for either to leave the building

   Anything blank is skipped rather than sent as an empty label — a
   prompt full of "DISLIKES:" with nothing after it teaches the model
   that the fields are decorative. */
/* THE RECORD IS FLAT, and this file read it as though it were
   grouped by section for its first hour of life.

   crm.assessments.answers is keyed by FIELD id — `food_allergies`,
   `meal_plan`, `weight_kg` — with no section nesting anywhere: see
   `fieldHTML(f, v[f.id])` in crm/assets/js/nsf-form.js and the
   assignment in pages/assessment.js. Reading `a.medical
   .food_allergies` found nothing on any record the form has ever
   produced, so the brief came out nearly empty and thin() would
   then refuse the whole thing. It only appeared to work because the
   seed had been written to the wrong shape as well. */
const LINES = [
  ["PERSON", (a) => person(a)],
  ["PATTERN", (a) => a.pattern],
  ["ALLERGIES", (a) => a.food_allergies],
  ["CONDITIONS", (a) => a.conditions],
  ["MEDICATIONS", (a) => a.medications],
  ["ALREADY TAKING", (a) => a.supplements],
  ["PHYSICAL SIGNS", (a) => a.deficiency_signs],
  ["GUT", (a) => join(a.appetite, a.bowels, a.bloating, a.nausea, a.discomfort, a.chewing)],
  ["WEIGHT", (a) => weight(a)],
  ["TYPICAL DAY", (a) => a.typical_day || a.recall_24h],
  ["YESTERDAY", (a) => (a.typical_day && a.recall_24h ? a.recall_24h : "")],
  ["MEALS & TIMING", (a) => a.meal_pattern],
  ["PORTIONS", (a) => a.portions],
  ["WHO COOKS", (a) => join(a.who_cooks, a.kitchen)],
  ["EATING OUT", (a) => a.eating_out],
  ["SNACKING", (a) => join(a.snacking, a.cravings)],
  ["DRINKS", (a) => join(a.fluid, a.caffeine, a.ssb, a.alcohol)],
  ["LIKES", (a) => a.likes],
  ["DISLIKES", (a) => a.dislikes],
  ["AVOIDING", (a) => a.avoiding],
  ["CULTURAL", (a) => a.cultural],
  ["TRIED BEFORE", (a) => a.past_diets],
  ["ACTIVITY", (a) => join(a.activity, a.sedentary)],
  ["SLEEP", (a) => a.sleep],
  ["STRESS", (a) => a.stress],
  ["READY TO CHANGE", (a) => a.readiness && `${a.readiness} out of 10`],
  ["BARRIERS", (a) => join(a.barriers, a.food_security)],
  ["SUPPORT", (a) => a.support],
  /* LABELLED AS AN ESTIMATE, because it is one and because her
     PRESCRIPTION sits four lines below it saying something else.

     This is Mifflin-St Jeor times the activity factor — what she
     burns, not what she should eat. For Sofia it comes out at 1988
     kcal while Khadija has prescribed 1650, which is the deficit
     being the whole point of the consultation. Sending both under
     the word "NEEDS" invited the model to split the difference. */
  ["ESTIMATED REQUIREMENT (maintenance, not the target)", (a) => needs(a)],
  ["CONDITION LIMITS", (a) => a.condition_targets],
  ["DIAGNOSIS", (a) => [a.pes_problem, a.pes_etiology, a.pes_signs].filter(Boolean).join(" — ")],
  ["PRESCRIPTION", (a) => a.prescription],
  ["THERAPEUTIC DIET", (a) => a.diet_type],
  ["DIETITIAN'S MEAL PLAN", (a) => a.meal_plan],
  ["DIETITIAN'S FOOD ADVICE", (a) => a.food_recs],
  ["DIETITIAN'S SUPPLEMENTS", (a) => a.supplement_recs],
  ["GOALS SET", (a) => a.progress],
  ["ADHERENCE SO FAR", (a) => a.adherence],
];

const join = (...bits) => bits.filter((b) => String(b ?? "").trim()).join("; ");

const numOf = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

function person(a) {
  const bits = [];
  const age = ageFrom(a.dob);
  if (age) bits.push(`${age}`);
  if (a.sex) bits.push(String(a.sex).toLowerCase());
  if (a.occupation) bits.push(a.occupation);
  if (a.reason) bits.push(`came about: ${a.reason}`);
  return bits.join(", ");
}

function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (365.2425 * 24 * 3600e3));
}

function weight(a) {
  const now = numOf(a.weight_kg);
  const goal = numOf(a.goal_weight_kg);
  const h = numOf(a.height_cm);
  const bits = [];
  if (now) bits.push(`${now} kg now`);
  if (goal) bits.push(`goal ${goal} kg`);
  if (now && h) bits.push(`BMI ${(now / ((h / 100) ** 2)).toFixed(1)}`);
  if (numOf(a.waist_cm)) bits.push(`waist ${numOf(a.waist_cm)} cm`);
  return bits.join(", ");
}

/* THE ENERGY TARGET IS DERIVED AND NEVER STORED, which is the second
   thing this file got wrong. nsf-form.js computes BMR from weight,
   height, age and sex (Mifflin-St Jeor) and multiplies by the
   activity factor, and stores neither — so that the numbers can
   never disagree with the weight above them.

   Reading `a.energy_kcal` therefore found nothing on a real record,
   and the single most important figure for a meal plan was silently
   missing from every brief. It is recomputed here, the same way, and
   only when every input for it is present. */
function needs(a) {
  const bits = [];

  const w = numOf(a.weight_kg);
  const h = numOf(a.height_cm);
  const age = ageFrom(a.dob);
  const factor = numOf(a.activity_factor);

  if (w && h && age && (a.sex === "Female" || a.sex === "Male")) {
    const bmr = 10 * w + 6.25 * h - 5 * age + (a.sex === "Male" ? 5 : -161);
    if (factor) bits.push(`${Math.round(bmr * factor)} kcal`);
    else bits.push(`BMR ${Math.round(bmr)} kcal, activity factor not set`);
  }

  if (a.protein_g) bits.push(`protein ${a.protein_g} g`);
  if (a.fluid_ml) bits.push(`fluid ${a.fluid_ml} ml`);
  if (a.carb_fat) bits.push(a.carb_fat);
  return bits.join(", ");
}

/**
 * The assessment as the model sees it. Also the thing to read when
 * somebody asks "what exactly did we send about this client".
 *
 * @param {object} values  the FLAT record — answers with the
 *        measurements folded back in, which is what crm/assessments.js
 *        `flatten` produces and what the form itself edits.
 */
function brief(values) {
  const a = values || {};
  const out = [];
  for (const [label, pick] of LINES) {
    let v;
    try { v = pick(a); } catch { v = null; }
    const said = String(v ?? "").replace(/\s+/g, " ").trim();
    if (said) out.push(`${label}: ${said.slice(0, 600)}`);
  }
  return out.join("\n");
}

/** Is there enough here to write a plan from? A finalised assessment
    with three fields filled in is finalised and still not a basis for
    anything, and answering that with a confident plan would be the
    worst outcome this button has. */
function thin(values) {
  const a = values || {};
  const musts = [
    a.typical_day || a.recall_24h,
    a.meal_pattern,
    a.meal_plan || a.food_recs || a.prescription || a.diet_type,
    a.pattern || a.conditions,
  ];
  return musts.filter((x) => String(x ?? "").trim()).length < 2;
}

/**
 * Write a first draft of the plan from a finalised assessment.
 *
 * @param {object} assessment  the finalised record, as Go returns it
 * @returns {Promise<{ok:boolean, items?:object[], warnings?:string[], why?:string}>}
 */
/* WHAT SHE ASKED FOR, cleaned. Defaults are four meals and
   between-meal options on, because that is the commonest plan this
   practice writes — but the number is hers and the model is told so
   in as many words. */
function shapeOf(shape) {
  const asked = Number(shape && shape.meals);
  const meals = Number.isFinite(asked) && asked >= 1 && asked <= 8 ? Math.round(asked) : 4;
  const fillers = !shape || shape.fillers !== false;
  return { meals, fillers };
}

async function draft(assessment, shape) {
  if (!KEY) return { ok: false, why: "the assistant is switched off" };
  const want = shapeOf(shape);

  /* `values`, not `answers`. crm/assessments.js folds the
     measurements — weight, height, waist — back out of their own
     table and into the flat shape the form edits. Reading `answers`
     directly loses every one of them, and a plan written without a
     weight is a plan written for nobody in particular. */
  const answers = assessment?.values || assessment?.answers || {};
  if (thin(answers)) {
    return {
      ok: false,
      why: "there is not enough in that assessment to write a plan from — " +
           "the dietary section and the intervention are what it reads",
    };
  }

  /* THE SHAPE GOES LAST, in the user message rather than the
     system one. A model weights the end of what it was just asked
     far more heavily than a rule it was given before the examples,
     and "exactly four meals" is the instruction most worth having
     obeyed. */
  const text =
    brief(answers) +
    `

SHAPE: exactly ${want.meals} eating occasions` +
    (want.fillers
      ? ", plus 2 to 4 between-meal options of kind \"filler\""
      : ", and no between-meal options");

  console.log(
    `[plan-ai] writing a draft from ${assessment.ref} ` +
      `(${text.length} chars, ${want.meals} meals${want.fillers ? " + fillers" : ""})`
  );

  const res = await askJSON([
    { role: "system", content: SYSTEM },
    ...SHOTS,
    { role: "user", content: text },
  ], TEMPERATURE);

  if (!res) return { ok: false, why: "the assistant did not answer" };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn(`[plan-ai] draft ${res.status}: ${detail.slice(0, 200)}`);
    return { ok: false, why: `the assistant refused (${res.status})` };
  }

  let parsed;
  try {
    const data = await res.json();
    parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return { ok: false, why: "the assistant's answer could not be read" };
  }

  /* THROUGH THE SAME VALIDATION AS EVERY OTHER ROW. `0` for the line
     count, so every `line` is nulled — these rows came from a record,
     not from a line of her prose, and pointing them at line 3 of an
     empty pad would be a lie the panel would then display. */
  let items = clean(parsed, 0).map((it) => ({ ...it, line: null }));

  if (!items.length) {
    return { ok: false, why: "the assistant did not write anything usable from that assessment" };
  }

  /* AND THEN CHECKED AGAINST THE RECORD IT CAME FROM. */
  const checked = safety.check(items, {
    allergies: answers.food_allergies,
    dislikes: answers.dislikes,
    avoiding: answers.avoiding,
    pattern: answers.pattern,
  });
  items = checked.items;

  if (checked.flagged) {
    console.warn(`[plan-ai] draft flagged ${checked.flagged} row(s): ${checked.why.join(" | ")}`);
  }

  /* DID IT GIVE HER WHAT SHE ASKED FOR?

     She chose the number of meals; a model does not always obey.
     Counting the eating occasions it actually produced and saying
     so is the difference between her noticing on the screen and
     her noticing three weeks later when a client asks where lunch
     went. Not an error — the draft is still useful and she is
     about to edit it — so it travels with the allergy warnings,
     in her words, on the same line of the page.

     Occasions, not rows: several rows share a meal. */
  const occasions = new Set(
    items
      .filter((i) => i.kind === "meal")
      .map((i) => (i.schedule || "").toLowerCase().trim() || i.label.toLowerCase())
  ).size;

  const notes = [...checked.why];
  if (occasions && occasions !== want.meals) {
    notes.push(
      `You asked for ${want.meals} meals and it wrote ${occasions}. ` +
        `Add or remove one before you build.`
    );
  }
  if (want.fillers && !items.some((i) => i.kind === "filler")) {
    notes.push("It did not write any between-meal options. Add them, or press Generate again.");
  }

  console.log(
    `[plan-ai] draft wrote ${items.length} row(s), ${occasions} meal(s) ` +
      `of ${want.meals} asked, from ${assessment.ref}`
  );
  return {
    ok: true,
    items,
    warnings: notes,
    model: `${MODEL}+draft`,
  };
}

module.exports = { draft, brief, thin };
