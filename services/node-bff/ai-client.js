/* ============================================================
   AI CLIENT — talks to services/py-ai

   The contract is narrow on purpose. The model gets to choose the
   WORDS and to read structured fields out of free text. It does
   not get to decide whether the office is open, whether a slot is
   bookable, whether a draft is complete, or whether to submit.
   Those are rules, they live in rules/, and they are evaluated
   after this call returns.

   Everything here is best-effort. A timeout, a 500, a malformed
   body or a service that was never started all resolve to `null`,
   and the flow falls through to the scripted path. The desk takes
   bookings with the AI service switched off.
   ============================================================ */
"use strict";

const { config } = require("./config");
const budget = require("./rules/budget");

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/** Fields the model is allowed to propose. Anything else is dropped. */
const ALLOWED = new Set([
  "name", "email", "phone", "focusArea", "country",
  "timezone", "mode", "notes", "suggestedSlots", "consent",
]);

function sanitize(fields) {
  const out = {};
  if (!fields || typeof fields !== "object") return out;
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k) || v == null || v === "") continue;
    if (k === "suggestedSlots") {
      if (!Array.isArray(v)) continue;
      out[k] = v
        .filter((s) => s && typeof s === "object")
        .slice(0, 3)
        .map((s) => ({
          date: typeof s.date === "string" ? s.date.slice(0, 20) : undefined,
          time: typeof s.time === "string" ? s.time.slice(0, 20) : undefined,
          label: typeof s.label === "string" ? s.label.slice(0, 80) : undefined,
        }));
      continue;
    }
    if (k === "consent") {
      out[k] = v === true;
      continue;
    }
    if (typeof v !== "string") continue;
    out[k] = v.slice(0, 2000);
  }
  return out;
}

/**
 * @returns {Promise<null | {reply:string, fields:object, intent:string, chips:string[], model:string, latencyMs:number}>}
 */
async function turn(payload) {
  if (!config.ai.enabled) return null;

  // Circuit breaker: after three straight failures, stop paying the
  // timeout on every message for a minute. A visitor waiting 12
  // seconds for a service that is down is a worse experience than
  // the scripted flow they will get instead.
  if (Date.now() < circuitOpenUntil) return null;

  /* THE DAILY CEILING ON A PAID MODEL. Anyone on the internet can
     make this spend, and the rate limits only cap how often ONE
     visitor may ask — five hundred honest visitors run up the same
     bill as one determined caller rotating addresses.

     Refused the same way everything else here is refused: return
     null, and the desk answers from its scripted flow. A visitor
     sees a working front desk; nobody sees an error about money.
     Taken BEFORE the request, because counting afterwards lets a
     burst of concurrent calls all pass the check. */
  if (!budget.spend("desk").ok) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.ai.timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(`${config.ai.url}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`ai ${res.status}`);
    const data = await res.json();

    consecutiveFailures = 0;
    return {
      reply: typeof data.reply === "string" ? data.reply.slice(0, 1500) : "",
      fields: sanitize(data.fields),
      intent: typeof data.intent === "string" ? data.intent.slice(0, 40) : "unknown",
      chips: Array.isArray(data.chips)
        ? data.chips.filter((c) => typeof c === "string").slice(0, 4).map((c) => c.slice(0, 42))
        : [],
      model: data.model || "unknown",
      // Set when the AI service replaced the model's wording with a
      // canned deflection. The reply is then safe but says nothing
      // about the booking, so the BFF has to re-ask on its own.
      guardrail: typeof data.guardrail === "string" ? data.guardrail : null,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (++consecutiveFailures >= 3) {
      circuitOpenUntil = Date.now() + 60_000;
      consecutiveFailures = 0;
      console.warn("[bff] ai service unreachable — scripted flow for 60s:", err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  try {
    const res = await fetch(`${config.ai.url}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : { ok: false };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

module.exports = { turn, health, sanitize };
