-- ============================================================
--  PRACTICE HISTORY — the weeks behind the programmes
-- ------------------------------------------------------------
--  Runs last, after practice_records.mjs.
--
--  IN SQL BECAUSE THE API IS RIGHT TO REFUSE IT. A client may
--  only fill in today — that is the rule the check-in exists
--  under, and it is a feature rather than an obstacle: let
--  somebody backfill last Tuesday and the record stops being a
--  record and becomes a memory test. So the API cannot write
--  these, and a seed that wants a month of use has to reach past
--  it. Nothing else in the system does.
--
--  Every programme is BACKDATED to match its history. A programme
--  started through the API begins today, and the client's app
--  draws the plan's own window — so without this, four weeks of
--  check-ins would sit outside the calendar that is meant to show
--  them, which looks exactly like a bug and is the confusing kind.
--
--  THE ADHERENCE IS DELIBERATELY UNEVEN. Somebody is nearly
--  perfect. Somebody started well and drifted. Two people are
--  days from the end. One asked a question four days ago that has
--  not been answered — because an inbox with nothing waiting in
--  it tells you nothing about how the screen behaves when
--  something is.
--
--  Safe to re-run: it clears the history it writes first.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

DELETE FROM crm.checkin_media;
DELETE FROM crm.checkins;
DELETE FROM crm.programme_notes;
DELETE FROM crm.measurements WHERE source = 'self';

/* ---- where each programme is in its course -------------------
   Set from how far through it should read, so the seed produces
   the situations worth looking at rather than nine identical
   week-ones: two nearly finished, one just begun, the rest in the
   middle. */
UPDATE crm.programmes p SET started_on = current_date - x.ago
  FROM (VALUES
    ('aisharahmanp0_0',      34),   -- day 35 of 90
    ('priyanairp0_0',        45),   -- day 46 of 60
    ('fatimaalbaluship0_0',  86),   -- day 87 of 90 — nearly done
    ('rohanmehtap0_0',       21),   -- day 22 of 90
    ('sanaqureship0_0',      56),   -- day 57 of 60 — nearly done
    ('meeraiyerp0_0',        12),   -- day 13 of 60
    ('arjundesaip0_0',        6),   -- day 7 of 90
    ('imrankhanp0_0',        27),   -- day 28 of 30 — nearly done
    ('lakshmimenonp0_0',      2)    -- day 3 of 30 — just begun
  ) AS x(ref, ago)
 WHERE p.plan_no = (SELECT pl.plan_no FROM crm.plans pl WHERE pl.ref = x.ref)
   AND p.person_id = (SELECT pl.person_id FROM crm.plans pl WHERE pl.ref = x.ref);

/* And they have been opened. open_count is what tells her whether
   somebody is actually using the app, so leaving it at zero on a
   programme with a month of ticks would be a contradiction. */
UPDATE crm.programmes
   SET opened_at  = started_on::timestamptz + interval '9 hours',
       open_count = GREATEST(1, (current_date - started_on) * 2 - 3)
 WHERE status = 'active';

COMMIT;

/* ---- the ticks ------------------------------------------------ */

DO $hist$
DECLARE
  prog    record;
  item    record;
  d       date;
  roll    int;
  answer  text;
  drift   numeric;
  made    int := 0;
BEGIN
  FOR prog IN
    SELECT p.id, p.person_id, p.plan_no, p.started_on, p.length_days,
           /* How diligent this person is. Derived from the id rather
              than drawn at random, so the same seed reads the same
              way twice — a dashboard that moves when nothing
              happened is a dashboard nobody trusts.

              THE FLOOR IS 0.70, and it was 0.55. That band put
              somebody at thirteen done against thirteen skipped
              while her own messages in the thread said the plan was
              working — numbers telling one story and words telling
              another, which is worse than either being wrong. These
              are people who booked a dietitian and are three weeks
              in; they are engaged and imperfect, not indifferent. */
           (0.70 + ((abs(hashtext(p.id::text)) % 20) / 100.0))::numeric AS diligence
      FROM crm.programmes p
     WHERE p.status = 'active'
  LOOP
    FOR d IN
      SELECT generate_series(prog.started_on, current_date - 1, '1 day')::date
    LOOP
      /* Nobody is at their best in week three. The dip is real
         enough that she should be able to see it on the monitor. */
      drift := CASE
        WHEN d BETWEEN prog.started_on + 14 AND prog.started_on + 22 THEN -0.20
        WHEN EXTRACT(isodow FROM d) >= 6 THEN -0.12
        ELSE 0
      END;

      -- Two days that simply did not happen.
      CONTINUE WHEN d IN (prog.started_on + 9, prog.started_on + 17);

      FOR item IN
        SELECT i.id, i.kind
          FROM crm.plan_items i
          JOIN crm.plans pl ON pl.id = i.plan_id
         WHERE pl.person_id = prog.person_id
           AND pl.plan_no = prog.plan_no
           AND pl.status = 'issued'
           AND i.status IN ('confirmed', 'edited')
         ORDER BY i.seq
      LOOP
        roll := (abs(hashtext(item.id::text || d::text)) % 100);

        answer := CASE
          WHEN roll < (prog.diligence + drift) * 100 THEN 'done'
          WHEN roll < (prog.diligence + drift) * 100 + 22 THEN 'part'
          ELSE 'skip'
        END;

        INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
        VALUES (prog.id, item.id, d, answer,
                CASE
                  WHEN answer = 'skip' AND item.kind = 'activity' THEN 'Too dark by the time I finished work.'
                  WHEN answer = 'part' AND item.kind = 'meal'     THEN 'Had about half of it.'
                  WHEN answer = 'skip' AND item.kind = 'meal'     THEN 'Ate out — could not manage this one.'
                  WHEN answer = 'skip' AND item.kind = 'supplement' THEN 'Ran out, picking more up tomorrow.'
                  ELSE ''
                END,
                d + time '21:20' + (roll || ' minutes')::interval);
        made := made + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  /* CORRECTIONS. Append-only: the earlier answer stays, the later
     one wins, and her monitor says the row was answered twice.
     This is the case a tally cannot show. */
  INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
  SELECT c.programme_id, c.plan_item_id, c.on_date, 'done',
         'Went back and did it later.', c.at + interval '2 hours'
    FROM crm.checkins c
   WHERE c.state = 'skip'
     AND c.on_date > current_date - 6
   ORDER BY c.on_date DESC
   LIMIT 7;

  RAISE NOTICE '% check-ins written', made;
END
$hist$;

/* ---- what the scales said ------------------------------------
   Weekly, from the app, and never in a straight line. A curve
   that only ever falls is a curve nobody believes.

   BEGIN again: the DO block above ends its own transaction, so
   without this the INSERT runs unwrapped and the COMMIT below
   warns that there is nothing in progress. */
BEGIN;

INSERT INTO crm.measurements
  (person_id, kind, metric, value, unit, method, source, programme_id, taken_at)
SELECT p.person_id, 'body', 'weight_kg',
       (t.start_kg - (w.n * t.per_week) + ((w.n % 3) - 1) * 0.4)::numeric(6,2),
       'kg', 'Self-reported', 'self', p.id,
       (p.started_on + (w.n * 7))::timestamptz + time '07:15'
  FROM crm.programmes p
  JOIN crm.plans pl ON pl.person_id = p.person_id AND pl.plan_no = p.plan_no AND pl.status = 'issued'
  JOIN (VALUES
    ('aisharahmanp0_0',     81.2, 0.35),
    ('priyanairp0_0',       88.6, 0.45),
    ('fatimaalbaluship0_0', 84.9, 0.30),
    ('rohanmehtap0_0',      67.4, 0.05),
    ('sanaqureship0_0',     59.8, 0.10),
    ('meeraiyerp0_0',       74.1, 0.25),
    ('arjundesaip0_0',      61.0, -0.30),
    ('imrankhanp0_0',       95.3, 0.40),
    ('lakshmimenonp0_0',    62.5, 0.10)
  ) AS t(ref, start_kg, per_week) ON t.ref = pl.ref
  CROSS JOIN generate_series(0, 12) AS w(n)
 WHERE p.status = 'active'
   AND (p.started_on + (w.n * 7)) <= current_date;

COMMIT;
