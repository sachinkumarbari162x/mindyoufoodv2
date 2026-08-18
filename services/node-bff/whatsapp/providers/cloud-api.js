/* ============================================================
   META CLOUD API — the system sends it
   ------------------------------------------------------------
   One HTTPS call to graph.facebook.com. No SDK, no dependency,
   nothing to keep up to date but a version number.

   SENDING NEEDS NO PUBLIC URL. This is outbound only, so it works
   from a laptop exactly as it works from the box — the same
   property that let the email go live before the site did. A
   public webhook is needed for delivery receipts and inbound
   replies, and for nothing else.

   BUSINESS-INITIATED MESSAGES MUST USE AN APPROVED TEMPLATE, and
   that is not a formality — free text sent outside the 24-hour
   window is refused by the API, not delivered and quietly
   dropped. So this only ever sends templates, and the template
   file is the single place their shape is defined.

   THE TOKEN IS READ FROM THE ENVIRONMENT AND STAYS IN THIS
   PROCESS. It is never in a committed file, never in anything
   the CRM can read back, and never in a browser.
   ============================================================ */
"use strict";

const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const TIMEOUT = 10_000;

/**
 * @param {object} m  { e164, template, bodyParams, buttonParam }
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function send(m) {
  const token = (process.env.WHATSAPP_TOKEN || "").trim();
  const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();

  if (!token) return { ok: false, error: "WHATSAPP_TOKEN is not set" };
  if (!phoneId) return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID is not set" };
  if (!m.e164) return { ok: false, error: "no usable phone number" };

  /* Components are positional. `body` variables fill {{1}}, {{2}} in
     the order the template file lists them; the button component
     carries the one dynamic URL suffix. Getting the order wrong is
     not an error the API can catch — it would send a fluent message
     with the name and the date swapped — which is why the ordering
     lives in the template file and not here. */
  const components = [
    {
      type: "body",
      parameters: (m.bodyParams || []).map((text) => ({ type: "text", text: String(text) })),
    },
  ];

  if (m.buttonParam) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(m.buttonParam) }],
    });
  }

  try {
    const res = await fetch(`https://graph.facebook.com/${VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        // WhatsApp wants the number without a leading +.
        to: m.e164.replace(/^\+/, ""),
        type: "template",
        template: {
          name: m.template.metaName,
          language: { code: m.template.language },
          components,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      /* Meta's own sentence, kept whole. The failures here need
         completely different actions — "template does not exist",
         "recipient has not opted in", "number not registered",
         "access token expired" — and collapsing them into "send
         failed" would leave her guessing at every one of them. */
      const e = body?.error || {};
      return {
        ok: false,
        error: [e.message, e.error_data?.details].filter(Boolean).join(" — ") || `HTTP ${res.status}`,
      };
    }

    return { ok: true, id: body?.messages?.[0]?.id || "" };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

module.exports = { name: "whatsapp-cloud", send, needsHand: false };
