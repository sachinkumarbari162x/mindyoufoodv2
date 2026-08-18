/* ============================================================
   THE FORM, AS DATA
   ------------------------------------------------------------
   Moved here from trial/nsf/ when the record was integrated. The
   trial copy stays where it is so the prototype keeps working;
   this is the one the practice uses.
   ------------------------------------------------------------
   Twelve sections, straight from nutrition_assessment_form.txt,
   written as a structure rather than as markup. Changing what is
   asked is then an edit to this file and nothing else — which is
   the whole point, because this form WILL change and she is the
   only person who can say how.

   `when` is the field that makes it usable during a consultation:

       "now"    open by default. She is listening to somebody and
                can type this without breaking eye contact.
       "later"  collapsed. Filled before, or afterwards, or when a
                lab result turns up next week.

   Twelve open sections during a live call is a form nobody fills.
   ============================================================ */

/** Where a value comes from when a fresh assessment is opened.
 *
 *  "person"  — already known from the booking. Prefilled and
 *              editable; she is confirming, not typing.
 *  "carry"   — taken from her last assessment of this client, so a
 *              follow-up is a diff rather than a re-run.
 *  "calc"    — derived, never stored. See `derive` in nsf.js.
 */
export const SECTIONS = [
  {
    id: "intake",
    n: 1,
    title: "Client & intake",
    when: "now",
    note: "Everything here came from the booking. Correct anything that is wrong.",
    fields: [
      { id: "name", label: "Full name", type: "text", from: "person" },
      { id: "dob", label: "Date of birth", type: "date", from: "person" },
      { id: "age", label: "Age", type: "calc", hint: "from date of birth" },
      { id: "sex", label: "Sex", type: "choice", options: ["", "Female", "Male", "Other", "Prefer not to say"] },
      { id: "phone", label: "Phone", type: "tel", from: "person" },
      { id: "email", label: "Email", type: "email", from: "person" },
      { id: "occupation", label: "Occupation & work pattern", type: "text", from: "carry",
        hint: "Shift work changes when meals are possible." },
      { id: "language", label: "Preferred language", type: "text", from: "carry" },
      { id: "referral", label: "Referred by", type: "text" },
      { id: "reason", label: "Reason for visit, in their words", type: "long", wide: true,
        hint: "Their sentence, not a category." },
    ],
  },

  {
    id: "anthro",
    n: 2,
    title: "Anthropometrics",
    when: "now",
    note: "Each of these is a point on a curve. The curve is the useful part.",
    fields: [
      { id: "weight_kg", label: "Weight", unit: "kg", type: "number", step: "0.1", trend: true },
      { id: "height_cm", label: "Height", unit: "cm", type: "number", step: "0.5", from: "carry", trend: true },
      { id: "bmi", label: "BMI", type: "calc", hint: "weight ÷ height²" },
      { id: "usual_weight_kg", label: "Usual weight", unit: "kg", type: "number", step: "0.1", from: "carry" },
      { id: "weight_change", label: "Change since last", type: "calc", hint: "against the previous assessment" },
      { id: "goal_weight_kg", label: "Goal weight", unit: "kg", type: "number", step: "0.1", from: "carry" },
      { id: "waist_cm", label: "Waist", unit: "cm", type: "number", step: "0.5", trend: true },
      { id: "hip_cm", label: "Hip", unit: "cm", type: "number", step: "0.5", trend: true },
      { id: "whr", label: "Waist-to-hip", type: "calc" },
      { id: "body_fat_pct", label: "Body fat", unit: "%", type: "number", step: "0.1", trend: true },
      { id: "lean_mass_kg", label: "Lean mass", unit: "kg", type: "number", step: "0.1", trend: true },
      { id: "measure_method", label: "Measured by", type: "choice",
        options: ["", "Clinic scale", "Home scale", "Bioimpedance", "Skinfold", "Self-reported"] },
    ],
  },

  {
    id: "medical",
    n: 3,
    title: "Medical & health history",
    when: "later",
    note: "True between visits. Carried forward — confirm rather than retype.",
    fields: [
      { id: "conditions", label: "Current conditions", type: "long", wide: true, from: "carry",
        hint: "Diabetes, hypertension, PCOS, thyroid, IBS, CKD…" },
      { id: "past_history", label: "Past medical & surgical", type: "long", wide: true, from: "carry" },
      { id: "family_history", label: "Family history", type: "long", wide: true, from: "carry" },
      { id: "medications", label: "Medications", type: "long", wide: true, from: "carry" },
      { id: "supplements", label: "Supplements & herbals", type: "long", wide: true, from: "carry" },
      { id: "drug_allergies", label: "Drug allergies", type: "long", wide: true, from: "carry",
        hint: "With the reaction, not just the name." },
      { id: "food_allergies", label: "Food allergies & intolerances", type: "long", wide: true, from: "carry",
        hint: "Kept apart from drug allergies on purpose." },
      { id: "bp", label: "Blood pressure", type: "text", placeholder: "120/80", trend: true },
      { id: "deficiency_signs", label: "Physical signs", type: "long", wide: true,
        hint: "Hair, skin, nails, oral." },
    ],
  },

  {
    id: "labs",
    n: 3.5,
    title: "Lab values",
    when: "later",
    note: "Dated, because a value with no date cannot be trended.",
    repeat: true,
    row: [
      { id: "analyte", label: "Test", type: "text", placeholder: "HbA1c" },
      { id: "value", label: "Value", type: "text", placeholder: "6.2" },
      { id: "unit", label: "Unit", type: "text", placeholder: "%" },
      { id: "taken_on", label: "Taken on", type: "date" },
    ],
  },

  {
    id: "gi",
    n: 4,
    title: "Gastrointestinal & functional",
    when: "later",
    fields: [
      { id: "appetite", label: "Appetite", type: "choice", options: ["", "Good", "Poor", "Variable"] },
      { id: "chewing", label: "Chewing or swallowing", type: "text" },
      { id: "nausea", label: "Nausea, vomiting, reflux", type: "text" },
      { id: "bowels", label: "Bowel habits", type: "text", hint: "Frequency, constipation, diarrhoea." },
      { id: "bloating", label: "Bloating & gas", type: "text" },
      { id: "discomfort", label: "Food-related discomfort", type: "long", wide: true },
    ],
  },

  {
    id: "diet",
    n: 5,
    title: "Dietary assessment",
    when: "now",
    note: "The heart of the consultation. Type it as they say it.",
    fields: [
      { id: "recall_24h", label: "24-hour recall", type: "long", wide: true, rows: 5,
        hint: "Yesterday, from waking to sleeping." },
      { id: "typical_day", label: "A typical day", type: "long", wide: true, rows: 3 },
      { id: "meal_pattern", label: "Meals & timing", type: "text", hint: "How many, when, which get skipped." },
      { id: "portions", label: "Portion sizes", type: "text" },
      { id: "eating_out", label: "Eating out & takeaway", type: "text" },
      { id: "who_cooks", label: "Who cooks", type: "text", from: "carry" },
      { id: "kitchen", label: "Cooking skill & kitchen access", type: "text", from: "carry" },
      { id: "fluid", label: "Fluid intake", type: "text" },
      { id: "caffeine", label: "Caffeine", type: "text" },
      { id: "alcohol", label: "Alcohol", type: "text", hint: "Frequency and quantity." },
      { id: "ssb", label: "Sweetened drinks", type: "text" },
      { id: "snacking", label: "Snacking & emotional eating", type: "long", wide: true },
      { id: "cravings", label: "Cravings", type: "text" },
    ],
  },

  {
    id: "prefs",
    n: 6,
    title: "Preferences & restrictions",
    when: "later",
    note: "Carried forward. This is the section a client notices you remembered.",
    fields: [
      { id: "pattern", label: "Dietary pattern", type: "choice", from: "carry",
        options: ["", "Vegetarian", "Vegan", "Eggetarian", "Non-vegetarian", "Jain", "Pescatarian"] },
      { id: "cultural", label: "Cultural & religious practice", type: "long", wide: true, from: "carry",
        hint: "Halal, kosher, Jain, fasting days." },
      { id: "likes", label: "Likes", type: "long", wide: true, from: "carry" },
      { id: "dislikes", label: "Dislikes & aversions", type: "long", wide: true, from: "carry" },
      { id: "avoiding", label: "Currently avoiding, and why", type: "long", wide: true },
      { id: "past_diets", label: "Diets tried before, and how they went", type: "long", wide: true, from: "carry" },
    ],
  },

  {
    id: "lifestyle",
    n: 7,
    title: "Lifestyle & behaviour",
    when: "later",
    fields: [
      { id: "activity", label: "Activity", type: "long", wide: true,
        hint: "Type, how often, how long, how hard." },
      { id: "sedentary", label: "Sitting time / job activity", type: "text" },
      { id: "sleep", label: "Sleep", type: "text", hint: "Hours, and whether it is any good." },
      { id: "stress", label: "Stress", type: "text" },
      { id: "smoking", label: "Smoking", type: "choice", from: "carry",
        options: ["", "Never", "Former", "Current"] },
      { id: "readiness", label: "Readiness to change", type: "scale",
        hint: "1 not ready · 10 already started" },
      { id: "barriers", label: "Barriers", type: "long", wide: true,
        hint: "Time, money, family, knowing how." },
      { id: "support", label: "Support at home", type: "text", from: "carry" },
      { id: "food_security", label: "Budget & food access", type: "text", from: "carry" },
    ],
  },

  {
    id: "needs",
    n: 8,
    title: "Estimated needs",
    when: "later",
    note: "The numbers are calculated. The basis is a judgement, so the basis is what gets recorded.",
    fields: [
      { id: "activity_factor", label: "Activity factor", type: "choice",
        options: ["", "1.2 sedentary", "1.375 light", "1.55 moderate", "1.725 heavy", "1.9 athlete"] },
      { id: "bmr", label: "BMR", unit: "kcal", type: "calc", hint: "Mifflin-St Jeor" },
      { id: "energy_kcal", label: "Energy target", unit: "kcal", type: "calc" },
      { id: "protein_g", label: "Protein", unit: "g", type: "number", step: "1" },
      { id: "fluid_ml", label: "Fluid", unit: "ml", type: "number", step: "50" },
      { id: "carb_fat", label: "Carbohydrate / fat targets", type: "text" },
      { id: "condition_targets", label: "Condition-specific limits", type: "text",
        hint: "Sodium, potassium, fibre…" },
    ],
  },

  {
    id: "pes",
    n: 9,
    title: "Nutrition diagnosis",
    when: "now",
    note: "Three fields, never one paragraph — that separation is most of the value of the format.",
    fields: [
      { id: "pes_problem", label: "Problem", type: "long", wide: true,
        hint: "The nutrition problem itself." },
      { id: "pes_etiology", label: "Etiology", type: "long", wide: true,
        hint: "Related to — the cause." },
      { id: "pes_signs", label: "Signs & symptoms", type: "long", wide: true,
        hint: "As evidenced by — what you observed." },
      { id: "ncpt", label: "NCPT code", type: "text" },
    ],
  },

  {
    id: "plan",
    n: 10,
    title: "Intervention & plan",
    when: "later",
    fields: [
      { id: "prescription", label: "Nutrition prescription", type: "long", wide: true,
        hint: "Target energy, macro split." },
      { id: "diet_type", label: "Therapeutic diet", type: "text",
        hint: "Diabetic, renal, low-sodium, high-protein, texture-modified…" },
      { id: "meal_plan", label: "Meal plan / sample menu", type: "long", wide: true, rows: 5 },
      { id: "food_recs", label: "Food-based recommendations", type: "long", wide: true },
      { id: "supplement_recs", label: "Supplements recommended", type: "long", wide: true },
      { id: "education", label: "Education covered", type: "long", wide: true },
      { id: "counselling", label: "Counselling approach", type: "text" },
      { id: "handouts", label: "Handouts given", type: "text" },
    ],
  },

  {
    id: "goals",
    n: 11,
    title: "Goals & monitoring",
    when: "later",
    note: "Goals outlive the visit that set them, so they are rows rather than a paragraph.",
    repeat: true,
    row: [
      { id: "goal", label: "Goal", type: "text", placeholder: "A vegetable at lunch, 5 days a week" },
      { id: "kind", label: "Kind", type: "choice", options: ["Behavioural", "Short-term", "Long-term"] },
      { id: "metric", label: "Tracked by", type: "text", placeholder: "weight" },
      { id: "due_on", label: "By", type: "date" },
      { id: "status", label: "Status", type: "choice", options: ["Active", "Met", "Missed", "Dropped"] },
    ],
    fields: [
      { id: "progress", label: "Progress since last visit", type: "long", wide: true, when: "now" },
      { id: "adherence", label: "Adherence to the last plan", type: "long", wide: true },
      { id: "follow_up", label: "Follow-up on", type: "date" },
    ],
  },

  {
    id: "admin",
    n: 12,
    title: "Attachments & admin",
    when: "later",
    note: "Uploads are not in this trial — files need a storage decision before they need code.",
    fields: [
      { id: "consent", label: "Consent & privacy acknowledged", type: "choice",
        options: ["", "Yes", "Not yet"] },
      { id: "dietitian", label: "Seen by", type: "text", from: "carry" },
    ],
  },
];

/** Which sections open by default — the ones she can fill while
    somebody is talking to her. */
export const OPEN_BY_DEFAULT = SECTIONS.filter((s) => s.when === "now").map((s) => s.id);
