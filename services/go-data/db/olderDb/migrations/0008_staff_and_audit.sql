-- ============================================================
--  0008_staff_and_audit — a door, and a record of what was done
-- ------------------------------------------------------------
--  Items 5 and 6. Until now /crm and /api/crm/* answered 200 to
--  anyone: every client's name, email, phone and consultation
--  history, on the only public port.
--
--  TWO TABLES, AND THE SECOND IS THE MORE IMPORTANT ONE.
--
--  The password prompt on every change was dropped, deliberately:
--  six prompts to add six bands produces a password short enough
--  to type six times. What protects the business instead is being
--  able to see, afterwards, that a band was deleted on Tuesday at
--  14:02 — and that is `crm.audit`.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

-- ------------------------------------------------------------
--  crm.staff — one row, hers
--
--  A table rather than an environment variable because a password
--  has to be changeable without a deploy, and because TOTP needs
--  somewhere to keep its secret.
--
--  The hash format is decided in Node and opaque here: this column
--  stores a string it does not interpret. Go never verifies a
--  password, so the shape of the hash is free to change without a
--  migration.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.staff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,

  -- Base32, RFC 4648. Null until she has actually enrolled a device;
  -- a secret that exists but was never confirmed would lock her out
  -- of her own CRM the first time she trusted it.
  totp_secret     text,
  totp_confirmed_at timestamptz,

  -- Set on a run of wrong passwords. Not a permanent lock: an
  -- attacker who can lock her out of her own practice has done
  -- damage without ever guessing anything.
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until    timestamptz,

  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staff_email_shape CHECK (position('@' IN email) > 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_email_once
  ON crm.staff (lower(email));

-- ------------------------------------------------------------
--  crm.audit — append only, and it means it
--
--  Every change she makes that a client could notice: hours, the
--  status of a request, anything sent, anything about payment.
--
--  `before` and `after` are jsonb rather than text so a change can
--  actually be read back later — "hours changed" is a note, but
--  "10:00-19:00 became 11:00-13:00" is a record.
--
--  There is no UPDATE or DELETE path in the application. The
--  guarantee is finished later by a role that lacks the privilege,
--  because a rule enforced only by the code that writes it is a
--  convention, not a guarantee.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),

  -- Who. One user today, so this is nearly always her — recorded
  -- anyway, because the day it is not is the day it matters.
  actor     text NOT NULL DEFAULT 'unknown',

  -- What, as a stable slug: hours.add, hours.drop, booking.accept,
  -- booking.decline, message.send, settings.save, payment.detail.
  action    text NOT NULL,

  -- Which thing it happened to, in words rather than keys. A row id
  -- here would age into a pointer at something deleted; "Monday
  -- 11:00-13:00" still reads in a year.
  target    text,

  before    jsonb,
  after     jsonb,

  -- Hashed, never the address itself. Enough to notice that a change
  -- came from somewhere new, not enough to be a location record.
  ip_hash   text
);

-- Read back newest first, which is the only way this is ever read.
CREATE INDEX IF NOT EXISTS audit_recent_idx ON crm.audit (at DESC);

-- And by subject, for "what has happened to the hours lately".
CREATE INDEX IF NOT EXISTS audit_action_idx ON crm.audit (action, at DESC);
