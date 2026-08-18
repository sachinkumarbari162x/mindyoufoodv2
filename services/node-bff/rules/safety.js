/* ============================================================
   BUSINESS RULES · SAFETY AND SCOPE

   The hard boundary. This runs on the visitor's message BEFORE it
   reaches the LLM and on the LLM's reply BEFORE it reaches the
   visitor — a prompt is a request, not a guarantee, so the limits
   that matter clinically are enforced in code on both sides.

   Three things this catches:
     1. EMERGENCY  — stop the flow, give emergency numbers.
     2. CLINICAL   — diagnosis / dosage / medication changes. The
                     desk declines and offers the consultation,
                     which is the honest answer anyway.
     3. OFF-TOPIC  — the desk is a receptionist for one practice,
                     not a general assistant. Includes prompt
                     injection attempts, which are just off-topic
                     requests wearing a costume.
   ============================================================ */
"use strict";

const { config } = require("../config");

/* Red flags. Erring toward false positives is the correct trade:
   the cost of a needless "please call a doctor" is a mild
   annoyance; the cost of a miss is somebody's emergency. */
const EMERGENCY = [
  /\b(suicid|kill myself|end my life|self.?harm|want to die)\b/i,
  /\b(chest pain|can'?t breathe|cannot breathe|difficulty breathing)\b/i,
  /\b(unconscious|passed out|fainted|collaps)/i,
  /\b(seizure|stroke|heart attack|anaphyla)/i,
  /\b(vomiting blood|blood in (my )?(stool|vomit)|coughing blood)\b/i,
  /\b(overdose|poison)/i,
  /\b(not eaten|haven'?t eaten) (for|in) \d+ (days|weeks)\b/i,
  /\b(starv(e|ing) myself|purg(e|ing)|making myself (sick|vomit))\b/i,
];

const CLINICAL = [
  /\b(diagnos|do i have|is this|am i)\b.*\b(cancer|diabet|pcos|thyroid|celiac|crohn|deficien)/i,
  /\b(dose|dosage|mg|how much) .*\b(metformin|insulin|thyroxine|levothyrox|ozempic|semaglutide|statin|supplement)\b/i,
  /\b(stop|quit|reduce|increase|change) (taking |my )?(medication|medicine|tablets|metformin|insulin|pills)\b/i,
  /\b(prescri|prescription)\b/i,
  /\b(interpret|read|explain) my (labs?|reports?|blood ?work|test results?)\b/i,
];

/* Prompt injection and role-escape. Not a security control on its
   own — the AI service refuses these too, and the BFF never lets
   the model touch anything but text — but rejecting them here
   keeps them out of the transcript and off the token bill. */
const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions?|prompts?|rules?)/i,
  /\b(system|developer) (prompt|message|instructions?)\b/i,
  /\byou are (now|actually) (a|an|not)\b/i,
  /\b(jailbreak|DAN mode|pretend to be|act as (if )?you)\b/i,
  /\b(reveal|show|print|repeat|output) (your|the) (prompt|instructions?|rules|system)/i,
  /\b(api[_ ]?key|secret|token|password|env(ironment)? var)/i,
];

/* On-topic markers. Used only to decide whether an unrecognised
   message is worth sending to the model — never to reject one.
   A visitor saying something the desk has no pattern for is the
   normal case, not an error. */
const ON_TOPIC =
  /\b(book|appoint|consult|slot|time|schedul|resched|cancel|availab|fee|cost|price|charge|payment|session|plan|diet|nutrition|food|eat|meal|weight|pcos|diabet|gut|sport|hormon|khadija|dietician|dietitian|online|clinic|video|call|email|phone|whatsapp|hour|open|when|how long|follow.?up)\b/i;

const OFF_TOPIC = [
  /\b(write|generate|code|debug|translate|summari[sz]e) (me )?(a|an|this|the)? ?(essay|poem|script|program|function|article|story)\b/i,
  /\b(who (won|is the president)|weather|stock|crypto|bitcoin|football|movie|recipe for a cake)\b/i,
  /\b(homework|assignment|exam)\b/i,
];

const EMERGENCY_REPLY =
  "I need to stop and say this plainly: what you've described needs urgent medical help, not a " +
  "nutrition appointment.\n\nIf you are in India, call 112 for emergency services, or Tele-MANAS on " +
  "14416 for mental health support — both are free and open around the clock. Anywhere else, please " +
  "use your local emergency number or go to your nearest emergency department.\n\nI'm not able to " +
  "help with this one, and I'd rather tell you that than take a booking. Please reach out to them now.";

const CLINICAL_REPLY =
  "That's a clinical question, and I'm the front desk — I'd be guessing, and guessing about " +
  "medication or lab results is exactly where harm comes from.\n\nWhat I can do is get you in front " +
  "of the practitioner, who will look at your actual reports and history. Would you like me to set " +
  "that up?";

const OFF_TOPIC_REPLY =
  "I only handle things for this practice — consultations, what she works with, and scheduling. " +
  "That one's outside what I can help with.\n\nIs there anything about booking a consultation I can " +
  "sort out for you?";

function match(list, text) {
  return list.some((re) => re.test(text));
}

/**
 * Screen an inbound message.
 * @returns {{action:'block'|'deflect'|'pass', kind:string, reply?:string, halt?:boolean}}
 */
function screenInbound(text) {
  const t = String(text || "");

  if (match(EMERGENCY, t)) {
    // `halt` ends the booking flow outright. Taking an appointment
    // from somebody in crisis would be the wrong outcome even if it
    // is the one the desk is built to produce.
    return { action: "block", kind: "emergency", reply: EMERGENCY_REPLY, halt: true };
  }
  if (match(INJECTION, t)) {
    return { action: "deflect", kind: "injection", reply: OFF_TOPIC_REPLY };
  }
  if (match(CLINICAL, t)) {
    return { action: "deflect", kind: "clinical", reply: CLINICAL_REPLY };
  }
  if (match(OFF_TOPIC, t) && !ON_TOPIC.test(t)) {
    return { action: "deflect", kind: "off_topic", reply: OFF_TOPIC_REPLY };
  }
  return { action: "pass", kind: "ok" };
}

/* Outbound. The model is instructed not to do any of this; these
   patterns are what catches it when the instruction does not hold.
   A tripped rule replaces the whole reply — a half-scrubbed
   clinical answer is worse than none. */
const OUTBOUND_FORBIDDEN = [
  /\byou (probably |likely |may |might )?have\b.*\b(pcos|diabetes|ibs|thyroid|deficiency|insulin resistance)\b/i,
  /\btake \d+\s?(mg|mcg|g|iu|ml)\b/i,
  /\b(stop|start|increase|reduce) (taking )?your (medication|metformin|insulin|thyroxine)\b/i,
  /\bi (diagnose|prescribe)\b/i,
  /\b(guarantee|guaranteed) (you|results|weight loss|\d+\s?(kg|kgs|pounds))/i,
  /\blose \d+\s?(kg|kgs|kilos|pounds|lbs)\b.*\b(in|within)\b.*\b(day|week)/i,
];

/** Prices are quoted by the practitioner, never by the desk. */
const PRICE_CLAIM = /(₹|rs\.?|inr|\$|usd|aed|£)\s?\d{2,}/i;

function screenOutbound(text) {
  const t = String(text || "");
  if (match(OUTBOUND_FORBIDDEN, t)) {
    return {
      ok: false,
      kind: "clinical_claim",
      replacement:
        "I started to answer that and realised it's past what a front desk should say — it needs the " +
        "practitioner, with your history in front of her. Shall I get you booked in?",
    };
  }
  if (PRICE_CLAIM.test(t)) {
    return {
      ok: false,
      kind: "price_claim",
      replacement:
        "Fees depend on which programme suits you, so she quotes them herself rather than my giving you " +
        "a number that turns out to be wrong. Send a consultation request and she'll set it out for you " +
        "in her reply. Shall I take your details?",
    };
  }
  return { ok: true };
}

const emergencyKinds = () => ({ EMERGENCY_REPLY, CLINICAL_REPLY, OFF_TOPIC_REPLY });

module.exports = { screenInbound, screenOutbound, emergencyKinds, config };
