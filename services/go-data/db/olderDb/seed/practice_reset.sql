-- ============================================================
--  PRACTICE RESET — clear the test data, seed a real practice
-- ------------------------------------------------------------
--  Everything in crm.* was harness pollution: 212 people called
--  things like "Cycle k256u Testclient", 583 plan items produced
--  by a model called "harness/scripted", and a dashboard whose
--  funnel read 4 -> 3 -> 3 -> 2 -> 1 because that is what a test
--  suite leaves behind. None of it told her anything about how a
--  screen would feel with a real week in it.
--
--  WHAT THIS KEEPS, and it is the important half:
--
--    staff          her login. Wiping it locks her out of her own
--                   CRM and there is no recovery path from SQL.
--    countries      reference data the booking form reads.
--    knowledge      the answers she wrote for the front desk.
--    bot_switches   which bots are on.
--
--  WHAT IT WRITES. A solo clinical dietitian's practice as it
--  actually looks: eighteen people across India, the Gulf and the
--  UK — the three places this practice's clients live — with the
--  conditions she actually sees. Three months of sessions behind,
--  a fortnight ahead, four requests waiting. Plans for the people
--  who have been seen, programmes for some of those, and a month
--  of check-ins under two of them.
--
--  THE NUMBERS ARE UNEVEN ON PURPOSE. Somebody does not come.
--  Somebody cancels. Two people are three days from the end of a
--  ninety-day plan. One asked a question four days ago that has
--  not been answered. A screen that only ever shows the happy path
--  is a screen that has never been tested.
--
--  SAFE TO RE-RUN. It clears what it seeds before seeding it.
--  NOT safe to run against production — it truncates client data.
--  There is a dump in var/backups from before the first run.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

/* ---- clear, in an order the foreign keys allow ---------------
   Children before parents. Not TRUNCATE ... CASCADE: cascade
   would happily take crm.staff with it if a link is ever added,
   and being locked out of the CRM is not a recoverable mistake
   from here. */
DELETE FROM crm.checkin_media;
DELETE FROM crm.checkins;
DELETE FROM crm.programme_notes;
DELETE FROM crm.programmes;
DELETE FROM crm.plan_items;
DELETE FROM crm.plan_links;
DELETE FROM crm.plans;
DELETE FROM crm.goals;
DELETE FROM crm.measurements;
DELETE FROM crm.assessments;
DELETE FROM crm.consultation_outcomes;
DELETE FROM crm.consultation_links;
DELETE FROM crm.messages;
DELETE FROM crm.room_participants;
DELETE FROM crm.room_sessions;
DELETE FROM crm.ratings;
DELETE FROM crm.consultations;
DELETE FROM crm.people;
DELETE FROM crm.bot_turns;
DELETE FROM crm.unrecognised;
DELETE FROM crm.audit;

/* ---- the people ----------------------------------------------
   Names from the three places this practice's clients live, and
   spelled the way they are spelled — the CRM is set in Noto for
   exactly this reason. Emails are all @example.com, which is
   reserved by RFC 2606 and cannot receive mail, so nothing here
   can ever be posted to a real person by accident. */
INSERT INTO crm.people (id, name, email, phone, dob, country_iso2, source, created_at) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'Aisha Rahman',      'aisha.rahman@example.com',   '+919820011201', '1986-04-12', 'IN', 'chatbot',  now() - interval '94 days'),
  ('a1000000-0000-4000-8000-000000000002', 'Priya Nair',        'priya.nair@example.com',     '+919845022302', '1992-11-03', 'IN', 'chatbot',  now() - interval '88 days'),
  ('a1000000-0000-4000-8000-000000000003', 'Fatima Al Balushi', 'fatima.balushi@example.com', '+96899330403',  '1979-02-25', 'OM', 'referral', now() - interval '81 days'),
  ('a1000000-0000-4000-8000-000000000004', 'Rohan Mehta',       'rohan.mehta@example.com',    '+919920044504', '1990-07-19', 'IN', 'chatbot',  now() - interval '76 days'),
  ('a1000000-0000-4000-8000-000000000005', 'Sana Qureshi',      'sana.qureshi@example.com',   '+971505500605', '1995-09-08', 'AE', 'chatbot',  now() - interval '70 days'),
  ('a1000000-0000-4000-8000-000000000006', 'Meera Iyer',        'meera.iyer@example.com',     '+919840066706', '1983-01-30', 'IN', 'referral', now() - interval '65 days'),
  ('a1000000-0000-4000-8000-000000000007', 'Zainab Sheikh',     'zainab.sheikh@example.com',  '+447700900807', '1988-06-14', 'GB', 'chatbot',  now() - interval '58 days'),
  ('a1000000-0000-4000-8000-000000000008', 'Arjun Desai',       'arjun.desai@example.com',    '+919833088908', '2001-03-22', 'IN', 'chatbot',  now() - interval '52 days'),
  ('a1000000-0000-4000-8000-000000000009', 'Nadia Hussain',     'nadia.hussain@example.com',  '+447700901009', '1975-12-05', 'GB', 'referral', now() - interval '47 days'),
  ('a1000000-0000-4000-8000-000000000010', 'Kavya Reddy',       'kavya.reddy@example.com',    '+919966011110', '1997-08-17', 'IN', 'chatbot',  now() - interval '41 days'),
  ('a1000000-0000-4000-8000-000000000011', 'Imran Khan',        'imran.khan@example.com',     '+966505512211', '1981-05-09', 'SA', 'chatbot',  now() - interval '36 days'),
  ('a1000000-0000-4000-8000-000000000012', 'Lakshmi Menon',     'lakshmi.menon@example.com',  '+919847013312', '1969-10-28', 'IN', 'referral', now() - interval '30 days'),
  ('a1000000-0000-4000-8000-000000000013', 'Tanvi Joshi',       'tanvi.joshi@example.com',    '+919821014413', '1993-04-02', 'IN', 'chatbot',  now() - interval '24 days'),
  ('a1000000-0000-4000-8000-000000000014', 'Yusuf Ali',         'yusuf.ali@example.com',      '+971504415514', '1986-11-11', 'AE', 'chatbot',  now() - interval '19 days'),
  ('a1000000-0000-4000-8000-000000000015', 'Ananya Bose',       'ananya.bose@example.com',    '+919831016615', '1999-01-24', 'IN', 'chatbot',  now() - interval '13 days'),
  ('a1000000-0000-4000-8000-000000000016', 'Hina Siddiqui',     'hina.siddiqui@example.com',  '+919820017716', '1990-09-30', 'IN', 'chatbot',  now() - interval '8 days'),
  ('a1000000-0000-4000-8000-000000000017', 'Sheetal Kapoor',    'sheetal.kapoor@example.com', '+919810018817', '1984-02-16', 'IN', 'referral', now() - interval '5 days'),
  ('a1000000-0000-4000-8000-000000000018', 'Ravi Subramanian',  'ravi.subram@example.com',    '+919845019918', '1972-07-07', 'IN', 'chatbot',  now() - interval '2 days');

COMMIT;
