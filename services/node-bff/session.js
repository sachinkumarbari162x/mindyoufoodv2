/* ============================================================
   SESSION STORE

   In-memory, TTL'd, capped. A session holds the transcript and a
   partly-filled booking draft — a name, an email, a phone number
   and a sentence about somebody's health. That is PII of the more
   sensitive kind, so:

     · it never touches disk,
     · it is dropped as soon as the booking lands (only the
       reference survives, so the visitor can be told it worked),
     · it lapses after `session.ttlMs` of silence,
     · nothing about it is written to the log unless
       LOG_TRANSCRIPTS is explicitly turned on for debugging.

   Restarting the process drops every in-flight conversation.
   That is the accepted trade for a single-box deployment: the
   only durable record was always meant to be the appointment.
   ============================================================ */
"use strict";

const crypto = require("node:crypto");
const { config } = require("./config");

const S = config.session;
const sessions = new Map(); // id → session
const byIp = new Map(); // ipHash → Set<id>

const newId = () => crypto.randomBytes(18).toString("base64url");

/** A booking draft with every field the upstream schema accepts. */
function emptyDraft() {
  return {
    name: "",
    email: "",
    phone: "",
    focusArea: "",
    focusId: "",
    dob: "",
    country: "",
    timezone: "",
    mode: "undecided",
    modeLabel: "Undecided",
    notes: "",
    suggestedSlots: [],
    consent: false,
  };
}

function create(ipHash, meta) {
  if (sessions.size >= S.maxTotal) {
    // Shed the oldest rather than refuse the newest: a full table is
    // an operational problem, and turning away a real booking is a
    // worse outcome than dropping a stale conversation.
    const oldest = [...sessions.values()].sort((a, b) => a.touched - b.touched)[0];
    if (oldest) destroy(oldest.id);
  }

  const ids = byIp.get(ipHash) || new Set();
  if (ids.size >= S.maxPerIp) {
    const stale = [...ids]
      .map((id) => sessions.get(id))
      .filter(Boolean)
      .sort((a, b) => a.touched - b.touched)[0];
    if (stale) destroy(stale.id);
  }

  const now = Date.now();
  const s = {
    id: newId(),
    ipHash,
    created: now,
    touched: now,
    turns: 0,
    // greeting → collecting → review → confirmed | halted | closed
    state: "greeting",
    draft: emptyDraft(),
    // Rolling transcript for the LLM. Capped — a long chat must not
    // grow the prompt without bound, and the draft already carries
    // everything that actually matters.
    history: [],
    booking: null,
    locale: meta?.locale || "",
    timezone: meta?.timezone || "",
    // What the desk last asked for, so a bare answer ("tuesday") can
    // be attributed to the right field without asking the LLM again.
    awaiting: null,
    flags: { emergency: false, deflections: 0, invalidSlots: 0 },
  };

  sessions.set(s.id, s);
  ids.add(s.id);
  byIp.set(ipHash, ids);
  return s;
}

function get(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.touched > S.ttlMs) {
    destroy(id);
    return null;
  }
  s.touched = Date.now();
  return s;
}

function destroy(id) {
  const s = sessions.get(id);
  if (!s) return false;
  // Overwrite the PII before dropping the reference. Belt and braces
  // against a heap dump outliving the delete.
  s.draft = emptyDraft();
  s.history.length = 0;
  sessions.delete(id);
  const ids = byIp.get(s.ipHash);
  if (ids) {
    ids.delete(id);
    if (!ids.size) byIp.delete(s.ipHash);
  }
  return true;
}

/** Append to the rolling history, keeping only the recent window. */
function remember(s, role, content) {
  s.history.push({ role, content: String(content).slice(0, 1200) });
  if (s.history.length > 16) s.history.splice(0, s.history.length - 16);
}

function sweep() {
  const cutoff = Date.now() - S.ttlMs;
  for (const [id, s] of sessions) if (s.touched < cutoff) destroy(id);
}

const stats = () => ({ sessions: sessions.size, ips: byIp.size });

module.exports = { create, get, destroy, remember, sweep, stats, emptyDraft };
