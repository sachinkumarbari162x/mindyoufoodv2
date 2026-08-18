-- ============================================================
--  SOFIA, THREE WEEKS INTO HER PROGRAMME
-- ------------------------------------------------------------
--  Run after she has been issued a plan and the programme has
--  started. It backdates the programme to the day after her
--  consultation and fills the days between then and now, which
--  the API cannot do: a client may only fill in TODAY, and that
--  rule is the point rather than an inconvenience to work around.
--
--  WHY IT IS NEEDED AT ALL. A programme started this morning has
--  no history, and every screen built to show a course over time —
--  the ring, the day-by-day grid, the weight line, the thread —
--  then shows an empty state. Those are the states least worth
--  looking at and the ones a fresh fixture always produces.
--
--  DELIBERATELY UNEVEN. A seed where every row is 'done' is a wall
--  of green that tells her nothing and hides every bug in the way
--  partial days are drawn. So the first fortnight goes well, the
--  third week slips, weekends are worse than weekdays, one day is
--  missed entirely, and today is left unanswered — because the
--  first thing she should see on opening the app is something to
--  do.
--
--  IT ONLY EVER TOUCHES SOFIA, by person id. programme_history.sql
--  picks "the most recently started programme", which on a machine
--  full of harness clients is somebody else.
--
--      psql -d myf_trial -f .../sofia_programme_history.sql
--
--  Safe to run twice: it clears her own history first.
-- ============================================================

\set ON_ERROR_STOP on
\set sofia '''ca466ca3-fa88-4508-ba1c-863b048d9a9c'''

BEGIN;

DO $seed$
DECLARE
  prog    uuid;
  started date := CURRENT_DATE - 20;   -- the day after her consultation
  item    record;
  d       date;
  n       int;
  state   text;
BEGIN
  SELECT id INTO prog
    FROM crm.programmes
   WHERE person_id = 'ca466ca3-fa88-4508-ba1c-863b048d9a9c'
     AND status = 'active'
   ORDER BY created_at DESC
   LIMIT 1;

  IF prog IS NULL THEN
    RAISE NOTICE 'Sofia has no active programme — issue a plan and start one first';
    RETURN;
  END IF;

  -- Start again rather than adding to whatever is there.
  DELETE FROM crm.checkin_media WHERE checkin_id IN (SELECT id FROM crm.checkins WHERE programme_id = prog);
  DELETE FROM crm.checkins       WHERE programme_id = prog;
  DELETE FROM crm.programme_notes WHERE programme_id = prog;

  UPDATE crm.programmes
     SET started_on  = started,
         ends_on     = started + length_days - 1,
         opened_at   = started + 1,
         open_count  = 34
   WHERE id = prog;

  /* ---- the days ------------------------------------------------
     n is how far through she is. The pattern below is a person
     rather than a distribution: keen at first, slipping in the
     third week when the rota turned, and the weekend rows worse
     than the weekday ones throughout. */
  FOR item IN
    SELECT pi.id, pi.kind
      FROM crm.plan_items pi
      JOIN crm.plans p ON p.id = pi.plan_id
     WHERE p.person_id = 'ca466ca3-fa88-4508-ba1c-863b048d9a9c'
       AND pi.status = 'confirmed'
  LOOP
    d := started;
    WHILE d < CURRENT_DATE LOOP
      n := d - started;

      /* One day missed entirely — the night she was called in. */
      IF n = 9 THEN
        d := d + 1;
        CONTINUE;
      END IF;

      state := CASE
        /* The first fortnight: mostly done, and worse at weekends,
           which is true of nearly everybody. The wobble is derived
           from the day and the row rather than from random(), so
           two runs of this file produce the same picture — a
           fixture that changes under you is not a fixture. */
        WHEN n < 14 AND EXTRACT(dow FROM d) IN (0, 6) THEN
          CASE WHEN (n + length(item.kind)) % 3 = 0 THEN 'part' ELSE 'done' END
        WHEN n < 14 THEN
          CASE WHEN n % 7 = 3 AND item.kind = 'activity' THEN 'part' ELSE 'done' END
        /* The third week, when the rota turned. */
        WHEN item.kind IN ('activity', 'sleep') THEN
          CASE WHEN n % 3 = 0 THEN 'skip' ELSE 'part' END
        WHEN item.kind = 'supplement' THEN 'done'
        ELSE
          CASE WHEN n % 4 = 0 THEN 'part' ELSE 'done' END
      END;

      INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, at)
      VALUES (prog, item.id, d, state, d + interval '21 hours');

      d := d + 1;
    END LOOP;
  END LOOP;

  /* ---- what they said to each other -----------------------------
     Hers, and Khadija's answers. Spread across the three weeks so
     the Messages tab has more than one day in it, which is the
     whole point of that screen. */
  INSERT INTO crm.programme_notes (programme_id, on_date, body, author, by, at) VALUES
    (prog, started + 2,
     'Started today. The 7pm meal before the shift is much easier than I expected — Mum made the poha.',
     'client', NULL, started + 2 + interval '22 hours'),

    (prog, started + 3,
     'Good. Keep the protein at that first occasion — it is what stops the 3am biscuits.',
     'practitioner', 'Khadija', started + 3 + interval '10 hours'),

    (prog, started + 8,
     'Managed the chana at 3am four nights out of six. Still very tired around then but not raiding the tin.',
     'client', NULL, started + 8 + interval '23 hours'),

    (prog, started + 9,
     'Four out of six is the win here, not six out of six. Tiredness at 3am is the shift, not the food.',
     'practitioner', 'Khadija', started + 9 + interval '9 hours'),

    (prog, started + 15,
     'Rota changed and I have been on days. The walk has not happened once this week, sorry.',
     'client', NULL, started + 15 + interval '20 hours'),

    (prog, started + 16,
     'Do not apologise. Leave the walk for now and hold the four eating occasions — that is the one that matters.',
     'practitioner', 'Khadija', started + 16 + interval '11 hours'),

    (prog, CURRENT_DATE - 1,
     'Back on nights from Thursday. Bowels much better since the fibre went up.',
     'client', NULL, CURRENT_DATE - 1 + interval '21 hours');

  /* ---- what the scales said ------------------------------------
     Self-reported, weekly, from the app — which is the only source
     the client's own Progress tab will show. */
  INSERT INTO crm.measurements
    (person_id, kind, metric, value, unit, method, source, programme_id, taken_at)
  VALUES
    ('ca466ca3-fa88-4508-ba1c-863b048d9a9c', 'body', 'weight_kg', 76.4, 'kg', 'Self-reported', 'self', prog, started + 1),
    ('ca466ca3-fa88-4508-ba1c-863b048d9a9c', 'body', 'weight_kg', 75.9, 'kg', 'Self-reported', 'self', prog, started + 8),
    ('ca466ca3-fa88-4508-ba1c-863b048d9a9c', 'body', 'weight_kg', 75.5, 'kg', 'Self-reported', 'self', prog, started + 15);

  RAISE NOTICE 'programme %: % check-ins over % days, % notes, 3 weights',
    prog,
    (SELECT count(*) FROM crm.checkins WHERE programme_id = prog),
    (SELECT count(DISTINCT on_date) FROM crm.checkins WHERE programme_id = prog),
    (SELECT count(*) FROM crm.programme_notes WHERE programme_id = prog);
END
$seed$;

COMMIT;
