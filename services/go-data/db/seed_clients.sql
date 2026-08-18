-- ============================================================
--  THREE CLIENTS, AND THREE PLANS THAT DISAGREE WITH EACH OTHER
-- ------------------------------------------------------------
--  The account panel is judged against this file. A panel that
--  only ever renders one client's data looks finished and is not:
--  the layout has to survive a plan with no dairy in it, a day
--  that starts at 8 PM, and a lab result the client can read.
--
--  So these three are not three copies of the same woman with
--  different names. Each one breaks a different assumption the
--  screens might otherwise be quietly making:
--
--    Sneha    type 2 diabetes, vegetarian, desk job.
--             Four meals on the hour. The ordinary case, and the
--             one everything else is compared against.
--
--    Rajat    hypertension, night shifts, non-vegetarian.
--             HIS DAY STARTS AT 7 PM. Meal 1 is at 19:30 and
--             Meal 4 is at 05:00 the following morning — any
--             screen that sorts by clock time and calls the
--             earliest one "breakfast" is wrong, and this is the
--             row that proves it.
--
--    Aisha    PCOS with iron-deficiency anaemia, lactose
--             intolerant, running a 10K in eleven weeks.
--             HER PLAN CHANGES SHAPE BY DAY: training days carry
--             carbs that rest days do not, so two of her meals
--             exist only on some days. A plan is not a fixed
--             list of rows repeated forever.
--
--  IDs ARE FIXED, NOT GENERATED. Re-running this file removes
--  exactly these three people and puts them back — nothing else
--  in the database is touched, and a test that hardcodes an id
--  keeps working tomorrow. The uuids are obviously invented
--  (…c11e17-0001…) so nobody mistakes seed data for a real
--  client in a hurry.
--
--  NOT LOADED AUTOMATICALLY. schema.sql is structure and
--  config.sql is configuration; this is neither. Run it when you
--  want the practice populated:
--
--    psql -d "$DATABASE_URL" -f db/seed_clients.sql
--
--  Emails are @example.com, which cannot receive mail, so no
--  seed run can post anything to a real person.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---- remove any previous run, children first -----------------
-- ON DELETE RESTRICT on documents, invoices and plan_items means
-- the people row will not go quietly; each one is named so a
-- table added later fails loudly here rather than leaking rows.
WITH seeded AS (
  SELECT unnest(ARRAY[
    'c11e1701-0000-4000-8000-000000000001'::uuid,
    'c11e1702-0000-4000-8000-000000000002'::uuid,
    'c11e1703-0000-4000-8000-000000000003'::uuid
  ]) AS person_id
)
DELETE FROM crm.checkins c
 USING crm.programmes p
 WHERE c.programme_id = p.id AND p.person_id IN (SELECT person_id FROM seeded);

DELETE FROM crm.client_sessions WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.client_codes WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.documents WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.invoices WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.payments WHERE consultation_id IN (
  SELECT id FROM crm.consultations WHERE person_id IN (
    'c11e1701-0000-4000-8000-000000000001',
    'c11e1702-0000-4000-8000-000000000002',
    'c11e1703-0000-4000-8000-000000000003'));
DELETE FROM crm.plan_items WHERE plan_id IN (
  SELECT id FROM crm.plans WHERE person_id IN (
    'c11e1701-0000-4000-8000-000000000001',
    'c11e1702-0000-4000-8000-000000000002',
    'c11e1703-0000-4000-8000-000000000003'));
DELETE FROM crm.plans WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.programmes WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.measurements WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.goals WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
/* AND THE ASSESSMENTS. Not in the first version of this file, and
   the omission announced itself exactly as the header promised it
   would: the delete failed on assessments_person_id_fkey rather
   than leaving orphans behind. An assessment appears against a
   seeded client the moment anybody opens one in the CRM to try the
   plan assistant, which is a thing that happens on any afternoon
   spent testing. */
DELETE FROM crm.assessments WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.consultations WHERE person_id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');
DELETE FROM crm.people WHERE id IN (
  'c11e1701-0000-4000-8000-000000000001',
  'c11e1702-0000-4000-8000-000000000002',
  'c11e1703-0000-4000-8000-000000000003');


-- ============================================================
--  THE PEOPLE
-- ============================================================

INSERT INTO crm.people (id, name, email, phone, dob, country_iso2, source, created_at) VALUES
  ('c11e1701-0000-4000-8000-000000000001', 'Sneha Bhattacharya',
   'sneha.b@example.com', '+919876543210', '1988-03-14', 'IN', 'chatbot',
   now() - interval '21 days'),
  ('c11e1702-0000-4000-8000-000000000002', 'Rajat Menon',
   'rajat.menon@example.com', '+919845012377', '1979-11-02', 'IN', 'chatbot',
   now() - interval '34 days'),
  ('c11e1703-0000-4000-8000-000000000003', 'Aisha Qureshi',
   'aisha.q@example.com', '+919920114488', '1995-06-27', 'IN', 'manual',
   now() - interval '12 days');


-- ============================================================
--  CONSULTATIONS — one completed each, and one ahead for two of
--  them. Aisha has none booked: the Sessions view must read
--  properly with an empty next slot, not only with a full one.
--
--  TIMES ARE PINNED TO THE HOUR, not offset from now(). A seed
--  run at 13:08 was otherwise producing "your next session is at
--  1:08 PM", which is not an hour anybody books — and Rajat's are
--  in the evening because he is awake in the evening.
--
--  AND THE BOOKED ONES SIT AT :15 AND :45. consultations_slot_unique
--  is a partial unique index across the WHOLE practice, so a seeded
--  hour on the hour collides with whatever the CRM already has
--  booked there and the seed refuses to run — which is exactly what
--  happened, and is the index doing its job. Quarter-past is a time
--  nothing else books.
-- ============================================================

INSERT INTO crm.consultations
  (id, person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
   confirmed_at, timezone, source, created_at) VALUES

  -- Sneha: seen, and due again
  ('c0f5a101-0000-4000-8000-000000000001', 'c11e1701-0000-4000-8000-000000000001',
   'Fasting sugar creeping up; wants to eat normally at home', 'video', 'completed',
   date_trunc('day', now()) - interval '20 days' + interval '11 hours', date_trunc('day', now()) - interval '20 days' + interval '12 hours',
   now() - interval '21 days', 'Asia/Kolkata', 'chatbot', now() - interval '21 days'),
  ('c0f5a102-0000-4000-8000-000000000001', 'c11e1701-0000-4000-8000-000000000001',
   'Four-week review', 'video', 'confirmed',
   date_trunc('day', now()) + interval '2 days 10 hours 15 minutes', date_trunc('day', now()) + interval '2 days 11 hours 15 minutes',
   now() - interval '3 days', 'Asia/Kolkata', 'review', now() - interval '3 days'),

  -- Rajat: seen twice, next one booked late in the evening because
  -- that is when he is awake
  ('c0f5a201-0000-4000-8000-000000000002', 'c11e1702-0000-4000-8000-000000000002',
   'BP 148/94 at the last check; works nights and eats at the plant', 'video', 'completed',
   date_trunc('day', now()) - interval '33 days' + interval '18 hours', date_trunc('day', now()) - interval '33 days' + interval '19 hours',
   now() - interval '34 days', 'Asia/Kolkata', 'chatbot', now() - interval '34 days'),
  ('c0f5a202-0000-4000-8000-000000000002', 'c11e1702-0000-4000-8000-000000000002',
   'Review — sodium and the 3 AM meal', 'audio', 'completed',
   date_trunc('day', now()) - interval '12 days' + interval '18 hours 30 minutes', date_trunc('day', now()) - interval '12 days' + interval '19 hours',
   now() - interval '13 days', 'Asia/Kolkata', 'review', now() - interval '13 days'),
  ('c0f5a203-0000-4000-8000-000000000002', 'c11e1702-0000-4000-8000-000000000002',
   'Second review', 'audio', 'confirmed',
   date_trunc('day', now()) + interval '5 days 18 hours 45 minutes', date_trunc('day', now()) + interval '5 days 19 hours 45 minutes',
   now() - interval '1 day', 'Asia/Kolkata', 'review', now() - interval '1 day'),

  -- Aisha: seen once, nothing booked
  ('c0f5a301-0000-4000-8000-000000000003', 'c11e1703-0000-4000-8000-000000000003',
   'PCOS, low haemoglobin, training for a 10K in November', 'in_person', 'completed',
   date_trunc('day', now()) - interval '11 days' + interval '16 hours', date_trunc('day', now()) - interval '11 days' + interval '17 hours',
   now() - interval '12 days', 'Asia/Kolkata', 'manual', now() - interval '12 days');


-- ============================================================
--  WHAT THEY PAID, AND THE RECEIPT IT EARNED
--  Amounts are minor units. The Account view prints these; it
--  never recomputes a total from anything else.
-- ============================================================

INSERT INTO crm.payments
  (id, consultation_id, currency, amount_minor, provider, provider_ref,
   status, created_at, paid_at) VALUES
  ('9a7e1701-0000-4000-8000-000000000001', 'c0f5a101-0000-4000-8000-000000000001',
   'INR', 500000, 'razorpay', 'pay_seed_sneha_first', 'paid',
   now() - interval '21 days', now() - interval '21 days'),
  ('9a7e1702-0000-4000-8000-000000000002', 'c0f5a201-0000-4000-8000-000000000002',
   'INR', 500000, 'razorpay', 'pay_seed_rajat_first', 'paid',
   now() - interval '34 days', now() - interval '34 days'),
  ('9a7e1703-0000-4000-8000-000000000003', 'c0f5a202-0000-4000-8000-000000000002',
   'INR', 250000, 'razorpay', 'pay_seed_rajat_review', 'paid',
   now() - interval '13 days', now() - interval '13 days'),
  ('9a7e1704-0000-4000-8000-000000000004', 'c0f5a301-0000-4000-8000-000000000003',
   'INR', 500000, 'manual', 'seed_aisha_upi', 'paid',
   now() - interval '12 days', now() - interval '12 days');

-- Receipt numbers here are taken from a series that will never
-- collide with the live counter: 9001 upward, while the counter
-- sits in the hundreds. A seed run must not consume a real
-- number, because a gap in an invoice series is a question an
-- accountant asks a year later.
INSERT INTO crm.invoices
  (id, payment_id, consultation_id, person_id, kind, series, seq, number,
   issued_to_name, issued_to_email, description, currency, amount_minor, issued_at) VALUES
  ('117e1701-0000-4000-8000-000000000001', '9a7e1701-0000-4000-8000-000000000001',
   'c0f5a101-0000-4000-8000-000000000001', 'c11e1701-0000-4000-8000-000000000001',
   'receipt', '2026-27', 9001, 'MYF/2026-27/9001',
   'Sneha Bhattacharya', 'sneha.b@example.com', 'Consultation — 60 minutes',
   'INR', 500000, now() - interval '21 days'),
  ('117e1702-0000-4000-8000-000000000002', '9a7e1702-0000-4000-8000-000000000002',
   'c0f5a201-0000-4000-8000-000000000002', 'c11e1702-0000-4000-8000-000000000002',
   'receipt', '2026-27', 9002, 'MYF/2026-27/9002',
   'Rajat Menon', 'rajat.menon@example.com', 'Consultation — 60 minutes',
   'INR', 500000, now() - interval '34 days'),
  ('117e1703-0000-4000-8000-000000000003', '9a7e1703-0000-4000-8000-000000000003',
   'c0f5a202-0000-4000-8000-000000000002', 'c11e1702-0000-4000-8000-000000000002',
   'receipt', '2026-27', 9003, 'MYF/2026-27/9003',
   'Rajat Menon', 'rajat.menon@example.com', 'Review — 30 minutes',
   'INR', 250000, now() - interval '13 days'),
  ('117e1704-0000-4000-8000-000000000004', '9a7e1704-0000-4000-8000-000000000004',
   'c0f5a301-0000-4000-8000-000000000003', 'c11e1703-0000-4000-8000-000000000003',
   'receipt', '2026-27', 9004, 'MYF/2026-27/9004',
   'Aisha Qureshi', 'aisha.q@example.com', 'Consultation — 60 minutes',
   'INR', 500000, now() - interval '12 days');


-- ============================================================
--  THE PLANS
--  `body` is the prose the Plan view renders — one <details>
--  section per "## " heading, so she writes a plan rather than
--  filling in a form, and the panel follows whatever she wrote.
--  `targets` is what Progress draws a line towards.
-- ============================================================

INSERT INTO crm.plans
  (id, person_id, consultation_id, plan_no, amendment, ref, status, body,
   private_note, targets, recorded_by, started_at, issued_at) VALUES

  ('91a71701-0000-4000-8000-000000000001', 'c11e1701-0000-4000-8000-000000000001',
   'c0f5a101-0000-4000-8000-000000000001', 1, 0, 'snehabhattacharyap1_0', 'issued',
$$## What we are working on
Bringing your fasting sugar down from 132 and holding a steady, unhurried weight loss. Two things carry most of that: eating at roughly the same hours every day, and getting protein at every meal rather than all of it at dinner.

## How the day is shaped
Four meals, about four hours apart. Breakfast within an hour of waking, the last meal finished by 8 PM. The overnight gap is doing real work — it is not an accident of the timings.

## Portions, and how to weigh them
Weights are cooked weights unless the line says otherwise. Weigh everything for the first two weeks; after that you will see 150 g of rice on a plate without a scale, and that is exactly what the first two weeks were for.

## What you can swap
Rice for roti by weight. Sweet potato for potato or a banana. Dal for rajma or chana. Keep the swap in the same meal and write it in the note, so it is in front of me at your review.

## Water, tea and coffee
Three litres of water across the day. Two cups of tea or coffee, without sugar, and none after 10 PM — caffeine that late costs you the sleep window, and the sleep window is part of this plan.

## What would make me change this
Fasting sugar not moving after four weeks, weight falling faster than half a kilo a week, or you telling me the 4 PM meal is not survivable on a working day. Any of those is a reason to rewrite the plan, not a reason to try harder.$$,
   'Metformin 500 mg at night — prescribed by her physician, not by me. Do not touch the dose.',
   '{"weight_kg": 68, "fasting_glucose_mgdl": 100, "sleep_hours": 7.5}'::jsonb,
   'Khadija', now() - interval '20 days', now() - interval '20 days'),

  ('91a71702-0000-4000-8000-000000000002', 'c11e1702-0000-4000-8000-000000000002',
   'c0f5a202-0000-4000-8000-000000000002', 1, 1, 'rajatmenonp1_1', 'issued',
$$## What we are working on
Getting your blood pressure under 130/85 without you having to change shifts. Salt is the lever here, not calories — most of what we are doing is moving sodium out of the food you already eat.

## Your day starts in the evening
You wake around 6 PM and sleep at 8 AM, so your first meal is at 7:30 PM and your last is at 5 AM. That is not a late dinner and an early breakfast — it is breakfast, lunch and dinner in the order your body actually meets them. Ignore anyone who tells you eating at 3 AM is the problem. Eating badly at 3 AM is the problem.

## Sodium, and where it hides
Not the salt shaker. The pickle, the papad, the packet masala, and the canteen dal. Under 2 g of sodium a day means cooking your own rice and dal for the shift and carrying it. Everything on your list is built to travel in a tiffin.

## The 3 AM meal
This is the one that decides the week. It is small on purpose and it is not optional — skipping it is why you were finishing the shift on tea and biscuits, and the biscuits are worth more sodium than the whole rest of the day.

## Caffeine
Two cups before 1 AM. After that it will sit between you and the 8 AM sleep, and short sleep puts your morning readings up on its own.

## What would make me change this
Readings above 150 systolic at any point, swelling in your ankles, or a shift rota change. Tell me the rota changed before you try to make this plan fit it.$$,
   'GP has him on amlodipine 5 mg. Home monitor readings are self-reported — treat as a trend, not a diagnosis.',
   '{"weight_kg": 82, "systolic_mmhg": 128, "sodium_g": 2.0}'::jsonb,
   'Khadija', now() - interval '33 days', now() - interval '12 days'),

  ('91a71703-0000-4000-8000-000000000003', 'c11e1703-0000-4000-8000-000000000003',
   'c0f5a301-0000-4000-8000-000000000003', 1, 0, 'aishaqureship1_0', 'issued',
$$## What we are working on
Two things at once, and they pull in the same direction: getting your haemoglobin up from 9.8, and steadying your cycle. Iron is the headline. The running is welcome and it is also why the iron matters more, not less.

## No dairy, and what replaces it
Nothing on your plan contains milk, curd, paneer or whey. Calcium comes from ragi, sesame and fortified soy; protein from dal, soya, eggs and fish. If you find a fortified soy milk you like, tell me the brand and I will fold it in properly rather than you guessing.

## Training days are different from rest days
On the days you run, two extra items appear on your plan — the pre-run banana and the post-run rice. They are not a treat and they are not optional on those days. On rest days they are simply not there. Tick what is on the list that day and ignore the rest.

## Iron, and the two rules that decide whether it works
Take the iron with vitamin C — the lemon on the dal is doing a job. Keep it two hours away from tea, coffee and any calcium. Tea with a meal can cost you most of the iron in that meal, which is how someone eats well for months and stays anaemic.

## The 10K
Eleven weeks. Long run on Sunday, and the plan follows it rather than the other way round. If a run goes badly, tell me what you ate the day before — that is usually the answer, and it is a fixable one.

## What would make me change this
Haemoglobin not moving by the six-week bloods, dizziness on a run, or your period going missing for more than two cycles. Any of those, message me — do not wait for the review.$$,
   'Ferritin 11 ng/mL at intake. Physician-prescribed ferrous ascorbate 100 mg. Recheck bloods at six weeks.',
   '{"weight_kg": 59, "haemoglobin_gdl": 12.0, "weekly_km": 32}'::jsonb,
   'Khadija', now() - interval '11 days', now() - interval '11 days');


-- ============================================================
--  THE PLAN ITEMS — the lines a client ticks.
--
--  ONE ROW PER LINE, NOT ONE ROW PER MEAL. The meal card in the
--  panel is a grouping of rows that share detail->>'meal'; the
--  tick is per row, because "I had the rice but not the dal" is
--  the answer she actually needs and a per-meal tick throws it
--  away.
--
--  detail carries what is specific to the kind:
--    meal / supplement  {"meal": 2, "time": "12:30", "kcal": 520}
--    activity           {"day": "Mon", "sets": 3, "reps": 12}
--    sleep              {"from": "23:00", "to": "06:30"}
--  and, where a line only exists on some days,
--    {"days": ["Tue","Thu","Sun"]}
--
--  Every row is `confirmed` with her name and a time against it,
--  because the schema refuses a confirmed line that nobody
--  agreed to — see plan_items_confirmed_has_who.
-- ============================================================

-- ---- Sneha: four meals on the hour, vegetarian, low GI --------
INSERT INTO crm.plan_items
  (plan_id, seq, kind, label, quantity, unit, schedule, status, detail,
   confirmed_by, confirmed_at) VALUES
  ('91a71701-0000-4000-8000-000000000001',  1, 'meal',       'Vegetable poha',                150, 'g',  'Meal 1 · 8:00 AM', 'confirmed', '{"meal":1,"time":"08:00","kcal":220}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  2, 'meal',       'Sprouted moong',                 80, 'g',  'Meal 1 · 8:00 AM', 'confirmed', '{"meal":1,"time":"08:00","kcal":120}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  3, 'supplement', 'Vitamin D 2000 IU',            2000, 'IU', 'Meal 1 · 8:00 AM', 'confirmed', '{"meal":1,"time":"08:00"}',             'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  4, 'meal',       'Brown rice',                    150, 'g',  'Meal 2 · 12:30 PM','confirmed', '{"meal":2,"time":"12:30","kcal":190}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  5, 'meal',       'Toor dal',                      200, 'ml', 'Meal 2 · 12:30 PM','confirmed', '{"meal":2,"time":"12:30","kcal":170}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  6, 'meal',       'Mixed vegetable sabzi',         150, 'g',  'Meal 2 · 12:30 PM','confirmed', '{"meal":2,"time":"12:30","kcal":110}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  7, 'meal',       'Curd',                          100, 'g',  'Meal 2 · 12:30 PM','confirmed', '{"meal":2,"time":"12:30","kcal":60}',   'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  8, 'meal',       'Roasted chana',                  30, 'g',  'Meal 3 · 4:30 PM', 'confirmed', '{"meal":3,"time":"16:30","kcal":110}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001',  9, 'meal',       'Green tea, no sugar',           200, 'ml', 'Meal 3 · 4:30 PM', 'confirmed', '{"meal":3,"time":"16:30","kcal":0}',    'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 10, 'meal',       'Jowar roti',                      2, 'no', 'Meal 4 · 7:45 PM', 'confirmed', '{"meal":4,"time":"19:45","kcal":220}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 11, 'meal',       'Paneer bhurji',                 120, 'g',  'Meal 4 · 7:45 PM', 'confirmed', '{"meal":4,"time":"19:45","kcal":230}',  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 12, 'meal',       'Salad, no dressing',            150, 'g',  'Meal 4 · 7:45 PM', 'confirmed', '{"meal":4,"time":"19:45","kcal":45}',   'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 13, 'supplement', 'Multivitamin',                    1, 'no', 'Meal 4 · 7:45 PM', 'confirmed', '{"meal":4,"time":"19:45"}',             'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 14, 'sleep',      'Lights out 11 PM, up at 6:30 AM', NULL, '', 'Every night',     'confirmed', '{"from":"23:00","to":"06:30","hours":7.5}', 'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 15, 'activity',   'Walk after dinner',              20, 'min','Every day',        'confirmed', '{"intensity":"easy"}',                  'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 16, 'activity',   'Resistance band circuit',         3, 'set','Mon / Wed / Fri',  'confirmed', '{"days":["Mon","Wed","Fri"],"sets":3,"reps":12,"restSeconds":60}', 'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 17, 'habit',      'Three litres of water',           3, 'L',  'Across the day',   'confirmed', '{}',                                    'Khadija', now() - interval '20 days');

-- ---- Rajat: the night shift. Meal 1 is at 19:30. -------------
INSERT INTO crm.plan_items
  (plan_id, seq, kind, label, quantity, unit, schedule, status, detail,
   confirmed_by, confirmed_at) VALUES
  ('91a71702-0000-4000-8000-000000000002',  1, 'meal',       'Oats with banana',              200, 'ml', 'Meal 1 · 7:30 PM', 'confirmed', '{"meal":1,"time":"19:30","kcal":290}',  'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  2, 'meal',       'Boiled eggs',                     2, 'no', 'Meal 1 · 7:30 PM', 'confirmed', '{"meal":1,"time":"19:30","kcal":140}',  'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  3, 'meal',       'Rice, cooked without salt',     180, 'g',  'Meal 2 · 11:30 PM','confirmed', '{"meal":2,"time":"23:30","kcal":230}',  'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  4, 'meal',       'Grilled chicken',               150, 'g',  'Meal 2 · 11:30 PM','confirmed', '{"meal":2,"time":"23:30","kcal":250}',  'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  5, 'meal',       'Cucumber and tomato',           150, 'g',  'Meal 2 · 11:30 PM','confirmed', '{"meal":2,"time":"23:30","kcal":35}',   'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  6, 'meal',       'Roasted peanuts, unsalted',      30, 'g',  'Meal 3 · 3:00 AM', 'confirmed', '{"meal":3,"time":"03:00","kcal":170}',  'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  7, 'meal',       'Orange',                          1, 'no', 'Meal 3 · 3:00 AM', 'confirmed', '{"meal":3,"time":"03:00","kcal":60}',   'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  8, 'meal',       'Moong dal khichdi',             250, 'g',  'Meal 4 · 5:00 AM', 'confirmed', '{"meal":4,"time":"05:00","kcal":310}',  'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002',  9, 'meal',       'Curd, unsalted',                100, 'g',  'Meal 4 · 5:00 AM', 'confirmed', '{"meal":4,"time":"05:00","kcal":60}',   'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 10, 'supplement', 'Potassium-rich fruit (banana)',   1, 'no', 'Meal 4 · 5:00 AM', 'confirmed', '{"meal":4,"time":"05:00"}',             'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 11, 'supplement', 'Vitamin D 2000 IU',            2000, 'IU', 'Meal 1 · 7:30 PM', 'confirmed', '{"meal":1,"time":"19:30"}',             'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 12, 'sleep',      'Dark room, 8 AM to 3 PM',      NULL, '',   'After every shift','confirmed', '{"from":"08:00","to":"15:00","hours":7}', 'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 13, 'activity',   'Walk before the shift',          30, 'min','Every day',        'confirmed', '{"intensity":"brisk"}',                 'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 14, 'habit',      'No packet masala or pickle',   NULL, '',   'Every day',        'confirmed', '{}',                                    'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 15, 'habit',      'BP reading before sleeping',   NULL, '',   'Every day',        'confirmed', '{}',                                    'Khadija', now() - interval '12 days');

-- ---- Aisha: no dairy, iron first, and two lines that only
--      exist on training days --------------------------------
INSERT INTO crm.plan_items
  (plan_id, seq, kind, label, quantity, unit, schedule, status, detail,
   confirmed_by, confirmed_at) VALUES
  ('91a71703-0000-4000-8000-000000000003',  1, 'meal',       'Ragi porridge with soy milk',   250, 'ml', 'Meal 1 · 7:30 AM', 'confirmed', '{"meal":1,"time":"07:30","kcal":260}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  2, 'meal',       'Dates',                           2, 'no', 'Meal 1 · 7:30 AM', 'confirmed', '{"meal":1,"time":"07:30","kcal":110}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  3, 'supplement', 'Ferrous ascorbate 100 mg',      100, 'mg', 'Meal 1 · 7:30 AM', 'confirmed', '{"meal":1,"time":"07:30","note":"with the lemon, never with tea"}', 'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  4, 'meal',       'Banana',                          1, 'no', 'Before the run',   'confirmed', '{"meal":2,"time":"17:30","kcal":105,"days":["Tue","Thu","Sun"]}', 'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  5, 'meal',       'Rajma',                         200, 'g',  'Meal 3 · 1:00 PM', 'confirmed', '{"meal":3,"time":"13:00","kcal":230}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  6, 'meal',       'Bajra roti',                      2, 'no', 'Meal 3 · 1:00 PM', 'confirmed', '{"meal":3,"time":"13:00","kcal":210}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  7, 'meal',       'Spinach with lemon',            150, 'g',  'Meal 3 · 1:00 PM', 'confirmed', '{"meal":3,"time":"13:00","kcal":70}',   'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  8, 'meal',       'Roasted rice with jaggery',     120, 'g',  'After the run',    'confirmed', '{"meal":4,"time":"19:00","kcal":250,"days":["Tue","Thu","Sun"]}', 'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003',  9, 'meal',       'Grilled fish',                  150, 'g',  'Meal 5 · 8:00 PM', 'confirmed', '{"meal":5,"time":"20:00","kcal":230}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 10, 'meal',       'Sesame and vegetable stir-fry', 150, 'g',  'Meal 5 · 8:00 PM', 'confirmed', '{"meal":5,"time":"20:00","kcal":180}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 11, 'supplement', 'Vitamin B12 1000 mcg',         1000, 'mcg','Meal 5 · 8:00 PM', 'confirmed', '{"meal":5,"time":"20:00"}',             'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 12, 'sleep',      'Lights out 10:30 PM, up at 6 AM', NULL, '','Every night',      'confirmed', '{"from":"22:30","to":"06:00","hours":7.5}', 'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 13, 'activity',   'Easy run, 5 km',                  5, 'km', 'Tue / Thu',        'confirmed', '{"days":["Tue","Thu"],"pace":"easy"}',  'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 14, 'activity',   'Long run',                        8, 'km', 'Sunday',           'confirmed', '{"days":["Sun"],"pace":"conversational"}', 'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 15, 'activity',   'Strength — squat, row, press',    3, 'set','Mon / Fri',        'confirmed', '{"days":["Mon","Fri"],"sets":3,"reps":10,"restSeconds":90}', 'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 16, 'habit',      'No tea or coffee within 2 hours of iron', NULL, '', 'Every day', 'confirmed', '{}', 'Khadija', now() - interval '11 days');


-- ============================================================
--  THE PROGRAMMES — the entitlement the Account view prints.
--  Three different lengths and three different amounts of time
--  remaining, so the progress bar is tested at both ends rather
--  than always near half.
-- ============================================================

INSERT INTO crm.programmes
  (id, token, person_id, plan_no, status, started_on, ends_on, length_days,
   opened_at, open_count, created_at) VALUES
  ('9406e701-0000-4000-8000-000000000001', 'seed_sneha_programme_token_0001',
   'c11e1701-0000-4000-8000-000000000001', 1, 'active',
   current_date - 20, current_date + 40, 60,
   now() - interval '19 days', 34, now() - interval '20 days'),
  ('9406e702-0000-4000-8000-000000000002', 'seed_rajat_programme_token_0002',
   'c11e1702-0000-4000-8000-000000000002', 1, 'active',
   current_date - 33, current_date - 3, 30,
   now() - interval '33 days', 61, now() - interval '33 days'),
  ('9406e703-0000-4000-8000-000000000003', 'seed_aisha_programme_token_0003',
   'c11e1703-0000-4000-8000-000000000003', 1, 'active',
   current_date - 11, current_date + 79, 90,
   now() - interval '10 days', 12, now() - interval '11 days');

-- RAJAT'S PROGRAMME HAS ALREADY RUN OUT — ends_on is three days
-- behind today while status is still 'active'. That combination
-- is the one the panel is most likely to get wrong: entitlement
-- is a date, not a flag, and "0 days left" has to render as
-- calmly as "40 days left". He keeps his account either way.


-- ============================================================
--  WHAT THEY ACTUALLY DID — checkins across the whole run.
--
--  Generated rather than typed, because two hundred hand-written
--  rows are two hundred chances to write a date that is not a
--  date. The pattern is deliberate and different per person:
--
--    Sneha  strong on weekdays, ragged at the weekend.
--    Rajat  near-perfect except the 3 AM meal, which he misses
--           about half the time — the thing his review is about.
--    Aisha  short history, and nothing on days her training-only
--           items do not exist.
-- ============================================================

-- Sneha: every day of her programme so far
INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
SELECT '9406e701-0000-4000-8000-000000000001', pi.id, d::date,
       CASE
         WHEN extract(dow FROM d) IN (0, 6) AND pi.seq IN (8, 9, 16) THEN 'skip'
         WHEN extract(dow FROM d) = 0 AND pi.seq IN (10, 11) THEN 'part'
         ELSE 'done'
       END,
       CASE WHEN extract(dow FROM d) = 0 AND pi.seq = 10
            THEN 'ate out — had two chapatis instead' ELSE '' END,
       d + interval '21 hours'
  FROM generate_series(current_date - 20, current_date - 1, interval '1 day') d
 CROSS JOIN crm.plan_items pi
 WHERE pi.plan_id = '91a71701-0000-4000-8000-000000000001'
   AND pi.kind IN ('meal', 'supplement');

-- Rajat: the 3 AM meal (seq 6 and 7) is the one that goes
INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
SELECT '9406e702-0000-4000-8000-000000000002', pi.id, d::date,
       CASE
         WHEN pi.seq IN (6, 7) AND (extract(doy FROM d)::int % 2) = 0 THEN 'skip'
         WHEN pi.seq = 9 AND (extract(doy FROM d)::int % 5) = 0 THEN 'part'
         ELSE 'done'
       END,
       CASE WHEN pi.seq = 6 AND (extract(doy FROM d)::int % 2) = 0
            THEN 'line was running, no break' ELSE '' END,
       d + interval '30 hours'
  FROM generate_series(current_date - 33, current_date - 1, interval '1 day') d
 CROSS JOIN crm.plan_items pi
 WHERE pi.plan_id = '91a71702-0000-4000-8000-000000000002'
   AND pi.kind IN ('meal', 'supplement');

-- Aisha: eleven days, and the training-only items only on the
-- days they exist — to_char(d,'Dy') against detail->'days'
INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
SELECT '9406e703-0000-4000-8000-000000000003', pi.id, d::date,
       CASE WHEN (extract(doy FROM d)::int % 7) = 3 THEN 'part' ELSE 'done' END,
       '', d + interval '20 hours'
  FROM generate_series(current_date - 11, current_date - 1, interval '1 day') d
 CROSS JOIN crm.plan_items pi
 WHERE pi.plan_id = '91a71703-0000-4000-8000-000000000003'
   AND pi.kind IN ('meal', 'supplement')
   AND (pi.detail->'days' IS NULL
        OR pi.detail->'days' ? to_char(d, 'Dy'));


-- ============================================================
--  MEASUREMENTS — body, and labs the client can read.
--  ref_low / ref_high are populated on the lab rows so the panel
--  can say "below range" in words rather than leaving a number
--  on screen for someone to search the internet about at 1 AM.
-- ============================================================

-- weight, weekly, each falling at a plausible and different rate
INSERT INTO crm.measurements
  (person_id, programme_id, kind, metric, value, unit, taken_at, source)
SELECT 'c11e1701-0000-4000-8000-000000000001', '9406e701-0000-4000-8000-000000000001',
       'body', 'weight', 72.4 - (n * 0.55), 'kg',
       now() - ((20 - n * 7) || ' days')::interval, 'self'
  FROM generate_series(0, 2) n;

INSERT INTO crm.measurements
  (person_id, programme_id, kind, metric, value, unit, taken_at, source)
SELECT 'c11e1702-0000-4000-8000-000000000002', '9406e702-0000-4000-8000-000000000002',
       'body', 'weight', 88.1 - (n * 0.9), 'kg',
       now() - ((33 - n * 7) || ' days')::interval, 'self'
  FROM generate_series(0, 4) n;

INSERT INTO crm.measurements
  (person_id, programme_id, kind, metric, value, unit, taken_at, source)
SELECT 'c11e1703-0000-4000-8000-000000000003', '9406e703-0000-4000-8000-000000000003',
       'body', 'weight', 60.2 - (n * 0.2), 'kg',
       now() - ((11 - n * 7) || ' days')::interval, 'self'
  FROM generate_series(0, 1) n;

-- blood pressure, self-reported, only Rajat
INSERT INTO crm.measurements
  (person_id, programme_id, kind, metric, value, unit, taken_at, source)
SELECT 'c11e1702-0000-4000-8000-000000000002', '9406e702-0000-4000-8000-000000000002',
       'body', 'systolic', 148 - (n * 2.5), 'mmHg',
       now() - ((33 - n * 4) || ' days')::interval, 'self'
  FROM generate_series(0, 7) n;

-- labs, from reports they uploaded
INSERT INTO crm.measurements
  (person_id, kind, metric, value, unit, method, ref_low, ref_high, taken_at, source) VALUES
  ('c11e1701-0000-4000-8000-000000000001', 'lab', 'fasting_glucose', 132, 'mg/dL', 'venous',  70, 100, now() - interval '22 days', 'clinic'),
  ('c11e1701-0000-4000-8000-000000000001', 'lab', 'hba1c',           7.1, '%',     'HPLC',  4.0, 5.6, now() - interval '22 days', 'clinic'),
  ('c11e1702-0000-4000-8000-000000000002', 'lab', 'sodium',          143, 'mmol/L','venous', 135, 145, now() - interval '35 days', 'clinic'),
  ('c11e1702-0000-4000-8000-000000000002', 'lab', 'creatinine',      1.0, 'mg/dL', 'venous', 0.7, 1.3, now() - interval '35 days', 'clinic'),
  ('c11e1703-0000-4000-8000-000000000003', 'lab', 'haemoglobin',     9.8, 'g/dL',  'venous',12.0,15.0, now() - interval '13 days', 'clinic'),
  ('c11e1703-0000-4000-8000-000000000003', 'lab', 'ferritin',         11, 'ng/mL', 'venous',15.0,150.0,now() - interval '13 days', 'clinic');

-- sleep, self-reported, the last fortnight
INSERT INTO crm.measurements
  (person_id, programme_id, kind, metric, value, unit, taken_at, source)
SELECT 'c11e1701-0000-4000-8000-000000000001', '9406e701-0000-4000-8000-000000000001',
       'sleep', 'hours', 6.4 + ((n % 5) * 0.35), 'h',
       now() - (n || ' days')::interval, 'self'
  FROM generate_series(1, 14) n;

INSERT INTO crm.measurements
  (person_id, programme_id, kind, metric, value, unit, taken_at, source)
SELECT 'c11e1702-0000-4000-8000-000000000002', '9406e702-0000-4000-8000-000000000002',
       'sleep', 'hours', 5.2 + ((n % 4) * 0.4), 'h',
       now() - (n || ' days')::interval, 'self'
  FROM generate_series(1, 14) n;


-- ============================================================
--  GOALS — what each of them agreed to, in their own terms
-- ============================================================

INSERT INTO crm.goals (person_id, kind, goal, target_metric, target_value, due_on, status) VALUES
  ('c11e1701-0000-4000-8000-000000000001', 'short_term',  'Fasting sugar under 110', 'fasting_glucose', 110, current_date + 40, 'active'),
  ('c11e1701-0000-4000-8000-000000000001', 'behavioural', 'Eat the 4:30 PM meal on working days', NULL, NULL, NULL, 'active'),
  ('c11e1702-0000-4000-8000-000000000002', 'short_term',  'Systolic under 130 on the home monitor', 'systolic', 130, current_date + 30, 'active'),
  ('c11e1702-0000-4000-8000-000000000002', 'behavioural', 'Carry the tiffin every shift instead of the canteen', NULL, NULL, NULL, 'active'),
  ('c11e1703-0000-4000-8000-000000000003', 'long_term',   'Finish the 10K without walking', NULL, NULL, current_date + 77, 'active'),
  ('c11e1703-0000-4000-8000-000000000003', 'short_term',  'Haemoglobin above 12', 'haemoglobin', 12, current_date + 30, 'active');


-- ============================================================
--  DOCUMENTS — what the Health records view lists.
--  storage_key points into the local store; these files do not
--  exist on disk, so a download is expected to 404 until a real
--  one is uploaded. That is the honest state, and better than a
--  placeholder PDF that looks like somebody's actual bloods.
-- ============================================================

INSERT INTO crm.documents
  (person_id, consultation_id, kind, title, storage_key, mime, bytes, sha256,
   uploaded_by, visible_to_client, uploaded_at) VALUES
  ('c11e1701-0000-4000-8000-000000000001', 'c0f5a101-0000-4000-8000-000000000001',
   'plan', 'Diet plan — August', 'seed/sneha/plan-aug.pdf', 'application/pdf',
   245760, 'seed0000000000000000000000000000000000000000000000000000000001',
   'practitioner', true, now() - interval '20 days'),
  ('c11e1701-0000-4000-8000-000000000001', NULL,
   'report', 'Blood work — fasting panel', 'seed/sneha/bloods-jul.pdf', 'application/pdf',
   1153434, 'seed0000000000000000000000000000000000000000000000000000000002',
   'client', true, now() - interval '22 days'),
  ('c11e1702-0000-4000-8000-000000000002', NULL,
   'report', 'BP log — four weeks', 'seed/rajat/bp-log.jpeg', 'image/jpeg',
   842301, 'seed0000000000000000000000000000000000000000000000000000000003',
   'client', true, now() - interval '14 days'),
  ('c11e1702-0000-4000-8000-000000000002', 'c0f5a202-0000-4000-8000-000000000002',
   'plan', 'Revised plan — the 3 AM meal', 'seed/rajat/plan-rev1.pdf', 'application/pdf',
   198340, 'seed0000000000000000000000000000000000000000000000000000000004',
   'practitioner', true, now() - interval '12 days'),
  ('c11e1703-0000-4000-8000-000000000003', NULL,
   'report', 'CBC and ferritin', 'seed/aisha/cbc.pdf', 'application/pdf',
   402118, 'seed0000000000000000000000000000000000000000000000000000000005',
   'client', true, now() - interval '13 days'),
  ('c11e1703-0000-4000-8000-000000000003', NULL,
   'prescription', 'Ferrous ascorbate — physician', 'seed/aisha/rx.jpeg', 'image/jpeg',
   611209, 'seed0000000000000000000000000000000000000000000000000000000006',
   'client', true, now() - interval '13 days'),
  -- Hers, and deliberately not theirs to read. If this ever shows
  -- up in the panel, the visible_to_client filter is missing.
  ('c11e1703-0000-4000-8000-000000000003', 'c0f5a301-0000-4000-8000-000000000003',
   'letter', 'Note to referring physician', 'seed/aisha/referral.pdf', 'application/pdf',
   88120, 'seed0000000000000000000000000000000000000000000000000000000007',
   'practitioner', false, now() - interval '11 days');

-- ============================================================
--  INTAKE DETAIL FOR THE THREE SEEDED CLIENTS
-- ------------------------------------------------------------
--  Appended to seed_clients.sql. Kept as its own block because
--  it is answering a different question from the rows above:
--  those say WHAT and WHEN, this says HOW MUCH IN A KITCHEN and
--  HOW IT IS TAKEN.
--
--  `detail` is merged rather than replaced (`||`), so the meal
--  number, the time and the kcal already on each row survive.
-- ============================================================

-- ---- Sneha: household measures and the intake instructions ----
UPDATE crm.plan_items SET detail = detail || d.extra FROM (VALUES
  (1,  '{"household":"one katori","how":"eat it within an hour of waking, not at your desk"}'::jsonb),
  (2,  '{"household":"one small bowl"}'::jsonb),
  (3,  '{"timing":"after_meal","how":"after breakfast, never on an empty stomach"}'::jsonb),
  (4,  '{"household":"one katori"}'::jsonb),
  (5,  '{"household":"one bowl","how":"sip water through the meal rather than a glass after it"}'::jsonb),
  (6,  '{"household":"one katori"}'::jsonb),
  (7,  '{"household":"half a katori","how":"plain, not sweetened"}'::jsonb),
  (8,  '{"household":"one fistful","how":"this is the meal that stops the 7pm hunger — do not skip it"}'::jsonb),
  (9,  '{"household":"one cup","how":"no sugar, and none after 10 PM"}'::jsonb),
  (10, '{"how":"jowar, not wheat, while the sugars are settling"}'::jsonb),
  (11, '{"household":"one katori"}'::jsonb),
  (12, '{"household":"one plate","how":"before the roti, not after"}'::jsonb),
  (13, '{"timing":"after_meal","how":"with dinner, so it is not on an empty stomach"}'::jsonb),
  (17, '{"household":"twelve glasses","how":"spread across the day, not all in the evening"}'::jsonb)
) AS d(seq, extra)
WHERE plan_items.plan_id = '91a71701-0000-4000-8000-000000000001'
  AND plan_items.seq = d.seq;

-- ---- Rajat: the sodium plan, and the 3 AM meal ----------------
UPDATE crm.plan_items SET detail = detail || d.extra FROM (VALUES
  (1,  '{"household":"one katori","how":"before the shift starts, not on the way in"}'::jsonb),
  (2,  '{"how":"boiled, not fried, and no salt on them"}'::jsonb),
  (3,  '{"household":"one katori","how":"cook it without salt and carry it — the canteen dal is the problem"}'::jsonb),
  (4,  '{"household":"one palmful","how":"grilled or roasted, no gravy"}'::jsonb),
  (5,  '{"household":"one plate","how":"no pickle, no papad, no chaat masala"}'::jsonb),
  (6,  '{"household":"one fistful","how":"unsalted — the salted ones cost more sodium than the rest of the shift"}'::jsonb),
  (7,  '{"how":"whole, not juiced"}'::jsonb),
  (8,  '{"household":"one katori","how":"warm, at the end of the shift, before you sleep"}'::jsonb),
  (9,  '{"household":"half a katori","how":"unsalted"}'::jsonb),
  (10, '{"timing":"with_meal","how":"potassium works against the sodium — have it with the last meal"}'::jsonb),
  (11, '{"timing":"with_meal","how":"with the meal that has the most fat in it"}'::jsonb)
) AS d(seq, extra)
WHERE plan_items.plan_id = '91a71702-0000-4000-8000-000000000002'
  AND plan_items.seq = d.seq;

-- ---- Aisha: iron, and the two rules that decide whether it works
UPDATE crm.plan_items SET detail = detail || d.extra FROM (VALUES
  (1,  '{"household":"one glass","how":"fortified soy, not dairy"}'::jsonb),
  (2,  '{"how":"the dates are here for the iron, not as a sweet"}'::jsonb),
  (3,  '{"timing":"after_meal","gapMinutes":120,"how":"after breakfast with the lemon. Keep two hours from tea, coffee and anything with calcium, or most of the iron is lost."}'::jsonb),
  (4,  '{"how":"forty minutes before you run, not on the way out"}'::jsonb),
  (5,  '{"household":"one katori"}'::jsonb),
  (6,  '{"how":"bajra, not wheat — more iron in it"}'::jsonb),
  (7,  '{"household":"one katori","how":"squeeze the lemon on at the table; the vitamin C is what carries the iron in"}'::jsonb),
  (8,  '{"household":"one katori","how":"within half an hour of finishing the run"}'::jsonb),
  (9,  '{"household":"one palmful"}'::jsonb),
  (10, '{"household":"one katori","how":"sesame for the calcium, since there is no dairy in this plan"}'::jsonb),
  (11, '{"timing":"with_meal","gapMinutes":120,"how":"with dinner, and keep it two hours away from the iron"}'::jsonb),
  (13, '{"how":"you should be able to hold a conversation the whole way"}'::jsonb),
  (14, '{"how":"slower than the easy runs, not faster"}'::jsonb),
  (15, '{"how":"stop the set when your form goes, not when it hurts"}'::jsonb),
  (16, '{"how":"two hours either side of the iron tablet"}'::jsonb)
) AS d(seq, extra)
WHERE plan_items.plan_id = '91a71703-0000-4000-8000-000000000003'
  AND plan_items.seq = d.seq;


-- ============================================================
--  WHAT TO EAT BETWEEN MEALS
--  kind = 'filler'. No time on them, not counted against the
--  day, and the answer to the question that breaks most plans
--  in week two: it is four o'clock and I am hungry.
--
--  Each one obeys the same pattern, allergy and limit as that
--  client's meals — a filler is not an exception to the plan.
-- ============================================================

INSERT INTO crm.plan_items
  (plan_id, seq, kind, label, quantity, unit, schedule, status, detail,
   confirmed_by, confirmed_at) VALUES

  -- Sneha: low GI, nothing that spikes
  ('91a71701-0000-4000-8000-000000000001', 20, 'filler', 'Buttermilk, no sugar', 200, 'ml',
   'between meals', 'confirmed',
   '{"household":"one glass","how":"if the gap to the next meal feels long","kcal":60}',
   'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 21, 'filler', 'Cucumber or carrot sticks', 100, 'g',
   'between meals', 'confirmed',
   '{"household":"one bowl","how":"as much as you want of these — they are free","kcal":25}',
   'Khadija', now() - interval '20 days'),
  ('91a71701-0000-4000-8000-000000000001', 22, 'filler', 'A guava or an apple', 1, 'no',
   'between meals', 'confirmed',
   '{"how":"whole fruit, never juice — the juice is the sugar without the brake","kcal":70}',
   'Khadija', now() - interval '20 days'),

  -- Rajat: has to travel in a tiffin, and carry no salt
  ('91a71702-0000-4000-8000-000000000002', 20, 'filler', 'Cucumber and tomato, no salt', 150, 'g',
   'during the shift', 'confirmed',
   '{"household":"one bowl","how":"keep it in the tiffin for the hour before the 3 AM meal","kcal":35}',
   'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 21, 'filler', 'Roasted makhana, unsalted', 20, 'g',
   'during the shift', 'confirmed',
   '{"household":"one fistful","how":"this is what replaces the biscuits at 4 AM","kcal":75}',
   'Khadija', now() - interval '12 days'),
  ('91a71702-0000-4000-8000-000000000002', 22, 'filler', 'Coconut water', 200, 'ml',
   'during the shift', 'confirmed',
   '{"household":"one glass","how":"good for the potassium, and it is not a soft drink","kcal":45}',
   'Khadija', now() - interval '12 days'),

  -- Aisha: no dairy, and iron-aware
  ('91a71703-0000-4000-8000-000000000003', 20, 'filler', 'Roasted chana', 30, 'g',
   'between meals', 'confirmed',
   '{"household":"one fistful","how":"iron and protein in one — the best of these to reach for","kcal":110}',
   'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 21, 'filler', 'An orange or a guava', 1, 'no',
   'between meals', 'confirmed',
   '{"how":"vitamin C, so it helps the iron rather than sitting beside it","kcal":60}',
   'Khadija', now() - interval '11 days'),
  ('91a71703-0000-4000-8000-000000000003', 22, 'filler', 'Two dates and four almonds', 1, 'no',
   'between meals', 'confirmed',
   '{"household":"a small handful","how":"on training days, and especially before an evening run","kcal":140}',
   'Khadija', now() - interval '11 days');


COMMIT;

\echo 'seeded: Sneha (diabetes, veg) · Rajat (nights, hypertension) · Aisha (PCOS, no dairy, running)'
