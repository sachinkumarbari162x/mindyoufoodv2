/* ============================================================
   HER ASSISTANT — the facts half
   ------------------------------------------------------------
   The model does not query anything. This file does, and hands it
   a finished brief.

       RULES GATHER THE FACTS. THE MODEL ONLY WORDS THEM.

   That split is why the answer can be trusted. An assistant with
   database access would be quicker to write and impossible to
   rely on: every reply would need checking against the data,
   which is the work it exists to save. With the facts fixed in
   advance, an invented number is one that is not in the brief —
   and she can see the brief.

   It also cannot ACT. It drafts; she sends. Nothing here writes.
   ============================================================ */
"use strict";

const data = require("../data-client");
const hours = require("../rules/hours");
const { config } = require("../config");

const P = config.practice;

const AI_URL = process.env.AI_SERVICE_URL || "http://127.0.0.1:5503";
const TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 12000;

/** Ask py-ai to word a brief. Never throws — the CRM shows its own
    numbers regardless, and a missing sentence is not a broken page. */
async function word(task, brief, question) {
  try {
    const res = await fetch(`${AI_URL}/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, brief, question }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return { text: "", note: `ai ${res.status}` };
    return await res.json();
  } catch (err) {
    return { text: "", note: err.name === "TimeoutError" ? "timed out" : "unavailable" };
  }
}

/* ---- the brief ------------------------------------------------
   Only what she could see for herself on the other pages. The
   assistant is a reading of her own data, not a source of new
   claims about it. */
async function gather() {
  const [held, today, ahead] = await Promise.all([
    data.crm.consultations("held"),
    data.crm.consultations("today"),
    data.crm.consultations("upcoming"),
  ]);

  const now = new Date();
  const presence = hours.presence(now);

  /* Times go in ALREADY FORMATTED, in the practice's timezone.
     Handing over a raw UTC instant made the model read 2026-08-13
     07:30Z back as "August 13th at 07:30" — and it was drafting a
     message to a client whose appointment is at 13:00. A draft with
     the wrong hour in it is the single most dangerous thing this
     feature can produce, and she would have to catch it every time.

     Formatting is not the model's job. It is arithmetic, it has one
     right answer, and code does it correctly every time. */
  const when = (iso) =>
    iso
      ? new Date(iso).toLocaleString("en-GB", {
          timeZone: P.timezone,
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : null;

  const brief = (list) =>
    (list?.consultations || []).map((c) => ({
      name: c.name.split(" ")[0],
      focus: c.focusArea,
      mode: c.mode,
      // Named to say what it is, so the model cannot mistake it for
      // the visitor's own local time.
      atPracticeTime: when(c.startAt),
      holdExpires: when(c.holdExpiresAt),
      holdExpiresIso: c.holdExpiresAt,
    }));

  const waiting = brief(held);

  /* Ids come back BESIDE the facts, never inside them — see
     briefing(). Kept in the same pass so this is still one round of
     queries, not two. */
  const waitingIds = (held?.consultations || []).map((c) => c.id);

  const facts = {
    now: now.toISOString(),
    office: presence.label,
    waiting,
    today: brief(today),
    upcoming: brief(ahead),
    // Named separately rather than left for the model to work out
    // from timestamps — arithmetic on dates is exactly the kind of
    // thing it gets quietly wrong.
    holdsExpiringSoon: waiting.filter(
      (w) => w.holdExpiresIso && Date.parse(w.holdExpiresIso) - now.getTime() < 12 * 3600e3
    ).length,
  };

  return { facts, waitingIds };
}

/** Two or three sentences on how the day stands. */
async function briefing() {
  const { facts, waitingIds } = await gather();
  const out = await word("brief", facts);

  /* The ids the draft buttons need, carried BESIDE the facts rather
     than inside them. Two reasons, and both matter:

     - the model never sees a UUID. It has no use for one, it cannot
       act on one, and a key in a prompt is a key in a log.
     - the CRM keeps them in module scope and never writes one into
       an attribute, so they do not reach the page's markup.

     Neither of those is the full fix. A short opaque `reference` on
     crm.consultations, used everywhere the primary key is used now,
     is — and it is still to do. */
  return {
    status: 200,
    body: {
      // The numbers travel WITH the sentence, so the page can show
      // her practice even when the model is unavailable — and so she
      // can check the sentence against them if she wants to.
      facts,
      waitingIds,
      text: out.text || "",
      model: out.model || "none",
      note: out.note || null,
    },
  };
}

/** A question about her own practice, answered from the same brief. */
async function ask(question) {
  if (!String(question || "").trim()) {
    return { status: 400, body: { error: "empty_question" } };
  }
  const { facts } = await gather();
  const out = await word("ask", facts, String(question).slice(0, 300));
  return {
    status: 200,
    body: { text: out.text || "", model: out.model || "none", note: out.note || null },
  };
}

/** A message to one client, for her to read and send herself. */
async function draft(id) {
  const held = await data.crm.consultations("held");
  const all = [held, await data.crm.consultations("today"), await data.crm.consultations("upcoming")];

  let person = null;
  for (const set of all) {
    const hit = (set?.consultations || []).find((c) => c.id === id);
    if (hit) {
      person = {
        name: hit.name.split(" ")[0],
        focus: hit.focusArea,
        mode: hit.mode,
        atPracticeTime: hit.startAt
          ? new Date(hit.startAt).toLocaleString("en-GB", {
              timeZone: P.timezone,
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : null,
      };
      break;
    }
  }
  if (!person) return { status: 404, body: { error: "not_found" } };

  const out = await word("draft", {
    client: person,
    office: hours.presence().label,
    timezone: P.timezone,
  });
  return {
    status: 200,
    body: {
      // Explicitly a draft. The CRM says so too — a generated message
      // that looked sent would be the one dangerous thing here.
      draft: out.text || "",
      model: out.model || "none",
      note: out.note || null,
    },
  };
}

module.exports = { briefing, ask, draft };
