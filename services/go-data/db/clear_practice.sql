-- ============================================================
--  CLEAR THE PRACTICE — leave the schema and its configuration
-- ------------------------------------------------------------
--  Companion to clear_harness_clients.sql, and a bigger broom.
--  That one removes what the test suites minted; this one
--  removes EVERY person and every trace of a visitor, so the
--  database is the system and nothing that has happened in it.
--
--  DO NOT RUN THIS WITHOUT A DUMP. The practice is nineteen
--  invented clients with months of history behind them and it
--  is what every screen in the CRM is judged against; rebuilding
--  it by hand is days. The dump is the point:
--
--    node scratchpad/make-dump.cjs     write db/dump.sql
--    psql "$DATABASE_URL" -f db/dump.sql    put it back
--
--  WHAT SURVIVES, because it is configuration rather than
--  history — the things a fresh database would seed for itself:
--
--    crm.countries              the country list
--    crm.knowledge              what the front desk knows
--    crm.phrasings, crm.prices  how it speaks, what it charges
--    crm.staff                  HER LOGIN. Clearing this locks
--                               her out of the CRM entirely.
--    crm.bot_switches           which lanes are on
--    availability_rules         her weekly hours
--    availability_exceptions    the one-offs
--    schema_migrations          what has been applied
--
--  NO CASCADE, DELIBERATELY. Every table that references
--  another is named in the list below, so if the schema grows a
--  table I have not thought about, Postgres refuses the whole
--  statement and names it. CASCADE would silently empty it
--  instead — and silence is the failure mode that matters here,
--  because nobody re-counts a table they did not know existed.
--
--  One statement, so it is one transaction: it either all goes
--  or none of it does.
-- ============================================================

\set ON_ERROR_STOP on

TRUNCATE TABLE
  -- the person, and everything that hangs off one
  crm.people,
  crm.consultations,
  crm.assessments,
  crm.programmes,
  crm.plans,
  crm.plan_items,
  crm.plan_links,
  crm.checkins,
  crm.checkin_media,
  crm.measurements,
  crm.programme_notes,
  crm.goals,
  crm.consultation_links,
  crm.consultation_outcomes,
  crm.messages,
  crm.payments,

  /* The receipt a payment earned, and the counter its number came
     from. invoices.payment_id is ON DELETE RESTRICT on purpose — a
     financial document must not vanish quietly with the row it
     refers to — so it has to be named here or Postgres refuses the
     whole statement. Which it did, exactly as this file's header
     says it should. */
  crm.invoices,
  crm.invoice_counters,

  crm.ratings,
  crm.room_sessions,
  crm.room_participants,

  -- the visitor, who never became a person
  public.bmi_snapshots,
  public.appointments,
  public.handoff_tokens,
  public.notifications,

  -- and the record of it all happening
  crm.audit,
  crm.bot_turns,
  crm.unrecognised
RESTART IDENTITY;
