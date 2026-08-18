/* ============================================================
   BOOKING — submit to the existing appointments API

   The receptionist is a new front door onto the SAME hardened
   endpoint the v1 form posts to:

       POST {APPOINTMENTS_API_URL}/appointments

   Nothing here changes that contract, the practitioner's
   notification email, or its copy — see email-changes-need-signoff.
   The only new thing in the payload is `source`, which is what the
   funnel work will use to tell desk bookings from form bookings.

   With APPOINTMENTS_API_URL unset the module runs DRY: it builds
   and validates the exact payload, logs it, and returns a
   reference. That is the default, so local development can never
   put a test booking in front of a real practitioner.
   ============================================================ */
"use strict";

const crypto = require("node:crypto");
const { config } = require("./config");

/** Visitor-facing reference. Not a secret and not an ID — just
    something quotable in an email if they need to chase it. */
function reference() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}`.slice(2) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
  return `MYF-${ymd}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

/** Draft → the upstream schema's shape, and nothing beyond it. */
function toPayload(draft, session) {
  const notes = [draft.notes || ""];

  // Anything the desk learned that the schema has no field for goes
  // into notes, labelled — the practitioner reads this, so it has to
  // be legible prose, not a JSON dump.
  if (draft.focusId === "other" && draft.focusArea) {
    notes.push(`Focus (in their words): ${draft.focusArea}`);
  }

  /* The upstream appointments schema has no date-of-birth field, and
     this module does not widen that contract. It goes to her as a
     labelled line in the notes, with the age worked out so she does
     not have to. If DOB becomes a first-class field, it belongs in a
     backend migration, not here. */
  if (draft.dob) {
    notes.push(`Date of birth: ${draft.dob}${draft.age ? ` (age ${draft.age})` : ""}`);
  }
  if (session?.timezone && session.timezone !== config.practice.timezone) {
    notes.push(`Visitor timezone: ${session.timezone} — times above are as they gave them.`);
  }
  notes.push("Booked through the website front desk (chat).");

  return {
    name: draft.name,
    email: draft.email,
    phone: draft.phone || undefined,
    focusArea: draft.focusArea,
    country: draft.country || undefined,
    timezone: session?.timezone || draft.timezone || undefined,
    mode: draft.mode || "undecided",
    notes: notes.filter(Boolean).join("\n").slice(0, 2000),
    suggestedSlots: (draft.suggestedSlots || []).slice(0, 3),
    source: config.upstream.source,
    policyVersion: config.privacy.policyVersion,
    locale: session?.locale || undefined,
  };
}

/**
 * @returns {Promise<{ok:true, reference:string, id?:string, crmOnly:boolean} | {ok:false, message:string, status?:number}>}
 */
async function submit(draft, session) {
  const payload = toPayload(draft, session);
  const ref = reference();

  if (!config.upstream.url) {
    /* NOT a dry run, and it has not been one since the CRM started
       storing bookings. The consultation lands in crm.consultations,
       appears in Requests, holds a slot and expires like any other.

       APPOINTMENTS_API_URL is a SECOND destination, for anybody
       still running v1's endpoint. Unset is the normal case now, and
       the log said "DRY RUN" at exactly the moment a real booking
       was written. */
    console.log(
      `[bff] booked ${ref} — recorded in the CRM (no external endpoint configured).\n` +
        JSON.stringify(
          config.privacy.logTranscripts
            ? payload
            : { ...payload, name: "«redacted»", email: "«redacted»", phone: undefined, notes: "«redacted»" },
          null,
          2
        )
    );
    return { ok: true, reference: ref, crmOnly: true };
  }

  try {
    const res = await fetch(`${config.upstream.url.replace(/\/$/, "")}/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.upstream.timeoutMs),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        message:
          "The booking system is throttling requests from your network just now. Give it a minute and " +
          "press send again — nothing has been lost.",
      };
    }
    if (!res.ok) {
      // Surface the upstream Zod message when there is one: it is the
      // authority on the schema, and it is usually more specific than
      // anything this layer would invent.
      const detail = data?.error || data?.message || `HTTP ${res.status}`;
      console.error(`[bff] booking rejected upstream: ${detail}`);
      return { ok: false, status: res.status, message: String(detail).slice(0, 300) };
    }

    return { ok: true, reference: ref, id: data.id, crmOnly: false };
  } catch (err) {
    console.error("[bff] booking upstream unreachable:", err.message);
    return {
      ok: false,
      message:
        "I couldn't reach the booking system just now. Nothing was lost — try confirming again in a " +
        `moment, or email ${config.practice.contactEmail} directly and she'll pick it up.`,
    };
  }
}

module.exports = { submit, toPayload, reference };
