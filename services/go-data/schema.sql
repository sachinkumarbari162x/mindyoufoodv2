-- ============================================================
--  MIND YOUR FOOD — the database
-- ------------------------------------------------------------
--  The whole structure, in one file, in the order a person would
--  want to read it: the visitor who has not met her yet, then the
--  practice, then the person and everything that accumulates
--  around one. It replaces thirty migrations that recorded how a
--  laptop got from empty to here — accurate history, and the
--  wrong thing to hand a new database. Those files are kept, in
--  db/olderDb/.
--
--  ---- TWO RULES THIS FILE KEEPS ------------------------------
--
--  NO ROWS. Not one INSERT. This describes the system, not any
--  installation of it, so it reads as a description rather than a
--  snapshot of one laptop. The country list, the knowledge base
--  and her hours live in db/config.sql; the invented practice
--  lives in db/dump.sql.
--
--  IDEMPOTENT. It runs on every boot, so every statement is
--  written to be harmless the second time. That is what lets a
--  fresh clone need nothing but a DATABASE_URL, and it is why
--  foreign keys are declared inline with the table rather than
--  bolted on afterwards with ALTER TABLE, which is not repeatable.
--
--  ---- CHANGING IT --------------------------------------------
--  Add a file to db/migrations/ rather than editing a shipped
--  table here, once anything real depends on the old shape. The
--  runner checksums what it applies and refuses to start if an
--  applied file has changed since. See db/README.md.
-- ============================================================

-- ---- what the schema itself needs ---------------------------
--  btree_gist  lets an EXCLUDE constraint mix equality on a
--              weekday with overlap on a time range, which is how
--              two of her working hours are stopped from covering
--              the same minute.
--  pgcrypto    gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS crm;


-- ============================================================
--  HELPERS
-- ============================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

/* WHO THE CURRENT TRANSACTION IS ACTING FOR. Set by Go with
   set_config('app.person_id', …, true) — transaction-scoped, so it
   cannot leak to the next request that borrows the same pooled
   connection.

   Returns NULL when unset, and NULL is the point: every policy
   below compares against this, and a comparison with NULL is not
   true, so an unscoped connection sees nothing rather than
   everything. Fail closed, by construction rather than by
   remembering to. */
CREATE OR REPLACE FUNCTION crm.current_person() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.person_id', true), '')::uuid
$$;

COMMENT ON FUNCTION crm.current_person() IS
  'The person the current transaction is acting for, from SET LOCAL app.person_id. NULL outside a client-scoped transaction, which filters every RLS policy to zero rows.';


-- ============================================================
--  THE VISITOR
--  Somebody on the marketing site who has not become a client.
--  Everything here is anonymous or nearly so, and most of it is
--  swept away on a timer.
-- ============================================================

/* A BMI worked out on the site. Kept only long enough to carry
   into a booking form, then purged — see purge_expired_handoffs
   below. The CHECKs are the ones the form already enforces, said
   again where they cannot be skipped by a crafted request. */
CREATE TABLE IF NOT EXISTS public.bmi_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  height_cm      numeric(5,1) NOT NULL CHECK (height_cm BETWEEN 60 AND 260),
  weight_kg      numeric(5,1) NOT NULL CHECK (weight_kg BETWEEN 20 AND 400),
  bmi            numeric(4,1) NOT NULL CHECK (bmi BETWEEN 5 AND 100),
  category       text NOT NULL,
  category_basis text NOT NULL DEFAULT 'who',
  age_years      smallint CHECK (age_years BETWEEN 16 AND 120),
  sex            text CHECK (sex IN ('female','male','unspecified')),
  goal           text,
  units          text NOT NULL DEFAULT 'metric' CHECK (units IN ('metric','imperial')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  ip_hash        text,
  user_agent     text
);

/* The one-time ticket that carries a snapshot from the calculator
   to the booking form without putting body measurements in a URL. */
CREATE TABLE IF NOT EXISTS public.handoff_tokens (
  token       text PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES public.bmi_snapshots(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS handoff_tokens_expires_idx
  ON public.handoff_tokens (expires_at) WHERE claimed_at IS NULL;

/* A request for a time, from the trial booking form. Distinct
   from crm.consultations, which is the same event once it belongs
   to a person she has on her books. */
CREATE TABLE IF NOT EXISTS public.appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,
  name               text NOT NULL,
  email              text NOT NULL,
  phone              text,
  focus_area         text NOT NULL,
  dob                date,
  country            text,
  mode               text NOT NULL DEFAULT 'undecided'
                       CHECK (mode IN ('video','audio','in_person','undecided')),
  notes              text,
  suggested_slots    jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot_id        uuid REFERENCES public.bmi_snapshots(id) ON DELETE SET NULL,
  source             text NOT NULL DEFAULT 'trial',
  status             text NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested','held','contacted','confirmed',
                                         'completed','cancelled','declined','no_show')),
  policy_version     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  scheduled_start_at timestamptz,
  scheduled_end_at   timestamptz,
  hold_expires_at    timestamptz,
  confirmed_at       timestamptz,
  timezone           text,
  CONSTRAINT appointments_slot_order_check CHECK (
    scheduled_end_at IS NULL OR scheduled_start_at IS NULL
    OR scheduled_end_at > scheduled_start_at)
);

/* THE ONLY THING THAT ACTUALLY PREVENTS A DOUBLE BOOKING.
   Two visitors shown the same free slot seconds apart will both
   try to take it, and everything else — the availability rules,
   the list of times the page was showing — is a snapshot that was
   true a moment ago. This is evaluated at the instant of writing.
   Partial, so a cancelled booking does not keep its hour forever. */
CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot_unique
  ON public.appointments (scheduled_start_at)
  WHERE status IN ('held','confirmed');

CREATE INDEX IF NOT EXISTS appointments_created_idx  ON public.appointments (created_at DESC);
CREATE INDEX IF NOT EXISTS appointments_email_idx    ON public.appointments (lower(email));
CREATE INDEX IF NOT EXISTS appointments_pending_idx  ON public.appointments (hold_expires_at)
  WHERE status = 'held';
CREATE INDEX IF NOT EXISTS appointments_upcoming_idx ON public.appointments (scheduled_start_at)
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS appointments_status_idx   ON public.appointments (status)
  WHERE status IN ('requested','contacted');

DROP TRIGGER IF EXISTS appointments_touch ON public.appointments;
CREATE TRIGGER appointments_touch
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

/* Every message the system sent, with the template version and
   the rendered body — so it can be shown not just THAT something
   was sent but what it said. notifications_once makes a
   double-clicked Accept fail in the database rather than in
   whichever branch of the code forgot to check. */
CREATE TABLE IF NOT EXISTS public.notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id      uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  channel             text NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  kind                text NOT NULL
                        CHECK (kind IN ('held','confirmed','declined','prep','practitioner_new')),
  recipient           text NOT NULL,
  template_id         text NOT NULL,
  template_version    text NOT NULL,
  body                text NOT NULL,
  provider_message_id text,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','failed')),
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  failed_at           timestamptz,
  error               text
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_once
  ON public.notifications (appointment_id, kind);
CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON public.notifications (queued_at) WHERE status <> 'sent';

/* Expired tickets carry body measurements, so they are swept
   rather than left. A snapshot that made it as far as a booking
   is kept — that one is part of a record now. */
CREATE OR REPLACE FUNCTION public.purge_expired_handoffs(older_than interval DEFAULT '1 hour')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  removed integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.handoff_tokens
     WHERE expires_at < now() - older_than
    RETURNING snapshot_id
  )
  DELETE FROM public.bmi_snapshots s
   USING gone
   WHERE s.id = gone.snapshot_id
     -- Keep any snapshot that made it as far as a booking.
     AND NOT EXISTS (SELECT 1 FROM public.appointments a WHERE a.snapshot_id = s.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;


-- ============================================================
--  WHEN SHE WORKS
--  The weekly pattern, and the exceptions to it. Read by both
--  the Node service and Go, which is why it is in the database
--  and not in either one's configuration.
-- ============================================================

/* Times are minutes from midnight, local. Not timestamps: this is
   a weekly pattern, and a pattern that shifts when the clocks do
   is a pattern that has been written down wrong. */
CREATE TABLE IF NOT EXISTS public.availability_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday        smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_min     smallint NOT NULL CHECK (starts_min BETWEEN 0 AND 1439),
  ends_min       smallint NOT NULL CHECK (ends_min BETWEEN 1 AND 1440),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_rules_span_check CHECK (ends_min > starts_min),
  CONSTRAINT availability_rules_dates_check CHECK (
    effective_to IS NULL OR effective_to >= effective_from),

  /* TWO RULES MAY NOT COVER THE SAME MINUTE of the same weekday
     while both are in force. Written as an EXCLUDE rather than
     checked in the application because it is a statement about
     rows that do not know about each other, and the only place
     that can be settled is where they are all visible at once. */
  CONSTRAINT availability_rules_no_overlap EXCLUDE USING gist (
    weekday WITH =,
    int4range(starts_min::integer, ends_min::integer) WITH &&,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS availability_rules_lookup_idx
  ON public.availability_rules (weekday, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS availability_rules_once
  ON public.availability_rules (weekday, starts_min, ends_min, effective_from,
                                COALESCE(effective_to, 'infinity'::date));

/* A single day that breaks the pattern: closed for the whole day,
   or open at a time she does not normally work. */
CREATE TABLE IF NOT EXISTS public.availability_exceptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  on_date    date NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('closed','open')),
  starts_min smallint CHECK (starts_min BETWEEN 0 AND 1439),
  ends_min   smallint CHECK (ends_min BETWEEN 1 AND 1440),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_times_check CHECK (
    (kind = 'closed' AND starts_min IS NULL AND ends_min IS NULL)
    OR (kind = 'open' AND starts_min IS NOT NULL AND ends_min IS NOT NULL
        AND ends_min > starts_min))
);

CREATE INDEX IF NOT EXISTS availability_exceptions_date_idx
  ON public.availability_exceptions (on_date);
CREATE UNIQUE INDEX IF NOT EXISTS availability_exceptions_closed_once
  ON public.availability_exceptions (on_date) WHERE kind = 'closed';

/* What the migration runner has applied, and the checksum it had
   at the time. Created here as well as by the runner so that a
   database built from this file alone is already complete. */
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
--  THE PRACTICE
--  Her, the desk, and what the desk knows. None of it belongs to
--  a client, and none of it is visible to one.
-- ============================================================

/* Her login, and the viewer account. No row is seeded: a password
   in a file is a password in a repository, and one shared between
   a laptop and a live site is worse. The CRM's setup screen makes
   the first account and refuses once one exists. */
CREATE TABLE IF NOT EXISTS crm.staff (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  password_hash     text NOT NULL,
  totp_secret       text,
  totp_confirmed_at timestamptz,
  failed_attempts   smallint NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  role              text NOT NULL DEFAULT 'crm',
  CONSTRAINT staff_email_shape CHECK (position('@' in email) > 1),
  CONSTRAINT staff_role_known  CHECK (role IN ('crm','viewer'))
);

/* One account per door, not per person: she signs in to the CRM
   and to the read-only view with the same address. */
CREATE UNIQUE INDEX IF NOT EXISTS staff_email_role_once
  ON crm.staff (lower(email), role);

/* What was changed, by whom, from what to what. Append-only in
   practice: nothing in the application deletes from it. */
CREATE TABLE IF NOT EXISTS crm.audit (
  id      bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL DEFAULT 'unknown',
  action  text NOT NULL,
  target  text,
  before  jsonb,
  after   jsonb,
  ip_hash text
);

CREATE INDEX IF NOT EXISTS audit_recent_idx ON crm.audit (at DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx ON crm.audit (action, at DESC);

/* The country list the phone field offers. Reference data, loaded
   from db/config.sql. `phone_digits` is the set of lengths a
   national number may have, which is why it is an array. */
CREATE TABLE IF NOT EXISTS crm.countries (
  iso2         char(2) PRIMARY KEY,
  name         text NOT NULL,
  dial_code    text NOT NULL,
  phone_digits smallint[] NOT NULL DEFAULT '{}',
  priority     smallint,
  active       boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS countries_order_idx ON crm.countries (priority, name);

/* What the front desk answers, in her words. One active answer
   per intent — enforced, because two would make which one a
   visitor sees a matter of row order. */
CREATE TABLE IF NOT EXISTS crm.knowledge (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent     text NOT NULL,
  label      text NOT NULL,
  answer     text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  /* The desk answers strangers about booking; the client app
     answers clients about their plan. Same shape, one editor,
     and they must never answer each other's questions. */
  audience   text NOT NULL DEFAULT 'desk'
               CHECK (audience IN ('desk','client')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_intent_active
  ON crm.knowledge (audience, intent) WHERE active;

/* Ways people have actually asked for something, mapped to the
   intent that answers it. Grows from what visitors type. */
CREATE TABLE IF NOT EXISTS crm.phrasings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent     text NOT NULL,
  phrase     text NOT NULL,
  source     text NOT NULL DEFAULT 'crm',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phrasings_intent_idx ON crm.phrasings (intent);
CREATE UNIQUE INDEX IF NOT EXISTS phrasings_unique ON crm.phrasings (lower(phrase));

/* What a consultation costs. Minor units and an explicit
   currency, so nothing anywhere has to guess at a decimal point. */
CREATE TABLE IF NOT EXISTS crm.prices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text NOT NULL DEFAULT 'Consultation',
  currency     char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS prices_currency_active
  ON crm.prices (currency) WHERE active;

/* Which bots are answering at all. A switch she can throw. */
CREATE TABLE IF NOT EXISTS crm.bot_switches (
  bot        text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  note       text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

/* Every exchange with a bot, for reading back later. `lane` says
   whether the answer came from rules or from a model, which is
   the distinction that matters when judging one. */
CREATE TABLE IF NOT EXISTS crm.bot_turns (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  bot         text NOT NULL,
  lane        text NOT NULL CHECK (lane IN ('deterministic','agentic')),
  session_ref text,
  input       text,
  output      text,
  intent      text,
  confidence  real,
  reason      text,
  model       text,
  latency_ms  integer,
  redacted_at timestamptz
);

CREATE INDEX IF NOT EXISTS bot_turns_recent_idx ON crm.bot_turns (at DESC);
CREATE INDEX IF NOT EXISTS bot_turns_lane_idx   ON crm.bot_turns (bot, lane, at DESC);
CREATE INDEX IF NOT EXISTS bot_turns_unredacted_idx
  ON crm.bot_turns (at) WHERE redacted_at IS NULL;

/* Questions the desk could not answer. The queue she works
   through to decide what to teach it next. */
CREATE TABLE IF NOT EXISTS crm.unrecognised (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text     text NOT NULL,
  seen     integer NOT NULL DEFAULT 1,
  resolved boolean NOT NULL DEFAULT false,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS unrecognised_text ON crm.unrecognised (text);
CREATE INDEX IF NOT EXISTS unrecognised_queue_idx
  ON crm.unrecognised (seen DESC, last_at DESC) WHERE NOT resolved;


-- ============================================================
--  THE PERSON
--  From here down, every table belongs to somebody. That is what
--  makes the row-level policies at the end of this file possible:
--  each one is the same sentence — this row is yours — written
--  in whatever way the table reaches its person.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  email        text NOT NULL,
  phone        text,
  dob          date,
  country_iso2 char(2) REFERENCES crm.countries(iso2),
  source       text NOT NULL DEFAULT 'chatbot',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

/* Case-folded, because Sofia@ and sofia@ are one woman. */
CREATE UNIQUE INDEX IF NOT EXISTS people_email_key ON crm.people (lower(email));

/* An hour of her time. `source` says how it came about: a
   stranger through the chatbot, a client asking to be seen again,
   or her putting it in herself. */
CREATE TABLE IF NOT EXISTS crm.consultations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          uuid NOT NULL REFERENCES crm.people(id) ON DELETE CASCADE,
  issue              text NOT NULL,
  mode               text NOT NULL DEFAULT 'undecided'
                       CHECK (mode IN ('video','audio','in_person','undecided')),
  status             text NOT NULL DEFAULT 'held'
                       CHECK (status IN ('held','confirmed','declined','completed',
                                         'cancelled','no_show')),
  scheduled_start_at timestamptz,
  scheduled_end_at   timestamptz,
  hold_expires_at    timestamptz,
  confirmed_at       timestamptz,
  timezone           text,
  notes              text,
  source             text NOT NULL DEFAULT 'chatbot'
                       CHECK (source IN ('chatbot','review','manual')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN crm.consultations.source IS
  'chatbot = a stranger booked a slot. review = an existing client asked to be seen again. manual = she entered it herself.';

/* The same guard the trial booking form has, for the same reason. */
CREATE UNIQUE INDEX IF NOT EXISTS consultations_slot_unique
  ON crm.consultations (scheduled_start_at)
  WHERE status IN ('held','confirmed');

CREATE INDEX IF NOT EXISTS consultations_person_idx
  ON crm.consultations (person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consultations_queue_idx
  ON crm.consultations (status, scheduled_start_at);

/* THE REQUESTS PAGE IS THIS INDEX. Someone who has asked to be
   seen and has not been given a time yet. */
CREATE INDEX IF NOT EXISTS consultations_awaiting_time
  ON crm.consultations (created_at DESC)
  WHERE status = 'held' AND scheduled_start_at IS NULL;

/* The link the client follows to their consultation. */
CREATE TABLE IF NOT EXISTS crm.consultation_links (
  token           text PRIMARY KEY,
  consultation_id uuid NOT NULL REFERENCES crm.consultations(id) ON DELETE CASCADE,
  /* 'checkout' is a visitor at the payment page; 'consultation' is
     the link she sends afterwards. Both are opaque and expiring —
     a page keyed by the row id would let one changed digit show a
     stranger's name and hour. */
  purpose         text NOT NULL DEFAULT 'consultation'
                    CONSTRAINT consultation_links_purpose_check
                    CHECK (purpose IN ('consultation','checkout')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  opened_at       timestamptz,
  open_count      integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS consultation_links_one_per_purpose
  ON crm.consultation_links (consultation_id, purpose);
CREATE INDEX IF NOT EXISTS consultation_links_expiry
  ON crm.consultation_links (expires_at);

/* What happened to the appointment. Separate from the status on
   the consultation because it is a record of an event rather than
   the current state of one, and because she may reschedule twice. */
CREATE TABLE IF NOT EXISTS crm.consultation_outcomes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL REFERENCES crm.consultations(id) ON DELETE CASCADE,
  outcome          text NOT NULL
                     CHECK (outcome IN ('done','rescheduled','cancelled','no_show')),
  was_scheduled_at timestamptz,
  moved_to         timestamptz,
  note             text,
  recorded_by      text NOT NULL DEFAULT 'unknown',
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_reschedule_has_a_target CHECK (
    outcome <> 'rescheduled' OR moved_to IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS outcomes_by_consultation_idx
  ON crm.consultation_outcomes (consultation_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS outcomes_kind_idx
  ON crm.consultation_outcomes (outcome, recorded_at DESC);
CREATE INDEX IF NOT EXISTS outcomes_recent_idx
  ON crm.consultation_outcomes (recorded_at DESC);

CREATE TABLE IF NOT EXISTS crm.ratings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES crm.consultations(id) ON DELETE CASCADE,
  stars           smallint CHECK (stars BETWEEN 1 AND 5),
  comment         text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ratings_one_per_consultation
  ON crm.ratings (consultation_id);

/* Money, in minor units, with the settled amount kept beside the
   charged one — they differ whenever a card is in another
   currency, and losing that difference makes the books wrong. */
CREATE TABLE IF NOT EXISTS crm.payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id      uuid NOT NULL REFERENCES crm.consultations(id) ON DELETE CASCADE,
  currency             char(3) NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  settled_currency     char(3),
  settled_amount_minor bigint,
  fee_minor            bigint,
  provider             text NOT NULL DEFAULT 'manual',
  provider_ref         text,
  checkout_url         text,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  paid_at              timestamptz,
  refunded_at          timestamptz,
  CONSTRAINT payments_settled_pair CHECK (
    (settled_currency IS NULL) = (settled_amount_minor IS NULL))
);

/* A provider's reference is the idempotency key for a webhook
   that may arrive twice. */
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref
  ON crm.payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_consultation_idx
  ON crm.payments (consultation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_outstanding_idx
  ON crm.payments (created_at) WHERE status = 'pending';

/* ---- what the client is given afterwards --------------------
   A RECEIPT TODAY, A TAX INVOICE IF SHE EVER REGISTERS. The tax
   columns are here and unused on purpose: adding a column later
   is a migration, but changing the shape of a document people
   have already been issued is a mess with no good ending. `kind`
   says which one a row is, and nothing but a GSTIN changes it.

   IT SNAPSHOTS WHO IT WAS ISSUED TO. A receipt is a historical
   document: what it said on the day is what it says forever. Join
   it to crm.people and a client who corrects the spelling of
   their name silently rewrites every receipt they were ever
   given. So the name, the email and the description are copied in
   at issue and never touched again. */
CREATE TABLE IF NOT EXISTS crm.invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES crm.payments(id) ON DELETE RESTRICT,
  consultation_id uuid REFERENCES crm.consultations(id) ON DELETE SET NULL,
  person_id       uuid REFERENCES crm.people(id) ON DELETE SET NULL,

  kind            text NOT NULL DEFAULT 'receipt'
                    CHECK (kind IN ('receipt','tax_invoice')),

  /* The number, in two halves: the series it belongs to and the
     position within it. Kept apart from the printed string so the
     format can change without the ordering becoming a guess. */
  series          text NOT NULL,
  seq             integer NOT NULL CHECK (seq > 0),
  number          text NOT NULL,

  /* Copied at issue. Never a join. */
  issued_to_name  text NOT NULL,
  issued_to_email text NOT NULL,
  description     text NOT NULL,

  currency        char(3) NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),

  /* ---- unused until she registers for GST ----
     taxable + the three taxes must add up to amount_minor when
     this is a tax invoice; until then they are all NULL and the
     amount is simply what was paid. */
  gstin            text,
  place_of_supply  text,
  sac              text,
  taxable_minor    bigint,
  cgst_minor       bigint,
  sgst_minor       bigint,
  igst_minor       bigint,

  issued_at       timestamptz NOT NULL DEFAULT now(),

  /* A tax invoice is not a tax invoice without the fields that
     make it one. Enforced here so the day she registers, a
     half-filled row is refused rather than issued. */
  CONSTRAINT invoices_tax_is_complete CHECK (
    kind = 'receipt'
    OR (gstin IS NOT NULL AND place_of_supply IS NOT NULL AND sac IS NOT NULL
        AND taxable_minor IS NOT NULL
        AND taxable_minor + coalesce(cgst_minor,0) + coalesce(sgst_minor,0)
                          + coalesce(igst_minor,0) = amount_minor)),

  /* CGST/SGST or IGST — never both. Within a state it is the pair,
     across states it is the single. */
  CONSTRAINT invoices_tax_split CHECK (
    igst_minor IS NULL OR (cgst_minor IS NULL AND sgst_minor IS NULL))
);

/* THE NUMBER IS UNIQUE WITHIN ITS SERIES, at the database. A
   duplicated receipt number is the kind of thing that is found by
   an accountant, a year later, in a room. */
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_once
  ON crm.invoices (series, seq);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_printed_once
  ON crm.invoices (number);

/* ONE RECEIPT PER PAYMENT. The webhook and the browser both report
   the same payment; neither may cause a second document. */
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_per_payment
  ON crm.invoices (payment_id);

CREATE INDEX IF NOT EXISTS invoices_person ON crm.invoices (person_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS invoices_recent ON crm.invoices (issued_at DESC);

/* The counter each series is drawn from. A separate row per series
   so allocating a number is a single-row UPDATE: the row lock
   serialises two payments landing in the same millisecond, and
   `next_seq` moves exactly once per issued document.

   Numbers are allocated in the SAME TRANSACTION as the document,
   which is what keeps the series gapless — a rolled-back payment
   takes its number back with it. */
CREATE TABLE IF NOT EXISTS crm.invoice_counters (
  series   text PRIMARY KEY,
  next_seq integer NOT NULL DEFAULT 1 CHECK (next_seq > 0)
);


/* ---- health records ----------------------------------------
   Clinical documents, both directions: she puts a plan or a
   letter here, the client puts their bloodwork here before a
   session. crm.checkin_media already stores photographs, but it
   hangs off a check-in — a lab report belongs to the person, not
   to a Tuesday.

   EVERY ROW SAYS WHO PUT IT THERE. A record with no provenance
   is a rumour, and "she uploaded this" and "the client uploaded
   this" carry very different weight in a clinical file.

   AND WHETHER THE CLIENT MAY SEE IT. She may attach something
   she has not discussed with them yet — a specialist's letter, a
   note to herself. Defaulting to visible is right for the common
   case; being unable to withhold anything would mean she simply
   stops using it. */
CREATE TABLE IF NOT EXISTS crm.documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES crm.people(id) ON DELETE RESTRICT,
  consultation_id uuid REFERENCES crm.consultations(id) ON DELETE SET NULL,

  kind            text NOT NULL DEFAULT 'other'
                    CHECK (kind IN ('report','prescription','plan','letter','other')),
  title           text NOT NULL CHECK (btrim(title) <> ''),

  storage_key     text NOT NULL,
  mime            text NOT NULL
                    CHECK (mime IN ('application/pdf','image/jpeg','image/png','image/webp')),
  bytes           integer NOT NULL CHECK (bytes > 0),
  sha256          text NOT NULL,

  uploaded_by     text NOT NULL CHECK (uploaded_by IN ('client','practitioner')),
  visible_to_client boolean NOT NULL DEFAULT true,

  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

/* The same file sent twice is one file. */
CREATE UNIQUE INDEX IF NOT EXISTS documents_once
  ON crm.documents (person_id, sha256);
CREATE INDEX IF NOT EXISTS documents_person
  ON crm.documents (person_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS documents_for_client
  ON crm.documents (person_id, uploaded_at DESC) WHERE visible_to_client;


/* ---- signing in --------------------------------------------
   THE IDENTITY ALREADY EXISTS. crm.people has the name and the
   email; a client is not a new kind of thing because they now
   have a password-less login. What is missing is proof that the
   person at the keyboard is them, and somewhere to keep that
   proof for a while.

   IDENTITY OUTLIVES A PLAN; ENTITLEMENT DOES NOT. Neither table
   below references a programme. Whether they may see a plan
   today is answered by crm.programmes.status, every time it is
   asked — so a plan ending logs nobody out, and a plan starting
   needs no new account. */
CREATE TABLE IF NOT EXISTS crm.client_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES crm.people(id) ON DELETE CASCADE,

  /* HASHED, never the code. This table is a list of live keys to
     client records; stored in the clear, one leak hands over every
     account that has a code in flight. */
  code_hash   text NOT NULL,
  sent_to     text NOT NULL,
  channel     text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),

  attempts    smallint NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ONE LIVE CODE PER PERSON. Without this, asking for a code five
   times leaves five working codes, which is five times the guesses
   for anybody trying them. */
CREATE UNIQUE INDEX IF NOT EXISTS client_codes_one_live
  ON crm.client_codes (person_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS client_codes_expiry
  ON crm.client_codes (expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS crm.client_sessions (
  token        text PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES crm.people(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  user_agent   text,
  ip_hash      text,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS client_sessions_person
  ON crm.client_sessions (person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_sessions_live
  ON crm.client_sessions (expires_at) WHERE revoked_at IS NULL;

/* Email and WhatsApp that went out about a consultation. */
CREATE TABLE IF NOT EXISTS crm.messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid REFERENCES crm.consultations(id) ON DELETE SET NULL,
  person_id        uuid REFERENCES crm.people(id) ON DELETE SET NULL,
  channel          text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  template_id      text NOT NULL,
  template_version integer NOT NULL DEFAULT 1,
  recipient        text NOT NULL,
  subject          text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','sent','failed')),
  provider         text,
  provider_id      text,
  error            text,
  attempts         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);

/* One of each letter per booking per channel. The database
   refusing a second is what makes a retry safe. */
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_per_booking_channel
  ON crm.messages (consultation_id, template_id, channel)
  WHERE consultation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_recent ON crm.messages (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_unsent ON crm.messages (status) WHERE status <> 'sent';

/* The video room, and who was in it. */
CREATE TABLE IF NOT EXISTS crm.room_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room            text NOT NULL,
  consultation_id uuid REFERENCES crm.consultations(id) ON DELETE SET NULL,
  state           text NOT NULL DEFAULT 'waiting'
                    CHECK (state IN ('waiting','live','ended')),
  started_at      timestamptz,
  ended_at        timestamptz,
  started_by      text,
  source          text NOT NULL DEFAULT 'system' CHECK (source IN ('system','trial')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS room_sessions_one_open
  ON crm.room_sessions (room) WHERE state <> 'ended';
CREATE INDEX IF NOT EXISTS room_sessions_recent ON crm.room_sessions (created_at DESC);

CREATE TABLE IF NOT EXISTS crm.room_participants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES crm.room_sessions(id) ON DELETE CASCADE,
  side       text NOT NULL CHECK (side IN ('host','client')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  connection text CHECK (connection IN ('direct','relayed','failed')),
  user_agent text,
  ip_hash    text
);

CREATE UNIQUE INDEX IF NOT EXISTS room_participants_one_present
  ON crm.room_participants (session_id, side) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS room_participants_session
  ON crm.room_participants (session_id);


-- ---- the consultation itself --------------------------------

/* What she asked and what they answered, at one visit.
   `answers` is FLAT — keyed by field id, one level, no nesting.
   Anything that should be watched over time is not in here at
   all; it is a row in crm.measurements, so that a weight is a
   point on a line rather than a value buried in a document.

   VERSIONED BY AMENDMENT, never overwritten: `visit` counts the
   consultations, `amendment` counts the corrections to one, and
   `amends` points back at the version this replaces. */
CREATE TABLE IF NOT EXISTS crm.assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES crm.people(id) ON DELETE RESTRICT,
  consultation_id uuid REFERENCES crm.consultations(id) ON DELETE SET NULL,
  visit           integer NOT NULL DEFAULT 0,
  amendment       integer NOT NULL DEFAULT 0,
  ref             text NOT NULL,
  amends          uuid REFERENCES crm.assessments(id) ON DELETE RESTRICT,
  kind            text NOT NULL DEFAULT 'first_visit'
                    CHECK (kind IN ('first_visit','follow_up')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  answers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_sections   jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes           text NOT NULL DEFAULT '',
  recorded_by     text NOT NULL DEFAULT 'unknown',
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finalised_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS assessments_ref ON crm.assessments (ref);
CREATE UNIQUE INDEX IF NOT EXISTS assessments_version
  ON crm.assessments (person_id, visit, amendment);

/* ONE DRAFT AT A TIME. Two half-finished assessments for the same
   visit is a question about which one is real, and there is no
   good answer to it. */
CREATE UNIQUE INDEX IF NOT EXISTS assessments_one_draft
  ON crm.assessments (person_id, visit) WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS assessments_person
  ON crm.assessments (person_id, visit DESC, amendment DESC);
CREATE INDEX IF NOT EXISTS assessments_consultation
  ON crm.assessments (consultation_id) WHERE consultation_id IS NOT NULL;

/* What they agreed to aim at. */
CREATE TABLE IF NOT EXISTS crm.goals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id            uuid NOT NULL REFERENCES crm.people(id) ON DELETE RESTRICT,
  set_at_assessment_id uuid REFERENCES crm.assessments(id) ON DELETE SET NULL,
  kind                 text NOT NULL DEFAULT 'behavioural'
                         CHECK (kind IN ('behavioural','short_term','long_term')),
  goal                 text NOT NULL,
  target_metric        text,
  target_value         numeric,
  due_on               date,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','met','missed','dropped')),
  reviewed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goals_person ON crm.goals (person_id, status, due_on);

/* One number, once, with who took it. `source` separates what she
   measured in the room from what the client typed into the app —
   which is the difference between a clinical record and a diary,
   and the client only ever sees their own handwriting. */
CREATE TABLE IF NOT EXISTS crm.measurements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES crm.people(id) ON DELETE RESTRICT,
  assessment_id uuid REFERENCES crm.assessments(id) ON DELETE CASCADE,
  programme_id  uuid,
  kind          text NOT NULL DEFAULT 'body'
                  CHECK (kind IN ('body','lab','sleep','activity')),
  metric        text NOT NULL,
  value         numeric NOT NULL,
  unit          text NOT NULL DEFAULT '',
  method        text,
  ref_low       numeric,
  ref_high      numeric,
  taken_at      timestamptz NOT NULL DEFAULT now(),
  /* 'device' is here for a wearable that does not exist yet.
     It costs nothing now and means a watch later writes rows every
     chart already draws — what it must never do is claim 'clinic'. */
  source        text NOT NULL DEFAULT 'clinic'
                  CHECK (source IN ('clinic','self','device'))
);

CREATE INDEX IF NOT EXISTS measurements_curve
  ON crm.measurements (person_id, metric, taken_at DESC);
CREATE INDEX IF NOT EXISTS measurements_assessment ON crm.measurements (assessment_id);


-- ---- the plan, and living with it ---------------------------

/* What she wrote for them. Amended forward like an assessment,
   never edited in place: an issued plan is a thing somebody has
   already read and may be following. */
CREATE TABLE IF NOT EXISTS crm.plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES crm.people(id) ON DELETE RESTRICT,
  consultation_id uuid REFERENCES crm.consultations(id) ON DELETE SET NULL,
  plan_no         integer NOT NULL DEFAULT 0,
  amendment       integer NOT NULL DEFAULT 0,
  ref             text NOT NULL,
  amends          uuid REFERENCES crm.plans(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  body            text NOT NULL DEFAULT '',
  private_note    text NOT NULL DEFAULT '',
  targets         jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by     text NOT NULL DEFAULT 'unknown',
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  issued_at       timestamptz,
  reads           integer NOT NULL DEFAULT 0,
  drafts          integer NOT NULL DEFAULT 0
);

COMMENT ON COLUMN crm.plans.reads IS
  'Times the assistant has been asked to read this version.';
COMMENT ON COLUMN crm.plans.drafts IS
  'Times a first draft has been written from the finalised assessment.';

CREATE UNIQUE INDEX IF NOT EXISTS plans_ref ON crm.plans (ref);
CREATE UNIQUE INDEX IF NOT EXISTS plans_version
  ON crm.plans (person_id, plan_no, amendment);
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_draft
  ON crm.plans (person_id, plan_no) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS plans_person
  ON crm.plans (person_id, plan_no DESC, amendment DESC);
CREATE INDEX IF NOT EXISTS plans_consultation
  ON crm.plans (consultation_id) WHERE consultation_id IS NOT NULL;

/* The plan broken into things a person can actually tick off.
   `proposed` keeps what the assistant suggested even after she
   edits it, so the two can be compared later. */
CREATE TABLE IF NOT EXISTS crm.plan_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES crm.plans(id) ON DELETE CASCADE,
  seq          integer NOT NULL DEFAULT 0,
  source_line  integer,
  /* `filler` is what to eat between meals when hungry: no time on
     it, conditional, and NOT counted against the day. It is a kind
     rather than a flag because it behaves differently everywhere —
     see db/migrations/0004_plan_intake.sql. */
  kind         text NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('meal','filler','supplement','activity','sleep','habit','other')),
  label        text NOT NULL,
  quantity     numeric,
  unit         text NOT NULL DEFAULT '',
  schedule     text NOT NULL DEFAULT '',
  proposed     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','confirmed','edited','rejected')),
  model        text NOT NULL DEFAULT '',
  /* Kind-specific: {sets, reps, restSeconds, day} for an exercise,
     {kcal} for a meal. Empty for kinds that need none. */
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  /* NOTHING IS CONFIRMED BY NOBODY. A line the client will follow
     has a person's name against it, at the database level, so no
     code path can quietly skip saying who agreed to it. */
  CONSTRAINT plan_items_confirmed_has_who CHECK (
    status IN ('proposed','rejected')
    OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS plan_items_plan ON crm.plan_items (plan_id, seq);
CREATE INDEX IF NOT EXISTS plan_items_live
  ON crm.plan_items (plan_id) WHERE status IN ('confirmed','edited');

/* The link that shows a client their plan. */
CREATE TABLE IF NOT EXISTS crm.plan_links (
  token      text PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES crm.people(id) ON DELETE CASCADE,
  plan_no    integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at  timestamptz,
  open_count integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_links_one_per_plan
  ON crm.plan_links (person_id, plan_no);
CREATE INDEX IF NOT EXISTS plan_links_expiry ON crm.plan_links (expires_at);

/* The stretch of time a plan is being followed for — 30, 60 or 90
   days. This is what the client's app is a view of. */
CREATE TABLE IF NOT EXISTS crm.programmes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL,
  person_id   uuid NOT NULL REFERENCES crm.people(id) ON DELETE CASCADE,
  plan_no     integer NOT NULL,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','ended','revoked')),
  started_on  date NOT NULL DEFAULT CURRENT_DATE,
  ends_on     date,
  length_days integer NOT NULL DEFAULT 30
                CONSTRAINT programmes_length_check CHECK (length_days IN (30,60,90)),
  opened_at   timestamptz,
  open_count  integer NOT NULL DEFAULT 0,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN crm.programmes.length_days IS
  'How long the plan runs. The client app draws its calendar from this.';

CREATE UNIQUE INDEX IF NOT EXISTS programmes_token ON crm.programmes (token);
CREATE UNIQUE INDEX IF NOT EXISTS programmes_one_live
  ON crm.programmes (person_id, plan_no) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS programmes_person
  ON crm.programmes (person_id, started_on DESC);

/* Deferred to here rather than declared on the column: the table
   it points at is created after measurements. Guarded so the
   whole file stays re-runnable. */
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'measurements_programme_id_fkey'
       AND conrelid = 'crm.measurements'::regclass
  ) THEN
    ALTER TABLE crm.measurements
      ADD CONSTRAINT measurements_programme_id_fkey
      FOREIGN KEY (programme_id) REFERENCES crm.programmes(id) ON DELETE SET NULL;
  END IF;
END
$fk$;

/* One line of the plan, ticked off on one day. */
CREATE TABLE IF NOT EXISTS crm.checkins (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES crm.programmes(id) ON DELETE CASCADE,
  plan_item_id uuid NOT NULL REFERENCES crm.plan_items(id) ON DELETE RESTRICT,
  on_date      date NOT NULL,
  state        text NOT NULL CHECK (state IN ('done','part','skip')),
  note         text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkins_day
  ON crm.checkins (programme_id, on_date DESC, at DESC);
CREATE INDEX IF NOT EXISTS checkins_item
  ON crm.checkins (plan_item_id, on_date DESC);

/* A photograph of a meal. The camera is for meals and macros and
   nothing else, so the accepted types are narrow and the size is
   checked here as well as at the door. */
CREATE TABLE IF NOT EXISTS crm.checkin_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id  uuid NOT NULL REFERENCES crm.checkins(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  bytes       integer NOT NULL CHECK (bytes > 0),
  sha256      text NOT NULL,
  width       integer,
  height      integer,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now()
);

/* The same photograph sent twice is one photograph. */
CREATE UNIQUE INDEX IF NOT EXISTS checkin_media_once
  ON crm.checkin_media (checkin_id, sha256);
CREATE INDEX IF NOT EXISTS checkin_media_checkin ON crm.checkin_media (checkin_id);
CREATE INDEX IF NOT EXISTS checkin_media_age     ON crm.checkin_media (received_at);

/* The conversation on a day: what the client wrote, and her
   reply. A reply has to say who wrote it. */
CREATE TABLE IF NOT EXISTS crm.programme_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES crm.programmes(id) ON DELETE CASCADE,
  on_date      date NOT NULL,
  body         text NOT NULL CHECK (btrim(body) <> ''),
  author       text NOT NULL DEFAULT 'client'
                 CHECK (author IN ('client','practitioner')),
  by           text,
  at           timestamptz NOT NULL DEFAULT now(),
  seen_at      timestamptz,
  CONSTRAINT programme_notes_reply_has_who CHECK (
    author = 'client' OR (by IS NOT NULL AND btrim(by) <> ''))
);

CREATE INDEX IF NOT EXISTS programme_notes_day
  ON crm.programme_notes (programme_id, on_date DESC, at DESC);
CREATE INDEX IF NOT EXISTS programme_notes_thread
  ON crm.programme_notes (programme_id, on_date DESC, at);
CREATE INDEX IF NOT EXISTS programme_notes_unseen
  ON crm.programme_notes (at DESC) WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS programme_notes_unseen_by_author
  ON crm.programme_notes (programme_id, author, at DESC) WHERE seen_at IS NULL;


-- ============================================================
--  ROW-LEVEL SECURITY
--  A client's request runs as myf_client, which owns nothing and
--  can see one person's rows: whoever the transaction says it is
--  acting for. The WHERE clauses in Go still name the person, and
--  should — a boundary you can read in the query is one the next
--  person to touch it understands. What this adds is that the
--  filtering no longer DEPENDS on that line being there and being
--  right.
--
--  ENABLE, NOT FORCE, and that is deliberate. FORCE would apply
--  the policies to the table's owner too, and the owner is the
--  connection the CRM runs on — the practitioner would go blind.
--  The safety of that choice rests entirely on myf_client not
--  owning anything, which db/roles.sql refuses to proceed without.
--
--  The role is created here with NOLOGIN and no password. It is
--  given a way in by db/roles.sql, which is separate because a
--  migration lives in git and a credential must not.
-- ============================================================

/* ---- the visitor's tables, closed to everyone -----------------
   These have no policy and never get one. On a managed database
   the `public` schema is the one PostgREST exposes, so anybody
   holding the anon key — which is published in a browser by
   design — can ask it for `public.bmi_snapshots`. That table
   holds a height and a weight against an IP hash;
   `public.appointments` holds a name, an email and a phone
   number; `public.notifications` holds the rendered body of every
   letter sent.

   RLS with no policy denies every row to everyone who is not the
   owner, which is exactly right: Go connects as the owner and is
   unaffected, and there is no other legitimate reader.

   Supabase turns this on by itself for tables in `public`, and
   that is how it was discovered here. It is written down anyway,
   because a protection that exists only as a vendor's default is
   one that quietly does not exist on a laptop, in a test, or on
   whatever this runs on next. Verified rather than assumed: with
   this in place `availability_rules` has twelve rows and returns
   `[]` to the anon key. */
DO $shut$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.bmi_snapshots', 'public.handoff_tokens', 'public.appointments',
    'public.notifications', 'public.availability_rules',
    'public.availability_exceptions', 'public.schema_migrations'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$shut$;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_client') THEN
    CREATE ROLE myf_client NOLOGIN;
  END IF;
END
$role$;

COMMENT ON ROLE myf_client IS
  'The connection a client''s own request runs on. Not an owner, not a superuser, no BYPASSRLS — which is what makes every policy here mean something. Given LOGIN and a password by db/roles.sql.';

GRANT USAGE ON SCHEMA crm TO myf_client;
GRANT EXECUTE ON FUNCTION crm.current_person() TO myf_client;

/* READ: their record, their plan, their days. */
GRANT SELECT ON
  crm.people, crm.programmes, crm.plans, crm.plan_items,
  crm.checkins, crm.checkin_media, crm.programme_notes,
  crm.measurements, crm.consultations,
  crm.consultation_links, crm.plan_links,
  /* The account panel's three: what she wrote for them, what
     they paid, and what they agreed to. Read only — a client
     cannot author a document, a receipt or a goal. */
  crm.documents, crm.invoices, crm.goals
TO myf_client;

/* WRITE: only the things a client authors — a tick, a photograph,
   a note, a weight, and asking to be seen again. */
GRANT INSERT ON
  crm.checkins, crm.checkin_media, crm.programme_notes,
  crm.measurements, crm.consultations
TO myf_client;

/* UPDATE IS COLUMN-SCOPED, so "I opened the link" cannot become
   "I changed my programme". */
GRANT UPDATE (opened_at, open_count) ON crm.programmes         TO myf_client;
GRANT UPDATE (opened_at, open_count) ON crm.consultation_links TO myf_client;
GRANT UPDATE (opened_at, open_count) ON crm.plan_links         TO myf_client;
GRANT UPDATE (seen_at)               ON crm.programme_notes    TO myf_client;

/* NO DELETE ANYWHERE. Not withheld by policy — never granted at
   all, so it fails before any policy is consulted. */

/* ---- the policies ------------------------------------------
   One sentence per table: this row is yours. Tables that reach
   their person through a parent say so with EXISTS. Written with
   DROP … IF EXISTS first so the file stays re-runnable. */
DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm.people', 'crm.programmes', 'crm.plans', 'crm.plan_items',
    'crm.checkins', 'crm.checkin_media', 'crm.programme_notes',
    'crm.measurements', 'crm.consultations',
    'crm.consultation_links', 'crm.plan_links',
    'crm.documents', 'crm.invoices', 'crm.goals'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS client_own ON %s', t);
  END LOOP;
END
$policies$;

CREATE POLICY client_own ON crm.people
  FOR ALL TO myf_client
  USING (id = crm.current_person());

CREATE POLICY client_own ON crm.programmes
  FOR ALL TO myf_client
  USING (person_id = crm.current_person())
  WITH CHECK (person_id = crm.current_person());

CREATE POLICY client_own ON crm.plans
  FOR ALL TO myf_client
  USING (person_id = crm.current_person());

CREATE POLICY client_own ON crm.plan_items
  FOR ALL TO myf_client
  USING (EXISTS (SELECT 1 FROM crm.plans p
                  WHERE p.id = plan_items.plan_id
                    AND p.person_id = crm.current_person()));

CREATE POLICY client_own ON crm.checkins
  FOR ALL TO myf_client
  USING (EXISTS (SELECT 1 FROM crm.programmes g
                  WHERE g.id = checkins.programme_id
                    AND g.person_id = crm.current_person()))
  WITH CHECK (EXISTS (SELECT 1 FROM crm.programmes g
                       WHERE g.id = checkins.programme_id
                         AND g.person_id = crm.current_person()));

CREATE POLICY client_own ON crm.checkin_media
  FOR ALL TO myf_client
  USING (EXISTS (SELECT 1 FROM crm.checkins c
                   JOIN crm.programmes g ON g.id = c.programme_id
                  WHERE c.id = checkin_media.checkin_id
                    AND g.person_id = crm.current_person()))
  WITH CHECK (EXISTS (SELECT 1 FROM crm.checkins c
                        JOIN crm.programmes g ON g.id = c.programme_id
                       WHERE c.id = checkin_media.checkin_id
                         AND g.person_id = crm.current_person()));

CREATE POLICY client_own ON crm.programme_notes
  FOR ALL TO myf_client
  USING (EXISTS (SELECT 1 FROM crm.programmes g
                  WHERE g.id = programme_notes.programme_id
                    AND g.person_id = crm.current_person()))
  WITH CHECK (EXISTS (SELECT 1 FROM crm.programmes g
                       WHERE g.id = programme_notes.programme_id
                         AND g.person_id = crm.current_person()));

CREATE POLICY client_own ON crm.measurements
  FOR ALL TO myf_client
  USING (person_id = crm.current_person())
  WITH CHECK (person_id = crm.current_person());

CREATE POLICY client_own ON crm.consultations
  FOR ALL TO myf_client
  USING (person_id = crm.current_person())
  WITH CHECK (person_id = crm.current_person());

CREATE POLICY client_own ON crm.consultation_links
  FOR ALL TO myf_client
  USING (EXISTS (SELECT 1 FROM crm.consultations c
                  WHERE c.id = consultation_links.consultation_id
                    AND c.person_id = crm.current_person()));

CREATE POLICY client_own ON crm.plan_links
  FOR ALL TO myf_client
  USING (person_id = crm.current_person());

/* ---- the account panel's three ------------------------------

   DOCUMENTS CARRY A SECOND CONDITION. Her letter to a referring
   physician is filed against the client and is not for the
   client to read, so the policy asks two questions rather than
   one. Putting `visible_to_client` here rather than in a WHERE
   clause is the point: a query that forgets it returns nothing
   instead of returning a letter she wrote in confidence. */
CREATE POLICY client_own ON crm.documents
  FOR ALL TO myf_client
  USING (person_id = crm.current_person() AND visible_to_client);

/* A receipt is theirs to keep for ever, including after the
   programme it paid for has ended. */
CREATE POLICY client_own ON crm.invoices
  FOR ALL TO myf_client
  USING (person_id = crm.current_person());

CREATE POLICY client_own ON crm.goals
  FOR ALL TO myf_client
  USING (person_id = crm.current_person());

/* NOT GRANTED TO myf_client AT ALL: crm.client_codes and
   crm.client_sessions. A signed-in client has no business
   reading the table that decides who is signed in, not even
   their own row — the only code that touches those two is
   client_auth.go, on the practitioner's pool, before anybody has
   been identified. RLS is enabled on both so the absence of a
   grant is belt and braces rather than the only thing standing
   there. */
ALTER TABLE crm.client_codes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.client_sessions ENABLE ROW LEVEL SECURITY;

