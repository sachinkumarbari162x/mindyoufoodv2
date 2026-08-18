/* ============================================================
   BOOKING PAID — sent when the money verifies, not before
   ------------------------------------------------------------
   DRAFT. Nothing sends this yet. It is written so the copy can be
   read as it will actually arrive rather than as a paragraph in a
   chat window; wiring it into the payment path is a separate,
   deliberate change.

   ---- WHY IT IS NOT booking-confirmed ------------------------
   That one is sent when SHE accepts a request. This one is sent
   when a stranger's card clears. They are different events and
   they make different promises: one says "she has looked at your
   request and said yes", the other says "you have paid and the
   hour is yours". Sending the first for the second would be a
   small lie in the one email nobody ever deletes.

   ---- WHAT IT HAS TO DO --------------------------------------
   1. BE FOUND AGAIN, weeks later, in a search. So the date is in
      the subject line. "Payment received" is unfindable.
   2. SAY THE HOUR before anything else. It is what they bought.
   3. CARRY THE RECEIPT NUMBER, because it is now the answer to
      "can you check what I paid" — and it must be copyable, so it
      is text and not an image.
   4. NOT LOOK LIKE A PAYMENT PROCESSOR. Nobody wants a
      transaction advice from their dietitian. The money is a line
      near the bottom; the appointment is the email.

   ---- WHAT IT DELIBERATELY DOES NOT SAY ----------------------
   A cancellation or refund policy. There is not one yet, and
   inventing one in an email that takes ₹5,000 would be writing
   business terms on her behalf. Flagged rather than guessed at.
   ============================================================ */
"use strict";

const { html, shell, when } = require("../render");

const HOW = {
  video: "a video call",
  audio: "a phone call",
  in_person: "an in-person session",
  undecided: "your consultation",
};

/** ₹5,000 — grouped the Indian way, no paise when there are none.
    A total with a trailing .00 reads like a statement line. */
function money(minor, currency) {
  const major = Number(minor || 0) / 100;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: currency || "INR",
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(major);
  } catch {
    return `${currency || "INR"} ${major.toFixed(whole ? 0 : 2)}`;
  }
}

module.exports = {
  id: "booking-paid",
  version: 1,

  subject: (d) => {
    const slot = when(d.startAt, d.timezone);
    return slot
      ? `Your consultation is booked — ${slot.date}`
      : "Your consultation is booked";
  },

  render(d) {
    const first = String(d.name || "").trim().split(/\s+/)[0] || "there";
    const slot = when(d.startAt, d.timezone);
    const how = HOW[d.mode] || HOW.undecided;
    const paid = money(d.amountMinor, d.currency);

    const body = html`
      <p style="margin:0 0 16px;">Hello ${first},</p>

      <p style="margin:0 0 16px;">
        That is booked. The hour below is yours and nobody else can take it.
      </p>

      ${slot
        ? html`<p style="margin:0 0 20px;padding:14px 16px;background:#ffffff;border:1px solid #e3e0d9;">
            <strong style="font-size:17px;">${slot.date}</strong><br />
            <strong style="font-size:17px;">${slot.time} ${slot.zone}</strong>
          </p>`
        : ""}

      <p style="margin:0 0 16px;">
        It is ${how}, and <strong>${d.practice.dietitian} will call you</strong>
        — there is no link to join and nothing to install.
      </p>

      <p style="margin:0 0 16px;">
        She reads everything before a session. If there is anything she should
        see first — recent bloodwork, a food diary, the medicines you take —
        reply to this email with it and she will have it in front of her.
      </p>

      <p style="margin:0 0 16px;">
        If that time stops suiting you, reply and she will move it. The sooner
        you say, the easier it is to give the hour to somebody else.
      </p>

      <p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #e3e0d9;
                font-size:13px;color:#6b5c4d;">
        Receipt <strong style="color:#3b3128;">${d.receiptNumber}</strong>
        &nbsp;·&nbsp; ${paid} paid
        ${d.testMode ? html`&nbsp;·&nbsp; <em>test mode — no money moved</em>` : ""}
      </p>
    `;

    const text = [
      `Hello ${first},`,
      ``,
      `That is booked. The hour below is yours and nobody else can take it.`,
      ``,
      ...(slot ? [`  ${slot.date}`, `  ${slot.time} ${slot.zone}`, ``] : []),
      `It is ${how}, and ${d.practice.dietitian} will call you - there is no`,
      `link to join and nothing to install.`,
      ``,
      `She reads everything before a session. If there is anything she should`,
      `see first - recent bloodwork, a food diary, the medicines you take -`,
      `reply to this email with it and she will have it in front of her.`,
      ``,
      `If that time stops suiting you, reply and she will move it. The sooner`,
      `you say, the easier it is to give the hour to somebody else.`,
      ``,
      `Receipt ${d.receiptNumber} - ${paid} paid`,
      ...(d.testMode ? [`(test mode - no money moved)`] : []),
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
