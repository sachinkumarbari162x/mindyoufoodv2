/* ============================================================
   BOOKING CONFIRMED — sent when she accepts on the Requests page
   ------------------------------------------------------------
   THE JOB OF THIS EMAIL IS TO BE FOUND AGAIN. Somebody will come
   back to it a week later to check what day it was, so the time
   is the most prominent thing in it and the subject line carries
   the date — a subject that says only "Confirmed" is unfindable
   in a search three weeks on.

   WHAT IT DOES NOT DO: attach a calendar invite. That is worth
   adding, and it is not free — an .ics needs a stable UID and a
   sequence number that increments on every change, or a
   rescheduled appointment silently leaves the old one in the
   visitor's calendar. Better absent than half-done.

   IT SAYS SHE WILL RING. There is no meeting link in this
   practice and never has been; an email that leaves that unsaid
   produces somebody sitting at their laptop waiting for a link
   that is not coming.
   ============================================================ */
"use strict";

const { html, shell, when } = require("../render");

const HOW = {
  video: "a video call",
  audio: "a phone call",
  in_person: "an in-person session",
  undecided: "your consultation",
};

module.exports = {
  id: "booking-confirmed",
  version: 1,

  subject: (d) => {
    const slot = when(d.startAt, d.timezone);
    return slot
      ? `Your consultation is confirmed — ${slot.date}`
      : "Your consultation is confirmed";
  },

  render(d) {
    const first = String(d.name || "").trim().split(/\s+/)[0] || "there";
    const slot = when(d.startAt, d.timezone);
    const how = HOW[d.mode] || HOW.undecided;

    const body = html`
      <p style="margin:0 0 16px;">Hello ${first},</p>

      <p style="margin:0 0 16px;">
        ${d.practice.dietitian} has confirmed your consultation.
      </p>

      ${slot
        ? html`<p style="margin:0 0 20px;padding:14px 16px;background:#ffffff;border:1px solid #e3e0d9;">
            <strong style="font-size:17px;">${slot.date}</strong><br />
            <strong style="font-size:17px;">${slot.time} ${slot.zone}</strong>
          </p>`
        : html`<p style="margin:0 0 16px;">
            She will be in touch to fix a time with you.
          </p>`}

      <p style="margin:0 0 16px;">
        It is ${how}, and <strong>she will call you</strong> — there is no
        link to join and nothing to install.
      </p>

      <p style="margin:0 0 16px;">
        If that time no longer suits, reply to this email and she will
        move it. The sooner you say, the easier it is to give the slot
        to somebody else.
      </p>
    `;

    const text = [
      `Hello ${first},`,
      ``,
      `${d.practice.dietitian} has confirmed your consultation.`,
      ``,
      ...(slot
        ? [`  ${slot.date}`, `  ${slot.time} ${slot.zone}`, ``]
        : [`She will be in touch to fix a time with you.`, ``]),
      `It is ${how}, and she will call you - there is no link to join and`,
      `nothing to install.`,
      ``,
      `If that time no longer suits, reply to this email and she will move`,
      `it. The sooner you say, the easier it is to give the slot to somebody`,
      `else.`,
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
