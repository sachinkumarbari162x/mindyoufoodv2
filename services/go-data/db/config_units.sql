-- ============================================================
--  UNITS, AND THE STANDARDS THAT PICK BETWEEN THEM
-- ------------------------------------------------------------
--  Configuration, not client data. Loaded alongside config.sql.
--
--    psql -d "$DATABASE_URL" -f db/config_units.sql
--
--  EVERY FACTOR HERE IS EXACT OR SOURCED, and where it is a
--  molar conversion the molar mass is written in the comment so
--  it can be checked rather than trusted. A wrong factor in this
--  table is a wrong number on every screen, silently, for ever.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO crm.units (code, dimension, label, symbol, factor, "offset", canonical, decimals, sort) VALUES

-- ---- mass: canonical kg -------------------------------------
('kg',      'mass',   'kilograms',  'kg',  1,           0, true,  1, 10),
('g',       'mass',   'grams',      'g',   0.001,       0, false, 0, 20),
('lb',      'mass',   'pounds',     'lb',  0.45359237,  0, false, 1, 30),
('st',      'mass',   'stones',     'st',  6.35029318,  0, false, 1, 40),
('oz',      'mass',   'ounces',     'oz',  0.028349523, 0, false, 1, 50),

-- ---- length: canonical cm -----------------------------------
('cm',      'length', 'centimetres', 'cm', 1,     0, true,  1, 10),
('m',       'length', 'metres',      'm',  100,   0, false, 2, 20),
('mm',      'length', 'millimetres', 'mm', 0.1,   0, false, 0, 30),
('in',      'length', 'inches',      'in', 2.54,  0, false, 1, 40),
('ft',      'length', 'feet',        'ft', 30.48, 0, false, 1, 50),

-- ---- energy: canonical kcal ---------------------------------
-- 1 kcal = 4.184 kJ exactly (thermochemical calorie).
('kcal',    'energy', 'kilocalories', 'kcal', 1,          0, true,  0, 10),
('kj',      'energy', 'kilojoules',   'kJ',   0.239005736, 0, false, 0, 20),

-- ---- volume: canonical ml -----------------------------------
('ml',      'volume', 'millilitres', 'ml',    1,      0, true,  0, 10),
('l',       'volume', 'litres',      'l',     1000,   0, false, 2, 20),
('fl_oz',   'volume', 'fluid ounces','fl oz', 29.5735,0, false, 1, 30),
('cup_us',  'volume', 'US cups',     'cup',   236.588,0, false, 1, 40),

-- ---- glucose ------------------------------------------------
-- Molar mass 180.156 g/mol. 1 mmol/L = 18.016 mg/dL.
-- Canonical mg/dL, because that is what Indian labs report and
-- what every client's own report will say.
('mg_dl_glucose',  'glucose', 'milligrams per decilitre', 'mg/dL',  1,      0, true,  0, 10),
('mmol_l_glucose', 'glucose', 'millimoles per litre',     'mmol/L', 18.016, 0, false, 1, 20),

-- ---- cholesterol (and HDL, LDL, non-HDL) --------------------
-- Molar mass 386.65 g/mol. 1 mmol/L = 38.67 mg/dL.
('mg_dl_chol',  'cholesterol', 'milligrams per decilitre', 'mg/dL',  1,     0, true,  0, 10),
('mmol_l_chol', 'cholesterol', 'millimoles per litre',     'mmol/L', 38.67, 0, false, 2, 20),

-- ---- triglycerides ------------------------------------------
-- Molar mass ~885.4 g/mol. 1 mmol/L = 88.57 mg/dL.
('mg_dl_tg',  'triglycerides', 'milligrams per decilitre', 'mg/dL',  1,     0, true,  0, 10),
('mmol_l_tg', 'triglycerides', 'millimoles per litre',     'mmol/L', 88.57, 0, false, 2, 20),

-- ---- creatinine ---------------------------------------------
-- Molar mass 113.12 g/mol. 1 mg/dL = 88.4 µmol/L.
('mg_dl_creat',  'creatinine', 'milligrams per decilitre', 'mg/dL',  1,          0, true,  2, 10),
('umol_l_creat', 'creatinine', 'micromoles per litre',     'µmol/L', 0.011312,   0, false, 0, 20),

-- ---- urea / BUN ---------------------------------------------
-- Urea molar mass 60.06 g/mol; BUN is nitrogen only, x 0.467.
('mg_dl_urea',  'urea', 'milligrams per decilitre', 'mg/dL',  1,      0, true,  0, 10),
('mmol_l_urea', 'urea', 'millimoles per litre',     'mmol/L', 6.006,  0, false, 1, 20),

-- ---- haemoglobin --------------------------------------------
('g_dl',  'haemoglobin', 'grams per decilitre', 'g/dL', 1,  0, true,  1, 10),
('g_l',   'haemoglobin', 'grams per litre',     'g/L',  0.1, 0, false, 0, 20),

-- ---- ferritin, B12, vitamin D and the other trace assays ----
('ng_ml',   'ferritin',  'nanograms per millilitre', 'ng/mL', 1, 0, true,  0, 10),
('ug_l',    'ferritin',  'micrograms per litre',     'µg/L',  1, 0, false, 0, 20),
('pg_ml',   'b12',       'picograms per millilitre', 'pg/mL', 1,      0, true,  0, 10),
('pmol_l',  'b12',       'picomoles per litre',      'pmol/L', 0.7378, 0, false, 0, 20),
('ng_ml_d', 'vitamin_d', 'nanograms per millilitre', 'ng/mL', 1,      0, true,  1, 10),
('nmol_l_d','vitamin_d', 'nanomoles per litre',      'nmol/L', 0.4006, 0, false, 0, 20),

-- ---- pressure, rate, and the plain ones ---------------------
('mmhg',    'pressure',      'millimetres of mercury', 'mmHg',   1, 0, true, 0, 10),
('bpm',     'rate',          'beats per minute',       'bpm',    1, 0, true, 0, 10),
('per_min', 'frequency',     'per minute',             '/min',   1, 0, true, 0, 10),
('hours',   'duration',      'hours',                  'h',      1, 0, true, 1, 10),
('minutes', 'duration',      'minutes',                'min',    0.0166667, 0, false, 0, 20),
('days',    'duration',      'days',                   'd',      24, 0, false, 0, 30),
('percent', 'proportion',    'per cent',               '%',      1, 0, true, 1, 10),
('ratio',   'ratio',         'ratio',                  '',       1, 0, true, 2, 10),
('count',   'count',         'count',                  '',       1, 0, true, 0, 10),
('steps',   'steps',         'steps',                  'steps',  1, 0, true, 0, 10),
('score',   'score',         'score',                  '',       1, 0, true, 0, 10),
('iu',      'iu',            'international units',    'IU',     1, 0, true, 0, 10),
('mcg',     'micromass',     'micrograms',             'mcg',    1, 0, true, 0, 10),
('mg',      'micromass',     'milligrams',             'mg',     1000, 0, false, 1, 20),
('c',       'temperature',   'degrees Celsius',        '°C',     1, 0, true, 1, 10),
('f',       'temperature',   'degrees Fahrenheit',     '°F',     0.5555556, -17.777778, false, 1, 20),
('mmol_l',  'electrolyte',   'millimoles per litre',   'mmol/L', 1, 0, true, 1, 10),
('miu_l',   'thyrotropin',   'milli-units per litre',  'mIU/L',  1, 0, true, 2, 10),
('mg_l',    'inflammation',  'milligrams per litre',   'mg/L',   1, 0, true, 1, 10),
('mm_hr',   'sedimentation', 'millimetres per hour',   'mm/hr',  1, 0, true, 0, 10),
('u_l',     'enzyme',        'units per litre',        'U/L',    1, 0, true, 0, 10),
('g_dl_protein', 'protein',  'grams per decilitre',    'g/dL',   1, 0, true, 1, 10),
('mg_dl_uric',   'urate',    'milligrams per decilitre','mg/dL', 1, 0, true, 1, 10),
('uiu_ml',  'insulin',       'micro-units per millilitre', 'µIU/mL', 1, 0, true, 1, 10),
('cells_ul','cell_count',    'cells per microlitre',   '/µL',    1, 0, true, 0, 10),
('fl',      'cell_volume',   'femtolitres',            'fL',     1, 0, true, 1, 10),
('ml_min',  'clearance',     'millilitres per minute', 'mL/min/1.73m²', 1, 0, true, 0, 10),
('kg_m2',   'bmi',           'kilograms per square metre', 'kg/m²', 1, 0, true, 1, 10),
('m2',      'area',          'square metres',          'm²',     1, 0, true, 2, 10),
('units',   'alcohol',       'units',                  'units',  1, 0, true, 1, 10)

ON CONFLICT (code) DO UPDATE SET
  dimension = EXCLUDED.dimension, label = EXCLUDED.label, symbol = EXCLUDED.symbol,
  factor = EXCLUDED.factor, "offset" = EXCLUDED."offset",
  canonical = EXCLUDED.canonical, decimals = EXCLUDED.decimals, sort = EXCLUDED.sort;


-- ============================================================
--  THE STANDARDS
--  Four, and the default is the fourth — because this is an
--  Indian practice and the honest default is what Indian labs
--  and Indian clients actually use: kilograms and centimetres
--  like the rest of the metric world, but mg/dL for glucose and
--  lipids, because that is what is printed on the report the
--  client is holding.
-- ============================================================

INSERT INTO crm.unit_standards (code, label, description, sort) VALUES
  ('india_clinical', 'Indian clinical',
   'Metric for body measurements, mg/dL for glucose and lipids — what Indian labs report and what your clients bring in.', 10),
  ('metric', 'Metric / SI',
   'Kilograms, centimetres, and mmol/L throughout. Standard across most of Europe.', 20),
  ('us_customary', 'US customary',
   'Pounds, inches, and mg/dL. For clients in the United States.', 30),
  ('uk', 'United Kingdom',
   'Stones and pounds for weight, centimetres for height, mmol/L for bloods.', 40)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label, description = EXCLUDED.description, sort = EXCLUDED.sort;


/* One row per dimension per standard. Anything a standard does
   not name falls back to the dimension's canonical unit, so this
   only has to list the DIFFERENCES — which is also what makes it
   readable as a statement of what each standard actually is. */
INSERT INTO crm.unit_standard_units (standard, dimension, unit) VALUES
  -- India: metric body, mg/dL bloods. Every one of these is the
  -- canonical unit, listed anyway so the default is explicit
  -- rather than implied by an empty table.
  ('india_clinical', 'mass',          'kg'),
  ('india_clinical', 'length',        'cm'),
  ('india_clinical', 'energy',        'kcal'),
  ('india_clinical', 'glucose',       'mg_dl_glucose'),
  ('india_clinical', 'cholesterol',   'mg_dl_chol'),
  ('india_clinical', 'triglycerides', 'mg_dl_tg'),
  ('india_clinical', 'creatinine',    'mg_dl_creat'),
  ('india_clinical', 'haemoglobin',   'g_dl'),
  ('india_clinical', 'volume',        'ml'),

  -- Metric / SI: everything in millimoles.
  ('metric', 'mass',          'kg'),
  ('metric', 'length',        'cm'),
  ('metric', 'energy',        'kj'),
  ('metric', 'glucose',       'mmol_l_glucose'),
  ('metric', 'cholesterol',   'mmol_l_chol'),
  ('metric', 'triglycerides', 'mmol_l_tg'),
  ('metric', 'creatinine',    'umol_l_creat'),
  ('metric', 'haemoglobin',   'g_l'),
  ('metric', 'volume',        'ml'),

  -- US: pounds and inches, mg/dL.
  ('us_customary', 'mass',          'lb'),
  ('us_customary', 'length',        'in'),
  ('us_customary', 'energy',        'kcal'),
  ('us_customary', 'glucose',       'mg_dl_glucose'),
  ('us_customary', 'cholesterol',   'mg_dl_chol'),
  ('us_customary', 'triglycerides', 'mg_dl_tg'),
  ('us_customary', 'creatinine',    'mg_dl_creat'),
  ('us_customary', 'haemoglobin',   'g_dl'),
  ('us_customary', 'volume',        'fl_oz'),

  -- UK: stones for weight, centimetres for height, mmol/L.
  ('uk', 'mass',          'st'),
  ('uk', 'length',        'cm'),
  ('uk', 'energy',        'kcal'),
  ('uk', 'glucose',       'mmol_l_glucose'),
  ('uk', 'cholesterol',   'mmol_l_chol'),
  ('uk', 'triglycerides', 'mmol_l_tg'),
  ('uk', 'creatinine',    'umol_l_creat'),
  ('uk', 'haemoglobin',   'g_dl'),
  ('uk', 'volume',        'ml')
ON CONFLICT (standard, dimension) DO UPDATE SET unit = EXCLUDED.unit;


-- ============================================================
--  WHAT THIS PRACTICE HAS CHOSEN
--  These four rows are the whole settings surface for now. Each
--  one changes how numbers are DISPLAYED and none of them
--  changes what is stored — every value in crm.measurements is
--  canonical, always, so switching standard reformats the past
--  as well as the future and cannot corrupt anything.
-- ============================================================

INSERT INTO crm.settings (key, value, label, description) VALUES

  ('units.standard', '"india_clinical"'::jsonb,
   'Unit standard',
   'Which set of units every number is shown in. Stored values never change — only how they are displayed.'),

  ('units.overrides', '{}'::jsonb,
   'Unit overrides',
   'Per-dimension exceptions to the standard, e.g. {"mass":"lb"} to show weights in pounds while everything else follows the standard.'),

  /* THE ONE THAT MATTERS CLINICALLY. A BMI of 24 is healthy on
     the international cut-offs and overweight on the WHO
     Asia-Pacific ones, and for this practice's clients the second
     is the correct reading. It is a setting rather than a
     hard-coded choice because she may one day have a client it is
     wrong for, and because a clinical cut-off should be visible
     and changeable rather than buried in a stylesheet. */
  ('metrics.bands_standard', '"asia_pacific"'::jsonb,
   'Reference cut-offs',
   'Which set of reference bands to read: asia_pacific (WHO Asian cut-offs — BMI 23 overweight, 25 obese) or who (international — 25 and 30).'),

  ('metrics.energy_formula', '"mifflin"'::jsonb,
   'Energy requirement formula',
   'Which equation estimates resting energy: mifflin (Mifflin-St Jeor, the default) or harris (Harris-Benedict, revised).')

ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label, description = EXCLUDED.description;
-- Deliberately NOT updating `value`: re-running this file must
-- not silently put her settings back to the defaults.

COMMIT;

\echo 'units: standards and settings loaded'
