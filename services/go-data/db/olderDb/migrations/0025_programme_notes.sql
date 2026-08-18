-- ============================================================
--  0025_programme_notes — what they wanted to say
-- ------------------------------------------------------------
--  A check-in answers a question she asked. This is the other
--  direction: something they wanted to tell her that no row on the
--  plan has a box for. "Stomach was off all day." "Travelling next
--  week, will not be able to cook." "The almonds are making me
--  gassy." None of that fits into done / some / no, and all of it
--  changes what she would do next.
--
--  WHY NOT crm.checkins.note. That column exists and is the right
--  place for "only had half the rice" — it belongs TO a row. This
--  does not belong to any row, and hanging it off an arbitrary one
--  would put a note about the whole day inside the record of
--  breakfast, where neither she nor a later query would find it.
--  plan_item_id is NOT NULL there, deliberately, and it stays that
--  way.
--
--  APPEND-ONLY, LIKE EVERYTHING ELSE ON THIS SIDE. No update path
--  and no delete path. A note is a message somebody sent; a
--  message you can quietly edit afterwards is not a record of
--  anything. Two notes on one day are two notes, in the order they
--  were written.
--
--  IT IS NOT A CONVERSATION, and the absence of a reply column is
--  the design rather than an omission. Replying is phase seven and
--  it needs a decision about notification that has not been taken:
--  a client who writes here and expects an answer within the hour
--  has been misled by the box. The app says so above the box.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.programme_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* CASCADE from the programme, like the check-ins. Erasing a
     client takes their notes with them. */
  programme_id uuid NOT NULL REFERENCES crm.programmes (id) ON DELETE CASCADE,

  /* The day it is ABOUT, which is not always the day it was
     written: a note queued on a train arrives tomorrow and still
     belongs to yesterday. Bounded in Go to the same window as a
     check-in, so this cannot become a way to write into last year. */
  on_date date NOT NULL,

  body text NOT NULL CHECK (btrim(body) <> ''),

  /* When it was written. `at` and not `created_at`, to match
     crm.checkins — one word for one idea across the two tables
     somebody will inevitably join. */
  at timestamptz NOT NULL DEFAULT now(),

  /* Set the first time she opens it. Nothing shows this to the
     client — it exists so her side can mark what is new, and so a
     later phase can answer "did she see it" honestly. */
  seen_at timestamptz
);

/* Her monitor's query: this programme, newest day first. */
CREATE INDEX IF NOT EXISTS programme_notes_day
  ON crm.programme_notes (programme_id, on_date DESC, at DESC);

/* Everything unread, across every client — the query the thread in
   phase seven will open with, and the one an "anything waiting?"
   badge would make on every page. Partial, so it stays small. */
CREATE INDEX IF NOT EXISTS programme_notes_unseen
  ON crm.programme_notes (at DESC) WHERE seen_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.programme_notes FROM myf_viewer;
  END IF;
END $$;
