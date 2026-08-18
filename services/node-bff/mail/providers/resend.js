/* ============================================================
   RESEND — the one that actually posts mail
   ------------------------------------------------------------
   An HTTP call and nothing else, which is what keeps this stack
   at zero dependencies. SMTP would have meant nodemailer or a
   hand-written client; the provider offers a JSON endpoint, so
   `fetch` is the whole integration.

   THE KEY IS READ FROM THE ENVIRONMENT AND NEVER LEAVES THIS
   PROCESS. It is not in any file that is committed, it is not in
   config that the CRM can read back, and it never reaches a
   browser — the send happens here, in the BFF, behind the
   session. The one place it could leak is an error message, so
   the failure path below returns the provider's text without the
   request that produced it.
   ============================================================ */
"use strict";

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT = 10_000;

/**
 * @param {object} m  { from, fromName, to, subject, html, text, replyTo }
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function send(m) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY is not set" };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        /* "Khadija <khadija@mindyourfood.co.in>" — the display name
           matters more than it looks. An inbox showing a bare address
           reads as automated; showing a person's name is the single
           cheapest thing that makes this look like mail from a
           practice rather than from a system. */
        from: m.fromName ? `${m.fromName} <${m.from}>` : m.from,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        /* Both halves, always. A multipart message with a plain-text
           alternative scores better with spam filters than HTML
           alone, and it is what plain-text clients will show. */
        text: m.text,
        /* Replies go to her, not into a void. Transactional mail
           that cannot be answered is the fastest way to teach
           somebody to phone instead. */
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      /* The provider's own sentence, kept as-is. "Domain is not
         verified" and "invalid API key" need entirely different
         actions from her, and a message of ours saying "send
         failed" would hide which one it was. */
      return {
        ok: false,
        error: body?.message || body?.name || `HTTP ${res.status}`,
      };
    }

    return { ok: true, id: body?.id || "" };
  } catch (err) {
    // A timeout or a DNS failure. Never a throw: the caller records
    // this against the message and the row becomes retryable.
    return { ok: false, error: err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

module.exports = { name: "resend", send };
