-- ============================================================
--  0015_consultation_links — the opaque link sent on WhatsApp
-- ------------------------------------------------------------
--  A WhatsApp message carries a token; the token resolves to a
--  page on our own domain; whatever the consultation actually
--  needs lives on that page. Nothing about the appointment
--  travels through WhatsApp itself.
--
--  WHY THE INDIRECTION IS WORTH A TABLE:
--
--    · what the link leads to can be changed or revoked later
--      without messaging anybody again;
--    · a forwarded chat, a screenshot or a phone backup carries
--      the token, not the destination;
--    · it can be made to stop working after the session, which
--      a raw link never can once it is out;
--    · an unopened link on the morning of a session is a signal
--      worth having.
--
--  ONE TOKEN PER CONSULTATION, not one per message. If she sends
--  the confirmation twice, the client must not end up holding two
--  different links wondering which is real — the unique index
--  below is what makes a second send reuse the first token.
--
--  NOT SINGLE-USE, unlike handoff_tokens. Somebody will open this
--  on their phone, then again on a laptop, then once more to
--  check the time. A link that dies on first read would look
--  broken exactly when it is being trusted.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.consultation_links (
  -- 24 random bytes, base64url — the same minting the BMI handoff
  -- uses. 192 bits is not guessable and not enumerable, which is
  -- what lets the page behind it be served without a login.
  token text PRIMARY KEY,

  consultation_id uuid NOT NULL
    REFERENCES crm.consultations (id) ON DELETE CASCADE,

  -- Room for what comes next — session notes, a plan, an intake
  -- form — without a second table shaped exactly like this one.
  purpose text NOT NULL DEFAULT 'consultation'
    CHECK (purpose IN ('consultation')),

  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Whether it was ever opened, and how often. Not analytics: a
  -- confirmed session whose link was never opened the morning of
  -- the appointment is worth her knowing about.
  opened_at  timestamptz,
  open_count int NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS consultation_links_one_per_purpose
  ON crm.consultation_links (consultation_id, purpose);

-- Sweeping expired rows, and nothing else reads by this.
CREATE INDEX IF NOT EXISTS consultation_links_expiry
  ON crm.consultation_links (expires_at);
