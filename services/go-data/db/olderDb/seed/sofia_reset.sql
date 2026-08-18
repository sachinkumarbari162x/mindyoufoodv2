-- ============================================================
--  SOFIA — back to the day before her first consultation
-- ------------------------------------------------------------
--  Clears everything hanging off one person and leaves the person
--  herself in place. Written because an afternoon of testing left
--  eleven plans in her record, seven of them stubs a suite made
--  before it was taught not to.
--
--  ONE PERSON, BY ID, AND NOTHING ELSE. No pattern matching on
--  names or emails: this is a delete of clinical-shaped rows and
--  the only safe discriminator is the primary key. If the id below
--  is wrong the script deletes nothing rather than the wrong
--  person's record.
--
--  IN ONE TRANSACTION. A half-cleared client — plans gone,
--  programme still pointing at them — is worse than either state,
--  and several of these tables reference each other.
--
--  WHAT SURVIVES: crm.people. She is still a client, still has her
--  email and phone, still appears in the People list. Everything
--  that happened TO her is what goes.
--
--      psql -d myf_trial -f services/go-data/db/seed/sofia_reset.sql
--
--  Then re-seed with sofia_journey.sql.
-- ============================================================

\set ON_ERROR_STOP on
\set sofia '''ca466ca3-fa88-4508-ba1c-863b048d9a9c'''

BEGIN;

-- Everything under her programmes: the day-by-day record, what she
-- wrote, what Khadija wrote back, and the photographs.
DELETE FROM crm.checkin_media WHERE checkin_id IN (
  SELECT c.id FROM crm.checkins c
    JOIN crm.programmes g ON g.id = c.programme_id
   WHERE g.person_id = :sofia);

DELETE FROM crm.checkins WHERE programme_id IN (
  SELECT id FROM crm.programmes WHERE person_id = :sofia);

DELETE FROM crm.programme_notes WHERE programme_id IN (
  SELECT id FROM crm.programmes WHERE person_id = :sofia);

DELETE FROM crm.programmes WHERE person_id = :sofia;

-- The plan and its rows. plan_items has no ON DELETE CASCADE to the
-- plan, deliberately — rows are the clinical content and a stray
-- cascade would take them silently.
DELETE FROM crm.plan_items WHERE plan_id IN (
  SELECT id FROM crm.plans WHERE person_id = :sofia);

-- The opaque links, before the things they point at. TWO tables and
-- not one: a consultation link and a plan link are different
-- credentials with different lifetimes, and only one of them lets
-- somebody write.
DELETE FROM crm.consultation_links WHERE consultation_id IN (
  SELECT id FROM crm.consultations WHERE person_id = :sofia);

-- plan_links is keyed by PERSON and plan number, not by plan id:
-- amending a plan must not change the address the client was
-- already given, so the link outlives the version.
DELETE FROM crm.plan_links WHERE person_id = :sofia;

-- The consulting room, if one was ever opened for her.
DELETE FROM crm.room_participants WHERE session_id IN (
  SELECT rs.id FROM crm.room_sessions rs
    JOIN crm.consultations c ON c.id = rs.consultation_id
   WHERE c.person_id = :sofia);

DELETE FROM crm.room_sessions WHERE consultation_id IN (
  SELECT id FROM crm.consultations WHERE person_id = :sofia);

DELETE FROM crm.ratings WHERE consultation_id IN (
  SELECT id FROM crm.consultations WHERE person_id = :sofia);

-- amends is a self-reference with ON DELETE RESTRICT, so the chain
-- has to come apart before the rows can go.
UPDATE crm.plans SET amends = NULL WHERE person_id = :sofia;
DELETE FROM crm.plans WHERE person_id = :sofia;

UPDATE crm.assessments SET amends = NULL WHERE person_id = :sofia;
DELETE FROM crm.measurements WHERE person_id = :sofia;
DELETE FROM crm.goals WHERE person_id = :sofia;
DELETE FROM crm.assessments WHERE person_id = :sofia;

-- Outcomes reference the consultation they describe.
DELETE FROM crm.consultation_outcomes WHERE consultation_id IN (
  SELECT id FROM crm.consultations WHERE person_id = :sofia);

-- By person as well as by consultation: not every message hangs off
-- one, and a plan link email does not.
DELETE FROM crm.messages
 WHERE person_id = :sofia
    OR consultation_id IN (SELECT id FROM crm.consultations WHERE person_id = :sofia);

DELETE FROM crm.consultations WHERE person_id = :sofia;

-- What is left, said out loud rather than assumed.
SELECT 'people'        AS table, count(*) FROM crm.people        WHERE id        = :sofia
UNION ALL SELECT 'consultations', count(*) FROM crm.consultations WHERE person_id = :sofia
UNION ALL SELECT 'assessments',   count(*) FROM crm.assessments   WHERE person_id = :sofia
UNION ALL SELECT 'measurements',  count(*) FROM crm.measurements  WHERE person_id = :sofia
UNION ALL SELECT 'plans',         count(*) FROM crm.plans         WHERE person_id = :sofia
UNION ALL SELECT 'programmes',    count(*) FROM crm.programmes    WHERE person_id = :sofia;

COMMIT;
