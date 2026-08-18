-- ============================================================
--  0014_messages — what the system sent, and whether it arrived
-- ------------------------------------------------------------
--  The Messages page has existed since the CRM was built and has
--  been showing sample rows the whole time, because there was no
--  table behind it. This is that table.
--
--  WHY EVERY SEND IS A ROW. An email nobody can see the fate of is
--  an email she has to ask the visitor about. "Did you get my
--  confirmation?" is a question this system exists to make
--  unnecessary — so a send that failed has to be visible, with the
--  provider's own reason attached, and retryable without her
--  having to reconstruct what it was.
--
--  WHAT IS NOT STORED: the body. It is re-rendered from the
--  consultation at retry time, so a template correction reaches
--  the retry rather than resending yesterday's wording, and so
--  this table does not become a second copy of everybody's
--  personal details.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Both nullable and both ON DELETE SET NULL: the record that we
  -- wrote to somebody must outlive the booking being cleaned up.
  consultation_id uuid REFERENCES crm.consultations (id) ON DELETE SET NULL,
  person_id       uuid REFERENCES crm.people (id)        ON DELETE SET NULL,

  channel text NOT NULL DEFAULT 'email'
    CHECK (channel IN ('email', 'whatsapp')),

  -- Which wording went out. The version is stored beside the id
  -- because the copy WILL be edited, and "she got the old one" is
  -- otherwise unanswerable six months later.
  template_id      text NOT NULL,
  template_version int  NOT NULL DEFAULT 1,

  recipient text NOT NULL,
  subject   text NOT NULL,

  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed')),

  -- Which service carried it, and its own id for the message, so a
  -- delivery question can be taken to the provider's dashboard.
  provider    text,
  provider_id text,
  error       text,
  attempts    int NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

/* ONE OF EACH KIND PER BOOKING, FOREVER.

   She double-clicks Accept; the browser sends it twice; the visitor
   gets two identical confirmations and now wonders whether they have
   two appointments. This is the same guard as the double-booking
   index on crm.consultations, for the same reason: the check that
   holds is the one the database makes, not the one the caller
   remembers to make.

   A retry UPDATES this row rather than inserting another, so the
   count of "how many times did we try" lives in `attempts` and the
   visitor's inbox stays truthful. */
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_per_booking
  ON crm.messages (consultation_id, template_id)
  WHERE consultation_id IS NOT NULL;

-- The page reads newest first, and only ever a page at a time.
CREATE INDEX IF NOT EXISTS messages_recent
  ON crm.messages (created_at DESC);

-- "What has not gone out?" is the question she will actually ask,
-- and it should not read the whole table to answer it.
CREATE INDEX IF NOT EXISTS messages_unsent
  ON crm.messages (status)
  WHERE status <> 'sent';
