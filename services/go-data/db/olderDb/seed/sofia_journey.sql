-- ============================================================
--  SOFIA D'SOUZA — booked, seen, assessed, and waiting for a plan
-- ------------------------------------------------------------
--  The state "Fetch and create" is meant to be pressed from: a
--  client who has had her first consultation, whose nutrition
--  assessment is complete and FINAL, and whose plan is an empty
--  draft.
--
--  DIRECTLY IN SQL rather than through the API, because that is
--  what a fixture is for: the API path is what the feature under
--  test uses, and building the fixture with it means a broken API
--  produces a broken fixture and a green test.
--
--  THE RECORD IS FLAT. crm.assessments.answers is keyed by FIELD
--  id — `food_allergies`, `meal_plan`, `weight_kg` — with no
--  section nesting anywhere. See fieldHTML(f, v[f.id]) in
--  crm/assets/js/nsf-form.js. An earlier version of this fixture
--  was written grouped by section, matched nothing the CRM has
--  ever saved, and hid a bug in the model's brief for an hour.
--
--  THE MEASUREMENTS ARE ROWS, not answers. Go splits the trended
--  fields out on save so they can be drawn as a curve; the BFF
--  folds them back into the flat shape on the way out. Both halves
--  are written here so the record matches what the form produces.
--
--  DELIBERATELY AWKWARD IN FOUR PLACES, because a fixture that
--  only contains easy cases proves nothing:
--
--    a milk allergy    the safety check has to catch paneer and
--                      buttermilk, neither of which says "milk"
--    with a tolerance  "tolerates small amounts of curd" must NOT
--                      be read as a ban
--    vegetarian        a plan with chicken in it is then wrong in
--                      a way the record can prove
--    night shifts      she eats at midnight; a textbook 8am
--                      breakfast is a plan she cannot follow
--
--      psql -d myf_trial -f services/go-data/db/seed/sofia_reset.sql
--      psql -d myf_trial -f services/go-data/db/seed/sofia_journey.sql
--
--  Run the reset first. This one assumes a clean record.
-- ============================================================

\set ON_ERROR_STOP on
\set sofia '''ca466ca3-fa88-4508-ba1c-863b048d9a9c'''

BEGIN;

-- ---- 1 · she is on file --------------------------------------
-- Already there; corrected rather than inserted, so the id every
-- other fixture and every saved link refers to stays the same.
UPDATE crm.people
   SET name         = 'Sofia D''Souza',
       email        = 'sofia.dsouza@example.com',
       phone        = '+919833077701',
       country_iso2 = 'IN',
       dob          = DATE '1992-03-14'
 WHERE id = :sofia;

-- ---- 2 · the consultation that happened ----------------------
-- Completed, three weeks ago. This is what the assessment hangs
-- off and what makes her a client rather than an enquiry.
INSERT INTO crm.consultations
  (id, person_id, issue, mode, status, source,
   scheduled_start_at, scheduled_end_at, confirmed_at, created_at, updated_at)
VALUES
  ('d1f0e100-0000-4000-8000-000000000001', :sofia,
   'Tired on night shifts, weight gain since the rota changed',
   'video', 'completed', 'chatbot',
   now() - interval '21 days', now() - interval '21 days' + interval '45 minutes',
   now() - interval '24 days', now() - interval '25 days', now() - interval '21 days');

INSERT INTO crm.consultation_outcomes
  (consultation_id, outcome, note, recorded_by, recorded_at)
VALUES
  ('d1f0e100-0000-4000-8000-000000000001', 'done',
   'Full first assessment taken. Plan to follow once the shift pattern is confirmed.',
   'Khadija', now() - interval '21 days');

-- ---- 3 · the assessment, complete and final ------------------
-- Eighty-three fields across twelve sections. The six trended ones
-- are written as measurements below and deliberately left out of
-- the narrative here, which is exactly what crmAssessmentSave does.
INSERT INTO crm.assessments
  (id, person_id, consultation_id, visit, amendment, ref, kind, status,
   answers, open_sections, notes, recorded_by, started_at, updated_at, finalised_at)
VALUES
  ('a55e5100-0000-4000-8000-000000000001', :sofia,
   'd1f0e100-0000-4000-8000-000000000001', 0, 0, 'sofiadsouza0_0',
   'first_visit', 'final',
   $json${
     "name": "Sofia D'Souza",
     "dob": "1992-03-14",
     "sex": "Female",
     "phone": "+919833077701",
     "email": "sofia.dsouza@example.com",
     "occupation": "Staff nurse, rotating shifts — three nights on, three off",
     "language": "English",
     "referral": "Her GP, after the last fasting glucose",
     "reason": "Tired all the time and putting on weight since the shift pattern changed two years ago. Wants to feel steady through a night shift without living on biscuits.",

     "usual_weight_kg": "70",
     "goal_weight_kg": "68",
     "measure_method": "Clinic scale",

     "conditions": "PCOS, diagnosed 2021 — irregular cycles, acne along the jaw. Borderline raised fasting glucose at the last check. Mild iron-deficiency anaemia in 2023.",
     "past_history": "Appendicectomy 2014. No other surgery. Two uncomplicated pregnancies, 2018 and 2021.",
     "family_history": "Mother type 2 diabetes at 52. Father hypertension. Maternal grandmother diabetes.",
     "medications": "Metformin 500 mg twice daily, with meals. Combined oral contraceptive.",
     "supplements": "None currently. Took an iron supplement for three months in 2023 and stopped.",
     "drug_allergies": "None known.",
     "food_allergies": "Cow's milk — bloating, cramps and loose stool within an hour. Not anaphylactic. Tolerates small amounts of curd.",
     "deficiency_signs": "Nails brittle and ridged. Hair shedding more than usual since the spring. No angular stomatitis.",

     "appetite": "Variable — no appetite at all on the first night shift, ravenous by the third",
     "chewing": "No trouble. Full dentition.",
     "nausea": "Occasional reflux if she eats late and lies down straight after. No vomiting.",
     "bowels": "Constipated on shift weeks — two or three days between. Normal on days off.",
     "bloating": "Most evenings, worse after bread and after milky tea",
     "discomfort": "Milk in tea reliably causes cramps within the hour. Curd in small amounts is fine. Large rice portions leave her heavy and sleepy.",

     "recall_24h": "Nothing before 11am. Tea with two biscuits at 11. Rice, dal and a potato sabzi about 2pm — two and a half cups of rice. Tea and three more biscuits at 5. Two chapatis with sabzi around 9pm. A piece of chocolate before bed.",
     "typical_day": "Skips breakfast entirely on shift days. Eats properly only in the evening. Grazes on whatever is in the staff room overnight — usually biscuits or namkeen.",
     "meal_pattern": "Two proper meals, both late. Breakfast almost never happens. No planned snack.",
     "portions": "Rice portions large — two to three cups at a sitting. Chapatis two to three.",
     "eating_out": "Twice a week, usually after a night shift. Pav bhaji or a dosa near the hospital.",
     "who_cooks": "Mother cooks on weekdays; Sofia cooks at weekends",
     "kitchen": "Full kitchen, confident cook, pressure cooker and a mixer. Limited time on shift days.",
     "fluid": "Under a litre most days. Forgets on shift. Fills the bottle and does not drink it.",
     "caffeine": "Five to six teas a day, all with two sugars. Black since the bloating started.",
     "alcohol": "Rarely — a glass of wine perhaps twice a year",
     "ssb": "Occasional — a cola on a long shift, maybe once a fortnight",
     "snacking": "Biscuits at every tea. Says it is boredom and tiredness rather than hunger. Worst between 2am and 4am when the ward is quiet.",
     "cravings": "Sweet things around 3pm and again at midnight",

     "pattern": "Vegetarian",
     "cultural": "No beef or pork in the house. Fasts on some Fridays — fruit and water only.",
     "likes": "Dal, paneer, idli, dosa, upma, poha, rajma, chana, fruit, curd, coconut chutney",
     "dislikes": "Bitter gourd, ridge gourd, brinjal",
     "avoiding": "Milk in tea since the bloating started. Uses black tea now.",
     "past_diets": "Tried a keto plan from an app in 2023 — lost 4 kg, gained 6 back in three months. Says she cannot keep anything up that stops her eating with the family.",

     "activity": "Nothing planned. On her feet the whole shift — perhaps 12,000 steps — then too tired to walk on days off.",
     "sedentary": "Forty minutes each way in the car on off days. Sits through handover twice a shift.",
     "sleep": "Broken. Five to six hours on shift weeks, catches up on days off. Room is bright in the morning.",
     "stress": "High during shift weeks. Settles within a day of finishing.",
     "smoking": "Never",
     "readiness": "7",
     "barriers": "Time on shift days, and the staff room having nothing in it but biscuits. Says she will not cook separately from the family.",
     "support": "Mother is willing to cook differently. Husband eats whatever is made.",
     "food_security": "No constraint. Happy to buy nuts, fruit and curd weekly.",

     "activity_factor": "1.375 light",
     "protein_g": "85",
     "fluid_ml": "2500",
     "carb_fat": "Lower-GI carbohydrate spread across four occasions. Fat around 30% of energy.",
     "condition_targets": "Even carbohydrate distribution for PCOS and the raised fasting glucose. Fibre 30 g for the constipation. Iron-rich foods with vitamin C at the same meal.",

     "pes_problem": "Excessive energy intake with irregular timing",
     "pes_etiology": "Related to shift work, skipped breakfast, and reliance on sweet snacks for energy overnight",
     "pes_signs": "As evidenced by 6.4 kg weight gain in eighteen months, waist 94 cm, BMI 29.1, and a 24-hour recall showing no intake before 11am followed by 2.5 cups of rice at 2pm",
     "ncpt": "NI-1.3",

     "prescription": "1650 kcal, protein 85 g, carbohydrate spread evenly across four occasions, fibre 30 g",
     "diet_type": "Lower-GI vegetarian, dairy-limited",
     "meal_plan": "Four eating occasions rather than two, arranged around the shift rather than the clock. Something with protein at every one. A planned snack she takes in with her, so the staff room biscuits stop being the only option at 3am.",
     "food_recs": "Swap two of the daily teas for water or a small buttermilk. Reduce rice to one cup and make up the volume with vegetables and dal. Keep roasted chana or nuts in her bag. Add a fruit with the mid-shift snack for the iron.",
     "supplement_recs": "Vitamin D 60,000 IU weekly for eight weeks — GP has already advised this",
     "education": "Carbohydrate spread and why it matters for PCOS. Why breakfast matters on a shift pattern. Reading a portion of rice by eye.",
     "counselling": "Motivational interviewing — she set the four-occasion goal herself",
     "handouts": "Portion guide, and the lower-GI swap list",

     "progress": "First visit — nothing to compare against yet.",
     "adherence": "First visit — no previous plan.",
     "follow_up": "2026-09-13",

     "consent": "Yes",
     "dietitian": "Khadija"
   }$json$::jsonb,
   '[]'::jsonb,
   'Bright, motivated, and completely defeated by the rota. The plan has to survive a night shift or it will not survive at all.',
   'Khadija',
   now() - interval '21 days', now() - interval '20 days', now() - interval '20 days');

-- ---- 4 · the numbers, as rows --------------------------------
-- What Go writes when the trended fields are saved. BMI, age and
-- waist-to-hip are DERIVED from these and never stored.
INSERT INTO crm.measurements
  (person_id, assessment_id, kind, metric, value, unit, method, source, taken_at)
VALUES
  (:sofia, 'a55e5100-0000-4000-8000-000000000001', 'body', 'weight_kg',    76.4, 'kg', 'Clinic scale', 'clinic', now() - interval '21 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001', 'body', 'height_cm',   162.0, 'cm', 'Clinic scale', 'clinic', now() - interval '21 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001', 'body', 'waist_cm',     94.0, 'cm', 'Clinic scale', 'clinic', now() - interval '21 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001', 'body', 'hip_cm',      108.0, 'cm', 'Clinic scale', 'clinic', now() - interval '21 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001', 'body', 'body_fat_pct', 38.2, '%',  'Bioimpedance', 'clinic', now() - interval '21 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001', 'body', 'lean_mass_kg', 47.2, 'kg', 'Bioimpedance', 'clinic', now() - interval '21 days');

-- ---- 5 · the goals she set -----------------------------------
-- THE DATABASE'S OWN VOCABULARY, not the form's. The kind is
-- 'behavioural' / 'short_term' / 'long_term' and the status is
-- lowercase — form-spec.js offers "Behavioural" and "Short-term"
-- because those are what a person reads, and something has to map
-- between the two. A fixture writing SQL directly has to use the
-- constraint's words.
INSERT INTO crm.goals
  (person_id, set_at_assessment_id, goal, kind, target_metric, target_value, due_on, status, created_at)
VALUES
  (:sofia, 'a55e5100-0000-4000-8000-000000000001',
   'Eat something with protein before every shift, five shifts out of six',
   'behavioural', NULL, NULL, current_date + 28, 'active', now() - interval '20 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001',
   'Take a planned snack in to work instead of the staff room biscuits',
   'behavioural', NULL, NULL, current_date + 28, 'active', now() - interval '20 days'),
  (:sofia, 'a55e5100-0000-4000-8000-000000000001',
   'Down to 72 kg', 'short_term', 'weight_kg', 72, current_date + 90, 'active', now() - interval '20 days');

-- ---- 6 · an empty plan, waiting -------------------------------
-- THE POINT OF THE WHOLE FIXTURE. A draft with nothing in it, a
-- full budget of three drafts and three reads, and a finalised
-- assessment sitting behind it. Press Fetch and create.
INSERT INTO crm.plans
  (id, person_id, consultation_id, plan_no, amendment, ref, status,
   body, private_note, targets, recorded_by, started_at, updated_at, reads, drafts)
VALUES
  ('b1a00100-0000-4000-8000-000000000001', :sofia,
   'd1f0e100-0000-4000-8000-000000000001', 0, 0, 'sofiadsouzap0_0', 'draft',
   '', '',
   -- The figures as they stood when it was opened, copied in rather
   -- than looked up later.
   '{"energy_kcal":"1650","protein_g":"85","fluid_ml":"2500","weight_kg":"76.4","activity_factor":"1.375 light"}'::jsonb,
   'Khadija', now() - interval '20 days', now() - interval '20 days', 0, 0);

-- ---- what is there now ----------------------------------------
SELECT 'consultations' AS table, count(*)::text AS n FROM crm.consultations WHERE person_id = :sofia
UNION ALL SELECT 'assessments  (final)', count(*)::text FROM crm.assessments WHERE person_id = :sofia AND status = 'final'
UNION ALL SELECT 'answer fields',        (SELECT count(*)::text FROM crm.assessments a,
                                            LATERAL jsonb_object_keys(a.answers) WHERE a.person_id = :sofia)
UNION ALL SELECT 'measurements',         count(*)::text FROM crm.measurements WHERE person_id = :sofia
UNION ALL SELECT 'goals',                count(*)::text FROM crm.goals        WHERE person_id = :sofia
UNION ALL SELECT 'plans (draft, empty)', count(*)::text FROM crm.plans        WHERE person_id = :sofia AND status = 'draft';

COMMIT;
