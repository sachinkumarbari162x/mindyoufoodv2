-- ============================================================
--  Give the client role a way in
-- ------------------------------------------------------------
--  schema.sql creates `myf_client` with NOLOGIN and no
--  password, and hangs every row-level policy off it. This is the
--  half that cannot live in schema.sql, because schema.sql lives
--  in git and this sets a credential.
--
--      psql -d myf_trial -v pw="'a-long-random-string'" \
--           -f services/go-data/db/roles.sql
--
--  The quoting is deliberate and easy to get wrong: the value of
--  -v must include its own single quotes, because psql substitutes
--  it literally.
--
--  Then put the matching connection string in .env as
--  DATABASE_URL_CLIENT. If that variable is unset, Go runs both
--  its connections as the practitioner and RLS is inert — which is
--  the correct behaviour for a fresh clone, and is announced at
--  boot rather than left to be discovered.
--
--  ---- WHAT THIS ROLE CANNOT DO -------------------------------
--  It is not a superuser, it owns nothing, and it has no
--  BYPASSRLS. Each of those three would silently undo every
--  policy in schema.sql, so each is CHECKED below — and this
--  script fails if any of them is wrong.
--
--  ---- ON A MANAGED POSTGRES ----------------------------------
--  Supabase, Neon and RDS do not give you a real superuser: the
--  `postgres` you connect as can create roles but cannot set
--  SUPERUSER or BYPASSRLS on them, so the hardening ALTER below
--  is REFUSED there.
--
--  That refusal is harmless — CREATE ROLE already defaults every
--  one of those attributes to off, and a role that cannot be
--  granted BYPASSRLS by anyone is safer than one that can. So the
--  hardening is attempted and its refusal tolerated, while the
--  CHECK at the end is not optional on any platform. Belt and
--  braces, where the braces are the part that fails loudly.
-- ============================================================

\set ON_ERROR_STOP on

/* ---- the check itself, written once and run twice ------------
   BEFORE the password, because on a managed database a role that
   is somehow already a superuser cannot even be given a password
   by the `postgres` you get there — the ALTER is refused, and the
   error you are left holding is Postgres's ("must be superuser to
   alter superuser roles") rather than the one that says what is
   actually wrong and why it matters.

   AFTER it too, because the password is the thing that turns a
   description of a role into a way in.

   pg_temp is session-local: this disappears when psql exits, and
   cannot be called by anything else in the meantime. */
CREATE FUNCTION pg_temp.verify_client(check_login boolean) RETURNS void
LANGUAGE plpgsql AS $verify$
DECLARE
  r     record;
  owned integer;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = 'myf_client';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'myf_client does not exist — apply schema.sql first.';
  END IF;

  IF r.rolsuper THEN
    RAISE EXCEPTION
      'myf_client is a SUPERUSER. Every row-level policy is inert. Refusing.';
  END IF;
  IF r.rolbypassrls THEN
    RAISE EXCEPTION
      'myf_client has BYPASSRLS. Every row-level policy is inert. Refusing.';
  END IF;

  /* An owner is exempt from its own tables' policies unless the
     table says FORCE, and schema.sql deliberately does not —
     that would blind the practitioner too. So ownership here is
     not a detail, it is a hole with no symptom. */
  SELECT count(*) INTO owned
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles    o ON o.oid = c.relowner
   WHERE n.nspname IN ('crm', 'public') AND o.rolname = 'myf_client';
  IF owned > 0 THEN
    RAISE EXCEPTION
      'myf_client owns % table(s). An owner bypasses its own policies. Refusing.',
      owned;
  END IF;

  IF check_login AND NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'myf_client cannot log in — the password did not take.';
  END IF;
END
$verify$;

/* Belt FIRST, so that where it works it actually repairs. CREATE
   ROLE defaults these to off, but an inherited role or a later
   ALTER could turn them on, and the failure would be invisible:
   every policy would still be there, and none would apply.

   Tolerated when refused, because on a managed database the
   refusal comes from not being a superuser — which is the same
   reason nobody can turn these ON there either. */
DO $harden$
BEGIN
  EXECUTE 'ALTER ROLE myf_client '
          'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION';
  RAISE NOTICE 'myf_client hardened.';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE
    'Not a superuser here, so the hardening ALTER was refused. '
    'That is expected on a managed database and is not a problem: '
    'the attributes default to off and the check below proves it.';
END
$harden$;

/* Braces, before the password. Where the belt worked this passes
   trivially; where it was refused, this is the whole defence —
   and it has to come first because a superuser myf_client cannot
   be given a password by a non-superuser either, so leaving it
   until later means the run dies on Postgres's "must be superuser
   to alter superuser roles" instead of on the sentence that says
   what is wrong and why it matters. */
SELECT pg_temp.verify_client(false);

ALTER ROLE myf_client LOGIN PASSWORD :pw;

/* Braces. "I ran the script" and "the role is safe" are different
   claims, and the difference is the whole point of the exercise —
   a superuser or a BYPASSRLS role walks through all eleven
   policies as if they were comments.

   This RAISES rather than SELECTs. The old version printed a row
   and trusted somebody to read it, which is not a check: a table
   scrolling past in a deploy log is exactly the thing nobody
   reads on the day it matters. */
SELECT pg_temp.verify_client(true);

DO $said$ BEGIN
  RAISE NOTICE
    'myf_client: can log in, not a superuser, no BYPASSRLS, owns nothing. Good.';
END $said$;
