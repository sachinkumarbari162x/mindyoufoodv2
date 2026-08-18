-- ============================================================
--  0002 · NOTIFICATIONS
--
--  Every message the system sends, and what it actually said.
--
--  Email is the only channel that sends by itself, so it is the only
--  channel here. Anything she taps out herself — a call, a WhatsApp
--  message from her own phone — is not a system message and is not
--  recorded as one; claiming otherwise would make this log a work of
--  fiction the first time she rang someone instead.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,

  channel        text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),

  -- held             → visitor: your slot is held, she will confirm
  -- confirmed        → visitor: it is booked, here is what happens
  -- declined         → visitor: not that time, here are others
  -- prep             → visitor: your session is tomorrow, have these ready
  -- practitioner_new → her: a booking is waiting
  kind           text NOT NULL CHECK (kind IN ('held', 'confirmed', 'declined',
                                               'prep', 'practitioner_new')),

  recipient      text NOT NULL,

  -- Which wording was in force. Without these two the log proves a
  -- message was sent but not what it said, which is the half that
  -- matters if a booking is ever disputed.
  template_id      text NOT NULL,
  template_version text NOT NULL,
  body             text NOT NULL,

  provider_message_id text,

  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sent', 'failed')),
  queued_at      timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  failed_at      timestamptz,
  error          text
);

-- ============================================================
--  SEND ONCE
--
--  A double-clicked Accept, a retried request, a page refreshed at
--  the wrong moment — all of them try to send a second confirmation.
--  The unique index makes the second attempt fail at the database
--  rather than in whichever branch of the code forgot to check.
--
--  Deliberately not partial: a failed send still occupies the slot,
--  so retrying means updating that row rather than quietly sending a
--  second message to somebody who already had the first.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once
  ON notifications (appointment_id, kind);

-- Her "did they actually get it?" column, and the retry sweep.
CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications (queued_at)
  WHERE status <> 'sent';
