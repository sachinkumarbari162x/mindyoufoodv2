/* ============================================================
   MAIL — the two emails this practice sends
   ------------------------------------------------------------
       booking-received    the form was submitted
       booking-confirmed   she accepted it on Requests

   THE ORDER IS: RECORD, SEND, RECORD THE OUTCOME. A row is
   written before the attempt, so a provider that times out
   leaves a failed message she can see and retry rather than
   silence. It is the same reasoning as writing an outcome and a
   status in one transaction — the visible state must never be
   able to disagree with what happened.

   SENDING NEVER FAILS A BOOKING. Every call here is best-effort
   and swallows its own errors. A booking that was accepted, with
   an email that did not go out, is a recoverable situation and
   the Messages page shows it. A booking refused because an email
   provider was down is a lost client.

   THE DATABASE DECIDES WHETHER TO SEND. The unique index on
   (consultation_id, template_id) means a second attempt to queue
   the same message comes back as `duplicate` and nothing is
   posted — so a double-clicked Accept cannot produce two
   confirmations in somebody's inbox. The guard is in Postgres
   rather than in a flag up here, because that is the only place
   it holds under two requests at once.
   ============================================================ */
"use strict";

const data = require("../data-client");
const { config } = require("../config");

const TEMPLATES = {
  "booking-received": require("./templates/booking-received"),
  "booking-confirmed": require("./templates/booking-confirmed"),
  /* Sent BY HAND, never by the accept flow — see the header of the
     template itself. It says the opposite of what booking-confirmed
     says about links, and which one a video client gets is a
     decision nobody has made yet. */
  "consultation-link": require("./templates/consultation-link"),
};

/* ---- who this is from ------------------------------------------
   One address, from config, used by both templates and by the
   Reply-To. It is hers rather than a no-reply because somebody
   answering "can we make it Thursday?" should reach a person. */
const FROM = process.env.MAIL_FROM || config.practice.contactEmail;
const FROM_NAME = process.env.MAIL_FROM_NAME || config.practice.dietitian || "Mind Your Food";

/* ---- which provider --------------------------------------------
   Outbox unless a key says otherwise, so the DEFAULT CANNOT SEND.
   A missing key is not an error here — it is the safe state. */
function provider() {
  const want = (process.env.MAIL_PROVIDER || "").trim().toLowerCase();
  if (want === "resend" || (!want && process.env.RESEND_API_KEY)) {
    return require("./providers/resend");
  }
  return require("./providers/outbox");
}

/** Everything a template needs that is not about the booking. */
function practice() {
  return {
    name: config.practice.name || "Mind Your Food",
    dietitian: config.practice.dietitian || "Khadija",
  };
}

/**
 * Send one templated email about one consultation.
 *
 * @param {string} templateId  a key of TEMPLATES
 * @param {object} booking     { id, personId, name, email, focusArea, mode, startAt }
 * @param {object} extra       anything the template needs that is not
 *                             about the booking — a minted token, say.
 *                             Spread over the view LAST is deliberate:
 *                             a caller handing in a token must be able
 *                             to override, and nothing in `booking`
 *                             carries these names today.
 * @returns {Promise<{sent:boolean, why?:string, messageId?:string}>}
 */
async function sendFor(templateId, booking, extra = {}) {
  const template = TEMPLATES[templateId];
  if (!template) return { sent: false, why: `no template "${templateId}"` };
  if (!booking?.email) return { sent: false, why: "no email address on that booking" };

  const view = {
    ...booking,
    practice: practice(),
    from: FROM,
    timezone: config.practice.timezone || "Asia/Kolkata",
    ...extra,
  };

  let rendered;
  try {
    rendered = template.render(view);
  } catch (err) {
    console.warn(`[mail] ${templateId} failed to render: ${err.message}`);
    return { sent: false, why: "template failed to render" };
  }

  /* 1 · claim it. The database refuses a second claim for the same
        booking and template, which is what makes this safe to call
        from a route somebody can double-click. */
  const claim = await data.crm.queueMessage({
    consultationId: booking.id || null,
    personId: booking.personId || null,
    templateId: template.id,
    templateVersion: template.version,
    recipient: booking.email,
    subject: rendered.subject,
    channel: "email",
  });

  if (!claim?.ok) return { sent: false, why: "could not record the message" };
  if (claim.duplicate) {
    console.log(`[mail] ${templateId} already ${claim.status} for ${booking.id} — not sending again`);
    return { sent: false, why: "already sent", messageId: claim.id };
  }

  // 2 · attempt it.
  const post = provider();
  const out = await post.send({
    from: FROM,
    fromName: FROM_NAME,
    to: booking.email,
    replyTo: FROM,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    templateId: template.id,
    templateVersion: template.version,
  });

  // 3 · say how it went, whichever way it went.
  await data.crm.messageResult(claim.id, {
    status: out.ok ? "sent" : "failed",
    provider: post.name,
    providerId: out.id || "",
    error: out.error || "",
  });

  if (!out.ok) console.warn(`[mail] ${templateId} to ${booking.email} failed: ${out.error}`);
  return { sent: !!out.ok, why: out.error, messageId: claim.id };
}

/** Send again, re-rendered from the booking as it stands now. */
async function retry(messageId) {
  const found = await data.crm.message(messageId);
  const m = found?.message;
  if (!m) return { sent: false, why: "no message with that reference" };
  if (!m.consultationId) return { sent: false, why: "that message is not attached to a booking" };

  const got = await data.crm.consultation(m.consultationId);
  const c = got?.consultation;
  if (!c) return { sent: false, why: "that booking is gone" };

  const template = TEMPLATES[m.templateId];
  if (!template) return { sent: false, why: `no template "${m.templateId}"` };

  /* Templates that carry a way in need it back before they can be
     rendered again. mintLink is mint-or-return, so this hands back
     the SAME token the first attempt used — a retry must never be a
     second link, or the client is holding two URLs and cannot tell
     which of them is real. */
  let token;
  if (template.needsLink) {
    const minted = await data.crm.mintLink(m.consultationId).catch(() => null);
    if (!minted?.ok) return { sent: false, why: "could not recover the link" };
    token = minted.token;
  }

  const rendered = template.render({
    ...c,
    name: c.name,
    email: c.email,
    startAt: c.startAt,
    practice: practice(),
    from: FROM,
    timezone: config.practice.timezone || "Asia/Kolkata",
    ...(token ? { token } : {}),
  });

  const post = provider();
  const out = await post.send({
    from: FROM,
    fromName: FROM_NAME,
    to: m.recipient,
    replyTo: FROM,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    templateId: template.id,
    templateVersion: template.version,
  });

  await data.crm.messageResult(messageId, {
    status: out.ok ? "sent" : "failed",
    provider: post.name,
    providerId: out.id || "",
    error: out.error || "",
  });

  return { sent: !!out.ok, why: out.error };
}

/* ---- the two triggers, named after what happened ---------------
   Called from the flow and from the Requests page. Both swallow
   everything: an email is downstream of the thing that matters. */
const bookingReceived = (booking) =>
  sendFor("booking-received", booking).catch((e) => ({ sent: false, why: e.message }));

const bookingConfirmed = (booking) =>
  sendFor("booking-confirmed", booking).catch((e) => ({ sent: false, why: e.message }));

/**
 * The room, by email. NOT WIRED TO ACCEPT — called by name, on
 * purpose, because it contradicts booking-confirmed and somebody has
 * to decide which a video client receives.
 *
 * It mints the token itself, exactly as the WhatsApp path does, so
 * both routes hand out ONE link per consultation. A second token
 * would leave a client holding two URLs with no way to tell which
 * one is real.
 */
async function consultationLink(booking) {
  const minted = await data.crm.mintLink(booking.id).catch(() => null);
  if (!minted?.ok) return { sent: false, why: "could not make the link" };

  return sendFor("consultation-link", booking, { token: minted.token })
    .then((out) => ({ ...out, token: minted.token, expiresAt: minted.expiresAt }))
    .catch((e) => ({ sent: false, why: e.message }));
}

/** What the console should say at boot, so the mode is never a guess. */
function describe() {
  const p = provider();
  return p.name === "outbox"
    ? "mail: OUTBOX — writing .eml files, nothing is sent"
    : `mail: ${p.name} — sending as ${FROM}`;
}

module.exports = {
  bookingReceived, bookingConfirmed, consultationLink,
  retry, describe, FROM, TEMPLATES,
};
