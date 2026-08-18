-- ============================================================
--  PRACTICE CONVERSATION — what clients said, and what she said
-- ------------------------------------------------------------
--  Runs after practice_history.sql.
--
--  The other direction. A check-in answers a question she asked;
--  these are the things people wanted to tell her that no row on
--  the plan has a box for — and every one of them would change
--  what she does next.
--
--  ONE IS LEFT UNANSWERED, four days old, and that is the point
--  of seeding this at all. An inbox with nothing waiting in it
--  tells you nothing about how the screen behaves when something
--  is: the unread badge, the amber "New", the reply box. This is
--  the state worth looking at, so it is the state the seed
--  produces.
--
--  Her replies carry her name because the database insists —
--  programme_notes_reply_has_who, migration 0027. A line in a
--  client's record can never be traced to "the system".
--
--  Safe to re-run: practice_history.sql clears the table first.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

/* Written against the plan reference rather than a uuid, so the
   file reads as a conversation with a named person rather than a
   list of keys — and so it survives the ids changing. */
INSERT INTO crm.programme_notes (programme_id, on_date, body, author, by, at, seen_at)
SELECT p.id,
       (current_date - n.ago)::date,
       n.body,
       n.author,
       CASE WHEN n.author = 'practitioner' THEN 'khadija@mindyourfood.co.in' END,
       (current_date - n.ago)::timestamptz + n.at_time,
       CASE WHEN n.seen THEN (current_date - n.ago + 1)::timestamptz + time '08:00' END
  FROM crm.programmes p
  JOIN crm.plans pl
    ON pl.person_id = p.person_id AND pl.plan_no = p.plan_no AND pl.status = 'issued'
  JOIN (VALUES
    -- Aisha, thirty-five days into ninety
    ('aisharahmanp0_0', 26, time '21:40', 'client',
     'The almonds are making me quite bloated. Can I swap them for something else?', true),
    ('aisharahmanp0_0', 25, time '19:10', 'practitioner',
     'Swap them for a small handful of walnuts or roasted chana and see if that settles. Tell me next week either way.', true),
    ('aisharahmanp0_0', 18, time '22:05', 'client',
     'Walnuts are much better, no bloating at all. Periods came on time this month which has not happened in a while.', true),
    ('aisharahmanp0_0',  3, time '20:15', 'client',
     'Travelling to Delhi next week for work, will be eating out most nights. Anything I should pick over anything else?', true),
    ('aisharahmanp0_0',  2, time '18:30', 'practitioner',
     'Ask for the roti dry and skip the naan and the rice at dinner. Tandoori over anything in a gravy. Do not worry about being perfect for four days.', true),

    -- Fatima, three days from the end of ninety
    ('fatimaalbaluship0_0', 12, time '20:50', 'client',
     'My fasting sugars have been between 5.8 and 6.4 all week. Lowest they have been in two years.', true),
    ('fatimaalbaluship0_0', 11, time '17:45', 'practitioner',
     'That is a real change and it is yours. Bring the last month of readings to the review and we will talk to your GP about the metformin together.', true),

    -- Sana, three days from the end of sixty
    ('sanaqureship0_0', 9, time '21:15', 'client',
     'Reintroduced onion this week and it was fine. Garlic was not — cramping within an hour.', true),
    ('sanaqureship0_0', 8, time '19:20', 'practitioner',
     'Useful to know, and quite common to split like that. Leave garlic out for now and we will try it again in a month.', true),

    -- Rohan, three weeks in
    ('rohanmehtap0_0', 5, time '06:40', 'client',
     'Did 16k on Sunday and felt strong the whole way. The banana before is making a real difference.', true),

    -- Imran, two days from the end of thirty
    ('imrankhanp0_0', 7, time '02:30', 'client',
     'Night shifts have been brutal this week and I have been skipping the walk. Everything else is holding.', true),
    ('imrankhanp0_0', 6, time '18:00', 'practitioner',
     'The walk matters less than the meals here, so do not let it become the reason you drop the rest. Ten minutes after your main meal is plenty on a bad week.', true),

    -- AND THE ONE STILL WAITING. Four days old, unanswered.
    ('priyanairp0_0', 4, time '22:20', 'client',
     'I have gained a kilo this week even though I have stuck to everything. Should I cut the roti at dinner? Starting to feel like it is not working.', false)
  ) AS n(ref, ago, at_time, author, body, seen) ON n.ref = pl.ref
 WHERE p.status = 'active';

COMMIT;
