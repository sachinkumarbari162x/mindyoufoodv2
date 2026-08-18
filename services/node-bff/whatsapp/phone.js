/* ============================================================
   PHONE — a typed number turned into one WhatsApp will accept
   ------------------------------------------------------------
   crm.people.phone is free text, because that is how people type
   their number: "9876543210", "+91 98765 43210", "098765-43210",
   "0091 9876543210". WhatsApp wants exactly one of those forms —
   digits, country code first, nothing else.

   IT REFUSES RATHER THAN GUESSES. That is the whole design. A
   number this cannot resolve becomes a row on the Messages page
   saying so, which she can fix in ten seconds. A number it
   resolves WRONGLY sends a client's appointment details to a
   stranger, and nobody finds out. The two failures are not
   comparable, so the doubtful cases all fall on the safe side.

   NOT A FULL PHONE-NUMBER LIBRARY, and not pretending to be.
   libphonenumber is 300KB and knows every numbering plan on
   earth; this knows the countries in crm.countries and says "I
   cannot tell" about the rest. Adding a country is a row in that
   table, which is also what puts it in the booking form.
   ============================================================ */
"use strict";

/* THE DIALLING PLANS COME FROM crm.countries, WHICH ALREADY HAS THEM.

   This file first carried its own hardcoded table of codes and
   lengths — twenty countries, copied by hand. The database has had
   `dial_code` and `phone_digits` on every country since the schema
   was written, feeding the booking form's own validation. Two tables
   of the same facts drift, and the one that drifts is always the
   copy nobody remembers exists.

   Loaded once and cached. It changes when she adds a country, which
   is a restart-shaped event, not a per-message one. */
let PLANS = null;

async function plans() {
  if (PLANS) return PLANS;
  const out = await require("../data-client").crm.countries().catch(() => null);
  if (!out?.ok) return null; // no guessing while the list is unknown
  PLANS = {};
  for (const c of out.countries || []) {
    if (!c.dialCode) continue;
    PLANS[c.iso2] = {
      code: String(c.dialCode).replace("+", ""),
      len: Array.isArray(c.digits) && c.digits.length ? c.digits : null,
    };
  }
  return PLANS;
}

/**
 * @param {string} raw      whatever they typed
 * @param {string} country  ISO-2 from crm.people, may be missing
 * @returns {{ok:true, e164:string, digits:string} | {ok:false, why:string}}
 */
async function toE164(raw, country) {
  const typed = String(raw || "").trim();
  if (!typed) return { ok: false, why: "no phone number on file" };

  /* A leading + is a claim about the country code, and it is the
     one form that needs no guessing at all. Anything else is a
     national number that only makes sense beside a country. */
  const explicit = typed.startsWith("+");
  let digits = typed.replace(/\D/g, "");

  if (!digits) return { ok: false, why: "no digits in that phone number" };

  if (explicit) {
    // Already international. Trust it, within reason.
    if (digits.length < 8 || digits.length > 15) {
      return { ok: false, why: `+${digits} is not a usable length` };
    }
    return { ok: true, e164: `+${digits}`, digits };
  }

  /* 00 is the other way of writing +, used across Europe and the
     Gulf. Same meaning, so same treatment. */
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    if (digits.length < 8 || digits.length > 15) {
      return { ok: false, why: "that number is not a usable length" };
    }
    return { ok: true, e164: `+${digits}`, digits };
  }

  const table = await plans();
  const plan = table && table[String(country || "").toUpperCase()];
  if (!plan) {
    /* This is the refusal that matters. Without a country, a bare
       ten-digit number could belong to half the world, and picking
       the practice's own country because it is the likeliest is
       exactly the guess that sends somebody else's appointment to a
       stranger in another country. */
    return {
      ok: false,
      why: country
        ? `no dialling code on file for ${country}`
        : "no country on file, and the number has no + to say which",
    };
  }

  /* A leading 0 is the national trunk prefix — how the number is
     dialled inside the country and never part of it. */
  const national = digits.replace(/^0+/, "");

  // Already carries its own country code.
  if (national.startsWith(plan.code)) {
    const rest = national.slice(plan.code.length);
    if (!plan.len || plan.len.includes(rest.length)) {
      return { ok: true, e164: `+${national}`, digits: national };
    }
  }

  /* A country whose digit count nobody recorded is accepted on the
     generic rule rather than refused — the check exists to catch
     typos, and a missing length is not evidence of one. */
  if (plan.len && !plan.len.includes(national.length)) {
    return {
      ok: false,
      why: `a ${country} number should be ${plan.len.join(" or ")} digits, that one is ${national.length}`,
    };
  }
  if (!plan.len && (national.length < 6 || national.length > 14)) {
    return { ok: false, why: `${national.length} digits is not a usable length` };
  }

  const full = plan.code + national;
  return { ok: true, e164: `+${full}`, digits: full };
}

module.exports = { toE164 };
