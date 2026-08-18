-- ============================================================
--  MIND YOUR FOOD · TRIAL SCHEMA
--
--  Applied to the myf_trial database ONLY. This is a testbed for
--  the BMI → chat → appointment path; it is not the production
--  backend's schema and shares nothing with it. The live system
--  keeps its appointments in its own Postgres (docker, :5433) via
--  Prisma, and this file must never be pointed at that database.
--
--  Idempotent throughout — re-running it is a no-op, so the Go
--  service can apply it on boot without a migration tool.
-- ============================================================

-- gen_random_uuid() lives here on PG13+.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
--  bmi_snapshots — one calculation, as submitted
--
--  Deliberately has NO name, email or phone column. A BMI plus a
--  health goal attached to a person is health data; keeping the
--  numbers unattached means a leak of this table is a pile of
--  anonymous measurements rather than a list of people and their
--  bodies. The join to a person happens only at booking time, and
--  only through the appointment row.
-- ============================================================
CREATE TABLE IF NOT EXISTS bmi_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  height_cm       numeric(5,1)  NOT NULL CHECK (height_cm  BETWEEN 60  AND 260),
  weight_kg       numeric(5,1)  NOT NULL CHECK (weight_kg  BETWEEN 20  AND 400),
  -- Stored, not recomputed on read: it is what the visitor was
  -- actually shown, and the formula could change.
  bmi             numeric(4,1)  NOT NULL CHECK (bmi        BETWEEN 5   AND 100),
  category        text          NOT NULL,
  -- WHO cut-offs differ for South Asian populations; which set was
  -- applied is part of the record, not an implementation detail.
  category_basis  text          NOT NULL DEFAULT 'who',

  age_years       smallint      CHECK (age_years BETWEEN 16 AND 120),
  sex             text          CHECK (sex IN ('female','male','unspecified')),
  goal            text,
  units           text          NOT NULL DEFAULT 'metric' CHECK (units IN ('metric','imperial')),

  created_at      timestamptz   NOT NULL DEFAULT now(),
  ip_hash         text,
  user_agent      text
);

-- ============================================================
--  handoff_tokens — the warm start
--
--  The BMI page hands the chat a token rather than the numbers
--  themselves, so the figures never travel through a URL, never
--  land in browser history, and cannot be edited by hand into
--  something the calculator would not have produced.
--
--  Single use and short lived: claimed_at is set the moment the
--  desk reads it, and a claimed or expired token resolves to
--  nothing.
-- ============================================================
CREATE TABLE IF NOT EXISTS handoff_tokens (
  token       text PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES bmi_snapshots(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS handoff_tokens_expires_idx
  ON handoff_tokens (expires_at)
  WHERE claimed_at IS NULL;

-- ============================================================
--  appointments — the trial mirror
--
--  Mirrors the shape the production endpoint accepts so the trial
--  exercises the same fields, plus the BMI link the live schema
--  has no column for. Writing here does NOT create a real booking;
--  the live path is still POST /appointments on the backend.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference      text UNIQUE NOT NULL,

  name           text NOT NULL,
  email          text NOT NULL,
  phone          text,
  focus_area     text NOT NULL,
  dob            date,
  country        text,
  mode           text NOT NULL DEFAULT 'undecided'
                   CHECK (mode IN ('video','in_person','undecided')),
  notes          text,
  -- The visitor proposes up to three; the practitioner picks one.
  -- JSONB rather than a child table because nothing ever queries
  -- inside it — it is read once, by a human.
  suggested_slots jsonb NOT NULL DEFAULT '[]'::jsonb,

  snapshot_id    uuid REFERENCES bmi_snapshots(id) ON DELETE SET NULL,

  source         text NOT NULL DEFAULT 'trial',
  status         text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','contacted','confirmed','completed',
                                     'cancelled','declined','no_show')),
  policy_version text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One person books repeatedly over time, and the practitioner reads
-- her list newest first — so both of those get an index.
CREATE INDEX IF NOT EXISTS appointments_email_idx      ON appointments (lower(email));
CREATE INDEX IF NOT EXISTS appointments_created_idx    ON appointments (created_at DESC);
CREATE INDEX IF NOT EXISTS appointments_status_idx     ON appointments (status)
  WHERE status IN ('requested','contacted');

-- ============================================================
--  housekeeping
-- ============================================================
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_touch ON appointments;
CREATE TRIGGER appointments_touch
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Expired handoffs are worthless and carry body measurements, so
-- they go rather than accumulating. Called by the Go service on a
-- timer; deliberately a function so it can also be run by hand.
CREATE OR REPLACE FUNCTION purge_expired_handoffs(older_than interval DEFAULT '1 hour')
RETURNS integer AS $$
DECLARE
  removed integer;
BEGIN
  WITH gone AS (
    DELETE FROM handoff_tokens
     WHERE expires_at < now() - older_than
    RETURNING snapshot_id
  )
  DELETE FROM bmi_snapshots s
   USING gone
   WHERE s.id = gone.snapshot_id
     -- Keep any snapshot that made it as far as a booking.
     AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.snapshot_id = s.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;
