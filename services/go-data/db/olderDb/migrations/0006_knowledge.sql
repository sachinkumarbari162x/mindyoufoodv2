-- ============================================================
--  0006 · THE KNOWLEDGE AND INTELLIGENCE BASE
--
--  Three tables that let the desk get better without a deploy.
--
--    crm.knowledge      what to SAY        (the answers)
--    crm.phrasings      how people ASK     (recognition)
--    crm.unrecognised   what it MISSED     (the loop between them)
--
--  Until now both halves lived in code: the answers as functions in
--  flow.js, the phrasings as regexes in rules/nlu.js. Changing a fee
--  sentence meant an edit, a commit and a restart, so in practice the
--  wording drifted out of date and nobody noticed.
--
--  THE LOOP IS THE POINT. A question the desk cannot place is
--  recorded rather than discarded. She reads what people actually
--  asked, attaches it to an intent or writes a new answer, and the
--  next visitor asking the same thing is understood. That is the
--  whole "learns without retraining" mechanism, and it needs no
--  model at all.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

-- ============================================================
--  crm.knowledge — one answer per intent
--
--  Answers may carry PLACEHOLDERS. Opening hours, focus areas and
--  her email are facts held elsewhere and must not be copied into
--  prose here: a fee sentence naming Saturday hours would go stale
--  the day she changes them and nobody would think to look. The BFF
--  substitutes at render time:
--
--    {hours}       Mon-Fri 10:00-19:00 · Sat 10:00-17:00 · Sun closed
--    {presence}    Open now · until 19:00 IST
--    {focusAreas}  the six areas, listed
--    {email}       her contact address
--    {replyWindow} "one working day"
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.knowledge (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Matches an intent id in rules/nlu.js.
  intent     text NOT NULL,
  -- How to name this topic back to a visitor when two intents are
  -- too close to separate: "did you mean the fee or where she is?"
  label      text NOT NULL,
  answer     text NOT NULL,

  active     boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live answer per intent; superseded ones stay for the record.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_intent_active
  ON crm.knowledge (intent) WHERE active;

-- ============================================================
--  crm.phrasings — the ways people actually ask
--
--  Additive only. The regexes in rules/nlu.js stay as the floor;
--  these are extra evidence on top, so a bad row can make the desk
--  recognise something it otherwise would not, but can never stop
--  it recognising what it already does. That asymmetry is
--  deliberate — this table is edited by hand, and a typo in it
--  should not be able to break the desk.
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.phrasings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent     text NOT NULL,
  -- Matched as a whole phrase, lowercased. Not a regex: this field
  -- is edited from a web form, and one stray bracket in a regex
  -- would throw on every message the desk received.
  phrase     text NOT NULL,
  -- seed | crm | missed  — where it came from, so the ones she added
  -- after a real visitor was misread can be told from the originals.
  source     text NOT NULL DEFAULT 'crm',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS phrasings_unique
  ON crm.phrasings (lower(phrase));

CREATE INDEX IF NOT EXISTS phrasings_intent_idx ON crm.phrasings (intent);

-- ============================================================
--  crm.unrecognised — what the desk could not place
--
--  The message only, never who sent it. This table exists to be
--  READ by a human, and a list of questions is useful without any
--  of the people attached to it. `seen` count rather than one row
--  per occurrence, so the thing forty people asked sorts above the
--  thing one person did.
-- ============================================================
CREATE TABLE IF NOT EXISTS crm.unrecognised (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalised, so "What are your HOURS?!" and "what are your hours"
  -- are one row with a count of two rather than two rows of one.
  text       text NOT NULL,
  seen       integer NOT NULL DEFAULT 1,
  -- Set once she has dealt with it, so the list is a queue that
  -- empties rather than a log that only grows.
  resolved   boolean NOT NULL DEFAULT false,
  first_at   timestamptz NOT NULL DEFAULT now(),
  last_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS unrecognised_text ON crm.unrecognised (text);

CREATE INDEX IF NOT EXISTS unrecognised_queue_idx
  ON crm.unrecognised (seen DESC, last_at DESC) WHERE NOT resolved;

-- ============================================================
--  Seed: the answers that were living in flow.js
--
--  Word for word, so nothing a visitor sees changes today. What
--  changes is that she can edit them.
-- ============================================================
INSERT INTO crm.knowledge (intent, label, answer) VALUES
  ('services', 'what she works with',
   'She works with {focusAreas}.

It''s medical nutrition therapy, built around your labs, your routine and the food you actually eat.'),

  ('process', 'how the sessions run',
   'You send a request here with a few times that suit you. She replies personally — usually within {replyWindow} — confirms one of them, and takes it from there.

The first session is the long one: history, labs, lifestyle and goals, before any plan exists.'),

  ('hours', 'opening hours',
   'Consultation hours are {hours}. {presence}.'),

  ('fees', 'the fee',
   'Fees depend on which programme suits you, so she sets them out herself rather than my quoting a number that turns out to be wrong. Send a request and she''ll cover it in her reply.'),

  ('location', 'where she is',
   'Both — video call, phone, or in person. Most people outside the city choose video, and it works just as well. You can tell me which you''d prefer when I take your details.'),

  ('mode', 'video, phone or in person',
   'Both — video call, phone, or in person. Most people outside the city choose video, and it works just as well. You can tell me which you''d prefer when I take your details.'),

  ('duration', 'how long a session takes',
   'The first consultation runs longest, because it covers your history and labs properly. Follow-ups are shorter. She''ll confirm the timing when she replies.'),

  ('about', 'about Khadija',
   'Khadija is a clinical dietitian and sports nutritionist. She takes on a limited number of clients so each one gets real attention — which is why this is by appointment.'),

  ('human', 'speaking to a person',
   'I''m the front desk — software, not Khadija. I take your details and find a time; she reads every request herself and replies personally.

If you''d rather skip me entirely, email {email} and she''ll pick it up directly.')
ON CONFLICT DO NOTHING;
