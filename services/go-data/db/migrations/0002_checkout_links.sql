-- ============================================================
--  A link that means "you are at the checkout"
-- ------------------------------------------------------------
--  crm.consultation_links already holds exactly the right shape:
--  an opaque token, the consultation it belongs to, an expiry,
--  and a count of how often it was opened. The only thing
--  stopping it carrying a checkout was the CHECK, which allowed
--  the single value 'consultation'.
--
--  WHY A TOKEN AND NOT THE CONSULTATION ID. The checkout page is
--  reached by somebody who has proved nothing — they have typed a
--  name and an email into a form. A page keyed by the row's own id
--  is a page where changing one digit shows you a stranger's
--  booking, their name and the hour they chose. The token is
--  random, single-purpose and expires with the hold.
--
--  ONE CHECKOUT PER CONSULTATION is already enforced by
--  consultation_links_one_per_purpose, so a visitor who reloads
--  the form does not accumulate live checkout links to the same
--  hour.
--
--  This is a migration rather than an edit to schema.sql because
--  the constraint exists on databases that are already running,
--  and CREATE TABLE IF NOT EXISTS would silently skip it there.
-- ============================================================

ALTER TABLE crm.consultation_links
  DROP CONSTRAINT IF EXISTS consultation_links_purpose_check;

ALTER TABLE crm.consultation_links
  ADD CONSTRAINT consultation_links_purpose_check
  CHECK (purpose IN ('consultation', 'checkout'));
