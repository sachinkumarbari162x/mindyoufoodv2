/* ============================================================
   NLU — intent recognition

       node --test services/node-bff/rules/nlu.test.js

   Written as a phrasebook rather than a unit test: each case is
   something a person might actually type. When a real visitor is
   misread, the fix is a new line here first, then whatever makes
   it pass — that way the phrasing is never lost again.
   ============================================================ */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const nlu = require("./nlu");

const got = (text) => nlu.classify(text).intent;

/** Assert a whole batch, reporting every miss rather than the first. */
function expectAll(pairs) {
  const misses = [];
  for (const [text, want] of pairs) {
    const actual = got(text);
    if (actual !== want) misses.push(`  "${text}" → ${actual} (wanted ${want})`);
  }
  assert.strictEqual(misses.length, 0, "\n" + misses.join("\n"));
}

/* ---- the things people come here to do ---------------------- */

test("booking, however it is asked", () => {
  expectAll([
    ["I want to book a consultation", "book"],
    ["can I book an appointment", "book"],
    ["I'd like to make an appointment", "book"],
    ["how do I set up a session", "book"],
    ["can i come in and see her", "book"],
    ["I need a consultation", "book"],
  ]);
});

test("moving and cancelling are not the same thing", () => {
  expectAll([
    ["I need to reschedule", "reschedule"],
    ["can we move my appointment", "reschedule"],
    ["can I change my booking to another time", "reschedule"],
    ["I have to cancel", "cancel"],
    ["please cancel my appointment", "cancel"],
    ["I cannot make it tomorrow", "cancel"],
  ]);
});

/* ---- the things people ask before booking ------------------- */

test("hours", () => {
  expectAll([
    ["what are your hours", "hours"],
    ["when are you open", "hours"],
    ["are you open on saturday", "hours"],
    ["what time do you close", "hours"],
  ]);
});

test("fees — including the phrasing that used to answer the wrong question", () => {
  expectAll([
    ["how much is it", "fees"],
    ["what are your fees", "fees"],
    ["what does a session cost", "fees"],
    ["is it expensive", "fees"],
  ]);
});

test("services", () => {
  expectAll([
    ["what do you help with", "services"],
    ["do you treat PCOS", "services"],
    ["can you help with diabetes", "services"],
    ["which areas do you specialise in", "services"],
  ]);
});

test("the rest of the front-desk questions", () => {
  expectAll([
    ["how does it work", "process"],
    ["what happens in the first session", "process"],
    ["where are you", "location"],
    ["what is your address", "location"],
    ["how long is a session", "duration"],
    ["who is Khadija", "about"],
    ["is she qualified", "about"],
    ["can I speak to a human", "human"],
    ["are you a bot", "human"],
  ]);
});

/* ---- the small words that carry a conversation -------------- */

test("greetings, thanks, yes and no", () => {
  expectAll([
    ["hi", "greeting"],
    ["hello there", "greeting"],
    ["good morning", "greeting"],
    ["thanks", "farewell"],
    ["thank you so much", "farewell"],
    ["bye", "farewell"],
    ["yes", "affirm"],
    ["yep that's right", "affirm"],
    ["no", "deny"],
    ["not really", "deny"],
    ["skip", "deny"],
  ]);
});

test("a correction is recognised as one", () => {
  expectAll([
    ["actually, make it Tuesday", "correction"],
    ["sorry I meant the 14th", "correction"],
    ["change that to video", "correction"],
  ]);
});

/* ---- normalisation ------------------------------------------ */

test("contractions and punctuation do not change the answer", () => {
  expectAll([
    ["What's your address?", "location"],
    ["I'd like to book!!!", "book"],
    ["WHEN ARE YOU OPEN???", "hours"],
  ]);
});

test("the misspellings this desk actually receives", () => {
  expectAll([
    ["i want to book an appointmnt", "book"],
    ["can i cancle my booking", "cancel"],
    ["need to reschedual", "reschedule"],
    ["do you help with daibetes", "services"],
  ]);
});

/* ---- knowing when it does not know -------------------------- */

test("nonsense is unknown, not a guess", () => {
  for (const text of ["asdfgh", "what about the weather in Peru", "12345", ""]) {
    assert.strictEqual(got(text), "unknown", `"${text}" should not be claimed`);
  }
});

test("a single weak hint is not enough to act on", () => {
  // "weight" alone could be a focus area, a services question, or part
  // of a sentence about something else. One hint scores 1, the floor
  // is 2, so the desk asks instead of assuming.
  const r = nlu.classify("weight");
  assert.ok(
    r.intent === "unknown" || r.confidence < 1,
    `expected uncertainty, got ${r.intent} at ${r.confidence}`
  );
});

test("two intents in one sentence come back as ambiguous", () => {
  // "how much is a video consultation" carries fees AND mode. The old
  // first-match FAQ answered whichever regex sat earlier in the file —
  // somebody asking about money was told about cameras.
  const r = nlu.classify("how much is a video consultation");
  assert.ok(
    r.intent === "ambiguous" || r.intent === "fees",
    `should not silently answer the wrong one, got ${r.intent}`
  );
});

/* ---- shape --------------------------------------------------- */

test("classify always returns a usable shape", () => {
  const r = nlu.classify("what are your hours");
  assert.strictEqual(typeof r.intent, "string");
  assert.ok(r.confidence >= 0 && r.confidence <= 1, "confidence is a fraction");
  assert.strictEqual(typeof r.text, "string", "the normalised text comes back for logging");
});
