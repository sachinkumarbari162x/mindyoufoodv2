/* The boundary between "explaining her practice" and "practising
   it" is the highest-liability line in this system. If it moves,
   a bot is giving clinical advice under her name.

   So it is tested in both directions. Over-refusing costs one turn
   and an apology; under-refusing costs her licence, and the two are
   not to be traded off against each other.

   Run: node corpus/scope.test.js
*/
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const scope = require("./scope");

/* Questions only Khadija may answer. Every one of these has been
   asked of a real dietitian's front desk. */
const CLINICAL = [
  "what should i eat for pcos",
  "can i eat rice",
  "how much protein do i need",
  "will my thyroid get better",
  "is dairy bad for me",
  "should i stop metformin",
  "what does my report mean",
  "what diet for diabetes",
  "can i take vitamin d",
  "is intermittent fasting safe for me",
  "my results came back high, what now",
  "what dosage should i take",
];

/* Questions about the practice, which the desk exists to answer.
   Refusing these would make it useless. */
const SCOPE = [
  "what do you treat",
  "are you a doctor",
  "what should i bring",
  "can we do this online",
  "how many sessions",
  "what happens in the session",
  "do you see people abroad",
  "do you do eating disorders",
  "how does the consultation work",
];

test("clinical questions are refused, every one", () => {
  for (const q of CLINICAL) {
    assert.equal(scope.isClinical(q), true, `LEAKED: "${q}" was not refused`);
  }
});

test("questions about the practice are not refused", () => {
  for (const q of SCOPE) {
    assert.equal(scope.isClinical(q), false, `OVER-REFUSED: "${q}"`);
  }
});

test("the refusal names who answers, and offers the consultation", () => {
  assert.match(scope.REFUSAL, /Khadija/);
  assert.match(scope.REFUSAL, /consultation/i);
  // Not an apology for existing, and not a hedge that answers anyway.
  assert.doesNotMatch(scope.REFUSAL, /\bgenerally\b|\busually you\b|\bmost people should\b/i);
});

test("nothing unapproved can reach a visitor", () => {
  const before = scope.ENTRIES.map((e) => e.approved);
  scope.ENTRIES.forEach((e) => (e.approved = false));
  assert.deepEqual(scope.retrieve("what do you treat"), [], "an unapproved corpus must return nothing");
  scope.ENTRIES.forEach((e, i) => (e.approved = before[i]));
});

test("retrieval finds the right entry once approved", () => {
  const before = scope.ENTRIES.map((e) => e.approved);
  scope.ENTRIES.forEach((e) => (e.approved = true));

  assert.equal(scope.retrieve("what do you treat")[0].id, "scope-treats");
  assert.equal(scope.retrieve("are you a doctor")[0].id, "scope-not");
  assert.equal(scope.retrieve("can we do this online")[0].id, "scope-remote");
  assert.deepEqual(scope.retrieve("what is the capital of france"), [], "nothing relevant returns nothing");

  scope.ENTRIES.forEach((e, i) => (e.approved = before[i]));
});

test("the corpus ships unapproved", () => {
  /* Not a style preference. `approved` is what makes "reviewed
     corpus" a fact rather than an intention, and an entry that
     shipped as true would never be read by her at all. */
  assert.equal(scope.stats().approved, 0, "entries must ship as unapproved");
});

test("no entry gives an instruction about food or dose", () => {
  /* NOT isClinical() over the answers — that detector reads
     QUESTIONS, and running it over answers is a category error: the
     entry that says "she does not prescribe medication, diagnose
     conditions" trips it while being exactly the sentence we want.
     The first version of this test did that and failed on its own
     corpus.

     What actually matters is narrower and checkable: no entry may
     tell somebody to eat, avoid or take anything. */
  const ADVICE = [
    /you should (eat|avoid|take|stop|start|cut)/i,
    /(eat|avoid|take) (more|less|no)/i,
    /cut (out|down on)/i,
    /\d+\s?(mg|g|ml|kcal|calories)/i,
    /recommend(ed)? (a|an|the)? ?(dose|dosage|supplement)/i,
  ];

  for (const e of ENTRIES_ALL()) {
    for (const re of ADVICE) {
      assert.doesNotMatch(e.answer, re, `entry "${e.id}" instructs the reader`);
    }
  }
});

/** Every entry, approved or not — the review gate is about what
    reaches a visitor, not about what this test is allowed to read. */
function ENTRIES_ALL() {
  return scope.ENTRIES;
}
