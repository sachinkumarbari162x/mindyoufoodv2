-- ============================================================
--  0004 · PAYMENTS
--
--  Provider-agnostic on purpose. Where the practice is
--  registered is not settled yet, and that decides the rail:
--  Stripe is restricted for Indian businesses, while Razorpay
--  and Cashfree handle cross-border card payments inside the
--  RBI framework. Nothing below names a provider, so choosing
--  one later is configuration rather than a migration.
--
--  THERE IS NO WALLET TABLE, DELIBERATELY.
--
--  Holding a customer balance is a licensed activity — in India
--  it means RBI authorisation as a prepaid payment instrument
--  issuer. "Receive foreign currency" is served by a bank or a
--  provider account she opens (Wise, Payoneer, EEFC), and this
--  schema RECORDS what arrived there. It never custodies money.
--  A `balance` column here would be the beginning of operating
--  unlicensed.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

-- ============================================================
--  crm.prices — what a consultation costs, per currency
--
--  One row per currency rather than one price converted at
--  checkout: a UK client seeing £N and a Saudi client seeing
--  SAR N are both round, deliberate numbers. Converting a rupee
--  price live produces £43.87, which reads as a machine talking.
--
--  The desk still never quotes these. She sets the amount when
--  she accepts a booking, and the confirmation carries the link
--  (see FR-1.3 — the fee guardrails stay exactly as they are).
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.prices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  label        text NOT NULL DEFAULT 'Consultation',
  -- ISO 4217, uppercase. char(3) so a typo cannot become a
  -- currency of its own.
  currency     char(3) NOT NULL,
  -- MINOR UNITS, always an integer. 4000 = ₹40.00 = £40.00.
  -- Never a float: binary cannot represent 0.1 exactly, and this
  -- is somebody's money.
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),

  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One live price per currency; older ones stay for the record.
CREATE UNIQUE INDEX IF NOT EXISTS prices_currency_active
  ON crm.prices (currency)
  WHERE active;

-- ============================================================
--  crm.payments — one row per attempt to be paid
--
--  Records, never custodies. The provider holds the money and
--  the bank receives it; this says what was asked for, what was
--  actually settled, and where the evidence lives.
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES crm.consultations (id) ON DELETE CASCADE,

  -- ---- what was asked for ----
  currency        char(3) NOT NULL,
  amount_minor    bigint  NOT NULL CHECK (amount_minor > 0),

  -- ---- what actually arrived ----
  -- Separate columns because they differ, always: FX moves and
  -- the provider takes a fee. A £40 invoice does not land as
  -- ₹4,240, and her books need the number that reached the bank
  -- rather than the one on the invoice.
  settled_currency     char(3),
  settled_amount_minor bigint,
  fee_minor            bigint,

  -- ---- who processed it ----
  -- 'manual' is the default and means she was paid some other
  -- way and marked it herself. Nothing is charged until a real
  -- provider is configured, matching how bookings stay dry-run
  -- until APPOINTMENTS_API_URL is set.
  provider        text NOT NULL DEFAULT 'manual',
  provider_ref    text,
  checkout_url    text,

  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'failed',
                                      'refunded', 'cancelled')),

  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  refunded_at     timestamptz,

  CONSTRAINT payments_settled_pair CHECK (
    (settled_currency IS NULL) = (settled_amount_minor IS NULL)
  )
);

-- ============================================================
--  A provider reference is unique PER PROVIDER
--
--  Webhooks are delivered more than once by design — every
--  gateway retries until it gets a 2xx, and a retry after a slow
--  response is normal traffic, not an error. Without this a
--  duplicate delivery books the same payment twice and her
--  takings are wrong.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref
  ON crm.payments (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_consultation_idx
  ON crm.payments (consultation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payments_outstanding_idx
  ON crm.payments (created_at)
  WHERE status = 'pending';
