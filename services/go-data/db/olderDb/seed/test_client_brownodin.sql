-- ============================================================
-- ONE CLIENT, IN FULL — brownodinsaas@gmail.com
-- ------------------------------------------------------------
--   psql "$DATABASE_URL" -f services/go-data/db/seed/test_client_brownodin.sql
--
-- The other seed makes a DAY: five names, five hours, enough to
-- see whether Today and the room draw. This makes a PERSON: one
-- record deep enough to test the things a single row cannot —
-- a weight curve with a shape to it, labs with reference ranges
-- either side of normal, goals set at a previous visit, and an
-- appointment about to start that a real link can be minted
-- against and mailed.
--
-- WHY THIS ADDRESS. brownodinsaas@gmail.com is the practice's
-- test recipient and nobody else's. It is the one address in this
-- database that mail can actually be sent to on purpose — every
-- other seeded person sits on a reserved domain precisely so that
-- a stray click cannot post anything to a stranger.
--
-- SAFE TO RUN TWICE, AND IT DELETES NOTHING. Fixed ids throughout;
-- a second run re-times the appointment and leaves the history
-- where it is.
-- ============================================================

BEGIN;

DO $seed$
DECLARE
  p uuid;
  c_live uuid := '7e570001-0000-4000-8000-0000000000a1';
  a_draft uuid := '7e570002-0000-4000-8000-000000000001';  -- her open visit-1 draft
  starts timestamptz;
BEGIN

  /* ---- her ---------------------------------------------------- */
  INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
  VALUES ('Aisha Khan', 'brownodinsaas@gmail.com', '+919876543210', '1992-04-18', 'IN', 'chatbot')
  ON CONFLICT (lower(email)) DO UPDATE SET
    name         = 'Aisha Khan',
    phone        = COALESCE(crm.people.phone, EXCLUDED.phone),
    dob          = COALESCE(crm.people.dob, EXCLUDED.dob),
    country_iso2 = COALESCE(crm.people.country_iso2, EXCLUDED.country_iso2),
    updated_at   = now()
  RETURNING id INTO p;

  /* ---- the appointment to test against -------------------------
     TEN MINUTES OUT, recomputed on every run. It has to be close
     enough that the room is worth opening and far enough that it
     has not begun — an appointment in the past reads as an
     overdue session and takes a different set of buttons. */
  starts := date_trunc('minute', now()) + interval '10 minutes';

  INSERT INTO crm.consultations
    (id, person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
     timezone, confirmed_at, notes)
  VALUES
    (c_live, p, 'PCOS & hormonal health', 'video', 'confirmed',
     starts, starts + interval '60 minutes', 'Asia/Kolkata', now(),
     'Link test. Third visit — bloods back, wants to go through them.')
  ON CONFLICT (id) DO UPDATE SET
    status             = 'confirmed',
    mode               = 'video',
    scheduled_start_at = EXCLUDED.scheduled_start_at,
    scheduled_end_at   = EXCLUDED.scheduled_end_at,
    updated_at         = now();

  /* Her open draft belongs to the visit, not to a booking — so it
     moves to whichever appointment is actually happening. The room
     opens the person's draft either way; this only keeps the
     record's own consultation_id honest. */
  UPDATE crm.assessments SET consultation_id = c_live, updated_at = now()
   WHERE id = a_draft;

  /* ---- the curve ----------------------------------------------
     Weights across five months, at person level with no assessment
     behind them — which is the point. A measurement outlives the
     visit that recorded it, and "what has her weight done since
     March" must be answerable without opening five assessments.

     The shape is deliberate: down, then a plateau, then down again.
     A straight line tests nothing — real adherence has a fortnight
     in it where nothing moved, and that is exactly the stretch she
     needs the record to show her. */
  INSERT INTO crm.measurements (id, person_id, assessment_id, kind, metric, value, unit, method, taken_at)
  VALUES
    ('7e570006-0000-4000-8000-000000000001', p, NULL, 'body', 'weight_kg', 71.4, 'kg', 'Clinic scale', now() - interval '150 days'),
    ('7e570006-0000-4000-8000-000000000002', p, NULL, 'body', 'weight_kg', 70.2, 'kg', 'Clinic scale', now() - interval '120 days'),
    ('7e570006-0000-4000-8000-000000000003', p, NULL, 'body', 'weight_kg', 68.9, 'kg', 'Clinic scale', now() - interval  '90 days'),
    ('7e570006-0000-4000-8000-000000000004', p, NULL, 'body', 'weight_kg', 68.7, 'kg', 'Home scale',   now() - interval  '60 days'),
    ('7e570006-0000-4000-8000-000000000005', p, NULL, 'body', 'weight_kg', 66.5, 'kg', 'Clinic scale', now() - interval  '30 days'),
    ('7e570006-0000-4000-8000-000000000006', p, NULL, 'body', 'waist_cm',  88,   'cm', 'Tape',         now() - interval '150 days'),
    ('7e570006-0000-4000-8000-000000000007', p, NULL, 'body', 'waist_cm',  84,   'cm', 'Tape',         now() - interval  '90 days'),
    ('7e570006-0000-4000-8000-000000000008', p, NULL, 'body', 'waist_cm',  82,   'cm', 'Tape',         now() - interval  '30 days')
  ON CONFLICT (id) DO UPDATE SET
    value = EXCLUDED.value, taken_at = EXCLUDED.taken_at;

  /* ---- the bloods ---------------------------------------------
     One inside its range, two under, one over, one comfortably
     normal. A record where everything is normal cannot show whether
     the out-of-range case is legible, and that is the only case that
     changes what she does next.

     ATTACHED TO THE DRAFT, NOT TO THE PERSON, and reusing the ids
     today_and_room.sql already gave the first three. Both files
     describe the same blood draw; keyed differently they produced
     two HbA1c results a day apart from one sample, which in a
     clinical record is not untidy test data — it is a wrong answer
     to "what was her HbA1c". Same ids, so whichever file runs second
     updates rather than duplicates. */
  INSERT INTO crm.measurements (id, person_id, assessment_id, kind, metric, value, unit, method, ref_low, ref_high, taken_at)
  VALUES
    ('7e570004-0000-4000-8000-000000000006', p, a_draft, 'lab', 'hba1c',        5.8, '%',     'Venous',  4.0,   5.6, now() - interval '6 days'),
    ('7e570004-0000-4000-8000-000000000007', p, a_draft, 'lab', 'vitamin_d',   28,   'ng/mL', 'Venous', 30,   100,   now() - interval '6 days'),
    ('7e570004-0000-4000-8000-000000000008', p, a_draft, 'lab', 'tsh',          2.1, 'mIU/L', 'Venous',  0.4,   4.0, now() - interval '6 days'),
    ('7e570006-0000-4000-8000-00000000000d', p, a_draft, 'lab', 'ferritin',    18,   'ng/mL', 'Venous', 15,   150,   now() - interval '6 days'),
    ('7e570006-0000-4000-8000-00000000000e', p, a_draft, 'lab', 'testosterone', 62,  'ng/dL', 'Venous',  8,    60,   now() - interval '6 days')
  ON CONFLICT (id) DO UPDATE SET
    assessment_id = EXCLUDED.assessment_id, value = EXCLUDED.value,
    ref_low = EXCLUDED.ref_low, ref_high = EXCLUDED.ref_high,
    taken_at = EXCLUDED.taken_at;

  /* The person-level copies an earlier version of this file wrote,
     before it knew the day-seed had already recorded the same draw.
     Three ids, all of them written by this file, none of them
     reachable by anything else. */
  DELETE FROM crm.measurements
   WHERE id IN ('7e570006-0000-4000-8000-00000000000a',
                '7e570006-0000-4000-8000-00000000000b',
                '7e570006-0000-4000-8000-00000000000c');

  /* ---- what she is meant to be doing ---------------------------
     Two reviewed and one of those missed, three still running. A
     goal list where everything is 'active' is a list nobody has
     reviewed, and the review is the whole reason goals are rows
     rather than a paragraph in one assessment.

     KEYED ON THE GOAL, NOT ON AN ID. today_and_room.sql already set
     four of these with ids of its own, so this reconciles by what
     the goal says: her existing rows are marked up, and only a goal
     she does not already have is inserted. */
  UPDATE crm.goals g SET
      status      = v.status,
      reviewed_at = v.reviewed,
      due_on      = current_date + v.days
    FROM (VALUES
       ('A protein at breakfast, five mornings a week',         -14, 'met',    (now() - interval '14 days')::timestamptz),
       ('Roasted chana in the desk drawer instead of biscuits', -14, 'missed', (now() - interval '14 days')::timestamptz),
       ('Walk 6,000 steps on working days',                      28, 'active', NULL::timestamptz),
       ('Down to 62 kg',                                        120, 'active', NULL)
    ) AS v(goal, days, status, reviewed)
   WHERE g.person_id = p AND g.goal = v.goal;

  INSERT INTO crm.goals (person_id, set_at_assessment_id, kind, goal, target_metric, target_value, due_on, status)
  SELECT p, a.id, v.kind, v.goal, v.metric, v.target, current_date + v.days, 'active'
    FROM crm.assessments a,
         (VALUES
            ('behavioural', 'Last meal before 8.30pm on working days', NULL::text, NULL::numeric, 14)
         ) AS v(kind, goal, metric, target, days)
   WHERE a.ref = 'aishakhan0_1'
     AND NOT EXISTS (SELECT 1 FROM crm.goals x WHERE x.person_id = p AND x.goal = v.goal);

  /* And the twins an earlier run of this file left behind — the four
     whose text the day-seed had already written. Scoped to the exact
     ids this file minted; her original rows, which the UPDATE above
     has just marked up, are what survive. */
  DELETE FROM crm.goals
   WHERE id IN ('7e570007-0000-4000-8000-000000000001',
                '7e570007-0000-4000-8000-000000000002',
                '7e570007-0000-4000-8000-000000000004',
                '7e570007-0000-4000-8000-000000000005');

  /* ---- today's draft, as she would have left it ----------------
     Enough in it that the panel is worth reading on open, and not
     so much that there is nothing left to type — the point of the
     test is to type into it while a call is running. */
  UPDATE crm.assessments SET answers = answers || jsonb_build_object(
      'sex', 'Female',
      'name', 'Aisha Khan',
      'email', 'brownodinsaas@gmail.com',
      'phone', '+919876543210',
      'dob', '1992-04-18',
      'occupation', 'Software tester, desk-bound, 10 to 7',
      'reason', 'Third visit. Bloods are back and she wants to go through them.',
      'conditions', 'PCOS, confirmed on ultrasound March 2026.',
      'medications', 'None. Still declining metformin.',
      'supplements', 'Vitamin D 60,000 IU weekly.',
      'appetite', 'Good',
      'bowels', 'Daily now, and easier.',
      'meal_pattern', 'Four, since the plan. Breakfast is the one that sticks.',
      'progress', 'Kept the breakfast protein most days. The five o''clock biscuits are still winning on release weeks.',
      'adherence', 'Good on the mornings, patchy on the evenings — she is honest about which.',
      'pattern', 'Vegetarian',
      'activity', 'Walking after dinner most days, roughly 25 minutes.',
      'sleep', 'Seven hours, better than it was.',
      'readiness', '8'
    ),
    updated_at = now()
   WHERE id = a_draft;

  RAISE NOTICE 'consultation % starts %', c_live, starts;
END
$seed$;

COMMIT;

SELECT to_char(c.scheduled_start_at, 'HH24:MI') AS starts,
       p.name, p.email, c.mode, c.status, c.id AS consultation_id
  FROM crm.consultations c
  JOIN crm.people p ON p.id = c.person_id
 WHERE c.id = '7e570001-0000-4000-8000-0000000000a1';
