-- ============================================================
--  0006 — A ROW SHE THREW AWAY LEAVES THE TABLE
-- ------------------------------------------------------------
--  "Clear rows does not work at all", and it did not, for a
--  reason that made sense to the database and to nobody else.
--
--  Clear removed rows with status = 'proposed' — the ones the
--  assistant had suggested and she had not ruled on. A row she
--  had looked at and REJECTED was, by that definition, ruled on,
--  so it stayed. And the button that runs Clear was disabled
--  whenever there were no proposed rows left. So the ordinary
--  sequence — read a bad plan, go down the list marking the
--  wrong ones wrong, then press Clear to start again — ended
--  with a table full of rejected rows and a greyed-out button.
--  Every single row was junk and there was no way to remove any
--  of it.
--
--  WHY THE ROWS COULD NOT SIMPLY BE DELETED. crm.plan_items is
--  also where the assistant's accuracy figure is counted from:
--  confirmed against edited against rejected, grouped by model.
--  Deleting a rejection erases the evidence that the model got
--  something wrong, which is the one direction that measurement
--  must not be able to drift.
--
--  So the row leaves HER TABLE and stays in THE RECORD. One
--  column, and the two readers disagree about it on purpose:
--  every screen filters `cleared_at IS NULL`, and the accuracy
--  query does not.
--
--  This is the same shape as the revoke on client_sessions and
--  the undo on outcomes: the thing stops being true without
--  stopping having happened.
-- ============================================================

ALTER TABLE crm.plan_items
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

COMMENT ON COLUMN crm.plan_items.cleared_at IS
  'Set when she cleared the reading. The row is gone from every screen and still counted in the assistant''s accuracy figure — a rejection she swept away is still a rejection that happened.';

/* Her table is read constantly and always with this filter, so
   the index carries it. */
CREATE INDEX IF NOT EXISTS plan_items_live_idx
  ON crm.plan_items (plan_id, seq) WHERE cleared_at IS NULL;
