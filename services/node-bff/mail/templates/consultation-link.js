/* ============================================================
   CONSULTATION LINK — the way into the room, by email
   ------------------------------------------------------------
   IT CONTRADICTS booking-confirmed, AND THAT IS NOT AN ACCIDENT
   TO BE TIDIED UP LATER. That email says, in as many words, "she
   will call you — there is no link to join and nothing to
   install." It was true when it was written and it is still true
   for a phone consultation. It is now false for a video one.

   Nothing here changes that template. Somebody has to decide
   which of these a video client receives, and it cannot be both:
   an inbox holding "there is no link" above "here is your link"
   has taught them that this practice does not know what it is
   doing. Until that decision is made, this template is sent by
   hand and by name, never by the accept flow.

   ---------------------------------------------------------------
   THE LINK IS OPAQUE AND SO IT LOOKS LIKE A SCAM. That is the
   unavoidable cost of a token that reveals nothing, and the
   answer is not to make the URL friendlier — it is to put enough
   around it that a real client recognises it as theirs. So this
   email leads with the appointment, names the practitioner, and
   says what happens when they press it. A bare link with "click
   here" is what a filter and a person both read as phishing.

   IT SAYS WHAT THE ROOM WILL DO. "You will be asked for your
   camera and microphone" and "nothing to install" between them
   remove the two reasons somebody closes a video link unopened.
   And it says she starts it, because a client who arrives to a
   waiting screen and has not been told to expect one assumes it
   is broken and rings instead.

   NO TRACKING PIXEL, no click wrapper, no shortener. A shortened
   link would defeat the domain being the only thing vouching for
   this URL, and it is the domain that carries SPF, DKIM and DMARC.
   ============================================================ */
"use strict";

const { html, shell, when } = require("../render");

/* Where the token resolves. The public origin, because it is read
   on somebody else's machine — localhost is meaningless to them.
   Overridden to a local origin only when testing on this box. */
const { publicBase } = require("../../config");

const LINK_BASE = publicBase()
  .replace(/\/+$/, "");

module.exports = {
  id: "consultation-link",
  version: 1,

  /* THIS TEMPLATE CANNOT BE RENDERED FROM A BOOKING ALONE. Every
     other one can — a name, a time, and it is complete. This one
     needs a token, and a re-send that quietly rendered without it
     would post a polite email with no way into the room in it, which
     is worse than not sending at all. The flag is what tells `retry`
     to fetch the link back before re-rendering. */
  needsLink: true,

  subject: (d) => {
    const slot = when(d.startAt, d.timezone);
    return slot
      ? `Your consultation room — ${slot.date}, ${slot.time}`
      : "Your consultation room";
  },

  render(d) {
    const first = String(d.name || "").trim().split(/\s+/)[0] || "there";
    const slot = when(d.startAt, d.timezone);
    const url = d.token ? `${LINK_BASE}/c/${d.token}` : null;

    const body = html`
      <p style="margin:0 0 16px;">Hello ${first},</p>

      <p style="margin:0 0 16px;">
        Here is the room for your consultation with ${d.practice.dietitian}.
      </p>

      ${slot
        ? html`<p style="margin:0 0 20px;padding:14px 16px;background:#ffffff;border:1px solid #e3e0d9;">
            <strong style="font-size:17px;">${slot.date}</strong><br />
            <strong style="font-size:17px;">${slot.time} ${slot.zone}</strong>
          </p>`
        : ""}

      ${url
        ? html`<p style="margin:0 0 20px;">
            <a href="${url}"
               style="display:inline-block;padding:12px 22px;background:#1b1610;color:#f6f3ee;
                      text-decoration:none;font-weight:600;">Open the room</a>
          </p>

          <p style="margin:0 0 16px;font-size:13px;color:#6b6357;">
            Or paste this into your browser:<br />
            <span style="font-family:monospace;word-break:break-all;">${url}</span>
          </p>`
        : html`<p style="margin:0 0 16px;">
            She will send the room link shortly.
          </p>`}

      <p style="margin:0 0 16px;">
        Open it a couple of minutes before your time. Your browser will ask
        for your camera and microphone — there is nothing to install and no
        account to make. You will see a waiting screen until
        ${d.practice.dietitian} starts the consultation, which is normal.
      </p>

      <p style="margin:0 0 16px;">
        The link is yours alone, so please do not forward it. If the time no
        longer suits, reply to this email and she will move it.
      </p>
    `;

    const text = [
      `Hello ${first},`,
      ``,
      `Here is the room for your consultation with ${d.practice.dietitian}.`,
      ``,
      ...(slot ? [`  ${slot.date}`, `  ${slot.time} ${slot.zone}`, ``] : []),
      ...(url ? [`Open the room:`, `  ${url}`, ``] : [`She will send the room link shortly.`, ``]),
      `Open it a couple of minutes before your time. Your browser will ask for`,
      `your camera and microphone - there is nothing to install and no account`,
      `to make. You will see a waiting screen until ${d.practice.dietitian} starts the`,
      `consultation, which is normal.`,
      ``,
      `The link is yours alone, so please do not forward it. If the time no`,
      `longer suits, reply to this email and she will move it.`,
      ``,
      `${d.practice.dietitian} - ${d.practice.name}`,
      d.from,
    ].join("\n");

    return {
      subject: this.subject(d),
      html: shell({ body, practice: d.practice, from: d.from }),
      text,
    };
  },
};
