/* ============================================================
   SOFIA'S NUTRITION ASSESSMENT — complete, and finalised
   ------------------------------------------------------------
   The record "Fetch and create" writes a plan from.

   FLAT, KEYED BY FIELD ID, because that is what the form
   produces. crm.assessments.answers has no section nesting in it
   anywhere — see `fieldHTML(f, v[f.id])` in nsf-form.js and the
   assignment in pages/assessment.js. An earlier version of this
   file wrote it grouped by section, which looked tidier, matched
   nothing the CRM has ever saved, and hid a bug in the brief for
   an hour.

   MEASUREMENTS GO THROUGH THE FORM'S OWN PATH. Weight, height and
   waist are saved as `values` and Go writes them into
   crm.measurements as rows, so they can be drawn as a curve; the
   BFF folds them back into the flat shape on the way out. Sending
   them here the same way is what makes this seed a realistic
   record rather than a hand-made one.

   EVERY SECTION THE FORM RENDERS IS FILLED — all twelve, 83
   fields. A thin assessment is a fair test of the refusal and a
   useless test of the feature.

   DELIBERATELY AWKWARD IN FOUR PLACES, because a record that only
   contains easy cases proves nothing:

     a milk allergy      so the safety check has something to
                         catch beyond the literal word "milk"
     …with a tolerance   "tolerates small amounts of curd" must
                         NOT be read as a ban
     vegetarian          so a plan with chicken in it is wrong in
                         a way the record can prove
     night shifts        she eats at midnight; a textbook 8am
                         breakfast would be a plan she cannot
                         follow

       node services/go-data/db/seed/sofia_assessment.mjs

   Idempotent: run it twice and the assessment is amended rather
   than duplicated.
   ============================================================ */

const BFF = process.env.BFF_URL || "http://127.0.0.1:5502";
const GO = process.env.GO_DATA_URL || "http://127.0.0.1:5504";
const PERSON = "ca466ca3-fa88-4508-ba1c-863b048d9a9c";   // Sofia D'Souza

async function j(base, path, body, method) {
  const res = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method || "POST"} ${path} → ${res.status} ${JSON.stringify(out)}`);
  return out;
}

const go = (path, body, method) => j(GO, path, body, method);

/* ---- 1 · client & intake ---------------------------------------- */
const INTAKE = {
  name: "Sofia D'Souza",
  dob: "1992-03-14",
  sex: "Female",
  phone: "+919833077701",
  email: "sofia.dsouza@example.com",
  occupation: "Staff nurse, rotating shifts — three nights on, three off",
  language: "English",
  referral: "Her GP, after the last fasting glucose",
  reason:
    "Tired all the time and putting on weight since the shift pattern changed two years ago. " +
    "Wants to feel steady through a night shift without living on biscuits.",
};

/* ---- 2 · anthropometrics ---------------------------------------
   These three go in as measurements as well as answers — see the
   note at the top. age, BMI, waist-to-hip and the weight change are
   all derived by the form and never stored. */
const ANTHRO = {
  weight_kg: "76.4",
  height_cm: "162",
  usual_weight_kg: "70",
  goal_weight_kg: "68",
  waist_cm: "94",
  hip_cm: "108",
  body_fat_pct: "38.2",
  lean_mass_kg: "47.2",
  measure_method: "Clinic scale",
};

/* ---- 3 · medical & health history ------------------------------- */
const MEDICAL = {
  conditions:
    "PCOS, diagnosed 2021 — irregular cycles, acne along the jaw. " +
    "Borderline raised fasting glucose at the last check. Mild iron-deficiency anaemia in 2023.",
  past_history: "Appendicectomy 2014. No other surgery. Two uncomplicated pregnancies, 2018 and 2021.",
  family_history: "Mother type 2 diabetes at 52. Father hypertension. Maternal grandmother diabetes.",
  medications: "Metformin 500 mg twice daily, with meals. Combined oral contraceptive.",
  supplements: "None currently. Took an iron supplement for three months in 2023 and stopped.",
  drug_allergies: "None known.",
  food_allergies:
    "Cow's milk — bloating, cramps and loose stool within an hour. Not anaphylactic. " +
    "Tolerates small amounts of curd.",
  bp: "126/82",
  deficiency_signs: "Nails brittle and ridged. Hair shedding more than usual since the spring. No angular stomatitis.",
};

/* ---- 4 · gastrointestinal & functional -------------------------- */
const GI = {
  appetite: "Variable — no appetite at all on the first night shift, ravenous by the third",
  chewing: "No trouble. Full dentition.",
  nausea: "Occasional reflux if she eats late and lies down straight after. No vomiting.",
  bowels: "Constipated on shift weeks — two or three days between. Normal on days off.",
  bloating: "Most evenings, worse after bread and after milky tea",
  discomfort:
    "Milk in tea reliably causes cramps within the hour. Curd in small amounts is fine. " +
    "Large rice portions leave her heavy and sleepy.",
};

/* ---- 5 · dietary assessment ------------------------------------- */
const DIET = {
  recall_24h:
    "Nothing before 11am. Tea with two biscuits at 11. Rice, dal and a potato sabzi about 2pm — " +
    "two and a half cups of rice. Tea and three more biscuits at 5. Two chapatis with sabzi around " +
    "9pm. A piece of chocolate before bed.",
  typical_day:
    "Skips breakfast entirely on shift days. Eats properly only in the evening. " +
    "Grazes on whatever is in the staff room overnight — usually biscuits or namkeen.",
  meal_pattern: "Two proper meals, both late. Breakfast almost never happens. No planned snack.",
  portions: "Rice portions large — two to three cups at a sitting. Chapatis two to three.",
  eating_out: "Twice a week, usually after a night shift. Pav bhaji or a dosa near the hospital.",
  who_cooks: "Mother cooks on weekdays; Sofia cooks at weekends",
  kitchen: "Full kitchen, confident cook, pressure cooker and a mixer. Limited time on shift days.",
  fluid: "Under a litre most days. Forgets on shift. Fills the bottle and does not drink it.",
  caffeine: "Five to six teas a day, all with two sugars. Black since the bloating started.",
  alcohol: "Rarely — a glass of wine perhaps twice a year",
  ssb: "Occasional — a cola on a long shift, maybe once a fortnight",
  snacking:
    "Biscuits at every tea. Says it is boredom and tiredness rather than hunger. " +
    "Worst between 2am and 4am when the ward is quiet.",
  cravings: "Sweet things around 3pm and again at midnight",
};

/* ---- 6 · preferences & restrictions ----------------------------- */
const PREFS = {
  pattern: "Vegetarian",
  cultural: "No beef or pork in the house. Fasts on some Fridays — fruit and water only.",
  likes: "Dal, paneer, idli, dosa, upma, poha, rajma, chana, fruit, curd, coconut chutney",
  dislikes: "Bitter gourd, ridge gourd, brinjal",
  avoiding: "Milk in tea since the bloating started. Uses black tea now.",
  past_diets:
    "Tried a keto plan from an app in 2023 — lost 4 kg, gained 6 back in three months. " +
    "Says she cannot keep anything up that stops her eating with the family.",
};

/* ---- 7 · lifestyle & behaviour ---------------------------------- */
const LIFESTYLE = {
  activity: "Nothing planned. On her feet the whole shift — perhaps 12,000 steps — then too tired to walk on days off.",
  sedentary: "Forty minutes each way in the car on off days. Sits through handover twice a shift.",
  sleep: "Broken. Five to six hours on shift weeks, catches up on days off. Room is bright in the morning.",
  stress: "High during shift weeks. Settles within a day of finishing.",
  smoking: "Never",
  readiness: "7",
  barriers:
    "Time on shift days, and the staff room having nothing in it but biscuits. " +
    "Says she will not cook separately from the family.",
  support: "Mother is willing to cook differently. Husband eats whatever is made.",
  food_security: "No constraint. Happy to buy nuts, fruit and curd weekly.",
};

/* ---- 8 · estimated needs ---------------------------------------
   BMR and the energy target are DERIVED by the form from weight,
   height, age, sex and this factor, and are never stored. */
const NEEDS = {
  activity_factor: "1.375 light",
  protein_g: "85",
  fluid_ml: "2500",
  carb_fat: "Lower-GI carbohydrate spread across four occasions. Fat around 30% of energy.",
  condition_targets:
    "Even carbohydrate distribution for PCOS and the raised fasting glucose. " +
    "Fibre 30 g for the constipation. Iron-rich foods with vitamin C at the same meal.",
};

/* ---- 9 · nutrition diagnosis ------------------------------------ */
const PES = {
  pes_problem: "Excessive energy intake with irregular timing",
  pes_etiology:
    "Related to shift work, skipped breakfast, and reliance on sweet snacks for energy overnight",
  pes_signs:
    "As evidenced by 6.4 kg weight gain in eighteen months, waist 94 cm, BMI 29.1, " +
    "and a 24-hour recall showing no intake before 11am followed by 2.5 cups of rice at 2pm",
  ncpt: "NI-1.3",
};

/* ---- 10 · intervention & plan ----------------------------------- */
const PLAN = {
  prescription:
    "1650 kcal, protein 85 g, carbohydrate spread evenly across four occasions, fibre 30 g",
  diet_type: "Lower-GI vegetarian, dairy-limited",
  meal_plan:
    "Four eating occasions rather than two, arranged around the shift rather than the clock. " +
    "Something with protein at every one. A planned snack she takes in with her, so the staff " +
    "room biscuits stop being the only option at 3am.",
  food_recs:
    "Swap two of the daily teas for water or a small buttermilk. Reduce rice to one cup and make " +
    "up the volume with vegetables and dal. Keep roasted chana or nuts in her bag. Add a fruit " +
    "with the mid-shift snack for the iron.",
  supplement_recs: "Vitamin D 60,000 IU weekly for eight weeks — GP has already advised this",
  education:
    "Carbohydrate spread and why it matters for PCOS. Why breakfast matters on a shift pattern. " +
    "Reading a portion of rice by eye.",
  counselling: "Motivational interviewing — she set the four-occasion goal herself",
  handouts: "Portion guide, and the lower-GI swap list",
};

/* ---- 11 · goals & monitoring ------------------------------------ */
const GOALS = {
  progress: "First visit — nothing to compare against yet.",
  adherence: "First visit — no previous plan.",
  follow_up: "2026-09-13",
};

/* ---- 12 · attachments & admin ----------------------------------- */
const ADMIN = {
  consent: "Yes",
  dietitian: "Khadija",
};

/* The flat record, exactly as the form would have saved it. */
const VALUES = {
  ...INTAKE, ...ANTHRO, ...MEDICAL, ...GI, ...DIET,
  ...PREFS, ...LIFESTYLE, ...NEEDS, ...PES, ...PLAN, ...GOALS, ...ADMIN,
};

(async () => {
  console.log("Sofia's assessment\n");

  const opened = await go("/crm/assessments", { personId: PERSON, by: "seed" });
  let a = opened.assessment;
  console.log(`  ${opened.opened ? "opened" : "reusing"} ${a.ref} (${a.status})`);

  /* Already final from a previous run? Amend it, so this stays
     idempotent rather than refusing. */
  if (a.status === "final") {
    const amended = await go(`/crm/assessments/${a.id}/amend`, { by: "seed" });
    a = amended.assessment;
    console.log(`  amended to ${a.ref}`);
  }

  await go(`/crm/assessments/${a.id}`, { answers: VALUES, by: "seed" }, "PATCH");
  console.log(`  wrote ${Object.keys(VALUES).length} fields across 12 sections`);

  /* THE MEASUREMENTS NEED NO SEPARATE CALL. crmAssessmentSave splits
     the trended fields — weight, height, waist, hip, body fat, lean
     mass, BP — out of the narrative and writes them into
     crm.measurements itself, replacing rather than appending so a
     draft being corrected does not become a curve made of
     keystrokes. The PATCH above did all of it. */

  await go(`/crm/assessments/${a.id}/final`, { by: "seed" });
  console.log("  marked final\n");

  const back = await go(`/crm/assessments/${a.id}`);
  const v = back.assessment.answers;
  const bodyRows = (back.assessment.measurements||[]).filter(m=>m.kind==="body");
  console.log(`  ${back.assessment.ref} · ${back.assessment.status}`);
  console.log(`  fields stored:  ${Object.keys(v).length}`);
  console.log(`  allergy:        ${String(v.food_allergies).slice(0, 46)}…`);
  console.log(`  pattern:        ${v.pattern}`);
  console.log(`  measurements:   ${bodyRows.map(m=>m.metric+" "+m.value).join(", ")}`);
  console.log(`  therapeutic:    ${v.diet_type}`);
  console.log("\n  Fetch and create is live on her plan page.");
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
