/* ============================================================
   THE MASTER ORCHESTRATOR — plain code, and that is the point
   ------------------------------------------------------------
   Items 9 and 12.

       RULES DECIDE WHO SPEAKS.

   Everything in this file is deterministic. There is no model
   call in the decision path and there must never be one: the
   component that decides whether to use the model cannot itself
   need the model, or the fallback fails in the exact moment it
   exists for.

   It does four things and nothing else:

     ROUTES   picks a lane for the turn
     GUARDS   a circuit breaker over the model service
     SWITCHES honours the on/off she sets in the panel
     RECORDS  writes every turn to crm.bot_turns

   THE TWO LANES

     deterministic  the knowledge base, the NLU, the slot engine,
                    the booking form. Always available. Works with
                    every provider on earth switched off.

     agentic        the deskOfficer. Explains, never interprets.
                    May be unavailable, and the desk says so
                    plainly rather than spinning.

   WHAT THIS IS NOT: a federated bus. There are two lanes and a
   registry that a third can join without rework. Building a
   federation for two participants would be machinery to maintain
   in exchange for nothing.
   ============================================================ */
"use strict";

const data = require("../data-client");

/* ---- the registry ---------------------------------------------
   Bots declare themselves rather than being hard-coded into the
   routing. Adding one is an entry here; the decision below does
   not change. */
const bots = new Map();

/**
 * @param {object} bot
 * @param {string} bot.id         slug, and the key in bot_turns
 * @param {"deterministic"|"agentic"} bot.lane
 * @param {string} bot.needs      "" or "model" — what it depends on
 */
function register(bot) {
  bots.set(bot.id, { enabled: true, ...bot });
  return bot.id;
}

const list = () => [...bots.values()].map((b) => ({ id: b.id, lane: b.lane, needs: b.needs || "", enabled: b.enabled }));

/* ---- the switches ---------------------------------------------
   Read from the database, cached, and re-read on a slow loop. She
   flips one in the panel and the next turn honours it — no deploy,
   no restart. Absent means ON, so a bot nobody has ever touched
   works. */
let switches = new Map();
let switchesAt = 0;
const SWITCH_TTL = 30 * 1000;

async function refreshSwitches() {
  try {
    const out = await data.crm.botSwitches();
    switches = new Map((out?.switches || []).map((s) => [s.bot, s.enabled]));
    switchesAt = Date.now();
  } catch {
    // Keep whatever was last known. A database blip must not turn
    // every bot off at once.
  }
}

function maybeRefreshSwitches() {
  if (Date.now() - switchesAt > SWITCH_TTL) refreshSwitches();
}

const isOn = (id) => switches.get(id) !== false;

/* ---- the circuit breaker --------------------------------------
   Three failures in a row and the agentic lane is withdrawn for a
   minute. Not because one failure is fatal, but because a provider
   that has failed three times running will fail the fourth, and
   every attempt costs the visitor the timeout before it does.

   Half-open: after the cooldown ONE request is let through. If it
   works the breaker closes; if it does not, the cooldown starts
   again. Letting everything through at once would hammer a service
   that has only just come back. */
const BREAKER = { fails: 0, openedAt: 0, threshold: 3, cooldownMs: 60 * 1000 };

function breakerOpen() {
  if (BREAKER.fails < BREAKER.threshold) return false;
  const since = Date.now() - BREAKER.openedAt;
  if (since > BREAKER.cooldownMs) return false; // half-open: try one
  return true;
}

function noteSuccess() {
  BREAKER.fails = 0;
  BREAKER.openedAt = 0;
}

function noteFailure() {
  BREAKER.fails += 1;
  if (BREAKER.fails >= BREAKER.threshold && !BREAKER.openedAt) BREAKER.openedAt = Date.now();
  else if (BREAKER.fails >= BREAKER.threshold) BREAKER.openedAt = Date.now();
}

const breakerState = () => ({
  open: breakerOpen(),
  fails: BREAKER.fails,
  // How long until the agentic lane is offered again, in seconds.
  retryInSec: breakerOpen()
    ? Math.max(0, Math.ceil((BREAKER.cooldownMs - (Date.now() - BREAKER.openedAt)) / 1000))
    : 0,
});

/* ---- the decision ---------------------------------------------
   The whole routing table, and it is a handful of ifs on purpose.
   Anyone should be able to read this and predict what the desk
   will do with a given message. */

/**
 * @param {object} turn
 * @param {boolean} turn.answerable  the knowledge base has an answer
 * @param {boolean} turn.collecting  the desk is mid-booking
 * @param {string}  turn.intent
 * @returns {{lane: string, bot: string, reason: string, note: string|null}}
 */
function decide(turn) {
  maybeRefreshSwitches();

  // 1 · An answer she has written beats everything. It is hers, it
  //     is instant, and it is the same every time.
  if (turn.answerable) {
    return { lane: "deterministic", bot: "front-desk", reason: "knowledge", note: null };
  }

  // 2 · Mid-booking, the deterministic lane owns the turn. The
  //     booking path never crosses a fallible edge — that is the
  //     one rule the whole shape exists to enforce.
  if (turn.collecting) {
    return { lane: "deterministic", bot: "front-desk", reason: "booking", note: null };
  }

  // 3 · Anything else would like the agentic lane. Whether it can
  //     have it is not its decision.
  const officer = bots.get("desk-officer");

  if (!officer || !isOn("desk-officer")) {
    return {
      lane: "deterministic",
      bot: "front-desk",
      reason: "switched-off",
      note: null,
    };
  }

  if (breakerOpen()) {
    return {
      lane: "deterministic",
      bot: "front-desk",
      reason: "breaker-open",
      /* Said plainly, not hidden behind a spinner. A visitor told
         the extra help is unavailable can still book; a visitor
         watching dots does not know that. */
      note: "I can still take a booking and answer the usual questions — the longer answers are unavailable for a moment.",
    };
  }

  return { lane: "agentic", bot: "desk-officer", reason: "model", note: null };
}

/**
 * Run something through the breaker.
 *
 * Every model call in the system should go through here, so there
 * is one place that knows whether the provider is healthy rather
 * than several that each guess.
 */
async function guard(fn) {
  try {
    const out = await fn();
    if (out === null || out === undefined) {
      noteFailure();
      return null;
    }
    noteSuccess();
    return out;
  } catch (err) {
    noteFailure();
    return null;
  }
}

/* ---- the record -----------------------------------------------
   Fire and forget, always. Nothing downstream waits on this: the
   conversation store takes turns in and returns nothing, which is
   exactly why it can never slow a reply down. */
function record(entry) {
  data.crm
    .botTurn({
      bot: entry.bot || "front-desk",
      lane: entry.lane || "deterministic",
      sessionRef: entry.sessionRef || null,
      input: entry.input || null,
      output: entry.output || null,
      intent: entry.intent || null,
      confidence: typeof entry.confidence === "number" ? entry.confidence : null,
      reason: entry.reason || null,
      model: entry.model || null,
      latencyMs: entry.latencyMs || 0,
    })
    .catch(() => {
      /* Deliberately silent. This is measurement, and measurement
         that can interrupt the thing being measured is worse than
         no measurement at all. The panel shows the gap. */
    });
}

/* The two lanes as they stand today. */
register({ id: "front-desk", lane: "deterministic", needs: "" });
register({ id: "desk-officer", lane: "agentic", needs: "model" });
register({ id: "crm-assistant", lane: "deterministic", needs: "" });

refreshSwitches();

module.exports = {
  register, list, decide, guard, record,
  breakerState, isOn, refreshSwitches,
  // Exposed for the tests, which drive the breaker directly rather
  // than by making a provider fail three times.
  _breaker: BREAKER, noteFailure, noteSuccess,
};
