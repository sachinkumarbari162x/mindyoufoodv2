-- ============================================================
-- TEST DATA — a working day for Today and the Consulting Room
-- ------------------------------------------------------------
--   psql "$DATABASE_URL" -f services/go-data/db/seed/today_and_room.sql
--
-- NOT A MIGRATION. It lives outside db/migrations on purpose: the
-- Go service embeds that directory and applies it on boot with a
-- checksum guard, so anything dropped in there would run against
-- the real database whether anybody wanted it or not. This has to
-- be asked for, by name, at a prompt.
--
-- WHAT IT IS FOR. Today and the room only have anything to show
-- when there are confirmed sessions dated today, and there is no
-- quick way to get those by hand: a booking has to be taken,
-- accepted and dated before either page has a subject. This makes
-- that day in one command.
--
-- THE CLOCK IS THE HARD PART. Times are computed from now(), never
-- written down. A fixed "11:00" seeds a page that reads correctly
-- for one hour and wrongly for the other twenty-three — the four
-- outcome buttons only appear on a session that has already begun,
-- so a morning of fixed hours tests nothing after lunch. Two
-- sessions are placed behind now and three ahead of it, so
-- whenever this is run the page has both kinds on it.
--
-- SAFE TO RUN TWICE, AND IT DELETES NOTHING. Every row is keyed on
-- a fixed id and upserted, so a second run re-times the day and
-- leaves everything else where it was. The people are matched on
-- email, so it reuses whoever is already on file rather than
-- growing a second Aisha Khan.
--
-- ONE CAUTION. Three of the five sit on reserved domains that
-- accept no mail (@example.com, @outlook.com here is real but not
-- ours). They are there to fill the list; pressing anything that
-- SENDS on those rows will bounce. The two sessions already begun
-- use deliverable addresses — test the sending path on those.
-- ============================================================

BEGIN;

DO $seed$
DECLARE
  p_aisha  uuid;  p_test uuid;  p_noor uuid;
  p_lena   uuid;  p_rea  uuid;  p_nadia uuid;

  /* Fixed ids, so a re-run updates rather than duplicates. The
     leading 7e57 is there to be recognisable in a table: anything
     starting 7e57 came from this file and nothing else did. */
  c_1 uuid := '7e570001-0000-4000-8000-000000000001';
  c_2 uuid := '7e570001-0000-4000-8000-000000000002';
  c_3 uuid := '7e570001-0000-4000-8000-000000000003';
  c_4 uuid := '7e570001-0000-4000-8000-000000000004';
  c_5 uuid := '7e570001-0000-4000-8000-000000000005';
  c_6 uuid := '7e570001-0000-4000-8000-000000000006';
  c_7 uuid := '7e570001-0000-4000-8000-000000000007';
  c_8 uuid := '7e570001-0000-4000-8000-000000000008';

  a_follow uuid := '7e570002-0000-4000-8000-000000000001';
  s_past   uuid := '7e570003-0000-4000-8000-000000000001';

  -- Today, midnight, in the practice's own reckoning. current_date
  -- is a date; adding an interval to it resolves in the session
  -- timezone, which is what every page reads by.
  midnight timestamptz := current_date;
  t_a timestamptz; t_b timestamptz;
  t_c timestamptz; t_d timestamptz; t_e timestamptz;
BEGIN

  /* ---- who is coming ------------------------------------------
     ON CONFLICT ... DO UPDATE rather than DO NOTHING, because
     DO NOTHING returns no row and then there is no id to book
     against. COALESCE the way the real upsert does, so a re-run
     never blanks a detail somebody has typed in since. */

  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Aisha Khan', 'brownodinsaas@gmail.com', '+919876543210', '1992-04-18', 'IN', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    phone        = COALESCE(crm.people.phone, EXCLUDED.phone),
    dob          = COALESCE(crm.people.dob, EXCLUDED.dob),
    country_iso2 = COALESCE(crm.people.country_iso2, EXCLUDED.country_iso2),
    updated_at   = now()
  RETURNING id INTO p_aisha;

  -- Resend's own sink address: it accepts mail and delivers it
  -- nowhere, which is exactly what a second sendable row should be.
  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Test Client', 'delivered@resend.dev', '+919999000111', '1988-11-02', 'IN', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    phone        = COALESCE(crm.people.phone, EXCLUDED.phone),
    country_iso2 = COALESCE(crm.people.country_iso2, EXCLUDED.country_iso2),
    updated_at   = now()
  RETURNING id INTO p_test;

  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Noor Aziz', 'noor.aziz@gmail.com', '+966501234567', '1979-02-09', 'SA', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    dob = COALESCE(crm.people.dob, EXCLUDED.dob), updated_at = now()
  RETURNING id INTO p_noor;

  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Lena Marsh', 'lena.marsh@outlook.com', '+447700900999', '1965-07-30', 'GB', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    dob = COALESCE(crm.people.dob, EXCLUDED.dob), updated_at = now()
  RETURNING id INTO p_lena;

  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Rea Sharma', 'rea.sharma@example.com', '+919812345678', '2001-01-22', 'IN', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    phone      = COALESCE(crm.people.phone, EXCLUDED.phone),
    dob        = COALESCE(crm.people.dob, EXCLUDED.dob),
    updated_at = now()
  RETURNING id INTO p_rea;

  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Nadia Hussain', 'nadia.hussain@example.com', '+447700900456', '1984-06-11', 'GB', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    dob = COALESCE(crm.people.dob, EXCLUDED.dob), updated_at = now()
  RETURNING id INTO p_nadia;

  /* ---- when ---------------------------------------------------
     Two behind now, three ahead, both ends clamped inside today so
     a session never leaks onto yesterday's page or tomorrow's.

     Run this late in the evening and the clamp bites: the three
     "ahead" ones land on the last hours of the day and may already
     have passed. That is a duller day to look at, not a broken one
     — every row is still a valid confirmed session dated today. */
  t_a := greatest(midnight + interval '5 minutes',
                  date_trunc('minute', now()) - interval '95 minutes');
  t_b := greatest(midnight + interval '20 minutes',
                  date_trunc('minute', now()) - interval '20 minutes');
  t_c := least(midnight + interval '20 hours', date_trunc('hour', now()) + interval '2 hours');
  t_d := least(midnight + interval '21 hours', date_trunc('hour', now()) + interval '4 hours');
  t_e := least(midnight + interval '22 hours', date_trunc('hour', now()) + interval '6 hours');

  /* ---- the day ------------------------------------------------
     Five confirmed sessions dated today. The mode varies on
     purpose: it decides how she reaches them from the row, and an
     in-person booking is the case where a video room would be the
     wrong thing to offer. */

  INSERT INTO crm.consultations
    (id, person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
     timezone, confirmed_at, notes)
  VALUES
    (c_1, p_aisha, 'PCOS & hormonal health', 'video', 'confirmed',
     t_a, t_a + interval '60 minutes', 'Asia/Kolkata', now(),
     'Follow-up. Third visit — bloods came back last week.'),
    (c_2, p_test, 'Weight management', 'audio', 'confirmed',
     t_b, t_b + interval '60 minutes', 'Asia/Kolkata', now(),
     'First visit. Asked to be rung rather than seen on video.'),
    (c_3, p_noor, 'Diabetes care', 'video', 'confirmed',
     t_c, t_c + interval '60 minutes', 'Asia/Kolkata', now(),
     'First visit. HbA1c 7.4 in June.'),
    (c_4, p_lena, 'Gut health', 'in_person', 'confirmed',
     t_d, t_d + interval '60 minutes', 'Asia/Kolkata', now(),
     'Coming to the clinic. No room needed.'),
    (c_5, p_rea, 'Weight management', 'video', 'confirmed',
     t_e, t_e + interval '60 minutes', 'Asia/Kolkata', now(),
     'Follow-up.')
  ON CONFLICT (id) DO UPDATE SET
    person_id          = EXCLUDED.person_id,
    mode               = EXCLUDED.mode,
    status             = 'confirmed',
    scheduled_start_at = EXCLUDED.scheduled_start_at,
    scheduled_end_at   = EXCLUDED.scheduled_end_at,
    confirmed_at       = COALESCE(crm.consultations.confirmed_at, EXCLUDED.confirmed_at),
    updated_at         = now();

  /* One left over from an earlier day with nothing said about it.
     This is the whole point of the overdue panel — a session that
     fell off the end of Wednesday and never got answered for — and
     the panel hides itself when empty, so without a row like this
     it can never be looked at. */
  INSERT INTO crm.consultations
    (id, person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
     timezone, confirmed_at, notes)
  VALUES
    (c_6, p_nadia, 'Gut health', 'video', 'confirmed',
     midnight - interval '2 days' + interval '11 hours',
     midnight - interval '2 days' + interval '12 hours', 'Asia/Kolkata', now(),
     'Nobody has said what became of this one.')
  ON CONFLICT (id) DO UPDATE SET
    status             = 'confirmed',
    scheduled_start_at = EXCLUDED.scheduled_start_at,
    scheduled_end_at   = EXCLUDED.scheduled_end_at,
    updated_at         = now();

  /* And two still waiting on her, so Requests is not empty either.
     They carry no hour: a request is a request until she gives it
     one, and the slot index only guards rows that have a time. */
  INSERT INTO crm.consultations
    (id, person_id, issue, mode, status, timezone, notes)
  VALUES
    (c_7, p_rea, 'PCOS & hormonal health', 'video', 'held', 'Asia/Kolkata',
     'Came in through the desk this morning.'),
    (c_8, p_noor, 'Gut health', 'undecided', 'held', 'Asia/Kolkata',
     'Has not said how they would like to be seen.')
  ON CONFLICT (id) DO UPDATE SET
    status     = 'held',
    updated_at = now();

  /* ---- the way in ---------------------------------------------
     One opaque token per video session, minted exactly the way Go
     mints them: 24 random bytes, base64url, padding trimmed. The
     token is the only thing that ever travels — it is what goes
     into a WhatsApp message — and the consultation's own id never
     leaves the building.

     ON CONFLICT keeps whatever token was already handed out. A
     re-run that reissued tokens would silently kill a link
     somebody is already holding. */
  INSERT INTO crm.consultation_links (token, consultation_id, purpose, expires_at)
  SELECT
    replace(replace(rtrim(encode(gen_random_bytes(24), 'base64'), '='), '+', '-'), '/', '_'),
    c.id, 'consultation', c.scheduled_start_at + interval '24 hours'
    FROM crm.consultations c
   WHERE c.id IN (c_1, c_3, c_5)
  ON CONFLICT (consultation_id, purpose) DO UPDATE
     SET expires_at = EXCLUDED.expires_at;

  /* ---- what she reads beside the call --------------------------
     The room embeds the assessment for whoever is in it, so an
     empty record makes the right-hand half of that page prove
     nothing. Aisha already has a finalised first visit and an
     amendment on it — this fills both out and adds today's
     follow-up draft, which is the one the room opens.

     TREND FIELDS ARE NOT WRITTEN HERE. Weight, height, waist and
     the rest are rows in crm.measurements, and the API folds them
     back into the form on the way out. Putting them in the answers
     document as well would make two copies of a weight that
     disagree the moment one of them is corrected. */

  UPDATE crm.assessments SET answers = answers || jsonb_build_object(
      'sex', 'Female',
      'occupation', 'Software tester, mostly desk-bound, 10 to 7',
      'language', 'English / Hindi',
      'referral', 'Found the site herself',
      'reason', 'Periods all over the place for about two years, and the weight has crept up with them. Wants to know whether food can do anything about it before she agrees to go on anything.',
      'conditions', 'PCOS, confirmed on ultrasound March 2026. Nothing else.',
      'family_history', 'Mother type 2 diabetic from her late forties. Father hypertensive.',
      'medications', 'None at present. Declined metformin for now.',
      'supplements', 'Vitamin D 60,000 IU weekly, started by her GP.',
      'food_allergies', 'None known.',
      'bp', '118/76',
      'appetite', 'Variable',
      'bowels', 'Every other day, harder than she would like.',
      'recall_24h', 'Tea on waking. Two parathas around 10 once she is at her desk. Rice, dal and a dry sabzi at 2. Biscuits with tea at 5, usually four or five. Roti and whatever is left over at 9.30.',
      'meal_pattern', 'Three, but breakfast is late and dinner is later.',
      'fluid', 'About 1.2 litres, mostly tea.',
      'caffeine', 'Five cups of milk tea.',
      'snacking', 'The evening biscuits are automatic — she does not decide to have them.',
      'pattern', 'Vegetarian',
      'cultural', 'No onion or garlic on Tuesdays.',
      'activity', 'Nothing structured. About 3,000 steps on a working day.',
      'sleep', 'Six hours, and broken.',
      'stress', 'High through releases, which is most months.',
      'smoking', 'Never',
      'readiness', '7',
      'barriers', 'Long hours, and a canteen with very little in it.',
      'pes_problem', 'Excessive carbohydrate intake in relation to activity',
      'pes_etiology', 'related to irregular meal timing, a long sedentary working day, and habitual evening snacking',
      'pes_signs', 'as evidenced by a 24-hour recall showing four refined-carbohydrate occasions, weight 68 kg at BMI 25.9, and waist 84 cm',
      'consent', 'Yes',
      'dietitian', 'Khadija'
    ),
    notes = 'She is doing this on her own terms and has read a great deal already. Do not start from first principles with her.'
   WHERE ref = 'aishakhan0_0';

  /* The amendment. It says the SAME visit corrected — one figure
     was wrong and the plan was never written out — which is what
     makes old-copy-beside-amended-copy worth looking at.

     IT CARRIES THE WHOLE DOCUMENT, not the corrections alone. That
     is what the real amend does, and it is the point of the format:
     each version has to be a complete statement of the visit, or
     the older copy becomes required reading to understand the newer
     one and neither can be quoted on its own. So the first copy's
     answers are laid down first and the changes go on top.

     Marked final, so the pair reads the way her record actually
     would: two settled copies of visit one, and today's follow-up
     the only thing still open. */
  UPDATE crm.assessments SET
    status = 'final',
    finalised_at = COALESCE(finalised_at, now() - interval '28 days'),
    answers = COALESCE((SELECT prev.answers FROM crm.assessments prev
                         WHERE prev.ref = 'aishakhan0_0'), '{}'::jsonb)
              || answers || jsonb_build_object(
      'sex', 'Female',
      'reason', 'Periods all over the place for about two years, and the weight has crept up with them. Wants to know whether food can do anything about it before she agrees to go on anything.',
      'bp', '124/80',
      'pes_problem', 'Excessive carbohydrate intake in relation to activity',
      'pes_etiology', 'related to irregular meal timing, a long sedentary working day, and habitual evening snacking',
      'pes_signs', 'as evidenced by a 24-hour recall showing four refined-carbohydrate occasions, weight 66.5 kg at BMI 25.3, and waist 82 cm',
      'prescription', '1,500 kcal, 90 g protein, carbohydrate spread across four occasions rather than three.',
      'diet_type', 'Low glycaemic index, vegetarian',
      'food_recs', 'A protein at breakfast. Roasted chana in the desk drawer instead of biscuits. Curd at lunch.',
      'education', 'Glycaemic load, and why the five o''clock biscuits cost more than the rice does.',
      'counselling', 'Motivational interviewing',
      'progress', 'Down 1.5 kg and 2 cm at the waist since the first visit.',
      'follow_up', to_char(current_date + 28, 'YYYY-MM-DD')
    ),
    notes = 'Amended: the blood pressure on the first copy was the reading taken before she had sat down. Corrected, and the plan written out properly.'
   WHERE ref = 'aishakhan0_1';

  /* Today's follow-up — a draft, opened against today's session, so
     the room has something live to write into. */
  INSERT INTO crm.assessments
    (id, person_id, consultation_id, visit, amendment, ref, kind, status,
     answers, open_sections, notes, recorded_by, started_at)
  VALUES
    (a_follow, p_aisha, c_1, 1, 0, 'aishakhan1_0', 'follow_up', 'draft',
     jsonb_build_object(
       'sex', 'Female',
       'reason', 'Third visit. Bloods are back and she wants to go through them.',
       'appetite', 'Good',
       'progress', 'Kept the breakfast protein most days. The five o''clock biscuits are still winning on release weeks.'
     ),
     '["intake","anthro","medical","gi","diet","pes"]'::jsonb,
     '', 'khadija@mindyourfood.co.in', now() - interval '10 minutes')
  ON CONFLICT (id) DO UPDATE SET
    consultation_id = EXCLUDED.consultation_id,
    status          = 'draft',
    updated_at      = now();

  /* Today's figures for that draft, and the labs behind the visit.
     Fixed ids again: a measurement has no natural key — the same
     person can weigh the same twice — so without one a re-run would
     stack duplicate points on the curve. */
  INSERT INTO crm.measurements (id, person_id, assessment_id, kind, metric, value, unit, method, ref_low, ref_high, taken_at)
  VALUES
    ('7e570004-0000-4000-8000-000000000001', p_aisha, a_follow, 'body', 'weight_kg',    65.2, 'kg',    'Clinic scale', NULL, NULL, now()),
    ('7e570004-0000-4000-8000-000000000002', p_aisha, a_follow, 'body', 'height_cm',   162,   'cm',    'Stadiometer',  NULL, NULL, now()),
    ('7e570004-0000-4000-8000-000000000003', p_aisha, a_follow, 'body', 'waist_cm',     80,   'cm',    'Tape',         NULL, NULL, now()),
    ('7e570004-0000-4000-8000-000000000004', p_aisha, a_follow, 'body', 'hip_cm',       97,   'cm',    'Tape',         NULL, NULL, now()),
    ('7e570004-0000-4000-8000-000000000005', p_aisha, a_follow, 'body', 'body_fat_pct', 31.4, '%',     'Bioimpedance', NULL, NULL, now()),
    ('7e570004-0000-4000-8000-000000000006', p_aisha, a_follow, 'lab',  'hba1c',         5.8, '%',     'Venous',        4.0,   5.6, now() - interval '6 days'),
    ('7e570004-0000-4000-8000-000000000007', p_aisha, a_follow, 'lab',  'vitamin_d',    28,   'ng/mL', 'Venous',       30,   100,  now() - interval '6 days'),
    ('7e570004-0000-4000-8000-000000000008', p_aisha, a_follow, 'lab',  'tsh',           2.1, 'mIU/L', 'Venous',        0.4,   4.0, now() - interval '6 days')
  ON CONFLICT (id) DO UPDATE SET
    value = EXCLUDED.value, unit = EXCLUDED.unit, taken_at = EXCLUDED.taken_at;

  /* The goals she left with last time. They outlive the visit that
     set them, which is why they are rows rather than a paragraph
     inside one assessment. */
  INSERT INTO crm.goals (person_id, set_at_assessment_id, kind, goal, target_metric, target_value, due_on, status)
  SELECT p_aisha, a.id, g.kind, g.goal, g.metric, g.target, current_date + g.days, 'active'
    FROM crm.assessments a,
         (VALUES
            ('behavioural', 'A protein at breakfast, five mornings a week', NULL::text, NULL::numeric, 14),
            ('behavioural', 'Roasted chana in the desk drawer instead of biscuits', NULL, NULL, 14),
            ('short_term',  'Walk 6,000 steps on working days', NULL, NULL, 28),
            ('long_term',   'Down to 62 kg', 'weight_kg', 62, 120)
         ) AS g(kind, goal, metric, target, days)
   WHERE a.ref = 'aishakhan0_1'
     AND NOT EXISTS (SELECT 1 FROM crm.goals x WHERE x.person_id = p_aisha AND x.goal = g.goal);

  /* A second record with something in it, so the room is never
     only ever tested against one person. Left as a draft on
     purpose — that is the state most records are in mid-clinic. */
  UPDATE crm.assessments SET answers = answers || jsonb_build_object(
      'sex', 'Male',
      'occupation', 'Retired teacher',
      'reason', 'Sugars have been climbing since the winter and he would rather fix it with food than add a second tablet.',
      'conditions', 'Type 2 diabetes, nine years. Hypertension.',
      'medications', 'Metformin 1 g twice daily. Amlodipine 5 mg.',
      'bp', '138/84',
      'appetite', 'Good',
      'recall_24h', 'Dates and Arabic coffee on waking. Foul and bread mid-morning. Rice with lamb at 2. Fruit at 6. Bread and cheese at 10.',
      'meal_pattern', 'Late, and the last one is very late.',
      'pattern', 'Omnivore',
      'activity', 'Walks after Maghrib most evenings, about 25 minutes.',
      'readiness', '9'
    ),
    notes = 'No interpreter needed. Prefers everything written down to take home.'
   WHERE ref = 'nooraziz0_0';

  /* ---- what happened in the room last time ---------------------
     One ended session with both sides recorded, so the room's own
     history is not empty and the participants table has a shape to
     read. THE ROOM NAME IS THE CONSULTATION ID — that is what the
     signalling hub keys on. 'ended' matters too: the one-open-per-
     room index would refuse a live session on the same booking, and
     that is the session she is about to start today. */
  INSERT INTO crm.room_sessions (id, room, consultation_id, state, started_at, ended_at, started_by, source)
  VALUES (s_past, c_1::text, c_1, 'ended',
          now() - interval '31 days',
          now() - interval '31 days' + interval '52 minutes',
          'khadija@mindyourfood.co.in', 'system')
  ON CONFLICT (id) DO UPDATE SET
    state = 'ended', ended_at = EXCLUDED.ended_at;

  INSERT INTO crm.room_participants (id, session_id, side, joined_at, left_at, connection)
  VALUES
    ('7e570005-0000-4000-8000-000000000001', s_past, 'host',
     now() - interval '31 days' - interval '2 minutes',
     now() - interval '31 days' + interval '52 minutes', 'direct'),
    ('7e570005-0000-4000-8000-000000000002', s_past, 'client',
     now() - interval '31 days' + interval '1 minute',
     now() - interval '31 days' + interval '51 minutes', 'direct')
  ON CONFLICT (id) DO UPDATE SET
    left_at = EXCLUDED.left_at, connection = EXCLUDED.connection;

  RAISE NOTICE 'today seeded: % / % / % / % / %', t_a, t_b, t_c, t_d, t_e;
END
$seed$;

COMMIT;

-- What was made, and the link to open the client side with.
SELECT to_char(c.scheduled_start_at, 'HH24:MI') AS at,
       p.name,
       c.mode,
       CASE WHEN c.scheduled_start_at <= now() THEN 'begun' ELSE 'to come' END AS state,
       /* /c/<token>, not ?t= — a path, because that is what the
          client page reads and what a dynamic URL button appends to. */
       COALESCE('/c/' || l.token, '—') AS client_link
  FROM crm.consultations c
  JOIN crm.people p ON p.id = c.person_id
  LEFT JOIN crm.consultation_links l ON l.consultation_id = c.id
 WHERE c.scheduled_start_at::date = current_date
   AND c.status = 'confirmed'
 ORDER BY c.scheduled_start_at;
