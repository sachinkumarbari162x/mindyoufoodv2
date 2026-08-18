-- ============================================================
--  PRACTICE DIARY — three months behind, a fortnight ahead
-- ------------------------------------------------------------
--  Runs after practice_reset.sql, which clears the tables and
--  writes the people these sessions belong to.
--
--  AT THE HOURS SHE ACTUALLY WORKS: 11:00–19:00 on weekdays,
--  10:00–17:00 on Saturday, IST, sixty minutes each, three a day
--  at most. Those are the settings the desk offers slots from, so
--  a diary that ignored them would make every screen disagree
--  with the booking engine.
--
--  Stored UTC. IST is +5:30, so 11:00 in the room is 05:30 in the
--  column — written as the UTC time rather than with a timezone
--  literal, so what is in the database is unambiguous.
--
--  IT IS NOT A TIDY WEEK. Somebody does not come. Somebody
--  cancels the evening before. Yesterday's session has no outcome
--  recorded, so it sits on Today asking to be written up — which
--  is the duty that stops those buttons being optional. Four
--  requests are waiting. A screen that only ever shows the happy
--  path has never been tested.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO crm.consultations
  (id, person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
   confirmed_at, timezone, notes, created_at)
VALUES
  -- ---- seen, over the last three months ----
  ('c1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','PCOS and hormonal health','video','completed', (current_date - 90)::timestamptz + time '05:30', (current_date - 90)::timestamptz + time '06:30', now() - interval '92 days','Asia/Kolkata','Referred by her gynaecologist.', now() - interval '94 days'),
  ('c1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000002','Weight management','video','completed', (current_date - 84)::timestamptz + time '07:30', (current_date - 84)::timestamptz + time '08:30', now() - interval '86 days','Asia/Kolkata',NULL, now() - interval '88 days'),
  ('c1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000003','Type 2 diabetes','video','completed', (current_date - 77)::timestamptz + time '09:30', (current_date - 77)::timestamptz + time '10:30', now() - interval '79 days','Asia/Muscat','Wants to come off metformin with her GP.', now() - interval '81 days'),
  ('c1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000004','Sports nutrition','video','completed', (current_date - 70)::timestamptz + time '11:30', (current_date - 70)::timestamptz + time '12:30', now() - interval '72 days','Asia/Kolkata','Half marathon in twelve weeks.', now() - interval '76 days'),
  ('c1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000005','IBS and gut health','video','completed', (current_date - 63)::timestamptz + time '05:30', (current_date - 63)::timestamptz + time '06:30', now() - interval '65 days','Asia/Dubai',NULL, now() - interval '70 days'),
  ('c1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000006','Thyroid and fatigue','video','completed', (current_date - 56)::timestamptz + time '07:30', (current_date - 56)::timestamptz + time '08:30', now() - interval '58 days','Asia/Kolkata',NULL, now() - interval '65 days'),

  -- somebody simply did not come
  ('c1000000-0000-4000-8000-000000000007','a1000000-0000-4000-8000-000000000007','Pregnancy nutrition','video','no_show', (current_date - 49)::timestamptz + time '09:30', (current_date - 49)::timestamptz + time '10:30', now() - interval '51 days','Europe/London',NULL, now() - interval '58 days'),

  ('c1000000-0000-4000-8000-000000000008','a1000000-0000-4000-8000-000000000008','Building muscle','video','completed', (current_date - 42)::timestamptz + time '11:30', (current_date - 42)::timestamptz + time '12:30', now() - interval '44 days','Asia/Kolkata','Student — asked about the fee.', now() - interval '52 days'),
  ('c1000000-0000-4000-8000-000000000009','a1000000-0000-4000-8000-000000000009','Cholesterol','video','completed', (current_date - 35)::timestamptz + time '05:30', (current_date - 35)::timestamptz + time '06:30', now() - interval '37 days','Europe/London',NULL, now() - interval '47 days'),

  -- and somebody cancelled the evening before
  ('c1000000-0000-4000-8000-000000000010','a1000000-0000-4000-8000-000000000010','Weight management','video','cancelled', (current_date - 28)::timestamptz + time '07:30', (current_date - 28)::timestamptz + time '08:30', now() - interval '30 days','Asia/Kolkata',NULL, now() - interval '41 days'),

  ('c1000000-0000-4000-8000-000000000011','a1000000-0000-4000-8000-000000000011','Type 2 diabetes','video','completed', (current_date - 21)::timestamptz + time '09:30', (current_date - 21)::timestamptz + time '10:30', now() - interval '23 days','Asia/Riyadh',NULL, now() - interval '36 days'),
  ('c1000000-0000-4000-8000-000000000012','a1000000-0000-4000-8000-000000000012','Bone health after menopause','in_person','completed', (current_date - 14)::timestamptz + time '05:30', (current_date - 14)::timestamptz + time '06:30', now() - interval '16 days','Asia/Kolkata',NULL, now() - interval '30 days'),
  ('c1000000-0000-4000-8000-000000000013','a1000000-0000-4000-8000-000000000013','PCOS and hormonal health','video','completed', (current_date - 9)::timestamptz + time '07:30', (current_date - 9)::timestamptz + time '08:30', now() - interval '11 days','Asia/Kolkata',NULL, now() - interval '24 days'),
  ('c1000000-0000-4000-8000-000000000014','a1000000-0000-4000-8000-000000000014','Weight management','video','completed', (current_date - 4)::timestamptz + time '09:30', (current_date - 4)::timestamptz + time '10:30', now() - interval '6 days','Asia/Dubai',NULL, now() - interval '19 days'),

  -- yesterday, and NOT yet written up: this is the one that sits
  -- on Today asking her to say what happened
  ('c1000000-0000-4000-8000-000000000015','a1000000-0000-4000-8000-000000000001','PCOS follow-up','video','completed', (current_date - 1)::timestamptz + time '05:30', (current_date - 1)::timestamptz + time '06:30', now() - interval '9 days','Asia/Kolkata','Twelve-week review.', now() - interval '12 days'),

  -- ---- today ----
  ('c1000000-0000-4000-8000-000000000016','a1000000-0000-4000-8000-000000000015','Iron deficiency','video','confirmed', current_date::timestamptz + time '07:30', current_date::timestamptz + time '08:30', now() - interval '11 days','Asia/Kolkata','Vegetarian. Ferritin 11.', now() - interval '13 days'),
  ('c1000000-0000-4000-8000-000000000017','a1000000-0000-4000-8000-000000000005','IBS follow-up','video','confirmed', current_date::timestamptz + time '09:30', current_date::timestamptz + time '10:30', now() - interval '8 days','Asia/Dubai',NULL, now() - interval '10 days'),

  -- ---- the fortnight ahead ----
  ('c1000000-0000-4000-8000-000000000018','a1000000-0000-4000-8000-000000000016','Weight management','video','confirmed', (current_date + 2)::timestamptz + time '05:30', (current_date + 2)::timestamptz + time '06:30', now() - interval '6 days','Asia/Kolkata',NULL, now() - interval '8 days'),
  ('c1000000-0000-4000-8000-000000000019','a1000000-0000-4000-8000-000000000003','Diabetes review','video','confirmed', (current_date + 3)::timestamptz + time '09:30', (current_date + 3)::timestamptz + time '10:30', now() - interval '5 days','Asia/Muscat',NULL, now() - interval '7 days'),
  ('c1000000-0000-4000-8000-000000000020','a1000000-0000-4000-8000-000000000017','Childhood nutrition','video','confirmed', (current_date + 6)::timestamptz + time '07:30', (current_date + 6)::timestamptz + time '08:30', now() - interval '4 days','Asia/Kolkata','For her eight-year-old.', now() - interval '5 days'),
  ('c1000000-0000-4000-8000-000000000021','a1000000-0000-4000-8000-000000000009','Cholesterol review','video','confirmed', (current_date + 9)::timestamptz + time '05:30', (current_date + 9)::timestamptz + time '06:30', now() - interval '3 days','Europe/London',NULL, now() - interval '4 days'),

  -- ---- waiting for her to say yes ----
  ('c1000000-0000-4000-8000-000000000022','a1000000-0000-4000-8000-000000000018','Fatty liver','video','held', (current_date + 4)::timestamptz + time '11:30', (current_date + 4)::timestamptz + time '12:30', NULL,'Asia/Kolkata','Ultrasound says grade 2.', now() - interval '2 days'),
  ('c1000000-0000-4000-8000-000000000023','a1000000-0000-4000-8000-000000000013','PCOS follow-up','video','held', (current_date + 5)::timestamptz + time '07:30', (current_date + 5)::timestamptz + time '08:30', NULL,'Asia/Kolkata',NULL, now() - interval '30 hours'),
  ('c1000000-0000-4000-8000-000000000024','a1000000-0000-4000-8000-000000000011','Diabetes review','video','held', (current_date + 7)::timestamptz + time '09:30', (current_date + 7)::timestamptz + time '10:30', NULL,'Asia/Riyadh',NULL, now() - interval '20 hours'),
  ('c1000000-0000-4000-8000-000000000025','a1000000-0000-4000-8000-000000000006','Thyroid review','video','held', (current_date + 8)::timestamptz + time '05:30', (current_date + 8)::timestamptz + time '06:30', NULL,'Asia/Kolkata',NULL, now() - interval '5 hours');

/* WHAT ACTUALLY HAPPENED. Recorded for everything except
   yesterday's, which is deliberately left unrecorded — that is the
   session Today keeps in front of her until she says how it went,
   and a seed where every box is ticked would hide the one part of
   that page that has real work in it. */
INSERT INTO crm.consultation_outcomes
  (consultation_id, outcome, was_scheduled_at, moved_to, note, recorded_by, recorded_at)
SELECT c.id,
       CASE c.status
         WHEN 'no_show'   THEN 'no_show'
         WHEN 'cancelled' THEN 'cancelled'
         ELSE 'done'
       END,
       c.scheduled_start_at,
       NULL,
       CASE c.status
         WHEN 'no_show'   THEN 'No message. Emailed to offer another time.'
         WHEN 'cancelled' THEN 'Cancelled the evening before — work travel.'
         ELSE NULL
       END,
       'khadija@mindyourfood.co.in',
       c.scheduled_start_at + interval '90 minutes'
  FROM crm.consultations c
 WHERE c.status IN ('completed', 'no_show', 'cancelled')
   AND c.id <> 'c1000000-0000-4000-8000-000000000015';

COMMIT;
