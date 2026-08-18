/* ============================================================
   WHATSAPP — the confirmation, on the channel her clients read
   ------------------------------------------------------------
   Deliberately the same shape as mail/: record, attempt, record
   the outcome. It writes to the SAME crm.messages table with
   channel='whatsapp', so the Messages page, the retry, the
   failure text and the one-per-booking guard all work unchanged.

   WHAT TRAVELS ON WHATSAPP IS A TOKEN, NOT A DESTINATION. The
   message carries a link to our own domain; what the
   consultation actually needs sits on the page behind it. That
   means it can be changed or revoked afterwards, it dies after
   the session, and a forwarded chat carries something that
   stops working rather than something that keeps letting people
   in.

   TWO SENDERS, ONE MESSAGE. `manual` prepares a wa.me link she
   taps — free, no Meta account, and the default so an
   unconfigured system cannot message anybody. `whatsapp-cloud`
   sends it from the business number. Same template file either
   way, so the two cannot drift apart.
   ============================================================ */
"use strict";

const data = require("../data-client");
const { config } = require("../config");
const { toE164 } = require("./phone");

const TEMPLATES = {
  "booking-confirmed": require("./templates/booking-confirmed"),
};

/* Where the token resolves. Must be the public origin — it is read
   by somebody's phone, so localhost is meaningless to them. */
/* One definition, in config.js. The hard-coded domain in
   templates/booking-confirmed.js is NOT this — that is a comment
   recording what Meta approved, and it has to keep saying exactly
   what was submitted. */
const { publicBase } = require("../config");
const LINK_BASE = publicBase();

function provider() {
  const want = (process.env.WHATSAPP_PROVIDER || "").trim().toLowerCase();
  if (want === "cloud" || want === "cloud-api" || (!want && process.env.WHATSAPP_TOKEN)) {
    return require("./providers/cloud-api");
  }
  return require("./providers/manual");
}

const practice = () => ({
  name: config.practice.name || "Mind Your Food",
  dietitian: config.practice.dietitian || "Khadija",
});

/**
 * Confirm a consultation on WhatsApp.
 *
 * @param {object} booking { id, personId, name, phone, country, startAt }
 * @returns {Promise<{sent:boolean, why?:string, link?:string, needsHand?:boolean}>}
 */
async function bookingConfirmed(booking) {
  const template = TEMPLATES["booking-confirmed"];

  /* THE NUMBER IS RESOLVED FIRST, and a failure here stops
     everything before a row is written. There is no point recording
     a message that was never sendable, and the reason it was not is
     something she can fix on the People page in seconds. */
  const phone = await toE164(booking.phone, booking.country);
  if (!phone.ok) return { sent: false, why: phone.why };

  /* The token. Minted or reused — one per consultation, so sending
     the confirmation twice cannot leave a client holding two
     different links wondering which is real. */
  const minted = await data.crm.mintLink(booking.id).catch(() => null);
  if (!minted?.ok) return { sent: false, why: "could not make the link" };

  const view = {
    ...booking,
    practice: practice(),
    timezone: config.practice.timezone || "Asia/Kolkata",
    token: minted.token,
    linkBase: LINK_BASE,
  };

  const claim = await data.crm.queueMessage({
    consultationId: booking.id || null,
    personId: booking.personId || null,
    templateId: template.id,
    templateVersion: template.version,
    recipient: phone.e164,
    subject: `WhatsApp · ${template.metaName}`,
    channel: "whatsapp",
  });

  if (!claim?.ok) return { sent: false, why: "could not record the message" };
  if (claim.duplicate) {
    return { sent: false, why: "already sent", messageId: claim.id };
  }

  const post = provider();
  const out = await post.send({
    e164: phone.e164,
    digits: phone.digits,
    template,
    bodyParams: template.bodyParams(view),
    buttonParam: template.buttonParam(view),
    text: template.text(view),
  });

  await data.crm.messageResult(claim.id, {
    status: out.ok ? "sent" : "failed",
    provider: post.name,
    providerId: out.id || "",
    error: out.error || "",
  });

  if (!out.ok) console.warn(`[whatsapp] to ${phone.e164} failed: ${out.error}`);

  return {
    sent: !!out.ok,
    why: out.error,
    /* Only the manual provider returns a link, and only it needs a
       hand. The CRM shows a "Send on WhatsApp" button when this
       comes back; with the Cloud API it is already gone. */
    link: out.link || null,
    needsHand: !!post.needsHand,
    messageId: claim.id,
  };
}

function describe() {
  const p = provider();
  return p.name === "manual"
    ? "whatsapp: MANUAL — prepares a wa.me link, she presses send"
    : `whatsapp: ${p.name} — sending from the business number`;
}

module.exports = { bookingConfirmed, describe, TEMPLATES, LINK_BASE };
