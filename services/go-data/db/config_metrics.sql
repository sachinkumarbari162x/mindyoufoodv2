-- ============================================================
--  THE METRIC CATALOGUE
-- ------------------------------------------------------------
--  Everything this practice measures, calculates, flags or aims
--  at — in five tiers, because a number cannot be read without
--  knowing which kind it is.
--
--    RAW         somebody measured it. A scale, a lab report, a
--                watch, a client typing what they ate. The only
--                tier ever written directly.
--    CALCULATED  arithmetic on raw values. Deterministic, and
--                recomputed rather than stored — a stored BMI is
--                a BMI that is wrong the day after a weigh-in.
--    SIGNAL      a clinical reading of the numbers. NOT A
--                DIAGNOSIS: every one of these is a flag that
--                says look here, and the description says so.
--    ADHERENCE   what the client did with the plan, rather than
--                what their body did about it. Kept apart on
--                purpose — a client can follow a plan perfectly
--                and have it not work, and confusing the two is
--                how somebody is blamed for a plan that needed
--                changing.
--    GOAL        distance from a target SHE set for THIS person.
--                Meaningless without a goal row behind it.
--
--  REFERENCE RANGES ARE ADULT AND GENERAL. They are here so a
--  screen can say "below range" in words instead of leaving a
--  number for somebody to search the internet about at one in
--  the morning. They are not a substitute for her judgement and
--  the panel says as much beside them.
--
--  UNITS ARE NEVER WRITTEN ON A VALUE. Every metric names a
--  DIMENSION; the unit comes from the practice's standard at
--  display time. That is what makes "show me pounds" a setting
--  rather than a migration.
--
--    psql -d "$DATABASE_URL" -f db/config_metrics.sql
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- ============================================================
--  TIER 1 — RAW: ANTHROPOMETRY
-- ============================================================

INSERT INTO crm.metric_defs
  (key, tier, family, label, short_label, description, dimension, decimals,
   direction, ref_low, ref_high, bands, source, cadence, sex, sort) VALUES

('weight', 'raw', 'anthropometry', 'Weight', 'Weight',
 'Measured first thing, after the toilet, before eating, in the same clothes. Same scale every time — two scales disagree by more than a fortnight of progress.',
 'mass', 1, 'neutral', NULL, NULL, '{}', 'self', 'weekly', 'any', 10),

('height', 'raw', 'anthropometry', 'Height', 'Height',
 'Measured without shoes, heels together, looking straight ahead. Taken once and re-checked yearly — it changes slowly, and after fifty it changes downwards.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'yearly', 'any', 20),

('waist', 'raw', 'anthropometry', 'Waist circumference', 'Waist',
 'At the midpoint between the lowest rib and the top of the hip bone, at the end of a normal breath out. A better predictor of metabolic risk than weight, and it moves when weight does not.',
 'length', 1, 'lower_better', NULL, NULL,
 '{"asia_pacific":[{"to":80,"label":"Healthy","tone":"good","sex":"female"},{"label":"Raised","tone":"warn","sex":"female"}],"who":[{"to":88,"label":"Healthy","tone":"good","sex":"female"},{"label":"Raised","tone":"warn","sex":"female"}]}',
 'clinic', 'monthly', 'any', 30),

('hip', 'raw', 'anthropometry', 'Hip circumference', 'Hip',
 'At the widest point of the buttocks. On its own it says little; it exists so the waist-to-hip ratio can be worked out.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'monthly', 'any', 40),

('mid_upper_arm', 'raw', 'anthropometry', 'Mid-upper arm circumference', 'MUAC',
 'Midway between the shoulder and the elbow, arm hanging loose. Used where weight is unreliable — oedema, ascites, a client who cannot stand on a scale.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'monthly', 'any', 50),

('neck', 'raw', 'anthropometry', 'Neck circumference', 'Neck',
 'Below the larynx. Screens for sleep apnoea risk and feeds one of the body-fat estimates.',
 'length', 1, 'lower_better', NULL, NULL, '{}', 'clinic', 'quarterly', 'any', 60),

('chest', 'raw', 'anthropometry', 'Chest circumference', 'Chest',
 'At nipple level, at the end of a normal breath out.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'monthly', 'any', 70),

('thigh', 'raw', 'anthropometry', 'Thigh circumference', 'Thigh',
 'Midway between the hip and the knee. Tracked when the goal is muscle rather than weight.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'monthly', 'any', 80),

('calf', 'raw', 'anthropometry', 'Calf circumference', 'Calf',
 'At the widest point. Under 31 cm is one of the markers of muscle loss in older adults.',
 'length', 1, 'higher_better', 31, NULL, '{}', 'clinic', 'quarterly', 'any', 90),

('wrist', 'raw', 'anthropometry', 'Wrist circumference', 'Wrist',
 'Just above the wrist bone. Used to estimate frame size, which is what stops an ideal-weight figure being nonsense for a heavy-framed person.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'once', 'any', 100),

-- ============================================================
--  TIER 1 — RAW: BODY COMPOSITION
-- ============================================================

('body_fat_pct', 'raw', 'body_composition', 'Body fat', 'Body fat',
 'From a bioimpedance scale or callipers. Hydration moves it by several points, so it is read as a trend on the same device and never as a single figure.',
 'proportion', 1, 'lower_better', NULL, NULL,
 '{"who":[{"to":21,"label":"Low","tone":"warn","sex":"female"},{"to":33,"label":"Healthy","tone":"good","sex":"female"},{"to":39,"label":"Raised","tone":"warn","sex":"female"},{"label":"High","tone":"bad","sex":"female"}]}',
 'device', 'monthly', 'any', 110),

('skeletal_muscle_mass', 'raw', 'body_composition', 'Skeletal muscle mass', 'Muscle',
 'The mass of muscle attached to bone, from bioimpedance. The number that should NOT fall during weight loss.',
 'mass', 1, 'higher_better', NULL, NULL, '{}', 'device', 'monthly', 'any', 120),

('visceral_fat_rating', 'raw', 'body_composition', 'Visceral fat rating', 'Visceral fat',
 'The fat around the organs, as the scale''s own index. Over 12 is where it starts to matter metabolically, and it is the fat that responds first to a change in diet.',
 'score', 0, 'lower_better', NULL, 12, '{}', 'device', 'monthly', 'any', 130),

('total_body_water', 'raw', 'body_composition', 'Total body water', 'Body water',
 'From bioimpedance. Mostly useful for explaining why the weight moved three kilos in a week and none of it was fat.',
 'proportion', 1, 'neutral', NULL, NULL, '{}', 'device', 'monthly', 'any', 140),

('bone_mass', 'raw', 'body_composition', 'Bone mass', 'Bone',
 'From bioimpedance, and an estimate rather than a measurement. Watched for stability, not for change.',
 'mass', 1, 'neutral', NULL, NULL, '{}', 'device', 'quarterly', 'any', 150),

('tricep_skinfold', 'raw', 'body_composition', 'Tricep skinfold', 'Tricep fold',
 'Callipers, back of the upper arm, midway. Three readings and the median taken.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'monthly', 'any', 160),

('subscapular_skinfold', 'raw', 'body_composition', 'Subscapular skinfold', 'Subscapular fold',
 'Callipers, just below the shoulder blade, at 45 degrees.',
 'length', 1, 'neutral', NULL, NULL, '{}', 'clinic', 'monthly', 'any', 170),

('handgrip_strength', 'raw', 'body_composition', 'Handgrip strength', 'Grip',
 'A dynamometer, dominant hand, best of three. The most practical single marker of whether muscle is being kept.',
 'mass', 1, 'higher_better', NULL, NULL, '{}', 'clinic', 'quarterly', 'any', 180),

-- ============================================================
--  TIER 1 — RAW: VITALS
-- ============================================================

('systolic', 'raw', 'vitals', 'Systolic blood pressure', 'Systolic',
 'Sitting, arm at heart height, after five minutes still. The higher of the two numbers.',
 'pressure', 0, 'lower_better', 90, 120,
 '{"who":[{"to":120,"label":"Normal","tone":"good"},{"to":130,"label":"Elevated","tone":"warn"},{"to":140,"label":"Stage 1","tone":"warn"},{"to":180,"label":"Stage 2","tone":"bad"},{"label":"Crisis — seek care now","tone":"bad"}]}',
 'self', 'weekly', 'any', 200),

('diastolic', 'raw', 'vitals', 'Diastolic blood pressure', 'Diastolic',
 'The lower of the two numbers — the pressure between beats.',
 'pressure', 0, 'lower_better', 60, 80,
 '{"who":[{"to":80,"label":"Normal","tone":"good"},{"to":90,"label":"Stage 1","tone":"warn"},{"to":120,"label":"Stage 2","tone":"bad"},{"label":"Crisis — seek care now","tone":"bad"}]}',
 'self', 'weekly', 'any', 210),

('resting_hr', 'raw', 'vitals', 'Resting heart rate', 'Resting HR',
 'Taken before getting out of bed, or the lowest the watch saw overnight. Falls as fitness improves.',
 'rate', 0, 'lower_better', 50, 90, '{}', 'device', 'daily', 'any', 220),

('spo2', 'raw', 'vitals', 'Blood oxygen', 'SpO2',
 'Pulse oximeter, at rest, warm hands.',
 'proportion', 0, 'higher_better', 95, 100, '{}', 'device', 'as needed', 'any', 230),

('temperature', 'raw', 'vitals', 'Body temperature', 'Temp',
 'Recorded when illness is part of the picture, because appetite and requirement both change with a fever.',
 'temperature', 1, 'target_band', 36.1, 37.5, '{}', 'clinic', 'as needed', 'any', 240),

('respiratory_rate', 'raw', 'vitals', 'Respiratory rate', 'Resp rate',
 'Breaths per minute at rest, counted over a full minute.',
 'frequency', 0, 'target_band', 12, 20, '{}', 'clinic', 'as needed', 'any', 250),

-- ============================================================
--  TIER 1 — RAW: GLYCAEMIC
-- ============================================================

('fasting_glucose', 'raw', 'biochemistry', 'Fasting blood glucose', 'Fasting glucose',
 'After eight hours with nothing but water. The single most useful number in a diabetes plan.',
 'glucose', 0, 'lower_better', 70, 100,
 '{"who":[{"to":70,"label":"Low","tone":"warn"},{"to":100,"label":"Normal","tone":"good"},{"to":126,"label":"Prediabetes range","tone":"warn"},{"label":"Diabetes range","tone":"bad"}]}',
 'lab', 'quarterly', 'any', 300),

('post_prandial_glucose', 'raw', 'biochemistry', 'Post-meal blood glucose', 'PP glucose',
 'Two hours from the first mouthful, not from the last. Says what a particular meal actually did.',
 'glucose', 0, 'lower_better', 70, 140,
 '{"who":[{"to":140,"label":"Normal","tone":"good"},{"to":200,"label":"Prediabetes range","tone":"warn"},{"label":"Diabetes range","tone":"bad"}]}',
 'self', 'weekly', 'any', 310),

('random_glucose', 'raw', 'biochemistry', 'Random blood glucose', 'Random glucose',
 'Any time, unrelated to meals. Useful for spotting a problem, useless for tracking one.',
 'glucose', 0, 'lower_better', 70, 140, '{}', 'self', 'as needed', 'any', 320),

('hba1c', 'raw', 'biochemistry', 'HbA1c', 'HbA1c',
 'The average of roughly the last three months, so it cannot be improved by eating carefully for two days beforehand. Recheck no sooner than eight weeks apart.',
 'proportion', 1, 'lower_better', 4.0, 5.7,
 '{"who":[{"to":5.7,"label":"Normal","tone":"good"},{"to":6.5,"label":"Prediabetes","tone":"warn"},{"to":7.0,"label":"Diabetes, at target","tone":"warn"},{"label":"Diabetes, above target","tone":"bad"}]}',
 'lab', 'quarterly', 'any', 330),

('fasting_insulin', 'raw', 'biochemistry', 'Fasting insulin', 'Insulin',
 'Read alongside fasting glucose. Together they give HOMA-IR, which sees insulin resistance years before the glucose does.',
 'insulin', 1, 'lower_better', 2, 12, '{}', 'lab', 'yearly', 'any', 340),

-- ============================================================
--  TIER 1 — RAW: LIPIDS
-- ============================================================

('total_cholesterol', 'raw', 'biochemistry', 'Total cholesterol', 'Total chol',
 'The sum of the fractions. On its own it is the least informative number on a lipid panel.',
 'cholesterol', 0, 'lower_better', NULL, 200,
 '{"who":[{"to":200,"label":"Desirable","tone":"good"},{"to":240,"label":"Borderline","tone":"warn"},{"label":"High","tone":"bad"}]}',
 'lab', 'yearly', 'any', 400),

('ldl', 'raw', 'biochemistry', 'LDL cholesterol', 'LDL',
 'The fraction that deposits. The target depends on overall cardiac risk, so the bands here are general.',
 'cholesterol', 0, 'lower_better', NULL, 100,
 '{"who":[{"to":100,"label":"Optimal","tone":"good"},{"to":130,"label":"Near optimal","tone":"good"},{"to":160,"label":"Borderline","tone":"warn"},{"to":190,"label":"High","tone":"bad"},{"label":"Very high","tone":"bad"}]}',
 'lab', 'yearly', 'any', 410),

('hdl', 'raw', 'biochemistry', 'HDL cholesterol', 'HDL',
 'The fraction that carries cholesterol away. The one number on the panel where higher is better.',
 'cholesterol', 0, 'higher_better', 50, NULL,
 '{"who":[{"to":40,"label":"Low","tone":"bad","sex":"male"},{"to":50,"label":"Low","tone":"bad","sex":"female"},{"to":60,"label":"Acceptable","tone":"good"},{"label":"Protective","tone":"good"}]}',
 'lab', 'yearly', 'any', 420),

('triglycerides', 'raw', 'biochemistry', 'Triglycerides', 'Trigs',
 'The most diet-responsive number on the panel — refined carbohydrate and alcohol move it within weeks. Must be fasting or it means nothing.',
 'triglycerides', 0, 'lower_better', NULL, 150,
 '{"who":[{"to":150,"label":"Normal","tone":"good"},{"to":200,"label":"Borderline","tone":"warn"},{"to":500,"label":"High","tone":"bad"},{"label":"Very high","tone":"bad"}]}',
 'lab', 'yearly', 'any', 430),

('lipoprotein_a', 'raw', 'biochemistry', 'Lipoprotein(a)', 'Lp(a)',
 'Largely genetic and largely unmoved by diet. Measured once, because it changes the risk picture and not the plan.',
 'cholesterol', 0, 'lower_better', NULL, 30, '{}', 'lab', 'once', 'any', 440),

-- ============================================================
--  TIER 1 — RAW: HAEMATOLOGY AND IRON
-- ============================================================

('haemoglobin', 'raw', 'haematology', 'Haemoglobin', 'Hb',
 'The oxygen-carrying capacity of the blood. The commonest deficiency seen in this practice.',
 'haemoglobin', 1, 'higher_better', 12, 15,
 '{"who":[{"to":8,"label":"Severe anaemia","tone":"bad","sex":"female"},{"to":11,"label":"Moderate anaemia","tone":"bad","sex":"female"},{"to":12,"label":"Mild anaemia","tone":"warn","sex":"female"},{"label":"Normal","tone":"good","sex":"female"}]}',
 'lab', 'quarterly', 'any', 500),

('hematocrit', 'raw', 'haematology', 'Haematocrit', 'Hct',
 'The proportion of blood that is red cells. Moves with hydration as well as with iron.',
 'proportion', 1, 'target_band', 36, 46, '{}', 'lab', 'quarterly', 'any', 510),

('mcv', 'raw', 'haematology', 'Mean corpuscular volume', 'MCV',
 'The size of the red cells, and the fastest way to tell an iron-deficiency anaemia (small) from a B12 one (large).',
 'cell_volume', 1, 'target_band', 80, 100, '{}', 'lab', 'quarterly', 'any', 520),

('mch', 'raw', 'haematology', 'Mean corpuscular haemoglobin', 'MCH',
 'How much haemoglobin is in each red cell.',
 'micromass', 1, 'target_band', 27, 33, '{}', 'lab', 'quarterly', 'any', 530),

('rdw', 'raw', 'haematology', 'Red cell distribution width', 'RDW',
 'How varied the red cells are in size. Rises early in iron deficiency, often before the haemoglobin falls.',
 'proportion', 1, 'lower_better', 11.5, 14.5, '{}', 'lab', 'quarterly', 'any', 540),

('rbc', 'raw', 'haematology', 'Red cell count', 'RBC',
 'Cells per microlitre.',
 'cell_count', 2, 'target_band', NULL, NULL, '{}', 'lab', 'quarterly', 'any', 550),

('wbc', 'raw', 'haematology', 'White cell count', 'WBC',
 'Raised with infection. Relevant here because appetite and requirement both change when somebody is fighting one.',
 'cell_count', 0, 'target_band', 4000, 11000, '{}', 'lab', 'as needed', 'any', 560),

('platelets', 'raw', 'haematology', 'Platelet count', 'Platelets',
 'Part of the standard blood count.',
 'cell_count', 0, 'target_band', 150000, 450000, '{}', 'lab', 'as needed', 'any', 570),

('ferritin', 'raw', 'haematology', 'Ferritin', 'Ferritin',
 'Stored iron, and the first thing to fall — it empties long before the haemoglobin moves. Raised by inflammation, so a normal ferritin with a raised CRP proves nothing.',
 'ferritin', 0, 'higher_better', 15, 150,
 '{"who":[{"to":15,"label":"Depleted","tone":"bad"},{"to":30,"label":"Low","tone":"warn"},{"to":150,"label":"Normal","tone":"good"},{"label":"High","tone":"warn"}]}',
 'lab', 'quarterly', 'any', 580),

('serum_iron', 'raw', 'haematology', 'Serum iron', 'Iron',
 'Iron circulating right now. Swings with the last meal, so it is read with TIBC rather than alone.',
 'micromass', 0, 'target_band', 60, 170, '{}', 'lab', 'quarterly', 'any', 590),

('tibc', 'raw', 'haematology', 'Total iron binding capacity', 'TIBC',
 'How much iron the blood could carry. Rises when stores are empty.',
 'micromass', 0, 'target_band', 240, 450, '{}', 'lab', 'quarterly', 'any', 600),

-- ============================================================
--  TIER 1 — RAW: VITAMINS, THYROID, ORGAN FUNCTION
-- ============================================================

('vitamin_d', 'raw', 'biochemistry', 'Vitamin D (25-OH)', 'Vitamin D',
 'Deficient in most of this practice''s clients regardless of how much sun there is, which is why it is checked rather than assumed.',
 'vitamin_d', 1, 'higher_better', 30, 100,
 '{"who":[{"to":12,"label":"Severely deficient","tone":"bad"},{"to":20,"label":"Deficient","tone":"bad"},{"to":30,"label":"Insufficient","tone":"warn"},{"to":100,"label":"Sufficient","tone":"good"},{"label":"High","tone":"warn"}]}',
 'lab', 'yearly', 'any', 700),

('vitamin_b12', 'raw', 'biochemistry', 'Vitamin B12', 'B12',
 'Low in long-standing vegetarian diets and in anyone on metformin for years. Symptoms appear late.',
 'b12', 0, 'higher_better', 200, 900,
 '{"who":[{"to":200,"label":"Deficient","tone":"bad"},{"to":300,"label":"Borderline","tone":"warn"},{"label":"Normal","tone":"good"}]}',
 'lab', 'yearly', 'any', 710),

('folate', 'raw', 'biochemistry', 'Serum folate', 'Folate',
 'Read with B12 — treating one while the other is low masks the problem.',
 'ferritin', 1, 'higher_better', 3, 20, '{}', 'lab', 'yearly', 'any', 720),

('tsh', 'raw', 'biochemistry', 'Thyroid stimulating hormone', 'TSH',
 'The screening test for thyroid function. Rises before the thyroid hormones fall.',
 'thyrotropin', 2, 'target_band', 0.4, 4.0,
 '{"who":[{"to":0.4,"label":"Low — overactive","tone":"warn"},{"to":4.0,"label":"Normal","tone":"good"},{"to":10,"label":"Subclinical underactive","tone":"warn"},{"label":"Underactive","tone":"bad"}]}',
 'lab', 'yearly', 'any', 730),

('free_t4', 'raw', 'biochemistry', 'Free T4', 'Free T4',
 'The circulating thyroid hormone. Checked when the TSH is abnormal.',
 'ferritin', 2, 'target_band', 0.8, 1.8, '{}', 'lab', 'as needed', 'any', 740),

('free_t3', 'raw', 'biochemistry', 'Free T3', 'Free T3',
 'The active thyroid hormone. Falls in prolonged severe restriction, which is a reason to stop restricting.',
 'ferritin', 2, 'target_band', 2.3, 4.2, '{}', 'lab', 'as needed', 'any', 750),

('serum_creatinine', 'raw', 'biochemistry', 'Serum creatinine', 'Creatinine',
 'Kidney function, and the reason a high-protein plan is not written for everybody. Rises with muscle mass as well as with kidney trouble.',
 'creatinine', 2, 'lower_better', 0.6, 1.2, '{}', 'lab', 'yearly', 'any', 760),

('blood_urea', 'raw', 'biochemistry', 'Blood urea', 'Urea',
 'Rises with a high protein intake, with dehydration, and with kidney impairment — so it is never read on its own.',
 'urea', 0, 'target_band', 15, 40, '{}', 'lab', 'yearly', 'any', 770),

('uric_acid', 'raw', 'biochemistry', 'Uric acid', 'Uric acid',
 'Raised by alcohol, fructose and rapid weight loss. The reason a crash diet can trigger gout.',
 'urate', 1, 'lower_better', 2.5, 6.0, '{}', 'lab', 'yearly', 'any', 780),

('alt', 'raw', 'biochemistry', 'ALT', 'ALT',
 'A liver enzyme. Mildly raised is the commonest sign of fatty liver, which is the most diet-reversible thing on this list.',
 'enzyme', 0, 'lower_better', NULL, 40, '{}', 'lab', 'yearly', 'any', 790),

('ast', 'raw', 'biochemistry', 'AST', 'AST',
 'A liver enzyme, less specific than ALT. The ratio between them is what carries the information.',
 'enzyme', 0, 'lower_better', NULL, 40, '{}', 'lab', 'yearly', 'any', 800),

('alp', 'raw', 'biochemistry', 'Alkaline phosphatase', 'ALP',
 'Liver and bone. Raised in vitamin D deficiency, which is how it earns a place here.',
 'enzyme', 0, 'target_band', 44, 147, '{}', 'lab', 'yearly', 'any', 810),

('albumin', 'raw', 'biochemistry', 'Serum albumin', 'Albumin',
 'A poor marker of nutrition and a good one of inflammation, contrary to how it is usually used. Included so it is read correctly rather than not at all.',
 'protein', 1, 'higher_better', 3.5, 5.0, '{}', 'lab', 'yearly', 'any', 820),

('total_protein', 'raw', 'biochemistry', 'Total protein', 'Protein',
 'Albumin plus globulins.',
 'protein', 1, 'target_band', 6.0, 8.3, '{}', 'lab', 'yearly', 'any', 830),

('sodium_serum', 'raw', 'biochemistry', 'Serum sodium', 'Sodium',
 'Tightly regulated, so an abnormal one is usually about water rather than about salt intake.',
 'electrolyte', 0, 'target_band', 135, 145, '{}', 'lab', 'as needed', 'any', 840),

('potassium_serum', 'raw', 'biochemistry', 'Serum potassium', 'Potassium',
 'Matters before recommending a high-potassium diet to anybody with kidney impairment.',
 'electrolyte', 1, 'target_band', 3.5, 5.1, '{}', 'lab', 'as needed', 'any', 850),

('calcium_serum', 'raw', 'biochemistry', 'Serum calcium', 'Calcium',
 'Read alongside vitamin D and albumin — a low albumin makes the calcium look low when it is not.',
 'micromass', 1, 'target_band', 8.5, 10.5, '{}', 'lab', 'yearly', 'any', 860),

('magnesium_serum', 'raw', 'biochemistry', 'Serum magnesium', 'Magnesium',
 'Low in long-standing diabetes and in heavy drinkers.',
 'micromass', 2, 'target_band', 1.7, 2.2, '{}', 'lab', 'as needed', 'any', 870),

('crp', 'raw', 'biochemistry', 'C-reactive protein', 'CRP',
 'Inflammation. Its main job here is to tell you whether the ferritin can be believed.',
 'inflammation', 1, 'lower_better', NULL, 3, '{}', 'lab', 'as needed', 'any', 880),

('esr', 'raw', 'biochemistry', 'ESR', 'ESR',
 'A slower marker of inflammation than CRP.',
 'sedimentation', 0, 'lower_better', NULL, 20, '{}', 'lab', 'as needed', 'any', 890),

-- ============================================================
--  TIER 1 — RAW: INTAKE
--  Self-reported, all of it. Under-reporting of 20 to 30 per
--  cent is the norm and is not dishonesty — it is what happens
--  when anybody writes down what they ate.
-- ============================================================

('energy_intake', 'raw', 'intake', 'Energy intake', 'Calories',
 'What was eaten, as recorded. Compared against the prescription rather than against the estimated requirement.',
 'energy', 0, 'target_band', NULL, NULL, '{}', 'self', 'daily', 'any', 1000),

('protein_intake', 'raw', 'intake', 'Protein intake', 'Protein',
 'The first thing to check when weight is coming off — protein is what decides whether the loss is fat or muscle.',
 'micromass', 0, 'higher_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1010),

('carb_intake', 'raw', 'intake', 'Carbohydrate intake', 'Carbs',
 'Total, not net. Where it sits in the day matters as much as how much.',
 'micromass', 0, 'target_band', NULL, NULL, '{}', 'self', 'daily', 'any', 1020),

('fat_intake', 'raw', 'intake', 'Fat intake', 'Fat',
 'Total fat, including what the cooking added.',
 'micromass', 0, 'target_band', NULL, NULL, '{}', 'self', 'daily', 'any', 1030),

('saturated_fat_intake', 'raw', 'intake', 'Saturated fat', 'Sat fat',
 'Ghee, coconut, full-fat dairy, red meat. Under 10 per cent of energy is the usual target.',
 'micromass', 0, 'lower_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1040),

('fibre_intake', 'raw', 'intake', 'Fibre intake', 'Fibre',
 'Almost universally short. 25 to 30 g a day, and it has to be raised slowly or it causes exactly the bloating it is meant to fix.',
 'micromass', 0, 'higher_better', 25, NULL, '{}', 'self', 'daily', 'any', 1050),

('sugar_intake', 'raw', 'intake', 'Free sugar intake', 'Sugar',
 'Added sugar and juice, not the sugar in whole fruit.',
 'micromass', 0, 'lower_better', NULL, 25, '{}', 'self', 'daily', 'any', 1060),

('sodium_intake', 'raw', 'intake', 'Sodium intake', 'Sodium',
 'Mostly not from the salt shaker — pickle, papad, packet masala and eating out are where it hides.',
 'micromass', 0, 'lower_better', NULL, 2000, '{}', 'self', 'daily', 'any', 1070),

('potassium_intake', 'raw', 'intake', 'Potassium intake', 'Potassium',
 'Works against the sodium. Raising it is usually easier than cutting salt.',
 'micromass', 0, 'higher_better', 3500, NULL, '{}', 'self', 'daily', 'any', 1080),

('calcium_intake', 'raw', 'intake', 'Calcium intake', 'Calcium',
 'Watched closely in a dairy-free plan.',
 'micromass', 0, 'higher_better', 1000, NULL, '{}', 'self', 'daily', 'any', 1090),

('iron_intake', 'raw', 'intake', 'Iron intake', 'Iron',
 'Plant iron is absorbed far less well than animal iron, so the target is higher on a vegetarian plan and vitamin C alongside it matters more.',
 'micromass', 1, 'higher_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1100),

('water_intake', 'raw', 'intake', 'Water intake', 'Water',
 'Everything drunk that is not caffeinated or alcoholic.',
 'volume', 0, 'higher_better', 2000, NULL, '{}', 'self', 'daily', 'any', 1110),

('alcohol_intake', 'raw', 'intake', 'Alcohol', 'Alcohol',
 'In units. Asked without comment, because a number given honestly is worth more than a lecture.',
 'alcohol', 1, 'lower_better', NULL, 14, '{}', 'self', 'weekly', 'any', 1120),

('caffeine_intake', 'raw', 'intake', 'Caffeine', 'Caffeine',
 'Cups a day, and when the last one was — the timing matters more than the total for anybody sleeping badly.',
 'count', 0, 'lower_better', NULL, 4, '{}', 'self', 'daily', 'any', 1130),

('meals_per_day', 'raw', 'behaviour', 'Eating occasions', 'Meals',
 'How many times a day food was eaten, counting everything.',
 'count', 0, 'target_band', NULL, NULL, '{}', 'self', 'daily', 'any', 1140),

('eating_window', 'raw', 'behaviour', 'Eating window', 'Eating window',
 'First mouthful to last. Shortening it is often more achievable than counting anything.',
 'duration', 1, 'lower_better', NULL, 12, '{}', 'self', 'daily', 'any', 1150),

-- ============================================================
--  TIER 1 — RAW: ACTIVITY AND SLEEP
-- ============================================================

('steps', 'raw', 'activity', 'Steps', 'Steps',
 'The least demanding measure of movement there is, and the one most people will actually keep.',
 'steps', 0, 'higher_better', 7000, NULL, '{}', 'device', 'daily', 'any', 1200),

('active_minutes', 'raw', 'activity', 'Active minutes', 'Active mins',
 'Minutes at moderate intensity or above.',
 'duration', 0, 'higher_better', 30, NULL, '{}', 'device', 'daily', 'any', 1210),

('exercise_sessions', 'raw', 'activity', 'Exercise sessions', 'Sessions',
 'Deliberate training, as distinct from moving about.',
 'count', 0, 'higher_better', 3, NULL, '{}', 'self', 'weekly', 'any', 1220),

('exercise_minutes', 'raw', 'activity', 'Exercise minutes', 'Exercise',
 'Total minutes of deliberate training in a week. 150 is the usual floor.',
 'duration', 0, 'higher_better', 150, NULL, '{}', 'self', 'weekly', 'any', 1230),

('resistance_sessions', 'raw', 'activity', 'Resistance sessions', 'Strength',
 'Twice a week is what protects muscle during weight loss, and it is the part that gets dropped first.',
 'count', 0, 'higher_better', 2, NULL, '{}', 'self', 'weekly', 'any', 1240),

('sedentary_hours', 'raw', 'activity', 'Sedentary hours', 'Sitting',
 'Hours sitting, awake. Independent of how much exercise was done.',
 'duration', 1, 'lower_better', NULL, 8, '{}', 'device', 'daily', 'any', 1250),

('sleep_duration', 'raw', 'sleep', 'Sleep duration', 'Sleep',
 'Time actually asleep. Under seven hours raises appetite and lowers the chance of any plan working.',
 'duration', 1, 'target_band', 7, 9, '{}', 'self', 'daily', 'any', 1300),

('sleep_onset', 'raw', 'sleep', 'Time to fall asleep', 'Sleep onset',
 'Lights out to asleep. Over thirty minutes most nights is worth attention.',
 'duration', 0, 'lower_better', NULL, 30, '{}', 'self', 'daily', 'any', 1310),

('night_wakings', 'raw', 'sleep', 'Night wakings', 'Wakings',
 'Times woken and remembered. Frequent waking with a full bladder is worth a glucose check.',
 'count', 0, 'lower_better', NULL, 2, '{}', 'self', 'daily', 'any', 1320),

('sleep_quality', 'raw', 'sleep', 'Sleep quality', 'Sleep quality',
 'Their own rating out of ten. Subjective and useful — it predicts how the day goes better than the duration does.',
 'score', 0, 'higher_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1330),

-- ============================================================
--  TIER 1 — RAW: HOW THEY ARE
-- ============================================================

('energy_level', 'raw', 'wellbeing', 'Energy level', 'Energy',
 'Out of ten. The first thing to improve on a plan that is working, and it improves before the weight does.',
 'score', 0, 'higher_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1400),

('hunger_level', 'raw', 'wellbeing', 'Hunger', 'Hunger',
 'Out of ten. Persistent high hunger means the plan is too aggressive, not that the client is weak.',
 'score', 0, 'lower_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1410),

('mood', 'raw', 'wellbeing', 'Mood', 'Mood',
 'Out of ten.', 'score', 0, 'higher_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1420),

('stress_level', 'raw', 'wellbeing', 'Stress', 'Stress',
 'Out of ten. Drives eating behaviour more reliably than knowledge does.',
 'score', 0, 'lower_better', NULL, NULL, '{}', 'self', 'weekly', 'any', 1430),

('bowel_frequency', 'raw', 'wellbeing', 'Bowel frequency', 'Bowels',
 'Per week. Moves quickly with fibre and water, which makes it an early sign that a plan is being followed.',
 'count', 0, 'target_band', 3, 21, '{}', 'self', 'weekly', 'any', 1440),

('bloating_score', 'raw', 'wellbeing', 'Bloating', 'Bloating',
 'Out of ten.', 'score', 0, 'lower_better', NULL, NULL, '{}', 'self', 'daily', 'any', 1450),


-- ============================================================
--  TIER 2 — CALCULATED
--  Arithmetic on the raw values. Recomputed on read, never
--  stored: a stored BMI is wrong the morning after a weigh-in.
-- ============================================================

('bmi', 'calculated', 'anthropometry', 'Body mass index', 'BMI',
 'Weight against height squared. It cannot tell muscle from fat and it is still the fastest screen there is. The Asia-Pacific cut-offs are lower than the international ones because risk starts earlier in South Asian populations.',
 'bmi', 1, 'target_band', 18.5, 23,
 '{"asia_pacific":[{"to":18.5,"label":"Underweight","tone":"warn"},{"to":23,"label":"Healthy","tone":"good"},{"to":25,"label":"Overweight","tone":"warn"},{"to":30,"label":"Obese I","tone":"bad"},{"label":"Obese II","tone":"bad"}],"who":[{"to":18.5,"label":"Underweight","tone":"warn"},{"to":25,"label":"Healthy","tone":"good"},{"to":30,"label":"Overweight","tone":"warn"},{"to":35,"label":"Obese I","tone":"bad"},{"to":40,"label":"Obese II","tone":"bad"},{"label":"Obese III","tone":"bad"}]}',
 'derived', '', 'any', 2000),

('waist_hip_ratio', 'calculated', 'anthropometry', 'Waist-to-hip ratio', 'WHR',
 'Where the fat is, which matters more than how much of it there is.',
 'ratio', 2, 'lower_better', NULL, 0.85,
 '{"who":[{"to":0.85,"label":"Low risk","tone":"good","sex":"female"},{"label":"Raised risk","tone":"warn","sex":"female"},{"to":0.90,"label":"Low risk","tone":"good","sex":"male"},{"label":"Raised risk","tone":"warn","sex":"male"}]}',
 'derived', '', 'any', 2010),

('waist_height_ratio', 'calculated', 'anthropometry', 'Waist-to-height ratio', 'WHtR',
 'Keep your waist under half your height. The single easiest rule on this list to remember and one of the better predictors on it.',
 'ratio', 2, 'lower_better', NULL, 0.5,
 '{"who":[{"to":0.5,"label":"Healthy","tone":"good"},{"to":0.6,"label":"Raised","tone":"warn"},{"label":"High","tone":"bad"}]}',
 'derived', '', 'any', 2020),

('bsa', 'calculated', 'anthropometry', 'Body surface area', 'BSA',
 'Du Bois. Used for drug and fluid calculations rather than for nutrition, and here because reports quote it.',
 'area', 2, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2030),

('ideal_body_weight', 'calculated', 'anthropometry', 'Ideal body weight', 'IBW',
 'Devine. A reference point, not a target — nobody should be told to weigh what a formula says.',
 'mass', 1, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2040),

('adjusted_body_weight', 'calculated', 'anthropometry', 'Adjusted body weight', 'AdjBW',
 'Used for energy and protein calculations where BMI is over 30, because dosing on actual weight overestimates and on ideal weight underestimates.',
 'mass', 1, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2050),

('lean_body_mass', 'calculated', 'body_composition', 'Lean body mass', 'LBM',
 'Everything that is not fat. Protein targets are set against this rather than against total weight.',
 'mass', 1, 'higher_better', NULL, NULL, '{}', 'derived', '', 'any', 2060),

('fat_mass', 'calculated', 'body_composition', 'Fat mass', 'Fat mass',
 'Weight times body fat percentage. The number a weight-loss plan is actually aiming at.',
 'mass', 1, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 2070),

('ffmi', 'calculated', 'body_composition', 'Fat-free mass index', 'FFMI',
 'Lean mass against height squared — BMI with the fat taken out. Says whether a low BMI is small or depleted.',
 'bmi', 1, 'higher_better', NULL, NULL, '{}', 'derived', '', 'any', 2080),

('bmr', 'calculated', 'energy', 'Resting energy expenditure', 'BMR',
 'What the body burns doing nothing. Mifflin-St Jeor by default; the formula is a setting because Harris-Benedict is still in use.',
 'energy', 0, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2100),

('tdee', 'calculated', 'energy', 'Total energy expenditure', 'TDEE',
 'Resting energy times an activity factor. An ESTIMATE OF MAINTENANCE and not a prescription — her target sits below it when the goal is loss, and the two must never be averaged.',
 'energy', 0, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2110),

('energy_balance', 'calculated', 'energy', 'Energy balance', 'Balance',
 'Intake minus expenditure. Negative is a deficit. Both halves are estimates, so it is read as a direction rather than as a figure.',
 'energy', 0, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2120),

('protein_per_kg', 'calculated', 'intake', 'Protein per kilogram', 'Protein/kg',
 'The number that actually says whether protein is adequate. 1.2 to 1.6 g/kg during weight loss; more for older adults.',
 'ratio', 2, 'higher_better', 1.2, 2.0, '{}', 'derived', '', 'any', 2130),

('energy_per_kg', 'calculated', 'intake', 'Energy per kilogram', 'kcal/kg',
 'Used in clinical nutrition where a total calorie figure means little without the body it belongs to.',
 'ratio', 1, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2140),

('carb_pct', 'calculated', 'intake', 'Carbohydrate share of energy', 'Carb %',
 'What proportion of the day''s energy came from carbohydrate.',
 'proportion', 0, 'target_band', 45, 60, '{}', 'derived', '', 'any', 2150),

('protein_pct', 'calculated', 'intake', 'Protein share of energy', 'Protein %',
 'Read alongside protein per kilogram, never instead of it — a percentage looks fine on a diet that is too small overall.',
 'proportion', 0, 'target_band', 15, 30, '{}', 'derived', '', 'any', 2160),

('fat_pct', 'calculated', 'intake', 'Fat share of energy', 'Fat %',
 'What proportion of the day''s energy came from fat.',
 'proportion', 0, 'target_band', 20, 35, '{}', 'derived', '', 'any', 2170),

('fibre_per_1000kcal', 'calculated', 'intake', 'Fibre density', 'Fibre/1000 kcal',
 'Fibre against energy. Fairer than a flat target on a small diet.',
 'ratio', 1, 'higher_better', 14, NULL, '{}', 'derived', '', 'any', 2180),

('sodium_potassium_ratio', 'calculated', 'intake', 'Sodium-to-potassium ratio', 'Na:K',
 'A better predictor of blood pressure than either number alone. Under 1 is the aim.',
 'ratio', 2, 'lower_better', NULL, 1.0, '{}', 'derived', '', 'any', 2190),

('pulse_pressure', 'calculated', 'vitals', 'Pulse pressure', 'Pulse pressure',
 'Systolic minus diastolic. A wide one suggests stiffer arteries.',
 'pressure', 0, 'lower_better', 30, 50, '{}', 'derived', '', 'any', 2200),

('map', 'calculated', 'vitals', 'Mean arterial pressure', 'MAP',
 'The average pressure through a cardiac cycle.',
 'pressure', 0, 'target_band', 70, 100, '{}', 'derived', '', 'any', 2210),

('homa_ir', 'calculated', 'biochemistry', 'HOMA-IR', 'HOMA-IR',
 'Fasting glucose and insulin together. Sees insulin resistance years before the glucose alone does — which is the window where diet still fixes it.',
 'ratio', 2, 'lower_better', NULL, 2.0,
 '{"who":[{"to":1.0,"label":"Optimal","tone":"good"},{"to":2.0,"label":"Normal","tone":"good"},{"to":2.9,"label":"Early resistance","tone":"warn"},{"label":"Insulin resistant","tone":"bad"}]}',
 'derived', '', 'any', 2220),

('eag', 'calculated', 'biochemistry', 'Estimated average glucose', 'eAG',
 'HbA1c expressed as an everyday glucose number, because 7.1 per cent means nothing to most people and 157 mg/dL means something.',
 'glucose', 0, 'lower_better', NULL, 154, '{}', 'derived', '', 'any', 2230),

('non_hdl_cholesterol', 'calculated', 'biochemistry', 'Non-HDL cholesterol', 'Non-HDL',
 'Total minus HDL — everything that deposits. Does not need a fasting sample, unlike LDL.',
 'cholesterol', 0, 'lower_better', NULL, 130, '{}', 'derived', '', 'any', 2240),

('tg_hdl_ratio', 'calculated', 'biochemistry', 'Triglyceride-to-HDL ratio', 'TG:HDL',
 'A good stand-in for insulin resistance when no insulin was measured. Over 3 is a signal.',
 'ratio', 2, 'lower_better', NULL, 3.0, '{}', 'derived', '', 'any', 2250),

('ldl_hdl_ratio', 'calculated', 'biochemistry', 'LDL-to-HDL ratio', 'LDL:HDL',
 'A summary of the lipid panel in one figure.',
 'ratio', 2, 'lower_better', NULL, 3.5, '{}', 'derived', '', 'any', 2260),

('transferrin_saturation', 'calculated', 'haematology', 'Transferrin saturation', 'TSAT',
 'Serum iron against binding capacity. Under 20 per cent with a low ferritin confirms iron deficiency.',
 'proportion', 1, 'target_band', 20, 50, '{}', 'derived', '', 'any', 2270),

('egfr', 'calculated', 'biochemistry', 'Estimated GFR', 'eGFR',
 'Kidney filtration, from creatinine, age and sex. Decides whether a high-protein or high-potassium plan is safe to write at all.',
 'clearance', 0, 'higher_better', 90, NULL,
 '{"who":[{"to":15,"label":"Stage 5","tone":"bad"},{"to":30,"label":"Stage 4","tone":"bad"},{"to":45,"label":"Stage 3b","tone":"warn"},{"to":60,"label":"Stage 3a","tone":"warn"},{"to":90,"label":"Stage 2","tone":"warn"},{"label":"Normal","tone":"good"}]}',
 'derived', '', 'any', 2280),

('ast_alt_ratio', 'calculated', 'biochemistry', 'AST-to-ALT ratio', 'AST:ALT',
 'Under 1 with raised enzymes points at fatty liver; over 2 points elsewhere.',
 'ratio', 2, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2290),

('weekly_weight_change', 'calculated', 'outcome', 'Weekly weight change', 'Weekly change',
 'Fitted across the last four weigh-ins, not taken between the last two. A single week is mostly water.',
 'mass', 2, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2300),

('weight_change_pct', 'calculated', 'outcome', 'Weight change', 'Change %',
 'Against the starting weight. Five per cent is where the metabolic benefits begin, which is usually far less than the client had in mind.',
 'proportion', 1, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2310),

('bmi_change', 'calculated', 'outcome', 'BMI change', 'BMI change',
 'Since the start of the programme.',
 'bmi', 1, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 2320),

('waist_change', 'calculated', 'outcome', 'Waist change', 'Waist change',
 'Often the number that moves when the scale refuses to.',
 'length', 1, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 2330),

('lean_mass_retention', 'calculated', 'outcome', 'Lean mass retained', 'Lean retained',
 'What share of the weight lost was fat rather than muscle. Under 75 per cent means the plan needs more protein or less deficit.',
 'proportion', 0, 'higher_better', 75, NULL, '{}', 'derived', '', 'any', 2340),


-- ============================================================
--  TIER 3 — DIAGNOSTIC SIGNALS
--  NOT DIAGNOSES. Every one of these is a flag that says look
--  here, and every description says so in as many words —
--  because the moment one of them is read as a conclusion, this
--  system is practising medicine.
-- ============================================================

('metabolic_syndrome_count', 'signal', 'flags', 'Metabolic syndrome criteria met', 'MetS criteria',
 'How many of the five are present: waist, triglycerides, HDL, blood pressure, fasting glucose. Three or more meets the definition — which is a reason to talk to her doctor, not a diagnosis made here.',
 'count', 0, 'lower_better', NULL, 2, '{}', 'derived', '', 'any', 3000),

('insulin_resistance_flag', 'signal', 'flags', 'Insulin resistance signal', 'IR signal',
 'Raised when HOMA-IR is over 2.9 or the TG:HDL ratio is over 3. A signal to investigate, not a diagnosis.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3010),

('prediabetes_flag', 'signal', 'flags', 'Prediabetes range', 'Prediabetes',
 'Fasting glucose 100–125 or HbA1c 5.7–6.4. The stage where diet reverses it, which is the whole reason it is flagged.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3020),

('diabetes_control_band', 'signal', 'flags', 'Glycaemic control', 'Control',
 'Where the HbA1c sits against the usual target of under 7 per cent. The target is individual and hers to set.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3030),

('hypertension_stage', 'signal', 'flags', 'Blood pressure stage', 'BP stage',
 'From the higher of the two readings. Needs several readings on separate days — one raised reading in a clinic is not hypertension.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3040),

('dyslipidaemia_flag', 'signal', 'flags', 'Lipid abnormality', 'Lipids',
 'Any of: LDL over 130, triglycerides over 150, HDL under 40 in men or 50 in women.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3050),

('anaemia_flag', 'signal', 'flags', 'Anaemia', 'Anaemia',
 'Haemoglobin under 12 in women or 13 in men. The MCV alongside it says what kind.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3060),

('iron_deficiency_flag', 'signal', 'flags', 'Iron deficiency', 'Iron deficiency',
 'Ferritin under 30, or under 100 with a raised CRP. Can be present with an entirely normal haemoglobin — which is why the ferritin is asked for.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3070),

('b12_deficiency_flag', 'signal', 'flags', 'B12 deficiency', 'B12 low',
 'Under 200, or under 300 with symptoms. Long vegetarian diets and long-term metformin are the two common causes here.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3080),

('vitamin_d_status', 'signal', 'flags', 'Vitamin D status', 'Vit D status',
 'Deficient, insufficient or sufficient, from the 25-OH level.',
 NULL, 0, 'higher_better', NULL, NULL, '{}', 'derived', '', 'any', 3090),

('thyroid_status', 'signal', 'flags', 'Thyroid status', 'Thyroid',
 'From TSH with free T4 where available. Subclinical hypothyroidism is common and mostly not a reason to change the diet.',
 NULL, 0, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 3100),

('fatty_liver_signal', 'signal', 'flags', 'Fatty liver signal', 'Fatty liver',
 'Raised ALT with an AST:ALT under 1 and central adiposity. The most diet-reversible finding on this list.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3110),

('sarcopenia_risk', 'signal', 'flags', 'Muscle loss risk', 'Muscle risk',
 'Low grip strength, low calf circumference or a falling lean mass. Changes the plan from restriction to protein and resistance work.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3120),

('malnutrition_risk', 'signal', 'flags', 'Malnutrition risk', 'Malnutrition',
 'Low BMI, unintentional weight loss and poor intake together. Screening only — a full assessment is hers to do.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3130),

('refeeding_risk', 'signal', 'flags', 'Refeeding risk', 'Refeeding',
 'Very low BMI or a long period of minimal intake. Matters because feeding somebody in that state too quickly is dangerous, and this is the flag that says start slowly.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3140),

('unintentional_loss_flag', 'signal', 'flags', 'Unintentional weight loss', 'Unplanned loss',
 'More than five per cent in six months without trying. Always worth a doctor rather than a diet.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3150),

('rapid_loss_flag', 'signal', 'flags', 'Losing too fast', 'Too fast',
 'Over one per cent of body weight a week. Costs muscle, raises uric acid and rarely holds.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3160),

('plateau_flag', 'signal', 'flags', 'Plateau', 'Plateau',
 'No meaningful change over four weeks on a plan being followed. A signal to change the plan, not to try harder at it.',
 NULL, 0, 'neutral', NULL, NULL, '{}', 'derived', '', 'any', 3170),

('hydration_flag', 'signal', 'flags', 'Low fluid intake', 'Hydration',
 'Consistently under two litres. The commonest cause of the constipation that gets blamed on the fibre.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3180),

('sleep_debt_flag', 'signal', 'flags', 'Short sleep', 'Sleep debt',
 'Under seven hours on most nights. Raises appetite and makes every other target harder, which is why it is a signal rather than a footnote.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3190),

('kidney_caution_flag', 'signal', 'flags', 'Kidney caution', 'Kidney',
 'eGFR under 60. High-protein and high-potassium plans need her review before they are written.',
 NULL, 0, 'lower_better', NULL, NULL, '{}', 'derived', '', 'any', 3200),


-- ============================================================
--  TIER 4 — ADHERENCE
--  What the client DID, not what their body did about it.
--  Kept apart deliberately: somebody can follow a plan perfectly
--  and have it not work, and mixing the two is how a person gets
--  blamed for a plan that needed changing.
-- ============================================================

('plan_adherence_pct', 'adherence', 'adherence', 'Plan adherence', 'Adherence',
 'Everything ticked against everything on the plan, over the period. Part-done counts as half.',
 'proportion', 0, 'higher_better', 80, NULL,
 '{"who":[{"to":50,"label":"Struggling","tone":"bad"},{"to":80,"label":"Partial","tone":"warn"},{"label":"Good","tone":"good"}]}',
 'derived', 'weekly', 'any', 4000),

('meal_adherence_pct', 'adherence', 'adherence', 'Meal adherence', 'Meals',
 'Meal rows only. Usually the highest of the four, and the one clients report on when asked in a room.',
 'proportion', 0, 'higher_better', 80, NULL, '{}', 'derived', 'weekly', 'any', 4010),

('supplement_adherence_pct', 'adherence', 'adherence', 'Supplement adherence', 'Supplements',
 'Supplement rows only. Usually the lowest, and the easiest to fix by moving one to a meal they never miss.',
 'proportion', 0, 'higher_better', 80, NULL, '{}', 'derived', 'weekly', 'any', 4020),

('activity_adherence_pct', 'adherence', 'adherence', 'Movement adherence', 'Movement',
 'Activity rows only.',
 'proportion', 0, 'higher_better', 70, NULL, '{}', 'derived', 'weekly', 'any', 4030),

('checkin_rate', 'adherence', 'adherence', 'Days recorded', 'Recording',
 'Days with anything ticked, against days in the programme. Distinguishes "did not follow it" from "did not write it down" — two completely different conversations.',
 'proportion', 0, 'higher_better', 70, NULL, '{}', 'derived', 'weekly', 'any', 4040),

('logging_streak', 'adherence', 'adherence', 'Current streak', 'Streak',
 'Consecutive days recorded. Kept off the client''s own screen on purpose — a streak is a reason not to come back after breaking one.',
 'count', 0, 'higher_better', NULL, NULL, '{}', 'derived', 'daily', 'any', 4050),

('longest_streak', 'adherence', 'adherence', 'Longest streak', 'Best streak',
 'The longest run of recorded days in this programme.',
 'count', 0, 'higher_better', NULL, NULL, '{}', 'derived', '', 'any', 4060),

('days_recorded', 'adherence', 'adherence', 'Days recorded', 'Days',
 'Total days with at least one tick.',
 'count', 0, 'higher_better', NULL, NULL, '{}', 'derived', '', 'any', 4070),

('weekend_gap', 'adherence', 'adherence', 'Weekend drop-off', 'Weekend gap',
 'Weekday adherence minus weekend adherence. A large gap is a plan that does not fit a Saturday, which is a plan problem.',
 'proportion', 0, 'lower_better', NULL, 15, '{}', 'derived', 'weekly', 'any', 4080),

('most_missed_item', 'adherence', 'adherence', 'Most missed item', 'Most missed',
 'The single line skipped most often. Almost always the most useful thing on a review, and almost always fixable by moving it.',
 NULL, 0, 'neutral', NULL, NULL, '{}', 'derived', 'weekly', 'any', 4090),

('most_missed_meal', 'adherence', 'adherence', 'Most missed meal', 'Missed meal',
 'Which eating occasion goes first. Usually the one nearest to work.',
 NULL, 0, 'neutral', NULL, NULL, '{}', 'derived', 'weekly', 'any', 4100),

('filler_use_rate', 'adherence', 'adherence', 'Between-meal use', 'Fillers',
 'How often the between-meal options were reached for. High is not failure — it is the plan working as designed, and it says the gaps are too long.',
 'proportion', 0, 'neutral', NULL, NULL, '{}', 'derived', 'weekly', 'any', 4110),

('note_rate', 'adherence', 'adherence', 'Notes written', 'Notes',
 'How often the client wrote something alongside a tick. The richest source of information in a review, and the least prompted for.',
 'proportion', 0, 'higher_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 4120),

('session_attendance', 'adherence', 'adherence', 'Sessions attended', 'Attendance',
 'Attended against booked.',
 'proportion', 0, 'higher_better', 90, NULL, '{}', 'derived', '', 'any', 4130),

('plan_open_rate', 'adherence', 'adherence', 'Plan opened', 'Opens',
 'How often the client opened their plan. A plan nobody opens is not being followed, whatever the ticks say.',
 'count', 0, 'higher_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 4140),

('days_since_open', 'adherence', 'adherence', 'Days since last opened', 'Last seen',
 'The earliest warning there is that somebody is drifting away, and it arrives weeks before a missed session does.',
 'count', 0, 'lower_better', NULL, 7, '{}', 'derived', 'daily', 'any', 4150),


-- ============================================================
--  TIER 5 — GOAL KPIs
--  Distance from a target SHE set for THIS person. Every one of
--  these is meaningless without a goal row behind it, and none
--  of them has a general reference range for exactly that
--  reason: the target is the reference.
-- ============================================================

('weight_goal_progress', 'goal', 'goal', 'Progress to goal weight', 'Weight progress',
 'How much of the distance from start to goal has been covered.',
 'proportion', 0, 'higher_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5000),

('weight_to_goal', 'goal', 'goal', 'Left to goal weight', 'To goal',
 'Current weight minus goal weight.',
 'mass', 1, 'lower_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5010),

('rate_of_change', 'goal', 'goal', 'Rate of change', 'Rate',
 'Weight change per week over the last four weeks. Half a kilo a week is the usual ceiling for keeping muscle.',
 'mass', 2, 'target_band', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5020),

('projected_goal_date', 'goal', 'goal', 'Projected goal date', 'On this rate',
 'When the goal arrives at the current rate. Shown to her rather than to the client: a date that keeps moving is discouraging in a way the number itself is not.',
 NULL, 0, 'neutral', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5030),

('goal_days_remaining', 'goal', 'goal', 'Days left', 'Days left',
 'Against the date she set, not against the projection.',
 'count', 0, 'neutral', NULL, NULL, '{}', 'derived', 'daily', 'any', 5040),

('on_track_flag', 'goal', 'goal', 'On track', 'On track',
 'Whether the current rate reaches the target by the date. Recalculated, never remembered.',
 NULL, 0, 'higher_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5050),

('hba1c_goal_gap', 'goal', 'goal', 'HbA1c to target', 'HbA1c gap',
 'Distance from the HbA1c target she set. Read no oftener than eight-weekly — the number cannot move faster than that.',
 'proportion', 1, 'lower_better', NULL, NULL, '{}', 'derived', 'quarterly', 'any', 5060),

('glucose_goal_gap', 'goal', 'goal', 'Fasting glucose to target', 'Glucose gap',
 'Distance from the fasting glucose target.',
 'glucose', 0, 'lower_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5070),

('bp_goal_gap', 'goal', 'goal', 'Blood pressure to target', 'BP gap',
 'Systolic distance from target.',
 'pressure', 0, 'lower_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5080),

('ldl_goal_gap', 'goal', 'goal', 'LDL to target', 'LDL gap',
 'Distance from the LDL target.',
 'cholesterol', 0, 'lower_better', NULL, NULL, '{}', 'derived', 'quarterly', 'any', 5090),

('haemoglobin_goal_gap', 'goal', 'goal', 'Haemoglobin to target', 'Hb gap',
 'Distance from the haemoglobin target. Six to eight weeks before iron shows here, which is worth saying out loud to a client who expects sooner.',
 'haemoglobin', 1, 'lower_better', NULL, NULL, '{}', 'derived', 'quarterly', 'any', 5100),

('waist_goal_gap', 'goal', 'goal', 'Waist to target', 'Waist gap',
 'Distance from the waist target. Frequently closes while the weight does not.',
 'length', 1, 'lower_better', NULL, NULL, '{}', 'derived', 'monthly', 'any', 5110),

('protein_target_gap', 'goal', 'goal', 'Protein against target', 'Protein gap',
 'Average daily protein minus the prescribed target.',
 'micromass', 0, 'higher_better', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5120),

('energy_target_gap', 'goal', 'goal', 'Energy against prescription', 'Energy gap',
 'Average daily intake minus HER PRESCRIPTION — never minus the estimated requirement. The two are different numbers and confusing them undoes the deficit.',
 'energy', 0, 'target_band', NULL, NULL, '{}', 'derived', 'weekly', 'any', 5130),

('steps_goal_pct', 'goal', 'goal', 'Steps against target', 'Steps %',
 'Average daily steps as a share of the target.',
 'proportion', 0, 'higher_better', 100, NULL, '{}', 'derived', 'weekly', 'any', 5140),

('sleep_goal_pct', 'goal', 'goal', 'Sleep against target', 'Sleep %',
 'Average sleep as a share of the target window.',
 'proportion', 0, 'higher_better', 100, NULL, '{}', 'derived', 'weekly', 'any', 5150),

('body_fat_goal_gap', 'goal', 'goal', 'Body fat to target', 'Fat gap',
 'Distance from the body fat target.',
 'proportion', 1, 'lower_better', NULL, NULL, '{}', 'derived', 'monthly', 'any', 5160),

('muscle_gain', 'goal', 'goal', 'Muscle gained', 'Muscle gained',
 'Change in skeletal muscle mass since the start. The number that says a loss was the right kind.',
 'mass', 1, 'higher_better', NULL, NULL, '{}', 'derived', 'monthly', 'any', 5170),

('behavioural_goals_met', 'goal', 'goal', 'Behavioural goals met', 'Goals met',
 'Of the goals she set that are not numbers — carrying a tiffin, eating the 4pm meal — how many are being kept. Often the ones that decide whether the rest happen.',
 'proportion', 0, 'higher_better', NULL, NULL, '{}', 'derived', 'monthly', 'any', 5180)

ON CONFLICT (key) DO UPDATE SET
  tier = EXCLUDED.tier, family = EXCLUDED.family, label = EXCLUDED.label,
  short_label = EXCLUDED.short_label, description = EXCLUDED.description,
  dimension = EXCLUDED.dimension, decimals = EXCLUDED.decimals,
  direction = EXCLUDED.direction, ref_low = EXCLUDED.ref_low,
  ref_high = EXCLUDED.ref_high, bands = EXCLUDED.bands,
  source = EXCLUDED.source, cadence = EXCLUDED.cadence, sex = EXCLUDED.sex,
  sort = EXCLUDED.sort, updated_at = now();


-- ============================================================
--  HOW THE DERIVED ONES ARE DERIVED
-- ------------------------------------------------------------
--  `formula` is written so a dietitian can check it, and
--  `depends_on` is what the implementation reads to know whether
--  it has enough to compute anything.
--
--  THESE ARE THE SPECIFICATION. The arithmetic lives in code;
--  this is what that code is tested against, and where a
--  disagreement is settled. Everything is in CANONICAL units —
--  kg, cm, kcal, mg/dL — because that is what is stored.
-- ============================================================

UPDATE crm.metric_defs SET formula = f.formula, depends_on = f.deps FROM (VALUES

-- ---- anthropometry ------------------------------------------
('bmi', 'weight_kg / (height_cm / 100) ^ 2', ARRAY['weight','height']),
('waist_hip_ratio', 'waist_cm / hip_cm', ARRAY['waist','hip']),
('waist_height_ratio', 'waist_cm / height_cm', ARRAY['waist','height']),
('bsa', 'Du Bois: 0.007184 * height_cm ^ 0.725 * weight_kg ^ 0.425', ARRAY['weight','height']),
('ideal_body_weight',
 'Devine: female 45.5 + 2.3 * (height_in - 60); male 50 + 2.3 * (height_in - 60). Floors at the formula value for 152 cm.',
 ARRAY['height']),
('adjusted_body_weight',
 'IBW + 0.4 * (weight_kg - IBW). Used only when BMI > 30; below that the actual weight is used.',
 ARRAY['weight','height','ideal_body_weight','bmi']),

-- ---- body composition ---------------------------------------
('lean_body_mass', 'weight_kg * (1 - body_fat_pct / 100)', ARRAY['weight','body_fat_pct']),
('fat_mass', 'weight_kg * body_fat_pct / 100', ARRAY['weight','body_fat_pct']),
('ffmi', 'lean_body_mass_kg / (height_cm / 100) ^ 2', ARRAY['lean_body_mass','height']),

-- ---- energy --------------------------------------------------
('bmr',
 'Mifflin-St Jeor (default): 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 male / -161 female). Harris-Benedict revised when settings.metrics.energy_formula is "harris".',
 ARRAY['weight','height']),
('tdee',
 'bmr * activity factor: 1.2 sedentary, 1.375 light, 1.55 moderate, 1.725 heavy, 1.9 very heavy. An estimate of MAINTENANCE, never a prescription.',
 ARRAY['bmr']),
('energy_balance', 'energy_intake_kcal - tdee_kcal. Negative is a deficit.', ARRAY['energy_intake','tdee']),

-- ---- intake --------------------------------------------------
('protein_per_kg',
 'protein_intake_g / weight_kg. Uses adjusted body weight where BMI > 30.',
 ARRAY['protein_intake','weight']),
('energy_per_kg', 'energy_intake_kcal / weight_kg', ARRAY['energy_intake','weight']),
('carb_pct', 'carb_intake_g * 4 / energy_intake_kcal * 100', ARRAY['carb_intake','energy_intake']),
('protein_pct', 'protein_intake_g * 4 / energy_intake_kcal * 100', ARRAY['protein_intake','energy_intake']),
('fat_pct', 'fat_intake_g * 9 / energy_intake_kcal * 100', ARRAY['fat_intake','energy_intake']),
('fibre_per_1000kcal', 'fibre_intake_g / energy_intake_kcal * 1000', ARRAY['fibre_intake','energy_intake']),
('sodium_potassium_ratio', 'sodium_intake_mg / potassium_intake_mg', ARRAY['sodium_intake','potassium_intake']),

-- ---- vitals --------------------------------------------------
('pulse_pressure', 'systolic - diastolic', ARRAY['systolic','diastolic']),
('map', 'diastolic + (systolic - diastolic) / 3', ARRAY['systolic','diastolic']),

-- ---- biochemistry --------------------------------------------
('homa_ir', 'fasting_glucose_mgdl * fasting_insulin_uiuml / 405', ARRAY['fasting_glucose','fasting_insulin']),
('eag', '28.7 * hba1c_pct - 46.7', ARRAY['hba1c']),
('non_hdl_cholesterol', 'total_cholesterol - hdl', ARRAY['total_cholesterol','hdl']),
('tg_hdl_ratio', 'triglycerides / hdl, both mg/dL. The ratio is unit-dependent — in mmol/L the thresholds are different.', ARRAY['triglycerides','hdl']),
('ldl_hdl_ratio', 'ldl / hdl', ARRAY['ldl','hdl']),
('transferrin_saturation', 'serum_iron / tibc * 100', ARRAY['serum_iron','tibc']),
('egfr',
 'CKD-EPI 2021 (race-free): 142 * min(Scr/k,1)^a * max(Scr/k,1)^-1.200 * 0.9938^age * 1.012 if female, where k = 0.7 female / 0.9 male and a = -0.241 female / -0.302 male.',
 ARRAY['serum_creatinine']),
('ast_alt_ratio', 'ast / alt', ARRAY['ast','alt']),

-- ---- outcome -------------------------------------------------
('weekly_weight_change',
 'Slope of a least-squares line through the last 4 weigh-ins, per week. NOT the difference between the last two — one week is mostly water.',
 ARRAY['weight']),
('weight_change_pct', '(weight_now - weight_at_start) / weight_at_start * 100', ARRAY['weight']),
('bmi_change', 'bmi_now - bmi_at_start', ARRAY['bmi']),
('waist_change', 'waist_now - waist_at_start', ARRAY['waist']),
('lean_mass_retention',
 '(1 - lean_mass_lost / total_weight_lost) * 100. Only meaningful while weight is falling.',
 ARRAY['weight','lean_body_mass']),

-- ---- signals -------------------------------------------------
('metabolic_syndrome_count',
 'Count of: waist >= 90 male / 80 female (Asia-Pacific); triglycerides >= 150; HDL < 40 male / 50 female; BP >= 130/85 or treated; fasting glucose >= 100 or treated. Three of five meets the definition.',
 ARRAY['waist','triglycerides','hdl','systolic','diastolic','fasting_glucose']),
('insulin_resistance_flag', 'homa_ir > 2.9 OR tg_hdl_ratio > 3.0', ARRAY['homa_ir','tg_hdl_ratio']),
('prediabetes_flag', 'fasting_glucose 100-125 OR hba1c 5.7-6.4', ARRAY['fasting_glucose','hba1c']),
('diabetes_control_band', 'hba1c against target (default 7.0): at target, above target, well above', ARRAY['hba1c']),
('hypertension_stage', 'The higher stage of the two readings, on the band table for systolic and diastolic', ARRAY['systolic','diastolic']),
('dyslipidaemia_flag', 'ldl > 130 OR triglycerides > 150 OR hdl < 40 male / 50 female', ARRAY['ldl','triglycerides','hdl']),
('anaemia_flag', 'haemoglobin < 12 female / 13 male', ARRAY['haemoglobin']),
('iron_deficiency_flag', 'ferritin < 30, or < 100 when crp > 5. Independent of haemoglobin.', ARRAY['ferritin','crp']),
('b12_deficiency_flag', 'vitamin_b12 < 200, or < 300 with macrocytosis (mcv > 100)', ARRAY['vitamin_b12','mcv']),
('vitamin_d_status', 'vitamin_d: < 20 deficient, 20-29 insufficient, >= 30 sufficient', ARRAY['vitamin_d']),
('thyroid_status', 'tsh with free_t4 where present: < 0.4 overactive, 0.4-4.0 normal, 4-10 subclinical, > 10 underactive', ARRAY['tsh','free_t4']),
('fatty_liver_signal', 'alt > 40 AND ast_alt_ratio < 1 AND (waist_height_ratio > 0.5 OR bmi > 25)', ARRAY['alt','ast_alt_ratio','waist_height_ratio','bmi']),
('sarcopenia_risk', 'handgrip below the age and sex cut-off, OR calf < 31 cm, OR skeletal muscle mass falling over 3 months', ARRAY['handgrip_strength','calf','skeletal_muscle_mass']),
('malnutrition_risk', 'MUST-style: bmi < 18.5 (2) or 18.5-20 (1); unplanned loss > 10% (2) or 5-10% (1); acute illness with no intake for 5 days (2). Total >= 2 is high risk.', ARRAY['bmi','weight_change_pct','energy_intake']),
('refeeding_risk', 'bmi < 16, or unintentional loss > 15% in 3-6 months, or little to no intake for more than 10 days, or low potassium, phosphate or magnesium before feeding', ARRAY['bmi','weight_change_pct','potassium_serum','magnesium_serum']),
('unintentional_loss_flag', 'weight_change_pct < -5 over 6 months with no weight-loss goal recorded', ARRAY['weight_change_pct']),
('rapid_loss_flag', 'weekly_weight_change / weight * 100 < -1 per cent per week', ARRAY['weekly_weight_change','weight']),
('plateau_flag', 'abs(weekly_weight_change) < 0.1 kg over 4 weeks AND plan_adherence_pct > 80. Adherence is part of the test on purpose — without it, "not following the plan" reads as "plateau".', ARRAY['weekly_weight_change','plan_adherence_pct']),
('hydration_flag', 'mean water_intake < 2000 ml over 7 days', ARRAY['water_intake']),
('sleep_debt_flag', 'mean sleep_duration < 7 h on 4 or more of the last 7 nights', ARRAY['sleep_duration']),
('kidney_caution_flag', 'egfr < 60', ARRAY['egfr']),

-- ---- adherence -----------------------------------------------
('plan_adherence_pct',
 '(done + 0.5 * part) / (tickable rows * days in period) * 100. Rows that only exist on some days count only on those days.',
 ARRAY[]::text[]),
('meal_adherence_pct', 'As plan adherence, over rows of kind = meal', ARRAY[]::text[]),
('supplement_adherence_pct', 'As plan adherence, over rows of kind = supplement', ARRAY[]::text[]),
('activity_adherence_pct', 'As plan adherence, over rows of kind = activity', ARRAY[]::text[]),
('checkin_rate', 'days with at least one checkin / days elapsed in the programme * 100', ARRAY[]::text[]),
('logging_streak', 'Consecutive days to today with at least one checkin', ARRAY[]::text[]),
('longest_streak', 'The longest such run in this programme', ARRAY[]::text[]),
('days_recorded', 'count(distinct on_date) in checkins for this programme', ARRAY[]::text[]),
('weekend_gap', 'weekday adherence - weekend adherence, in percentage points', ARRAY['plan_adherence_pct']),
('most_missed_item', 'The plan_item with the highest (skipped + not recorded) count over the period', ARRAY[]::text[]),
('most_missed_meal', 'The detail.meal group with the highest miss rate', ARRAY[]::text[]),
('filler_use_rate', 'days a filler was used / days elapsed * 100', ARRAY[]::text[]),
('note_rate', 'checkins with a non-empty note / total checkins * 100', ARRAY[]::text[]),
('session_attendance', 'consultations completed / consultations booked * 100', ARRAY[]::text[]),
('plan_open_rate', 'programmes.open_count over weeks elapsed', ARRAY[]::text[]),
('days_since_open', 'current_date - date(programmes.opened_at, or the last client session)', ARRAY[]::text[]),

-- ---- goal ----------------------------------------------------
('weight_goal_progress', '(start_weight - current_weight) / (start_weight - goal_weight) * 100', ARRAY['weight']),
('weight_to_goal', 'current_weight - goal_weight', ARRAY['weight']),
('rate_of_change', 'weekly_weight_change. Target band is set per goal, typically -0.25 to -0.75 kg/week for loss.', ARRAY['weekly_weight_change']),
('projected_goal_date', 'today + (weight_to_goal / weekly_weight_change) weeks. Undefined when the rate is zero or the wrong sign.', ARRAY['weight_to_goal','weekly_weight_change']),
('goal_days_remaining', 'goals.due_on - current_date', ARRAY[]::text[]),
('on_track_flag', 'projected_goal_date <= goals.due_on', ARRAY['projected_goal_date','goal_days_remaining']),
('hba1c_goal_gap', 'hba1c - goal target', ARRAY['hba1c']),
('glucose_goal_gap', 'fasting_glucose - goal target', ARRAY['fasting_glucose']),
('bp_goal_gap', 'systolic - goal target', ARRAY['systolic']),
('ldl_goal_gap', 'ldl - goal target', ARRAY['ldl']),
('haemoglobin_goal_gap', 'goal target - haemoglobin (positive means still short)', ARRAY['haemoglobin']),
('waist_goal_gap', 'waist - goal target', ARRAY['waist']),
('protein_target_gap', 'mean protein_intake over 7 days - prescribed protein', ARRAY['protein_intake']),
('energy_target_gap',
 'mean energy_intake over 7 days - HER PRESCRIPTION. Never against tdee: the prescription sits below maintenance by design and comparing to tdee erases the deficit.',
 ARRAY['energy_intake']),
('steps_goal_pct', 'mean steps / goal target * 100', ARRAY['steps']),
('sleep_goal_pct', 'mean sleep_duration / goal target * 100', ARRAY['sleep_duration']),
('body_fat_goal_gap', 'body_fat_pct - goal target', ARRAY['body_fat_pct']),
('muscle_gain', 'skeletal_muscle_mass now - at start', ARRAY['skeletal_muscle_mass']),
('behavioural_goals_met', 'goals with kind = behavioural and status = met / total behavioural goals * 100', ARRAY[]::text[])

) AS f(key, formula, deps)
WHERE crm.metric_defs.key = f.key;

COMMIT;

\echo 'metric catalogue loaded'
