/* ============================================================
   THE SCOPE CORPUS — what she does, and what she does not
   ------------------------------------------------------------
   Item 10, at the size you chose: a reviewed set of scope answers,
   richer than the knowledge base, and nothing clinical in it.

   THE LINE, AND IT IS THE WHOLE POINT OF THIS DIRECTORY

     This corpus may say what a consultation covers, what it costs,
     what happens in it, what to bring, and whether something is
     within her practice at all.

     It may not say what to eat, what a symptom means, what a
     medication does, or what a result is likely to be. Not
     hedged, not "in general" — not at all.

   Khadija is a CLINICAL dietitian. A bot that interprets on her
   domain is practising her profession under her name, and the
   exposure is hers. Every entry below was written to be read out
   loud by somebody who is not her, to somebody she has never met.

   NO MEDICAL HISTORY IS COLLECTED BEFORE A CONSULTATION. You
   settled that, and it removes a whole class of risk: the front
   desk never holds special-category data, so consent, retention
   and encryption-at-rest are not obligations we have to design
   around here. History belongs to the system that starts once a
   consultation has been accepted, which is a separate build.

   APPROVAL. Every entry carries `approved`. Nothing reaches a
   visitor until Khadija has read it and it is flipped to true —
   that flag is what makes "reviewed corpus" a fact rather than an
   intention. They ship as false on purpose.
   ============================================================ */
"use strict";

const ENTRIES = [
  {
    id: "scope-treats",
    topic: "What she works with",
    asks: ["what do you treat", "what can she help with", "do you help with", "is this something you do"],
    answer:
      "Khadija works with PCOS and hormonal health, diabetes care, gut health, weight management, " +
      "sports nutrition, and long-term lifestyle change. If what you need sits outside that, say so " +
      "and she will tell you honestly rather than take the booking.",
    approved: false,
  },
  {
    id: "scope-not",
    topic: "What she does not do",
    asks: ["do you do eating disorders", "can you prescribe", "do you do surgery", "are you a doctor"],
    answer:
      "She is a clinical dietitian, not a doctor. She does not prescribe medication, diagnose conditions, " +
      "or work with eating disorders — those need a specialist team, and she will say so rather than " +
      "take it on. She works alongside your doctor, not instead of them.",
    approved: false,
  },
  {
    id: "scope-session",
    topic: "What happens in a consultation",
    asks: ["what happens in the session", "what will we do", "how does the consultation work", "what should i expect"],
    answer:
      "The first consultation is an hour. She asks about your health, your routine, what you actually eat " +
      "and what you have already tried, then builds a plan around your life rather than a template. " +
      "You leave with something you can start that week.",
    approved: false,
  },
  {
    id: "scope-bring",
    topic: "What to bring",
    asks: ["what should i bring", "do i need test results", "do you need my reports"],
    answer:
      "Recent blood work if you have it, and a list of anything you take regularly. If you have neither, " +
      "come anyway — she will tell you what is worth getting.",
    approved: false,
  },
  {
    id: "scope-followup",
    topic: "Follow-ups",
    asks: ["how many sessions", "do i need to come back", "how long does it take"],
    answer:
      "Most people see her again two to four weeks after the first session, then less often as things " +
      "settle. How many depends entirely on what you are working on, and she will tell you what she " +
      "expects rather than sell you a package.",
    approved: false,
  },
  {
    id: "scope-remote",
    topic: "Working remotely",
    asks: ["can we do this online", "i am not in india", "do you see people abroad", "video consultation"],
    answer:
      "Yes. A good share of her clients are in the UK, the Gulf and the US, and the sessions run by video. " +
      "She works around your timezone and around what food is actually available where you live.",
    approved: false,
  },
];

/* ---- the boundary ---------------------------------------------
   Checked BEFORE retrieval, and it is the most important function
   in this directory.

   Without it the deflection is accidental: "what should I eat for
   PCOS" happens to match the entry about what a consultation
   covers, so the visitor gets a vaguely relevant answer to a
   question that should not have been answered at all. Right result,
   wrong reason — and a wrong reason will not hold when the corpus
   grows.

   These are the shapes of a question that asks her to practise. A
   deliberately blunt list: over-refusing costs one turn and an
   apology, under-refusing costs her licence. */
const CLINICAL = [
  /\bwhat (should|can|do|shall) i (eat|avoid|take|drink|have)\b/i,
  /\b(is|are)\b.{0,30}\b(safe|bad|good|ok|okay) for (me|my)\b/i,
  /\bdiet (for|plan for)\b/i,
  /\b(dosage|dose|supplement|medication|medicine|tablet)s?\b/i,
  /\bwill (it|this|my|i)\b.{0,25}\b(cure|fix|heal|improve|get better|go away)\b/i,
  /\b(diagnos|prescri)/i,
  /\btreat me\b/i,
  /\bmy (results?|reports?|levels?|bloods?|symptoms?)\b/i,
  /\bhow (much|many)\b.{0,20}\b(protein|carbs?|calories|sugar|fat)\b/i,
  /\bcan i (eat|have|take|drink)\b/i,
  /\bshould i (eat|avoid|stop|start|take)\b/i,
];

/**
 * Is this a question only Khadija may answer?
 *
 * The deskOfficer must not answer these — not hedged, not "in
 * general". It says so and offers the consultation, which is the
 * honest answer and also the one that converts.
 */
function isClinical(text) {
  const t = String(text || "");
  return CLINICAL.some((re) => re.test(t));
}

/** What it says instead. Not an apology for existing — a straight
    account of who answers that kind of question, and an offer. */
const REFUSAL =
  "That one is genuinely for Khadija — it depends on your history and your bloods, and I would only " +
  "be guessing. It is exactly what the first consultation is for. Shall I book you in?";

/* ---- retrieval -------------------------------------------------
   Scored overlap against the phrasings, not embeddings. Six entries
   do not need a vector store, and a retrieval step nobody can
   explain is a bad foundation for the one part of this system with
   a liability attached.

   When the corpus grows past what this handles, the replacement is
   a real index — and the interface here stays the same. */
function retrieve(text, limit = 2) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return [];

  const scored = ENTRIES
    // Unapproved entries do not exist as far as a visitor is
    // concerned. This is the enforcement, not the intention.
    .filter((e) => e.approved)
    .map((e) => {
      let score = 0;
      for (const ask of e.asks) {
        if (t.includes(ask)) score += 3;
        else {
          const words = ask.split(/\s+/).filter((w) => w.length > 3);
          const hits = words.filter((w) => t.includes(w)).length;
          if (words.length && hits / words.length >= 0.6) score += 1;
        }
      }
      return { entry: e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => ({
    id: s.entry.id,
    topic: s.entry.topic,
    answer: s.entry.answer,
  }));
}

const stats = () => ({
  total: ENTRIES.length,
  approved: ENTRIES.filter((e) => e.approved).length,
});

module.exports = { ENTRIES, retrieve, stats, isClinical, REFUSAL };
