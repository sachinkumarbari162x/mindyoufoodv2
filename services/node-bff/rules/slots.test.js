/* ============================================================
   SLOT PARSING — regression tests

       node --test services/node-bff/rules/slots.test.js

   Name the FILE, not the directory. `node --test <dir>` fails on
   Windows with MODULE_NOT_FOUND — it tries to load the directory
   itself rather than discovering the tests inside it.

   Node's built-in runner, so this adds no dependency — the same
   rule the rest of the service follows.

   The clock is FIXED to a known Wednesday. Every expectation here
   is relative to "today", so a test written against the real date
   passes in the week it was written and fails the next.
   ============================================================ */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const slots = require("./slots");

// Wednesday 12 August 2026, midday UTC.
const NOW = new Date("2026-08-12T12:00:00Z");

const dates = (text) => slots.parseSlots(text, NOW).map((f) => f.slot.date);

/* ---- the bug this file was written for ---------------------- */

test('a weekday beside a date is describing it, not proposing another', () => {
  // "Thursday 20 August" is ONE date. Rule 2 reads "20 aug" and rule 4
  // reads "thursday"; the two matches do not overlap in the text, so
  // neither could tell the other had spoken for the phrase. The result
  // was a phantom slot on the NEXT Thursday — a time the visitor never
  // offered, passed to the practitioner as though they had.
  assert.deepStrictEqual(dates("Thursday 20 August 4pm"), ["2026-08-20"]);
});

test('the full reported case: one real slot plus a separate offer', () => {
  const got = slots.parseSlots("Thursday 20 August 4pm, or Sunday morning", NOW);
  assert.strictEqual(got.length, 2, "should be two proposals, not three");
  assert.deepStrictEqual(
    got.map((f) => f.slot.date),
    ["2026-08-20", "2026-08-16"]
  );
});

/* ---- what the fix must not break ---------------------------- */

test('two bare weekdays are still two proposals', () => {
  assert.deepStrictEqual(dates("Thursday or Friday at 4pm"), ["2026-08-13", "2026-08-14"]);
});

test('a date and a genuinely separate weekday both survive', () => {
  // Split on "or" before parsing, so these arrive as different clauses
  // and the suppression above never sees them together.
  assert.deepStrictEqual(dates("20 August or Friday"), ["2026-08-20", "2026-08-14"]);
});

test('a qualified weekday on its own still resolves', () => {
  assert.deepStrictEqual(dates("next Tuesday at 11"), ["2026-08-25"]);
});

test('relative dates still work', () => {
  assert.deepStrictEqual(dates("tomorrow at 3pm"), ["2026-08-13"]);
});

test('an explicit ISO date still works', () => {
  assert.deepStrictEqual(dates("2026-08-19 at 10am"), ["2026-08-19"]);
});

test('vague but usable phrases are kept in the visitor\'s words', () => {
  const got = slots.parseSlots("weekday evenings", NOW);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].slot.date, undefined, "no date to invent");
  assert.match(got[0].slot.label, /weekday evenings/i);
});

/* ---- the desk must be able to read back its own chips --------
   The quick replies are generated from the slot engine in the form
   "Thursday 13 Aug · 12:00". Tapping one sends that exact text back,
   so if the parser cannot read its own label the visitor picks a
   time and the desk loses it. This is a round trip, and it has to
   be tested as one. */

test('a month followed by a clock time is not a second date', () => {
  // "13 Aug 12:00" produced BOTH the 13th and the 12th: the "aug 12"
  // matcher read the hour as a day of the month. The 12th was today,
  // so the desk answered "that has already passed" — refusing a slot
  // it had itself just offered a moment earlier.
  assert.deepStrictEqual(dates("Thursday 13 Aug 12:00"), ["2026-08-13"]);
});

test('a bare 24-hour time is recognised', () => {
  const [first] = slots.parseSlots("Thursday 13 Aug 12:00", NOW);
  assert.strictEqual(first.slot.time, "12:00", "the time must survive, not just the date");
});

test('every label the desk offers parses back to the same slot', () => {
  // Exactly the shape services/go-data/slots.go emits.
  for (const [label, date, time] of [
    ["Thursday 13 Aug · 12:00", "2026-08-13", "12:00"],
    ["Monday 17 Aug · 10:00", "2026-08-17", "10:00"],
    ["Saturday 15 Aug · 16:00", "2026-08-15", "16:00"],
  ]) {
    const got = slots.parseSlots(label, NOW);
    assert.strictEqual(got.length, 1, `${label} should be one slot, got ${got.length}`);
    assert.strictEqual(got[0].slot.date, date, label);
    assert.strictEqual(got[0].slot.time, time, label);
  }
});

/* ---- things that must never be read as an offer -------------- */

test('a date in the past is recorded, so it can be refused', () => {
  // Not silently dropped: left unmatched it fell through to the
  // bare-time rule and became "any day, around 4pm" — the desk hearing
  // something the visitor never said. validateSlot rejects it later
  // with an honest "that has already passed".
  assert.deepStrictEqual(dates("yesterday at 4pm"), ["2026-08-11"]);
});

test('never more proposals than the practice accepts', () => {
  const got = slots.parseSlots(
    "Monday or Tuesday or Wednesday or Thursday or Friday at 4pm",
    NOW
  );
  assert.ok(got.length <= 3, `expected at most 3, got ${got.length}`);
});
