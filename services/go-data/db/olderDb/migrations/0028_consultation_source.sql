-- ============================================================
--  0028_consultation_source — where a request came from
-- ------------------------------------------------------------
--  Every consultation in this table arrived one way: a stranger
--  talked to the front desk and booked a slot. That is about to
--  stop being true — a client already on a programme can ask for
--  a review from their app — and the two are not the same job.
--
--  A STRANGER'S BOOKING AND A CLIENT'S REVIEW LOOK IDENTICAL IN A
--  LIST AND ARE ANSWERED DIFFERENTLY. She has never met the first
--  and reads their whole enquiry before deciding. She has seen the
--  second for an hour, has their plan open in the next tab, and
--  the only question is when. Requests showing both as one kind of
--  row would make her read every one as if it were the first.
--
--  A COLUMN RATHER THAN A DERIVATION. "Has an active programme"
--  would answer it today and stop answering it the day a
--  programme is revoked or expires — and then a consultation
--  quietly changes what it was after the fact. What something IS
--  should not depend on what is true this afternoon.
--
--  DEFAULT 'chatbot', because that is what every existing row is
--  and backfilling a guess would be worse than saying so.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

ALTER TABLE crm.consultations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'chatbot';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consultations_source_check'
  ) THEN
    ALTER TABLE crm.consultations
      ADD CONSTRAINT consultations_source_check
      CHECK (source IN ('chatbot', 'review', 'manual'));
  END IF;
END $$;

COMMENT ON COLUMN crm.consultations.source IS
  'chatbot = a stranger booked a slot. review = a client on a programme asked from their app, with no time on it yet. manual = she wrote it in herself.';

/* A REVIEW REQUEST HAS NO TIME ON IT, and that is the shape rather
   than an omission: the client is asking, she is offering. The
   column was already nullable — the chatbot writes null when
   somebody described an hour in prose that matched nothing — so
   nothing changes there. This index is what makes her Requests
   page able to find the timeless ones without reading the table. */
CREATE INDEX IF NOT EXISTS consultations_awaiting_time
  ON crm.consultations (created_at DESC)
  WHERE status = 'held' AND scheduled_start_at IS NULL;
