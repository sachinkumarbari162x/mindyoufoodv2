-- ============================================================
--  0004 — WHAT TO EAT WHEN YOU ARE HUNGRY
-- ------------------------------------------------------------
--  One widened CHECK, and it buys a whole category of
--  instruction the plan could not hold before.
--
--  A plan with four meals and nothing between them is a plan
--  that breaks at four o'clock. Until now the only place to put
--  "a glass of buttermilk if you are hungry" was as a fifth meal
--  — which then shows on the client's screen as a meal they
--  missed every single day they were not hungry — or as a
--  `habit`, where it is filed next to "weigh yourself on Monday"
--  and nobody looks for food there.
--
--  `filler` is its own kind because it behaves differently in
--  every direction: it has no time, it is conditional, it is not
--  counted against the day, and it needs its own heading on the
--  page. A boolean in `detail` would have done none of that and
--  would have left every screen writing the same special case.
--
--  The rest of what this feature needs — the household measure,
--  the intake instruction, the supplement timing and the gap —
--  needs no migration at all. plan_items.detail is jsonb and has
--  been there since 0003; it simply had nothing writing to it
--  until now.
--
--  Applied by the embedded migrator on boot. Rebuild godata.exe
--  after adding this file or it will not exist for Go to run.
-- ============================================================

ALTER TABLE crm.plan_items DROP CONSTRAINT IF EXISTS plan_items_kind_check;

ALTER TABLE crm.plan_items
  ADD CONSTRAINT plan_items_kind_check
  CHECK (kind IN ('meal', 'filler', 'supplement', 'activity', 'sleep', 'habit', 'other'));

COMMENT ON COLUMN crm.plan_items.kind IS
  'meal = a scheduled eating occasion. filler = what to eat between them, if hungry — no time, not counted against the day. supplement, activity, sleep, habit, other as named.';

COMMENT ON COLUMN crm.plan_items.detail IS
  'Kind-specific, and absent rather than null when empty. meal/filler: {meal, time, kcal, days, household, how}. supplement: {timing, gapMinutes, household, how}. activity: {days, sets, reps, restSeconds, how}. sleep: {from, to, hours}.';
