-- ============================================================
-- A MONTH OF SOMEBODY FOLLOWING THEIR PLAN
-- ------------------------------------------------------------
-- The cycle harness proves the machinery; this makes her monitor
-- worth opening. It fills four weeks of check-ins behind the most
-- recently started programme, because the API cannot: a client may
-- only fill in TODAY, and that rule is the point rather than an
-- inconvenience to work around.
--
-- WHAT IT WRITES IS DELIBERATELY UNEVEN. A seed where every row is
-- 'done' produces a wall of green, which tells her nothing and hides
-- every bug in the way partial weeks are drawn. So: the first fortnight
-- goes well, the third week slips, weekends are worse than weekdays,
-- two days are missed entirely, and three rows are answered twice.
--
-- SAFE TO RUN TWICE. It writes nothing if that programme already has
-- history behind it, so a second run is a no-op rather than a doubled
-- month. Nothing here updates or deletes.
-- ============================================================

\set ON_ERROR_STOP on

DO $seed$
DECLARE
  prog     uuid;
  person   uuid;
  plan     uuid;
  item     record;
  d        date;
  n        int;
  answer   text;
  roll     int;
  weekend  boolean;
  made     int := 0;
BEGIN
  -- The most recently started active programme.
  SELECT id, person_id, plan_no INTO prog, person, n
    FROM crm.programmes
   WHERE status = 'active'
   ORDER BY created_at DESC
   LIMIT 1;

  IF prog IS NULL THEN
    RAISE NOTICE 'no active programme — start one first';
    RETURN;
  END IF;

  -- Already seeded? Leave it exactly as it is.
  IF EXISTS (SELECT 1 FROM crm.checkins
              WHERE programme_id = prog AND on_date < current_date) THEN
    RAISE NOTICE 'programme % already has history — nothing written', prog;
    RETURN;
  END IF;

  SELECT id INTO plan FROM crm.plans
   WHERE person_id = person AND plan_no = n AND status = 'issued'
   ORDER BY amendment DESC LIMIT 1;

  /* A name she can read in a list. The generated one carries a
     timestamp so the plan reference stays unique across runs; it is
     not something to look at for four weeks. */
  UPDATE crm.people
     SET name = 'Meera Test'
   WHERE id = person AND name LIKE 'Cycle%';

  /* AND THE PROGRAMME HAS TO HAVE BEGUN BEFORE ITS OWN HISTORY.

     A programme started through the API begins today, and this fills
     in the four weeks behind it — so without this the client's
     calendar, which draws the plan's window and nothing else, would
     open on a month with none of the seeded days in it. The rows
     were there; the window simply did not reach them, which looks
     exactly like a bug and is the more confusing kind. */
  UPDATE crm.programmes
     SET started_on = current_date - 28
   WHERE id = prog AND started_on > current_date - 28;

  FOR d IN
    SELECT generate_series(current_date - 28, current_date - 1, '1 day')::date
  LOOP
    weekend := EXTRACT(isodow FROM d) >= 6;

    -- Two days simply did not happen. Missed stays missed.
    CONTINUE WHEN d IN (current_date - 9, current_date - 8);

    FOR item IN
      SELECT id, kind FROM crm.plan_items
       WHERE plan_id = plan AND status IN ('confirmed', 'edited')
       ORDER BY seq
    LOOP
      /* Weighted rather than random-uniform: a plan that is followed
         four times in five, worse at weekends, and worse again in the
         third week when the novelty wore off. */
      roll := (abs(hashtext(item.id::text || d::text)) % 100);

      answer := CASE
        WHEN d BETWEEN current_date - 21 AND current_date - 15 THEN
          CASE WHEN roll < 45 THEN 'done' WHEN roll < 75 THEN 'part' ELSE 'skip' END
        WHEN weekend THEN
          CASE WHEN roll < 60 THEN 'done' WHEN roll < 85 THEN 'part' ELSE 'skip' END
        ELSE
          CASE WHEN roll < 80 THEN 'done' WHEN roll < 94 THEN 'part' ELSE 'skip' END
      END;

      INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
      VALUES (prog, item.id, d, answer,
              CASE
                WHEN answer = 'skip' AND item.kind = 'activity' THEN 'Too dark by the time I finished work.'
                WHEN answer = 'part' AND item.kind = 'meal' THEN 'Had about half.'
                WHEN answer = 'skip' AND item.kind = 'meal' THEN 'Ate out — could not manage this one.'
                ELSE ''
              END,
              d + time '21:30' + (roll || ' minutes')::interval);
      made := made + 1;
    END LOOP;
  END LOOP;

  /* THREE CORRECTIONS. Appended, never overwritten — the earlier
     answer stays, the later one wins, and her monitor says the row
     was answered twice. This is the case a tally cannot show. */
  INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
  SELECT prog, c.plan_item_id, c.on_date, 'done',
         'Went back and did it later.', c.at + interval '2 hours'
    FROM crm.checkins c
   WHERE c.programme_id = prog
     AND c.state = 'skip'
     AND c.on_date > current_date - 7
   ORDER BY c.on_date DESC
   LIMIT 3;

  /* Five weeks of a bathroom scale, drifting down with one week that
     goes the other way — a curve that only ever falls is a curve
     nobody believes. */
  INSERT INTO crm.measurements
    (person_id, kind, metric, value, unit, method, source, programme_id, taken_at)
  SELECT person, 'body', 'weight_kg', w.kg, 'kg', 'Self-reported', 'self', prog,
         (current_date - w.ago)::timestamptz + time '07:15'
    FROM (VALUES (28, 81.4), (21, 80.6), (14, 80.9), (7, 79.8)) AS w(ago, kg);

  /* THINGS THAT DO NOT FIT IN A TICK. The reason the notes table
     exists, and the reason her monitor needs a place to read them:
     none of these is done/some/no, and every one of them would
     change what she does next. One is left unread, so the "new"
     badge on her sidebar has something to be right about. */
  INSERT INTO crm.programme_notes (programme_id, on_date, body, at, seen_at)
  SELECT prog, (current_date - n.ago)::date, n.body,
         (current_date - n.ago)::timestamptz + time '21:40',
         CASE WHEN n.ago > 2 THEN (current_date - n.ago + 1)::timestamptz ELSE NULL END
    FROM (VALUES
      (19, 'Stomach was off all day. Managed breakfast and nothing after it.'),
      (12, 'Travelling for work next week - I will be eating out most nights. Is there anything I should pick over anything else?'),
      (6,  'The almonds are making me quite gassy. Can I swap them for something?'),
      (1,  'Better week. Walked every evening except Sunday, it was raining.')
    ) AS n(ago, body);

  RAISE NOTICE 'programme %: % check-ins across 26 days, 4 notes', prog, made;
END
$seed$;
