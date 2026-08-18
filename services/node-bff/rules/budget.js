/* ============================================================
   BUDGET — a ceiling on what the paid models can cost
   ------------------------------------------------------------
   THE RATE LIMITS DO NOT DO THIS, and it is worth being exact
   about why. limits.js caps how often ONE visitor may ask. It
   says nothing about the total: five hundred honest visitors on
   a good day, or one determined caller rotating addresses, both
   run up a bill with no upper bound anywhere in the system. The
   first thing anybody knows about it is the invoice.

   So this is a hard daily ceiling. When it is reached the model
   is simply not called, and the caller gets the same thing they
   get when the key is missing or the service is down: the desk
   falls through to its scripted answers, and the plan assistant
   says it is unavailable. Nothing breaks and nobody sees an
   error about money.

   TWO BUDGETS, AND THEY ARE SEPARATE ON PURPOSE.

     desk   the public front desk. Anyone on the internet can
            make it spend.
     plan   her plan assistant. Only she can, from behind a
            login.

   If they shared a pot, somebody hammering the public desk could
   exhaust it and stop Khadija issuing a plan to a client sitting
   in front of her. A public surface must never be able to starve
   a private one — that is the whole reason for two numbers.

   IT COUNTS CALLS, NOT TOKENS. Tokens would be more precise and
   would need every provider to report usage on every path,
   including the ones that fail halfway. Calls times the
   per-call token ceiling is an honest upper bound, it cannot be
   wrong in the dangerous direction, and it is countable at the
   one place every call goes through.

   IT SURVIVES A RESTART. An in-memory counter resets whenever
   the container does, which on a box that restarts on deploy is
   a ceiling that can be lifted by accident. The count is written
   to disk.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/* Beside the uploads, and for the same reason: it is the one
   directory on the box that is expected to be writable and is
   not part of the image. */
const DIR = process.env.STATE_DIR || path.join(__dirname, "..", "..", "..", "var");
const FILE = path.join(DIR, "budget.json");

/* Defaults sized for one dietitian in Mumbai, not for a startup.
   A very good day sends her a few hundred visitors in total, and
   she writes a handful of plans. Both are generous multiples of
   that, so a normal day never touches them and a runaway does. */
const CEILINGS = {
  desk: Number(process.env.AI_DESK_CALLS_PER_DAY) || 500,
  plan: Number(process.env.AI_PLAN_CALLS_PER_DAY) || 150,
};

/* The UTC day, because a rolling window needs storage per call
   and a local-midnight reset needs a timezone the container may
   not agree with. */
const today = () => new Date().toISOString().slice(0, 10);

let state = { day: today(), used: { desk: 0, plan: 0 } };
let dirty = false;

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (saved && saved.day === today() && saved.used) {
      state = { day: saved.day, used: { desk: 0, plan: 0, ...saved.used } };
    }
  } catch {
    /* No file yet, or it is unreadable. Starting from zero is
       the right answer for both: this is a ceiling, and the
       failure mode of forgetting it is a day with a fresh
       allowance rather than a service that will not start. */
  }
}
load();

/* Written on a timer rather than on every call. A synchronous
   write in the path of every model call would put disk latency
   in front of the visitor, and losing a few seconds of count to
   a hard kill costs a few calls, not a budget. */
function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state), "utf8");
  } catch {
    /* Read-only disk, or the directory is gone. The ceiling still
       works for this process; it just will not survive a restart.
       Not worth failing a request over. */
  }
}
const timer = setInterval(persist, 10_000);
if (timer.unref) timer.unref();
process.on("exit", persist);

function roll() {
  const now = today();
  if (state.day !== now) {
    state = { day: now, used: { desk: 0, plan: 0 } };
    dirty = true;
  }
}

/**
 * Take one call from a budget.
 *
 * Call this BEFORE the request goes out, and only when it is
 * actually going to. Counting afterwards means a burst of
 * concurrent calls all pass the check and the ceiling is a
 * suggestion.
 *
 * @param {"desk"|"plan"} name
 * @returns {{ok: boolean, used: number, ceiling: number, left: number}}
 */
function spend(name) {
  roll();
  const ceiling = CEILINGS[name];
  if (!ceiling) return { ok: true, used: 0, ceiling: 0, left: Infinity };

  const used = state.used[name] || 0;
  if (used >= ceiling) {
    return { ok: false, used, ceiling, left: 0 };
  }

  state.used[name] = used + 1;
  dirty = true;

  /* Said once, at the moment it happens, rather than on every
     refusal afterwards — a log that repeats a thousand times is a
     log nobody reads to the end of. */
  if (state.used[name] === ceiling) {
    console.warn(
      `[bff] ${name} model budget reached for today (${ceiling} calls). ` +
        (name === "desk"
          ? "The desk is on its scripted answers until midnight UTC."
          : "The plan assistant is unavailable until midnight UTC.")
    );
  }

  return { ok: true, used: state.used[name], ceiling, left: ceiling - state.used[name] };
}

/** What is left, without spending anything. For /health. */
function state_() {
  roll();
  const out = {};
  for (const name of Object.keys(CEILINGS)) {
    const used = state.used[name] || 0;
    out[name] = { used, ceiling: CEILINGS[name], left: Math.max(0, CEILINGS[name] - used) };
  }
  return { day: state.day, budgets: out };
}

/** The boot line, so the ceiling is never a guess. */
function describe() {
  return `budgets: desk ${CEILINGS.desk}/day · plan ${CEILINGS.plan}/day (paid models)`;
}

module.exports = { spend, state: state_, describe, CEILINGS };
