-- ============================================================
--  0008 — NOT EVERY WAY IN OPENS EVERY DOOR
-- ------------------------------------------------------------
--  /me/<token> now opens the account panel instead of the old
--  programme app, so that one link no longer has to be typed
--  into and still gets somebody to their food. Good — but the
--  panel shows a great deal more than the programme app did:
--  receipts, lab results, uploaded documents, a phone number.
--
--  THE TOKEN IS NOT A PASSWORD AND MUST NOT BE TREATED AS ONE.
--  It lives in a URL. It is in browser history, it is forwarded
--  in WhatsApp, it appears in screenshots, it is read over the
--  phone. Today a leaked link exposes one programme's plan. If it
--  minted a full session, the same leak would expose somebody's
--  haemoglobin and what they paid — which is a quiet, permanent
--  escalation of what losing that link costs.
--
--  So a session records HOW it was opened:
--
--    full        a six-digit code was typed, sent to the address
--                on their record. Everything.
--    programme   a token in a URL. The plan, the day, the
--                calendar, the questions — the things a client
--                needs at breakfast. Not the receipts, not the
--                labs, not the documents, not the phone number.
--
--  It is one column because it must be impossible to get wrong:
--  the scope travels WITH the session, so /client/me decides from
--  the row rather than from anything a caller says. The panel
--  hides the screens too, but that is a courtesy — the server is
--  what actually withholds them.
--
--  DEFAULT 'full', so every session minted before this migration
--  keeps working exactly as it did. Only the token path mints a
--  narrow one, and that path did not exist until now.
-- ============================================================

ALTER TABLE crm.client_sessions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'full';

ALTER TABLE crm.client_sessions
  DROP CONSTRAINT IF EXISTS client_sessions_scope_check;

ALTER TABLE crm.client_sessions
  ADD CONSTRAINT client_sessions_scope_check
  CHECK (scope IN ('full', 'programme'));

COMMENT ON COLUMN crm.client_sessions.scope IS
  'How this session was opened. full = a code was typed and everything is visible. programme = a token in a URL; the plan and the day only, never receipts, labs, documents or contact details. See migration 0008.';

/* Which programme the token was for, when it was a token. Not used
   to scope anything — row-level security already does that by
   person — but a session opened by a link that has since been
   revoked should not outlive it, and this is what lets that be
   checked. */
ALTER TABLE crm.client_sessions
  ADD COLUMN IF NOT EXISTS via_programme uuid REFERENCES crm.programmes(id) ON DELETE SET NULL;
