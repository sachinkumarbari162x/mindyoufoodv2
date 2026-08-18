-- ============================================================
--  0027 — how long a programme runs, and who wrote a note
-- ------------------------------------------------------------
--  TWO CHANGES, and they are in one file because they arrived
--  from one conversation: the client's app should show the plan's
--  own window rather than a rolling month, and it should show her
--  answers next to their questions.
--
--  ---- length_days -------------------------------------------
--  A programme is a course of treatment with a beginning and an
--  end. The app was drawing "the last thirty days", which is a
--  different thing entirely: it drifts forward daily, it never
--  ends, and it cannot answer "how far through am I". Thirty,
--  sixty or ninety, chosen when she starts it.
--
--  A CHECK and not a free integer. These are the three she
--  actually offers, and a column that accepts 47 is a column that
--  eventually holds 47 because something calculated it.
--
--  DEFAULT 30 so the programmes already running get the length
--  they were effectively already being shown.
--
--  ---- author, and `by` --------------------------------------
--  crm.programme_notes becomes a THREAD rather than an inbox. The
--  same table, one more column: a note is from the client or from
--  her, and both sides read the day's whole conversation.
--
--  A SEPARATE REPLIES TABLE WAS THE OTHER OPTION and it is worse.
--  Every read would become a union of two tables ordered by time,
--  every new feature would need writing twice, and the one
--  question that matters — what was said about the fourth, in
--  order — would be the awkward query rather than the obvious one.
--
--  `seen_at` NOW MEANS "the other side has read this". For a
--  client's note that is her; for her reply it is the client. One
--  column, because the question is the same from both ends.
--
--  STILL APPEND-ONLY. No edit path and no delete path on either
--  side. A message somebody can quietly rewrite after it was read
--  is not a record of a conversation.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

ALTER TABLE crm.programmes
  ADD COLUMN IF NOT EXISTS length_days int NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'programmes_length_check'
  ) THEN
    ALTER TABLE crm.programmes
      ADD CONSTRAINT programmes_length_check CHECK (length_days IN (30, 60, 90));
  END IF;
END $$;

COMMENT ON COLUMN crm.programmes.length_days IS
  'How long the plan runs. The client app draws exactly this window.';

ALTER TABLE crm.programme_notes
  ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT 'client';

ALTER TABLE crm.programme_notes
  ADD COLUMN IF NOT EXISTS by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'programme_notes_author_check'
  ) THEN
    ALTER TABLE crm.programme_notes
      ADD CONSTRAINT programme_notes_author_check
      CHECK (author IN ('client', 'practitioner'));
  END IF;

  /* HER REPLIES CARRY HER NAME, and the database is what insists on
     it. The same rule as a confirmed plan row: anything written by
     the practice has somebody attached, so a line in a client's
     record can never be traced to "the system". */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'programme_notes_reply_has_who'
  ) THEN
    ALTER TABLE crm.programme_notes
      ADD CONSTRAINT programme_notes_reply_has_who
      CHECK (author = 'client' OR (by IS NOT NULL AND btrim(by) <> ''));
  END IF;
END $$;

/* The thread for one day, in order. Replaces the day index from
   0025, which did not know about the author. */
CREATE INDEX IF NOT EXISTS programme_notes_thread
  ON crm.programme_notes (programme_id, on_date DESC, at ASC);

/* Unread, from either side. Partial so it stays small, and split by
   author so "has she replied to me" and "has anybody written to me"
   are both one index scan. */
CREATE INDEX IF NOT EXISTS programme_notes_unseen_by_author
  ON crm.programme_notes (programme_id, author, at DESC) WHERE seen_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.programme_notes FROM myf_viewer;
  END IF;
END $$;
