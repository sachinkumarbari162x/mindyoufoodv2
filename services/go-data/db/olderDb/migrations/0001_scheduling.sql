-- ============================================================
--  0001 · SCHEDULING
--
--  Turns the appointments table from a record of what a visitor
--  ASKED for into a record of a time that is actually booked, and
--  adds the two tables that decide which times may be offered.
--
--  Run inside a transaction by the migration runner — do not add
--  BEGIN/COMMIT here.
-- ============================================================

-- ---- modes -------------------------------------------------
-- `audio` is new: she rings some visitors rather than video calling
-- them, and which one it is decides what the confirmation says and
-- whether a phone number is required at all.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_mode_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_mode_check
  CHECK (mode IN ('video', 'audio', 'in_person', 'undecided'));

-- ---- status ------------------------------------------------
-- `held` is the state between a visitor picking a slot and her
-- accepting it. It is the whole reason double-booking is possible,
-- and the reason the unique index below exists.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('requested', 'held', 'contacted', 'confirmed',
                    'completed', 'cancelled', 'declined', 'no_show'));

-- ---- the booked time ---------------------------------------
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_end_at   timestamptz,
  -- When an unanswered hold stops blocking the slot for everybody
  -- else. Null once she has answered, either way.
  ADD COLUMN IF NOT EXISTS hold_expires_at    timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at       timestamptz,
  -- The visitor's own zone, so she calls at the hour they expect and
  -- the confirmation reads in their local time.
  ADD COLUMN IF NOT EXISTS timezone           text;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_slot_order_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_slot_order_check
  CHECK (scheduled_end_at IS NULL
         OR scheduled_start_at IS NULL
         OR scheduled_end_at > scheduled_start_at);

-- ============================================================
--  THE DOUBLE-BOOKING GUARD
--
--  Two visitors are shown the same free slot seconds apart and both
--  take it. Everything else — the availability rules, the cached
--  view of what was free — is a snapshot that was true a moment ago.
--  This is the only check evaluated at the instant of writing, so
--  this is what actually prevents it.
--
--  Partial on purpose: a cancelled or declined booking must not keep
--  its slot reserved forever.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot_unique
  ON appointments (scheduled_start_at)
  WHERE status IN ('held', 'confirmed');

-- Her working list: what is waiting, and what is coming up.
CREATE INDEX IF NOT EXISTS appointments_pending_idx
  ON appointments (hold_expires_at)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS appointments_upcoming_idx
  ON appointments (scheduled_start_at)
  WHERE status = 'confirmed';

-- ============================================================
--  availability_rules — the weekly pattern, set in bulk
--
--  "Tuesdays and Thursdays, 11:00-13:00, from now until October."
--  One row per band per weekday, so a split day is two rows and a
--  change of season is a new row rather than an edit.
--
--  Minutes from midnight, in the practice's timezone. Not a `time`
--  column: these are rules about the clock on the wall, and storing
--  them as instants would make them drift with daylight saving in
--  any country that observes it.
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday        smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  starts_min     smallint NOT NULL CHECK (starts_min BETWEEN 0 AND 1439),
  ends_min       smallint NOT NULL CHECK (ends_min   BETWEEN 1 AND 1440),

  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,                                  -- null = until further notice

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT availability_rules_span_check CHECK (ends_min > starts_min),
  CONSTRAINT availability_rules_dates_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS availability_rules_lookup_idx
  ON availability_rules (weekday, effective_from);

-- ============================================================
--  availability_exceptions — the one-offs
--
--  Two kinds, and they are opposites:
--    closed — shut a date the weekly pattern would have opened
--    open   — open a band the weekly pattern does not cover
--
--  `closed` always wins over both the rules and any `open` row; it
--  is the row she adds because something has come up, and that must
--  never be overridden by a pattern she set up weeks earlier.
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  on_date    date NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('closed', 'open')),
  starts_min smallint CHECK (starts_min BETWEEN 0 AND 1439),
  ends_min   smallint CHECK (ends_min   BETWEEN 1 AND 1440),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- A closure shuts the whole day and needs no times; an opening is
  -- meaningless without them.
  CONSTRAINT availability_exceptions_times_check CHECK (
    (kind = 'closed' AND starts_min IS NULL AND ends_min IS NULL)
    OR
    (kind = 'open' AND starts_min IS NOT NULL AND ends_min IS NOT NULL
     AND ends_min > starts_min)
  )
);

-- A date can only be closed once; saying it twice is the same fact.
CREATE UNIQUE INDEX IF NOT EXISTS availability_exceptions_closed_once
  ON availability_exceptions (on_date)
  WHERE kind = 'closed';

CREATE INDEX IF NOT EXISTS availability_exceptions_date_idx
  ON availability_exceptions (on_date);
