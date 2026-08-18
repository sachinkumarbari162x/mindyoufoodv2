-- ============================================================
--  0010_readonly_role — the viewer cannot write, whatever the code says
-- ------------------------------------------------------------
--  Item 8. The database browser is meant to be uneditable. A
--  viewer that is uneditable because the page has no edit button
--  is uneditable until somebody opens the network tab.
--
--  So it gets its own Postgres role with SELECT and nothing else.
--  Then it is read-only even when the code is wrong, which is the
--  only kind of read-only worth the name.
--
--  The role has NO PASSWORD and NOLOGIN by default. go-data reaches
--  it with SET ROLE on a connection it already holds, so there is
--  no second credential to manage, leak or rotate — and nothing
--  new listening on the network.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    CREATE ROLE myf_viewer NOLOGIN;
  END IF;
END
$$;

-- Reach the schemas, and nothing more than reach them.
GRANT USAGE ON SCHEMA public TO myf_viewer;
GRANT USAGE ON SCHEMA crm    TO myf_viewer;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO myf_viewer;
GRANT SELECT ON ALL TABLES IN SCHEMA crm    TO myf_viewer;

-- And on whatever is created later, so a table added next month is
-- not silently invisible to the viewer — or worse, writable by it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO myf_viewer;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm    GRANT SELECT ON TABLES TO myf_viewer;

-- ------------------------------------------------------------
--  Two doors, not one.
--
--  The viewer is a different door with a different key, as asked.
--  `role` says which door an account opens: 'crm' is the workspace,
--  'viewer' is the raw tables. A session for one is not a session
--  for the other, which is the entire point of separating them.
-- ------------------------------------------------------------
ALTER TABLE crm.staff
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'crm';

ALTER TABLE crm.staff
  DROP CONSTRAINT IF EXISTS staff_role_known;

ALTER TABLE crm.staff
  ADD CONSTRAINT staff_role_known CHECK (role IN ('crm', 'viewer'));

-- One account per door. The unique index on the email alone would
-- have stopped her using the same address for both, which is what
-- anybody would try first.
DROP INDEX IF EXISTS crm.staff_email_once;
CREATE UNIQUE INDEX IF NOT EXISTS staff_email_role_once
  ON crm.staff (lower(email), role);
