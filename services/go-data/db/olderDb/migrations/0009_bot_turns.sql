-- ============================================================
--  0009_bot_turns — what every bot was asked, and what it said
-- ------------------------------------------------------------
--  Item 13. One row per turn, across every bot in the system:
--  the front desk, the deskOfficer, her CRM assistant.
--
--  The question this exists to answer is "is the deterministic
--  lane good enough yet", and it answers it with evidence rather
--  than impressions. Which lane replied, how confident it was,
--  how long it took, and when a model was reached for at all.
--
--  IT IS ALSO THE MOST SENSITIVE TABLE HERE. It holds whatever a
--  visitor typed, which is health-adjacent by definition — people
--  explain why they want a dietitian. `redacted_at` and the
--  retention sweep below are not decoration.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.bot_turns (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),

  -- Which bot. A slug, because bots are added and this must not
  -- need a migration each time: 'front-desk', 'desk-officer',
  -- 'crm-assistant'.
  bot          text NOT NULL,

  -- 'deterministic' or 'agentic'. The whole point of the table is
  -- being able to count these against each other.
  lane         text NOT NULL CHECK (lane IN ('deterministic', 'agentic')),

  -- The conversation this belongs to, so a turn can be read in
  -- context. Not a foreign key: sessions live in memory and expire,
  -- and a log that cascade-deleted itself would be useless.
  session_ref  text,

  input        text,
  output       text,

  -- What the deterministic reader made of it. Null for turns that
  -- never went through classification.
  intent       text,
  confidence   real,

  -- Why the orchestrator chose what it chose. 'knowledge',
  -- 'scripted', 'model', 'breaker-open', 'model-failed'.
  reason       text,

  model        text,
  latency_ms   integer,

  -- Set when the text has been cleared by the retention sweep. The
  -- ROW stays: the counts and timings are what make the table worth
  -- keeping, and they are not personal once the words are gone.
  redacted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS bot_turns_recent_idx ON crm.bot_turns (at DESC);
CREATE INDEX IF NOT EXISTS bot_turns_lane_idx   ON crm.bot_turns (bot, lane, at DESC);

-- Finding turns still holding text, for the sweep.
CREATE INDEX IF NOT EXISTS bot_turns_unredacted_idx
  ON crm.bot_turns (at) WHERE redacted_at IS NULL;

-- ------------------------------------------------------------
--  crm.bot_switches — the master panel's on/off
--
--  A table rather than a config file because she flips these, not
--  a deploy. Absent means on: a bot nobody has ever switched off
--  should work, and a panel that has to seed a row before anything
--  runs is a panel that can lock the desk out of its own lanes.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.bot_switches (
  bot        text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  note       text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
