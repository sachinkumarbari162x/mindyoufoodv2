-- ============================================================
--  0003 · THE CRM SCHEMA
--
--  A schema of its own rather than a second database. It gives
--  the separation that was asked for — the CRM's tables are not
--  mixed in with the desk's working tables, and a grant can be
--  scoped to `crm` alone — without a second connection pool, a
--  second set of credentials, or a second thing to back up on a
--  box with 1GB of memory.
--
--  Deliberately three plain tables. Everything the CRM does is
--  reading and writing rows; there is no logic down here to go
--  out of step with the logic upstairs.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS crm;

-- ============================================================
--  crm.countries — the country of origin list
--
--  She named four markets: the UK, the USA, Saudi Arabia and
--  India. Those are PINNED to the top of every dropdown via
--  `priority`; everything else follows alphabetically, because
--  "any country" was the other half of her answer and a list
--  that only offers four would turn a fifth into a support
--  email.
--
--  `phone_digits` is how many digits a mobile number has there.
--  An empty array means "no rule known" and the generic 6–15
--  check applies — an unlisted country is accepted, never
--  rejected for being unlisted.
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.countries (
  iso2         char(2) PRIMARY KEY,
  name         text NOT NULL,
  dial_code    text NOT NULL,
  phone_digits smallint[] NOT NULL DEFAULT '{}',
  -- Non-null pins it to the top of the list, in this order.
  priority     smallint,
  active       boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS countries_order_idx
  ON crm.countries (priority NULLS LAST, name);

INSERT INTO crm.countries (iso2, name, dial_code, phone_digits, priority) VALUES
  -- ---- hers, in the order she gave them ----
  ('GB', 'United Kingdom',        '+44',  '{10,11}', 1),
  ('US', 'United States',         '+1',   '{10}',    2),
  ('SA', 'Saudi Arabia',          '+966', '{9}',     3),
  ('IN', 'India',                 '+91',  '{10}',    4),

  -- ---- the Gulf and wider Middle East ----
  ('AE', 'United Arab Emirates',  '+971', '{9}',     NULL),
  ('QA', 'Qatar',                 '+974', '{8}',     NULL),
  ('KW', 'Kuwait',                '+965', '{8}',     NULL),
  ('BH', 'Bahrain',               '+973', '{8}',     NULL),
  ('OM', 'Oman',                  '+968', '{8}',     NULL),
  ('JO', 'Jordan',                '+962', '{9}',     NULL),
  ('LB', 'Lebanon',               '+961', '{7,8}',   NULL),
  ('EG', 'Egypt',                 '+20',  '{10}',    NULL),
  ('TR', 'Türkiye',               '+90',  '{10}',    NULL),
  ('IL', 'Israel',                '+972', '{9}',     NULL),
  ('IQ', 'Iraq',                  '+964', '{10}',    NULL),

  -- ---- South Asia ----
  ('PK', 'Pakistan',              '+92',  '{10}',    NULL),
  ('BD', 'Bangladesh',            '+880', '{10}',    NULL),
  ('LK', 'Sri Lanka',             '+94',  '{9}',     NULL),
  ('NP', 'Nepal',                 '+977', '{10}',    NULL),
  ('MV', 'Maldives',              '+960', '{7}',     NULL),
  ('BT', 'Bhutan',                '+975', '{8}',     NULL),
  ('AF', 'Afghanistan',           '+93',  '{9}',     NULL),

  -- ---- Europe ----
  ('IE', 'Ireland',               '+353', '{9}',     NULL),
  ('DE', 'Germany',               '+49',  '{10,11}', NULL),
  ('FR', 'France',                '+33',  '{9}',     NULL),
  ('ES', 'Spain',                 '+34',  '{9}',     NULL),
  ('IT', 'Italy',                 '+39',  '{9,10}',  NULL),
  ('PT', 'Portugal',              '+351', '{9}',     NULL),
  ('NL', 'Netherlands',           '+31',  '{9}',     NULL),
  ('BE', 'Belgium',               '+32',  '{9}',     NULL),
  ('CH', 'Switzerland',           '+41',  '{9}',     NULL),
  ('AT', 'Austria',               '+43',  '{}',      NULL),
  ('SE', 'Sweden',                '+46',  '{9}',     NULL),
  ('NO', 'Norway',                '+47',  '{8}',     NULL),
  ('DK', 'Denmark',               '+45',  '{8}',     NULL),
  ('FI', 'Finland',               '+358', '{9}',     NULL),
  ('PL', 'Poland',                '+48',  '{9}',     NULL),
  ('CZ', 'Czechia',               '+420', '{9}',     NULL),
  ('GR', 'Greece',                '+30',  '{10}',    NULL),
  ('RO', 'Romania',               '+40',  '{9}',     NULL),
  ('HU', 'Hungary',               '+36',  '{9}',     NULL),
  ('UA', 'Ukraine',               '+380', '{9}',     NULL),
  ('RU', 'Russia',                '+7',   '{10}',    NULL),

  -- ---- North America ----
  ('CA', 'Canada',                '+1',   '{10}',    NULL),
  ('MX', 'Mexico',                '+52',  '{10}',    NULL),

  -- ---- Asia-Pacific ----
  ('AU', 'Australia',             '+61',  '{9}',     NULL),
  ('NZ', 'New Zealand',           '+64',  '{8,9}',   NULL),
  ('SG', 'Singapore',             '+65',  '{8}',     NULL),
  ('MY', 'Malaysia',              '+60',  '{9,10}',  NULL),
  ('ID', 'Indonesia',             '+62',  '{}',      NULL),
  ('TH', 'Thailand',              '+66',  '{9}',     NULL),
  ('PH', 'Philippines',           '+63',  '{10}',    NULL),
  ('VN', 'Vietnam',               '+84',  '{9}',     NULL),
  ('CN', 'China',                 '+86',  '{11}',    NULL),
  ('HK', 'Hong Kong',             '+852', '{8}',     NULL),
  ('JP', 'Japan',                 '+81',  '{10}',    NULL),
  ('KR', 'South Korea',           '+82',  '{9,10}',  NULL),
  ('TW', 'Taiwan',                '+886', '{9}',     NULL),

  -- ---- Africa ----
  ('ZA', 'South Africa',          '+27',  '{9}',     NULL),
  ('NG', 'Nigeria',               '+234', '{10}',    NULL),
  ('KE', 'Kenya',                 '+254', '{9}',     NULL),
  ('GH', 'Ghana',                 '+233', '{9}',     NULL),
  ('TZ', 'Tanzania',              '+255', '{9}',     NULL),
  ('UG', 'Uganda',                '+256', '{9}',     NULL),
  ('MA', 'Morocco',               '+212', '{9}',     NULL),
  ('DZ', 'Algeria',               '+213', '{9}',     NULL),
  ('TN', 'Tunisia',               '+216', '{8}',     NULL),
  ('ET', 'Ethiopia',              '+251', '{9}',     NULL),
  ('MU', 'Mauritius',             '+230', '{8}',     NULL),

  -- ---- South America ----
  ('BR', 'Brazil',                '+55',  '{10,11}', NULL),
  ('AR', 'Argentina',             '+54',  '{10}',    NULL),
  ('CL', 'Chile',                 '+56',  '{9}',     NULL),
  ('CO', 'Colombia',              '+57',  '{10}',    NULL),
  ('PE', 'Peru',                  '+51',  '{9}',     NULL)
ON CONFLICT (iso2) DO NOTHING;

-- ============================================================
--  crm.people — one row per human, ever
--
--  Email is the identity. Somebody who books three times is one
--  person with three consultations, not three records — which is
--  the whole reason this table exists separately from the
--  booking rows.
--
--  `id` is the unique id everything in the CRM hangs off.
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name         text NOT NULL,
  -- Normalised to lowercase before insert; the index enforces it.
  email        text NOT NULL,
  phone        text,
  dob          date,
  country_iso2 char(2) REFERENCES crm.countries (iso2),

  -- Where this person first came from: 'chatbot', 'crm', 'form'.
  source       text NOT NULL DEFAULT 'chatbot',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS people_email_key
  ON crm.people (lower(email));

-- ============================================================
--  crm.consultations — what each person came about
--
--  One row per request. The person is the constant; this is the
--  thing that has a date, a mode and a status.
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.consultations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES crm.people (id) ON DELETE CASCADE,

  -- Kept in the visitor's own words. She would rather read
  -- "my sugar has been high since March" than a category the
  -- desk guessed at.
  issue        text NOT NULL,
  mode         text NOT NULL DEFAULT 'undecided'
                 CHECK (mode IN ('video', 'audio', 'in_person', 'undecided')),

  status       text NOT NULL DEFAULT 'held'
                 CHECK (status IN ('held', 'confirmed', 'declined',
                                   'completed', 'cancelled', 'no_show')),

  scheduled_start_at timestamptz,
  scheduled_end_at   timestamptz,
  hold_expires_at    timestamptz,
  confirmed_at       timestamptz,

  -- The visitor's zone, so she calls at the hour they expect.
  timezone     text,
  notes        text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The same guard as public.appointments, for the same reason: two
-- visitors shown one free slot will both take it, and only a write-
-- time check can refuse the second.
CREATE UNIQUE INDEX IF NOT EXISTS consultations_slot_unique
  ON crm.consultations (scheduled_start_at)
  WHERE status IN ('held', 'confirmed');

CREATE INDEX IF NOT EXISTS consultations_person_idx
  ON crm.consultations (person_id, created_at DESC);

CREATE INDEX IF NOT EXISTS consultations_queue_idx
  ON crm.consultations (status, scheduled_start_at);
