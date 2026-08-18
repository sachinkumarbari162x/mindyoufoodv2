-- ============================================================
--  0005 — THE METRIC REGISTRY, AND UNITS THAT ARE NOT A GUESS
-- ------------------------------------------------------------
--  Until now every number in this system carried its unit as a
--  free-text column beside it: measurements.unit is `text`, and
--  it holds whatever the person typing put there. "kg", "Kg",
--  "kgs", "kilogram". That is survivable for storing a weight
--  and impossible for anything else — you cannot chart, compare,
--  convert or band a column whose unit is spelled four ways, and
--  you certainly cannot show one client pounds and another
--  kilograms off the same row.
--
--  THREE TABLES, AND THEY ANSWER THREE DIFFERENT QUESTIONS.
--
--    crm.units          what a unit IS: its dimension, and the
--                       factor that takes it to the canonical one.
--                       Conversion is arithmetic, and arithmetic
--                       belongs in one place.
--
--    crm.metric_defs    what a metric IS: which tier it belongs
--                       to, what it is measured in, how it is
--                       derived if it is derived, what counts as
--                       normal, and which direction is better.
--
--    crm.settings       what this practice has CHOSEN: which unit
--                       standard, which set of reference bands.
--
--  WHY THE DIMENSION IS PER-ANALYTE AND NOT "CONCENTRATION".
--  mg/dL to mmol/L is not one conversion. Glucose divides by
--  18.0, cholesterol by 38.67, triglycerides by 88.57, creatinine
--  by 88.4 — because the factor is the molar mass of the thing
--  being measured. A single `concentration` dimension would let
--  the system convert a cholesterol with a glucose factor and
--  produce a number that looks entirely plausible and is wrong by
--  a factor of two. So glucose, cholesterol and creatinine are
--  each their own dimension, and a conversion between two units
--  of different dimensions is refused rather than approximated.
--
--  WHY BANDS ARE PER-STANDARD.
--  A BMI of 24 is "healthy" by the international cut-offs and
--  "overweight" by the WHO Asia-Pacific ones. For an Indian
--  practice the second is the clinically correct set, and saying
--  so out loud is better than hard-coding one and hoping. So
--  `bands` is keyed by standard and the practice picks which it
--  reads in settings.
-- ============================================================

-- ============================================================
--  UNITS
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.units (
  code         text PRIMARY KEY,

  /* WHAT KIND OF QUANTITY THIS IS. Two units can only be
     converted between when they share one. */
  dimension    text NOT NULL,

  label        text NOT NULL,
  symbol       text NOT NULL,

  /* value_in_canonical = value * factor + offset.
     The offset exists for temperature and for nothing else so
     far; it is here because leaving it out means discovering on
     the day somebody records a body temperature that the whole
     table has to change. */
  factor       numeric NOT NULL DEFAULT 1 CHECK (factor > 0),
  "offset"     numeric NOT NULL DEFAULT 0,

  /* Exactly one canonical unit per dimension — enforced below.
     Everything is stored canonical and converted on the way out,
     so a chart never mixes two units on one axis. */
  canonical    boolean NOT NULL DEFAULT false,

  decimals     smallint NOT NULL DEFAULT 1 CHECK (decimals BETWEEN 0 AND 4),
  sort         smallint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS units_dimension_idx ON crm.units (dimension);

CREATE UNIQUE INDEX IF NOT EXISTS units_one_canonical
  ON crm.units (dimension) WHERE canonical;

COMMENT ON TABLE crm.units IS
  'Every unit the system understands. Conversion is value * factor + offset to reach the dimension''s canonical unit, and is refused across dimensions.';


/* A NAMED SET OF CHOICES — "metric", "US customary", "Indian
   clinical". One row per dimension per standard, so a practice
   can be metric for weight and mg/dL for glucose, which is
   exactly what Indian labs actually report. */
CREATE TABLE IF NOT EXISTS crm.unit_standards (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort        smallint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crm.unit_standard_units (
  standard  text NOT NULL REFERENCES crm.unit_standards(code) ON DELETE CASCADE,
  dimension text NOT NULL,
  unit      text NOT NULL REFERENCES crm.units(code) ON DELETE RESTRICT,
  PRIMARY KEY (standard, dimension)
);


-- ============================================================
--  THE METRIC REGISTRY
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.metric_defs (
  key          text PRIMARY KEY,

  /* THE HIERARCHY, and the five tiers are not a taxonomy for its
     own sake — each one is produced differently and trusted
     differently:

       raw         somebody measured it. A scale, a lab, a watch,
                   a client typing what they ate. The only tier
                   that is ever written directly.
       calculated  arithmetic on raw values. Deterministic, and
                   recomputed rather than stored stale.
       signal      a clinical reading of the numbers — "insulin
                   resistant", "iron deficient". Never a
                   diagnosis; a flag that says look here.
       adherence   what the client did with the plan, not what
                   their body did.
       goal        distance from a target SHE set for THIS person.
                   Meaningless without a goal row behind it.

     A number cannot be interpreted without knowing which of
     these it is: "82" as a raw weight, a calculated adherence
     percentage and a goal gap are three different facts. */
  tier         text NOT NULL
                 CHECK (tier IN ('raw', 'calculated', 'signal', 'adherence', 'goal')),

  /* The group it belongs to on screen. */
  family       text NOT NULL,

  label        text NOT NULL,
  short_label  text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',

  /* What it is measured in. NULL dimension means dimensionless —
     a count, a ratio, a flag. */
  dimension    text,
  decimals     smallint NOT NULL DEFAULT 1 CHECK (decimals BETWEEN 0 AND 4),

  /* For calculated and goal tiers: how it is derived, written so
     a human can check it, and what it needs to exist. The formula
     is documentation and a specification — the implementation
     lives in code and is tested against these. */
  formula      text NOT NULL DEFAULT '',
  depends_on   text[] NOT NULL DEFAULT '{}',

  /* Which way is better, so a chart knows which direction to
     colour and a goal knows whether it is closing or opening.
     `target_band` means neither: there is a window and both
     sides of it are wrong. */
  direction    text NOT NULL DEFAULT 'neutral'
                 CHECK (direction IN ('higher_better', 'lower_better', 'target_band', 'neutral')),

  /* The general adult reference, in the CANONICAL unit. Bands
     below are richer; these two are what a simple in/out of range
     check reads, and they are what the client's panel already
     uses on lab rows. */
  ref_low      numeric,
  ref_high     numeric,

  /* Keyed by standard: {"who": [...], "asia_pacific": [...]}.
     Each band is {"to": 23, "label": "Healthy", "tone": "good"}
     with the last one open-ended (no "to"). */
  bands        jsonb NOT NULL DEFAULT '{}'::jsonb,

  /* Who or what produces it, and how often it is worth asking
     for. `cadence` is guidance for the CRM, not a rule. */
  source       text NOT NULL DEFAULT 'clinic'
                 CHECK (source IN ('clinic', 'self', 'device', 'lab', 'derived')),
  cadence      text NOT NULL DEFAULT '',

  /* Only sensible for one sex, where that is true — waist
     cut-offs and haemoglobin ranges both are. */
  sex          text NOT NULL DEFAULT 'any' CHECK (sex IN ('any', 'female', 'male')),

  active       boolean NOT NULL DEFAULT true,
  sort         smallint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS metric_defs_tier_idx ON crm.metric_defs (tier, family, sort);

COMMENT ON TABLE crm.metric_defs IS
  'The catalogue of everything this practice measures, calculates, flags or targets. Rows here are definitions; crm.measurements holds the values.';

COMMENT ON COLUMN crm.metric_defs.bands IS
  'Reference bands keyed by standard, e.g. {"asia_pacific":[{"to":18.5,"label":"Underweight","tone":"warn"},…]}. The last band omits "to".';


-- ============================================================
--  SETTINGS
--  One row per setting, value as jsonb. A single-practitioner
--  practice does not need a settings hierarchy; it needs a place
--  to put the four decisions that change how numbers are shown.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  label       text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT ''
);

COMMENT ON TABLE crm.settings IS
  'Practice-wide choices. Read on boot and cached; changing one changes how every number is displayed, never what is stored.';


/* ---- and the measurement rows point at the registry ---------
   `metric` on crm.measurements has always been free text. It
   stays text — a foreign key would refuse a reading whose
   definition has not been written yet, and refusing to record a
   client's number because the catalogue is behind is the wrong
   trade. The index is so the join is cheap; the discipline is
   that new metrics get a row in metric_defs. */
CREATE INDEX IF NOT EXISTS measurements_metric_idx ON crm.measurements (metric);
