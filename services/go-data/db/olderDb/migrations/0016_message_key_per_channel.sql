-- ============================================================
--  0016_message_key_per_channel — one of each kind PER CHANNEL
-- ------------------------------------------------------------
--  0014 made (consultation_id, template_id) unique so a
--  double-clicked Accept could not send two confirmations. That
--  was right about the problem and wrong about the key.
--
--  The email confirmation and the WhatsApp confirmation are the
--  SAME template — "booking-confirmed" — sent down two different
--  channels. Under the old index they were the same row, so
--  whichever queued first claimed it and the second was told
--  "already sent" and silently never went.
--
--  It was not theoretical. A booking accepted while this was
--  live got its email and no WhatsApp message: the link had been
--  minted 0.4 seconds after the email row was written, and then
--  the queue refused it. The only trace was a link nobody was
--  ever sent.
--
--  The rule she actually wants is one confirmation per booking
--  PER CHANNEL: never two emails, never two WhatsApps, but an
--  email and a WhatsApp are two different promises to the same
--  person and both should keep.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

DROP INDEX IF EXISTS crm.messages_one_per_booking;

CREATE UNIQUE INDEX IF NOT EXISTS messages_one_per_booking_channel
  ON crm.messages (consultation_id, template_id, channel)
  WHERE consultation_id IS NOT NULL;
