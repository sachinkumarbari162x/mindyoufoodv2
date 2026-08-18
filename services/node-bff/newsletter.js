/* ============================================================
   NEWSLETTER — subscribe, forwarded to the existing backend

       POST {APPOINTMENTS_API_URL}/newsletter/subscribe
       body: { email, source, locale, policyVersion }   → 202

   That endpoint already implements double opt-in: it stores an
   UNCONFIRMED row and sends a confirmation email. Nothing is
   actually subscribed until the visitor clicks the link in it.

   IMPORTANT — this triggers a real outbound email. Per the standing
   rule about email changes, this module does not compose, alter, or
   re-word any of it: it forwards an address to the existing service
   and lets the approved template do its job. If the copy of that
   email ever needs to change, that is a backend change and needs
   sign-off first.

   With APPOINTMENTS_API_URL unset it runs DRY: validates, logs, and
   returns the same 202 shape without sending anything. That is the
   default, so local work never mails anyone.
   ============================================================ */
"use strict";

const { config } = require("./config");

// Deliberately the same rule as rules/validate.js — close to the
// upstream Zod check, not a full RFC parser.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// One generic reply whatever happens, so this endpoint cannot be
// used to find out whether an address is already on the list.
const GENERIC = "Almost there — check your inbox and click the link to confirm.";

/**
 * @returns {Promise<{status:number, body:object}>}
 */
async function subscribe({ email, company, locale }, ipHash) {
  // Honeypot: bots fill the hidden `company` field. Accept silently
  // and do nothing — the same shape the appointments route uses, so
  // a bot cannot tell the two apart either.
  if (typeof company === "string" && company.trim() !== "") {
    return { status: 202, body: { ok: true, message: GENERIC } };
  }

  const value = String(email || "").trim().toLowerCase();

  if (!value || value.length > 254 || !EMAIL.test(value)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "invalid_email",
        message: "That doesn't look like a complete email address — could you check it?",
      },
    };
  }
  if (/\.(test|invalid|example|local)$/.test(value)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "undeliverable",
        message: "That address won't receive mail. Is there another one?",
      },
    };
  }

  const payload = {
    email: value,
    source: "v2-site-newsletter-card",
    locale: typeof locale === "string" ? locale.slice(0, 20) : undefined,
    policyVersion: config.privacy.policyVersion,
  };

  if (!config.upstream.url) {
    console.log(
      `[bff] DRY RUN newsletter subscribe — no email sent. ` +
        `(${config.privacy.logTranscripts ? value : "«redacted»"}, source=${payload.source})`
    );
    return { status: 202, body: { ok: true, message: GENERIC, dryRun: true } };
  }

  try {
    const res = await fetch(`${config.upstream.url.replace(/\/$/, "")}/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.upstream.timeoutMs),
    });

    if (res.status === 429) {
      return {
        status: 429,
        body: {
          ok: false,
          error: "rate_limited",
          message: "That's a few too many tries from this connection. Give it a minute.",
        },
      };
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error(`[bff] newsletter rejected upstream: ${data?.error || res.status}`);
      return {
        status: 502,
        body: {
          ok: false,
          error: "upstream",
          message: "I couldn't reach the mailing list just now. Try again in a moment?",
        },
      };
    }

    return { status: 202, body: { ok: true, message: GENERIC } };
  } catch (err) {
    console.error("[bff] newsletter upstream unreachable:", err.message);
    return {
      status: 502,
      body: {
        ok: false,
        error: "unreachable",
        message: `I couldn't reach the mailing list just now. Email ${config.practice.contactEmail} and she'll add you.`,
      },
    };
  }
}

module.exports = { subscribe };
