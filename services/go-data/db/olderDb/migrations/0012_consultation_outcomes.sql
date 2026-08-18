-- ============================================================
--  0012_consultation_outcomes — what actually happened
-- ------------------------------------------------------------
--  Until now a consultation was held, confirmed or declined, and
--  the story stopped at the door. Whether it then HAPPENED — was
--  attended, moved, called off, or quietly not turned up to — was
--  nowhere, which means she could not answer "how many no-shows
--  last month" and neither could anybody else.
--
--  A SEPARATE TABLE, NOT A COLUMN. Two reasons, and the second is
--  the one that matters:
--
--    A consultation can be rescheduled more than once. A column
--    holds the latest answer and forgets the rest; a table keeps
--    the sequence, which is the thing worth having — three moves
--    before an appointment is a fact about that client.
--
--    An outcome is recorded BY somebody AT a time, sometimes with
--    a note. That is a row, not a value.
--
--  The consultation's own `status` stays what it is: the state of
--  the booking. This is the state of the appointment, and they
--  genuinely differ — a confirmed booking can end in a no-show.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.consultation_outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL
                    REFERENCES crm.consultations (id) ON DELETE CASCADE,

  /* done         she saw them, the session happened
     rescheduled  moved to another time; `moved_to` says when
     cancelled    called off in advance, by either side
     no_show      the time came and went

     Spelled out rather than coded, because this column is read by
     eye far more often than it is written. */
  outcome         text NOT NULL
                    CHECK (outcome IN ('done', 'rescheduled', 'cancelled', 'no_show')),

  -- When the appointment this refers to was scheduled for. Copied
  -- rather than joined: a rescheduled consultation changes its own
  -- start time, and this row is about the slot that was missed or
  -- kept, not wherever it ended up.
  was_scheduled_at timestamptz,

  -- Only for 'rescheduled', and it is what makes the sequence
  -- readable: moved from Tuesday to Thursday to the following week.
  moved_to        timestamptz,

  -- Hers. A no-show with "car broke down, rebooking" is a different
  -- fact from a no-show with nothing.
  note            text,

  recorded_by     text NOT NULL DEFAULT 'unknown',
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  -- A reschedule that does not say where it went is not a
  -- reschedule, it is a cancellation with better manners.
  CONSTRAINT outcome_reschedule_has_a_target
    CHECK (outcome <> 'rescheduled' OR moved_to IS NOT NULL)
);

-- The two readings this table exists for: one consultation's
-- history, and everything that happened lately.
CREATE INDEX IF NOT EXISTS outcomes_by_consultation_idx
  ON crm.consultation_outcomes (consultation_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS outcomes_recent_idx
  ON crm.consultation_outcomes (recorded_at DESC);

-- And counting them by kind, which is the question she will
-- actually ask: how many no-shows this month.
CREATE INDEX IF NOT EXISTS outcomes_kind_idx
  ON crm.consultation_outcomes (outcome, recorded_at DESC);
