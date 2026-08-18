/* ============================================================
   PARSE — what it reads, and what it refuses to scold
   ------------------------------------------------------------
   Half of these cases are about the COMPLAINT list rather than
   about the rows. That list is the only thing standing between
   "Build dropped a line" and nobody noticing, and it only works
   if it is quiet: a list that objects to correct writing is a
   list she stops reading, and then the one real complaint in it
   goes past her too.

     node services/node-bff/plan-ai/parse.test.js
   ============================================================ */
"use strict";

const { parse, parseLine } = require("./parse.js");

let pass = 0;
let fail = 0;

function is(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}` + (ok ? "" : `\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  );
}

/* ---- HER PROSE IS NEVER A COMPLAINT ---------------------------
   Every line here is real writing from a real plan, and not one
   of them is a failed instruction. */
const PROSE = [
  "Weights are cooked weights unless the line says otherwise. Weigh everything for the first two weeks; after that you will see 150 g of rice on a plate without a scale.",
  "Bringing your fasting sugar down from 132 and holding a steady, unhurried weight loss.",
  "Four meals, about four hours apart. Breakfast within an hour of waking, the last meal finished by 8 PM.",
  "Three litres of water across the day. Two cups of tea or coffee, without sugar, and none after 10 PM.",
  "Rice swaps one-for-one with roti by weight, sweet potato with potato or a banana.",
  "You wake around 6 PM and sleep at 8 AM, so your first meal is at 7:30 PM and your last is at 5 AM.",
  "Come back in six weeks, and ring me if the headaches carry on.",
  "## Portions, and how to weigh them",
  "Take the iron with vitamin C — the lemon on the dal is doing a job.",
];

PROSE.forEach((line) => {
  const out = parse(line);
  is(`prose, no complaint: "${line.slice(0, 46)}…"`, out.problems.length, 0);
});

/* ---- A BOTCHED ROW STILL IS ONE -------------------------------
   The heuristics have to keep working on the short lines they
   were written for, or the fix above has thrown the baby out. */
const BROKEN = [
  ["- - Two eggs", /two dashes/],
  ["– Two eggs and toast", /wrong mark/],
  ["-Two eggs", /no space after the dash/],
  ["Breakfast: two eggs", /looks like an instruction/],
  ["150 g brown rice", /an amount here/],
];

BROKEN.forEach(([line, expected]) => {
  const out = parse(line);
  const why = out.problems[0] && out.problems[0].why;
  const ok = why && expected.test(why);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} broken row is caught: "${line}" -> ${why || "NOTHING"}`);
});

/* ---- and the rows themselves still read ----------------------- */
const row = parseLine("- Brown rice (150 g) [one katori], lunch — sip water through the meal", 0, null);
is("row: label", row.label, "Brown rice");
is("row: quantity", row.quantity, 150);
is("row: household", row.household, "one katori");
is("row: schedule", row.schedule, "lunch");
is("row: how", row.how, "sip water through the meal");

/* A plan is prose AND rows together, which is the normal case —
   nothing here should be reported. */
const MIXED = [
  "## How the day is shaped",
  "Four meals, about four hours apart. The overnight gap is doing real work.",
  "",
  "Food",
  "- Brown rice (150 g) [one katori], lunch",
  "- Two rotis, dinner",
  "",
  "Come back in six weeks.",
].join("\n");

const mixed = parse(MIXED);
is("mixed plan: rows found", mixed.items.length, 2);
is("mixed plan: nothing complained about", mixed.problems.length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
