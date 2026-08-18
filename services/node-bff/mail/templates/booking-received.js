/* ============================================================
   BOOKING RECEIVED — sent the moment the form is submitted
   ------------------------------------------------------------
   THE JOB OF THIS EMAIL IS TO STOP SOMEBODY WORRYING. They have
   just given a stranger's website their name, their date of
   birth and a health concern, and the page said "thank you".
   This is the proof that it went somewhere.

   IT PROMISES ONLY WHAT THE SYSTEM CAN KEEP. It does not say
   "confirmed", because nothing is: she has not looked at it yet.
   It does not name a time as settled, because she may move it.
   An email that over-promises here produces the exact phone call
   it was meant to prevent.

   VERSION 1. Bump the version when the wording changes — the
   version is stored on every send, so "which one did they get"
   stays answerable.
   ============================================================ */
"use strict";

const { html, shell, when } = require("../render");

module.exports = {
  id: "booking-received",
  version: 1,

  /* Plain, specific, and no exclamation mark. It has to be
     recognisable in a crowded inbox as "the thing I just did". */
  subject: () => "We have your consultation request",

  /**
   * @param {object} d  { name, focusArea, startAt, practice, from, timezone }
   */
  render(d) {
    const first = String(d.name || "").trim().split(/\s+/)[0] || "there";
    const slot = when(d.startAt, d.timezone);

    const body = html`
      <p style="margin:0 0 16px;">Hello ${first},</p>

      <p style="margin:0 0 16px;">
        Thank you for asking about a consultation with
        ${d.practice.dietitian}. This is just to confirm your request
        reached us — nothing further is needed from you right now.
      </p>

      ${slot
        ? html`<p style="margin:0 0 16px;">
            You asked for <strong>${slot.full}</strong>. That time is being
            held for you while she looks at it.
          </p>`
        : html`<p style="margin:0 0 16px;">
            You did not pick a time, so she will suggest one when she
            writes back.
          </p>`}

      ${d.focusArea
        ? html`<p style="margin:0 0 16px;">You told us it is about ${d.focusArea}.</p>`
        : ""}

      <p style="margin:0 0 16px;">
        She reads these herself, so a confirmation will follow rather
        than an instant answer. If anything changes in the meantime,
        reply to this email and it comes straight to her.
      </p>
    `;

    /* The plain-text half is not a courtesy. A message with no text
       alternative is scored as more likely to be spam, and some
       clients show nothing at all without one. It is written out
       rather than stripped from the HTML, because tag-stripped prose
       reads like a machine wrote it. */
    const text = [
      `Hello ${first},`,
      ``,
      `Thank you for asking about a consultation with ${d.practice.dietitian}.`,
      `This is just to confirm your request reached us - nothing further is`,
      `needed from you right now.`,
      ``,
      slot
        ? `You asked for ${slot.full}. That time is being held for you while she looks at it.`
        : `You did not pick a time, so she will suggest one when she writes back.`,
      ...(d.focusArea ? ["", `You told us it is about ${d.focusArea}.`] : []),
      ``,
      `She reads these herself, so a confirmation will follow rather than an`,
      `instant answer. If anything changes in the meantime, reply to this`,
      `email and it comes straight to her.`,
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
