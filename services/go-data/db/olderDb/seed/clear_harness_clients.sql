-- ============================================================
--  CLEAR HARNESS CLIENTS — what the test suites leave behind
-- ------------------------------------------------------------
--  Every suite in scratchpad/ creates its own client so runs
--  cannot collide: "Cycle k256u Testclient", "Race9f2 Testclient",
--  and so on. That is correct — a test that reuses a fixture is a
--  test that passes because the last run left the right state.
--
--  But they accumulate. After an afternoon's work the People list
--  has thirty rows in it and four are real, which makes every
--  screen useless for judging how anything looks.
--
--  THE DISCRIMINATOR IS THE EMAIL DOMAIN, not the name. Name
--  patterns are a guess that eventually deletes a real Mrs Cycle;
--  the domains are a rule the harnesses actually follow:
--
--    @example.invalid   reserved by RFC 2606, cannot receive mail
--    @example.org       reserved, used once the form started
--                       refusing .invalid as undeliverable
--    @example.com       THE SEEDED PRACTICE — kept
--
--  Run it after a test session. Safe when there is nothing to
--  clear, and it touches nothing belonging to a .com address.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE harness_people ON COMMIT DROP AS
  SELECT id FROM crm.people
   WHERE email LIKE '%@example.invalid' OR email LIKE '%.invalid'
      OR email LIKE '%@example.org'     OR email LIKE '%.org';

CREATE TEMP TABLE harness_plans ON COMMIT DROP AS
  SELECT id FROM crm.plans WHERE person_id IN (SELECT id FROM harness_people);

CREATE TEMP TABLE harness_progs ON COMMIT DROP AS
  SELECT id FROM crm.programmes WHERE person_id IN (SELECT id FROM harness_people);

CREATE TEMP TABLE harness_consults ON COMMIT DROP AS
  SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM harness_people);

/* Children first. The foreign keys would refuse the other order,
   which is the schema doing its job rather than an inconvenience. */
DELETE FROM crm.checkin_media
 WHERE checkin_id IN (SELECT id FROM crm.checkins WHERE programme_id IN (SELECT id FROM harness_progs));
DELETE FROM crm.checkins        WHERE programme_id IN (SELECT id FROM harness_progs);
DELETE FROM crm.programme_notes WHERE programme_id IN (SELECT id FROM harness_progs);
DELETE FROM crm.measurements    WHERE programme_id IN (SELECT id FROM harness_progs);
DELETE FROM crm.programmes      WHERE id IN (SELECT id FROM harness_progs);

DELETE FROM crm.plan_items WHERE plan_id IN (SELECT id FROM harness_plans);
DELETE FROM crm.plan_links WHERE person_id IN (SELECT id FROM harness_people);
DELETE FROM crm.plans      WHERE id IN (SELECT id FROM harness_plans);

DELETE FROM crm.goals        WHERE person_id IN (SELECT id FROM harness_people);
DELETE FROM crm.measurements WHERE person_id IN (SELECT id FROM harness_people);
DELETE FROM crm.assessments  WHERE person_id IN (SELECT id FROM harness_people);

/* THE RECEIPTS FIRST. crm.invoices.payment_id is ON DELETE
   RESTRICT — deliberately, because a receipt is a financial
   document and must not disappear silently with the payment it
   refers to — so payments cannot be cascaded away underneath one.
   Harness receipts are numbers burnt out of a test series and are
   not owed to anybody; they go explicitly, which is the honest
   way to delete a document. */
DELETE FROM crm.invoices
 WHERE payment_id IN (
   SELECT p.id FROM crm.payments p
    WHERE p.consultation_id IN (SELECT id FROM harness_consults));

DELETE FROM crm.payments WHERE consultation_id IN (SELECT id FROM harness_consults);

DELETE FROM crm.consultation_outcomes WHERE consultation_id IN (SELECT id FROM harness_consults);
DELETE FROM crm.consultation_links    WHERE consultation_id IN (SELECT id FROM harness_consults);
DELETE FROM crm.messages              WHERE person_id IN (SELECT id FROM harness_people);
DELETE FROM crm.room_participants
 WHERE session_id IN (SELECT id FROM crm.room_sessions WHERE consultation_id IN (SELECT id FROM harness_consults));
DELETE FROM crm.room_sessions  WHERE consultation_id IN (SELECT id FROM harness_consults);
DELETE FROM crm.ratings        WHERE consultation_id IN (SELECT id FROM harness_consults);
DELETE FROM crm.consultations  WHERE id IN (SELECT id FROM harness_consults);

DELETE FROM crm.people WHERE id IN (SELECT id FROM harness_people);

COMMIT;
