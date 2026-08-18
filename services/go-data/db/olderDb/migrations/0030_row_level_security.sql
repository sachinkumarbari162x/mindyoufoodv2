-- ============================================================
--  0030_row_level_security — a second boundary, in the database
-- ------------------------------------------------------------
--  Until now exactly one thing has kept Sofia's rows apart from
--  Ravi's: Go writing `WHERE person_id = $1` correctly, in every
--  query, every time. That has held. It is also one boundary,
--  enforced by care, and it is about to be asked to hold under
--  client accounts — the first time untrusted principals read from
--  this database at all.
--
--  This adds a second boundary that does not depend on the query
--  being right. A client-scoped connection carries the person it
--  is acting for; the database filters every row against it. A
--  query with a missing or wrong WHERE clause returns nothing
--  rather than somebody else's record.
--
--  ---- IT FAILS CLOSED, AND THAT IS THE WHOLE DESIGN ----------
--  crm.current_person() reads a session setting. Unset, it is
--  NULL; `person_id = NULL` is NULL, which is not true, so the row
--  is filtered. Forgetting to set the identity therefore yields an
--  EMPTY result, never a full one. The opposite arrangement — NULL
--  meaning "see everything" — is the same feature with the failure
--  mode reversed, and it is how this is usually got wrong.
--
--  ---- WHY ENABLE AND NOT FORCE -------------------------------
--  ENABLE applies RLS to every role except the table's owner and
--  anything with BYPASSRLS. FORCE applies it to the owner too.
--
--  FORCE is deliberately NOT used. Khadija's own connection has to
--  see every client, and it reaches these tables as the owner. The
--  day that connection moves off a superuser — which is the plan —
--  FORCE would blind the entire CRM, and it would do it quietly.
--  The isolation here comes from the client connecting as a role
--  that does NOT own these tables, which is a fact about the role
--  rather than a flag on the table.
--
--  ---- ONE POLICY PER TABLE -----------------------------------
--  Each policy below is PERMISSIVE, which means any policy added
--  later is OR'd with it and can only WIDEN access. If a future
--  rule needs to narrow it, that rule must be declared `AS
--  RESTRICTIVE` or it will do the opposite of what it says.
--
--  The role has no password here and cannot log in. That is
--  granted separately by db/roles.sql, so no credential is ever
--  committed.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

-- ---- the role a client's request travels on ------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_client') THEN
    CREATE ROLE myf_client NOLOGIN;
  END IF;
END
$role$;

COMMENT ON ROLE myf_client IS
  'The connection a client''s own request runs on. Not an owner, not a superuser, no BYPASSRLS — which is what makes every policy in this migration mean something. Given LOGIN and a password by db/roles.sql.';

-- ---- who is asking -------------------------------------------
-- STABLE, so the planner may hoist it out of the row loop rather
-- than calling it per row. NULL when unset, which is what makes
-- every policy below fail closed.
CREATE OR REPLACE FUNCTION crm.current_person() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.person_id', true), '')::uuid
$fn$;

COMMENT ON FUNCTION crm.current_person() IS
  'The person the current transaction is acting for, from SET LOCAL app.person_id. NULL outside a client-scoped transaction, which filters every RLS policy to zero rows.';

GRANT USAGE ON SCHEMA crm TO myf_client;
GRANT EXECUTE ON FUNCTION crm.current_person() TO myf_client;

-- ============================================================
--  GRANTS — coarse, and narrower than the policies
-- ------------------------------------------------------------
--  RLS decides WHICH rows. These decide WHICH VERBS, and they are
--  a cheaper boundary that costs nothing to keep tight.
--
--  There is no DELETE on this list, anywhere. A client's
--  connection cannot remove a row from this database. Corrections
--  in this system are append-only by design — a later check-in
--  wins, a note is never unsaid — so the ability to delete would
--  be new capability with no feature behind it.
-- ============================================================

GRANT SELECT ON
  crm.people, crm.programmes, crm.plans, crm.plan_items,
  crm.checkins, crm.checkin_media, crm.programme_notes,
  crm.measurements, crm.consultations,
  crm.consultation_links, crm.plan_links
TO myf_client;

GRANT INSERT ON
  crm.checkins, crm.checkin_media, crm.programme_notes,
  crm.measurements, crm.consultations
TO myf_client;

-- The only updates a client's own request makes: marking a link
-- opened, and their notes seen. Column-scoped, so nothing else on
-- these rows can move.
GRANT UPDATE (opened_at, open_count) ON crm.programmes        TO myf_client;
GRANT UPDATE (opened_at, open_count) ON crm.consultation_links TO myf_client;
GRANT UPDATE (opened_at, open_count) ON crm.plan_links         TO myf_client;
GRANT UPDATE (seen_at)               ON crm.programme_notes    TO myf_client;

-- ============================================================
--  POLICIES
-- ============================================================

-- ---- the person themselves -----------------------------------
ALTER TABLE crm.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.people
  FOR ALL TO myf_client
  USING (id = crm.current_person());

-- ---- their programmes ----------------------------------------
ALTER TABLE crm.programmes ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.programmes
  FOR ALL TO myf_client
  USING (person_id = crm.current_person())
  WITH CHECK (person_id = crm.current_person());

-- ---- their plans ---------------------------------------------
ALTER TABLE crm.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.plans
  FOR ALL TO myf_client
  USING (person_id = crm.current_person());

-- plan_items reach the person through their plan.
ALTER TABLE crm.plan_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.plan_items
  FOR ALL TO myf_client
  USING (EXISTS (
    SELECT 1 FROM crm.plans p
     WHERE p.id = plan_items.plan_id
       AND p.person_id = crm.current_person()));

-- ---- the day-by-day record -----------------------------------
-- Through the programme, which is the only route a client has to
-- one. The subquery is a primary-key lookup, so this costs an
-- index probe per row rather than a scan.
ALTER TABLE crm.checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.checkins
  FOR ALL TO myf_client
  USING (EXISTS (
    SELECT 1 FROM crm.programmes g
     WHERE g.id = checkins.programme_id
       AND g.person_id = crm.current_person()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crm.programmes g
     WHERE g.id = checkins.programme_id
       AND g.person_id = crm.current_person()));

ALTER TABLE crm.checkin_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.checkin_media
  FOR ALL TO myf_client
  USING (EXISTS (
    SELECT 1 FROM crm.checkins c
      JOIN crm.programmes g ON g.id = c.programme_id
     WHERE c.id = checkin_media.checkin_id
       AND g.person_id = crm.current_person()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crm.checkins c
      JOIN crm.programmes g ON g.id = c.programme_id
     WHERE c.id = checkin_media.checkin_id
       AND g.person_id = crm.current_person()));

-- ---- the conversation ----------------------------------------
ALTER TABLE crm.programme_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.programme_notes
  FOR ALL TO myf_client
  USING (EXISTS (
    SELECT 1 FROM crm.programmes g
     WHERE g.id = programme_notes.programme_id
       AND g.person_id = crm.current_person()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crm.programmes g
     WHERE g.id = programme_notes.programme_id
       AND g.person_id = crm.current_person()));

-- ---- what they weighed ---------------------------------------
-- The SELECT side is narrowed further in Go to source='self', so a
-- client never reads a measurement Khadija took. This policy is
-- the boundary that survives that WHERE clause being dropped.
ALTER TABLE crm.measurements ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.measurements
  FOR ALL TO myf_client
  USING (person_id = crm.current_person())
  WITH CHECK (person_id = crm.current_person());

-- ---- their appointments --------------------------------------
ALTER TABLE crm.consultations ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.consultations
  FOR ALL TO myf_client
  USING (person_id = crm.current_person())
  WITH CHECK (person_id = crm.current_person());

-- ---- the links they arrived on -------------------------------
ALTER TABLE crm.consultation_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.consultation_links
  FOR ALL TO myf_client
  USING (EXISTS (
    SELECT 1 FROM crm.consultations c
     WHERE c.id = consultation_links.consultation_id
       AND c.person_id = crm.current_person()));

ALTER TABLE crm.plan_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_own ON crm.plan_links
  FOR ALL TO myf_client
  USING (person_id = crm.current_person());
