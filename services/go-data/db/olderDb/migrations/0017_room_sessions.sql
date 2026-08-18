-- ============================================================
--  0017_room_sessions — the consultation room, remembered
-- ------------------------------------------------------------
--  TWO TABLES, NOT ONE, and the reason is that the two sides
--  fail independently. She can be connected for forty minutes
--  while the client never got through at all; one row per
--  session cannot record that, and the single most useful thing
--  these tables can tell her is which of them it was.
--
--  It also settles a question the architecture doc could only
--  estimate. "Roughly one call in seven needs a TURN relay" was
--  an educated guess used to size the bandwidth; `connection`
--  below turns it into a count.
--
--  WHAT IS NOT HERE: anything said, shown or recorded. This is
--  who joined, when, and whether the media got through. The
--  consultation itself lives in crm.assessments, and the video
--  never touches a disk at all.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.room_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The room key. In the system this is derived from the booking;
  -- in the trial it is whatever ?room= said, which is why it is a
  -- text key of its own rather than the consultation's id.
  room text NOT NULL,

  consultation_id uuid REFERENCES crm.consultations (id) ON DELETE SET NULL,

  state text NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting', 'live', 'ended')),

  started_at timestamptz,
  ended_at   timestamptz,
  -- Who moved it to live. Only ever the host, and recorded so that
  -- "she started it" is a fact rather than an assumption.
  started_by text,

  /* Trial rows are told apart at the source rather than by
     guessing from the data later. A prototype writing into the
     same tables as the practice is fine; a prototype that becomes
     indistinguishable from it is not. */
  source text NOT NULL DEFAULT 'system'
    CHECK (source IN ('system', 'trial')),

  created_at timestamptz NOT NULL DEFAULT now()
);

/* ONE SESSION PER ROOM AT A TIME. Two live sessions for one
   appointment means two of something — two waiting rooms, two sets
   of participants — and whichever the client landed in would be
   the wrong one half the time. */
CREATE UNIQUE INDEX IF NOT EXISTS room_sessions_one_open
  ON crm.room_sessions (room)
  WHERE state <> 'ended';

CREATE INDEX IF NOT EXISTS room_sessions_recent
  ON crm.room_sessions (created_at DESC);

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crm.room_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  session_id uuid NOT NULL
    REFERENCES crm.room_sessions (id) ON DELETE CASCADE,

  side text NOT NULL CHECK (side IN ('host', 'client')),

  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz,

  /* How the media actually travelled, which is the number worth
     collecting. 'relayed' means it went through TURN and cost
     bandwidth; 'failed' means it never connected and she had to
     ring them. Null until the connection settles. */
  connection text CHECK (connection IN ('direct', 'relayed', 'failed')),

  user_agent text,
  -- Hashed, never stored raw — it is the client's home address as
  -- far as this system is concerned, and nothing here needs it.
  ip_hash text
);

/* One PRESENT participant per side. Somebody who reconnects gets a
   new row, and the old one is closed off with left_at — so a flaky
   connection reads as three joins rather than as three people. */
CREATE UNIQUE INDEX IF NOT EXISTS room_participants_one_present
  ON crm.room_participants (session_id, side)
  WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS room_participants_session
  ON crm.room_participants (session_id);
