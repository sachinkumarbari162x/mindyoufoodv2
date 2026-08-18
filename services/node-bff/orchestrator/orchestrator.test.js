/* The orchestrator decides whether the model is used. If it is
   wrong, the desk either stops booking or starts spending money on
   questions it already knows the answer to — so it is tested
   directly rather than through the desk.

   Run: node orchestrator/orchestrator.test.js
*/
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const o = require("./index");

function reset() {
  o.noteSuccess();
}

test("an answer she has written beats everything", () => {
  reset();
  const d = o.decide({ answerable: true, collecting: false, intent: "hours" });
  assert.equal(d.lane, "deterministic");
  assert.equal(d.reason, "knowledge");
});

test("mid-booking never reaches the agentic lane", () => {
  reset();
  const d = o.decide({ answerable: false, collecting: true, intent: "book" });
  assert.equal(d.lane, "deterministic");
  assert.equal(d.reason, "booking");
});

test("anything else goes agentic while the provider is healthy", () => {
  reset();
  const d = o.decide({ answerable: false, collecting: false, intent: "unknown" });
  assert.equal(d.lane, "agentic");
  assert.equal(d.bot, "desk-officer");
});

test("three failures withdraw the agentic lane", () => {
  reset();
  o.noteFailure();
  assert.equal(o.decide({ answerable: false, collecting: false }).lane, "agentic", "one is not enough");
  o.noteFailure();
  o.noteFailure();

  const d = o.decide({ answerable: false, collecting: false });
  assert.equal(d.lane, "deterministic");
  assert.equal(d.reason, "breaker-open");
  // And it must SAY so, rather than quietly answering with less.
  assert.match(d.note, /booking/i);
});

test("booking still works with the breaker open", () => {
  reset();
  o.noteFailure(); o.noteFailure(); o.noteFailure();
  assert.equal(o.breakerState().open, true);

  const d = o.decide({ answerable: false, collecting: true });
  assert.equal(d.lane, "deterministic");
  assert.equal(d.reason, "booking");
});

test("the knowledge base still answers with the breaker open", () => {
  reset();
  o.noteFailure(); o.noteFailure(); o.noteFailure();
  assert.equal(o.decide({ answerable: true, collecting: false }).reason, "knowledge");
});

test("one success closes the breaker", () => {
  reset();
  o.noteFailure(); o.noteFailure(); o.noteFailure();
  assert.equal(o.breakerState().open, true);
  o.noteSuccess();
  assert.equal(o.breakerState().open, false);
  assert.equal(o.decide({ answerable: false, collecting: false }).lane, "agentic");
});

test("guard reports a failure without throwing", async () => {
  reset();
  const out = await o.guard(async () => {
    throw new Error("provider down");
  });
  assert.equal(out, null, "a failed call returns null rather than throwing at the desk");
  assert.equal(o.breakerState().fails, 1);
});

test("guard treats a null answer as a failure", async () => {
  reset();
  await o.guard(async () => null);
  assert.equal(o.breakerState().fails, 1, "a provider that answers nothing has failed");
});

test("guard passes a real answer through and clears the count", async () => {
  reset();
  o.noteFailure();
  const out = await o.guard(async () => ({ text: "hello" }));
  assert.deepEqual(out, { text: "hello" });
  assert.equal(o.breakerState().fails, 0);
});

test("every registered bot declares its lane and what it needs", () => {
  const ids = o.list().map((b) => b.id);
  assert.ok(ids.includes("front-desk"));
  assert.ok(ids.includes("desk-officer"));

  const officer = o.list().find((b) => b.id === "desk-officer");
  assert.equal(officer.lane, "agentic");
  assert.equal(officer.needs, "model");

  const desk = o.list().find((b) => b.id === "front-desk");
  assert.equal(desk.lane, "deterministic");
  assert.equal(desk.needs, "", "the deterministic lane must depend on nothing");
});
