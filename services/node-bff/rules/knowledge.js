/* ============================================================
   KNOWLEDGE — the answers, loaded from the database

   What the desk says used to be functions in flow.js, so changing
   a sentence meant an edit, a commit and a restart. In practice
   that meant the wording drifted out of date and nobody noticed.
   These now come from crm.knowledge, and she edits them in the CRM
   like her hours.

   CACHED, AND STALE IS THE RIGHT FAILURE.
   Fetched once and refreshed on a timer. If the data service is
   unreachable the cache is kept and used — a desk answering with
   last hour's wording is obviously better than one that cannot
   answer at all, and these sentences change perhaps monthly.
   Nothing here is ever fetched inside a conversation turn.

   PLACEHOLDERS KEEP THE FACTS LIVE.
   Hours, focus areas and her email are held elsewhere and are
   substituted at render time. An answer that spelled out Saturday
   hours in prose would go stale the day she changed them, and the
   sentence is exactly where nobody would think to look.
   ============================================================ */
"use strict";

const { config } = require("../config");
const data = require("../data-client");
const hours = require("./hours");
const v = require("./validate");

const P = config.practice;

/* Refreshed on this interval. Long, because these are sentences a
   person edits by hand — a minute of staleness after she saves is
   not worth a query on every turn. */
const REFRESH_MS = 60_000;

let answers = new Map(); // intent -> { label, answer }
let phrasings = new Map(); // intent -> [phrase, …]
let loadedAt = 0;
let loading = null;

/* ---- placeholders --------------------------------------------
   Resolved fresh on every render, never at load time: `{presence}`
   is "Open now · until 19:00" and would be a lie within the hour
   if it were baked into the cache. */
function substitute(text) {
  if (!text) return text;
  const focus = v.FOCUS_AREAS.map((f) => f.label.toLowerCase());

  return text
    .replace(/\{hours\}/g, P.hoursText)
    .replace(/\{presence\}/g, hours.presence().label)
    .replace(/\{focusAreas\}/g, focus.slice(0, -1).join(", ") + ", and " + focus[focus.length - 1])
    .replace(/\{email\}/g, P.contactEmail)
    .replace(/\{replyWindow\}/g, P.replyWindow);
}

/* ---- loading -------------------------------------------------- */

async function refresh() {
  /* THE DESK'S ANSWERS, AND ONLY THOSE. Said explicitly rather
     than relying on the default: this is the loader whose output
     goes to strangers, and it should be obvious at this line which
     half of the table it reads. */
  const out = await data.crm.knowledge("desk");
  if (!out || !out.ok) return false;

  const nextAnswers = new Map();
  for (const a of out.answers || []) {
    nextAnswers.set(a.intent, { label: a.label, answer: a.answer });
  }
  const nextPhrasings = new Map();
  for (const p of out.phrasings || []) {
    if (!nextPhrasings.has(p.intent)) nextPhrasings.set(p.intent, []);
    nextPhrasings.get(p.intent).push(p.phrase);
  }

  // Only swap on a good load. A half-read response must not be able
  // to empty the knowledge base.
  if (nextAnswers.size) {
    answers = nextAnswers;
    phrasings = nextPhrasings;
    loadedAt = Date.now();
    return true;
  }
  return false;
}

/** Kick a refresh if the cache is old. Never awaited by a turn.
 *
 *  Note what this means in practice: the request that NOTICES the
 *  cache is stale still gets served the old copy, and the next one
 *  gets the new. So an edit takes effect after the refresh interval
 *  plus one visitor, not exactly at the interval.
 *
 *  That is the right trade. Awaiting it would put a database round
 *  trip inside the turn that happened to arrive on the minute — one
 *  unlucky visitor waiting so the one after them saves nothing.
 *  These are sentences she edits by hand; a minute either way is
 *  invisible.
 */
function maybeRefresh() {
  if (loading || Date.now() - loadedAt < REFRESH_MS) return;
  loading = refresh()
    .catch(() => false)
    .finally(() => {
      loading = null;
    });
}

/** Called once at boot so the first visitor is not served from an
    empty cache. Failure is survivable — flow.js keeps its built-in
    answers as a floor.
 *
 *  Retried, because the usual reason this fails is a race rather
 *  than a fault: all four services start together, and go-data
 *  applies its migrations before it answers anything. One attempt
 *  lost that race every time, logged a warning that read like an
 *  outage, and left the desk on built-in answers until a visitor
 *  happened to trigger the refresh timer.
 */
async function prime(attempt = 1) {
  const ok = await refresh().catch(() => false);
  if (ok) return true;

  if (attempt < 8) {
    /* 1s, 2s, 4s, 8s, 16s, 16s, 16s — sixty-three seconds in all.
       Four attempts over fifteen seconds was sized for a local
       database, where go-data applies its schema in well under a
       second. Against a managed one across the network the same
       schema is a couple of hundred statements at ~50 ms each, so
       go-data is simply not answering yet when the old budget ran
       out — and the desk fell back to built-in answers on every
       restart. Capped at 16s so the tail is patience, not a
       process that never gives up. */
    const wait = Math.min(2 ** (attempt - 1) * 1000, 16000);
    await new Promise((r) => setTimeout(r, wait));
    return prime(attempt + 1);
  }

  console.warn("[bff] knowledge base unavailable after 8 attempts — using built-in answers");
  return false;
}

/* ---- reading -------------------------------------------------- */

/** The answer for an intent, with placeholders resolved, or null. */
function answerFor(intent) {
  maybeRefresh();
  const hit = answers.get(intent);
  return hit ? substitute(hit.answer) : null;
}

/** How to name a topic back to a visitor. */
function labelFor(intent) {
  return answers.get(intent)?.label || null;
}

/** Phrasings she has taught it, as extra evidence for the NLU. */
function phrasingsFor(intent) {
  return phrasings.get(intent) || [];
}

/** Every phrasing, flattened — the NLU scores against this. */
function allPhrasings() {
  maybeRefresh();
  const out = [];
  for (const [intent, list] of phrasings) for (const phrase of list) out.push({ intent, phrase });
  return out;
}

/** Record a message the desk could not place, so she can teach it.
    Fire and forget: this is a note for later, and it must never
    affect the conversation that produced it. */
function missed(text) {
  data.crm.missed(text).catch(() => {});
}

module.exports = {
  prime,
  answerFor,
  labelFor,
  phrasingsFor,
  allPhrasings,
  missed,
  substitute,
  get size() {
    return answers.size;
  },
};
