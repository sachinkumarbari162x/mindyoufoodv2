/* ============================================================
   MANUAL — the deep link she taps
   ------------------------------------------------------------
   Builds a wa.me URL with the message already written and sends
   nothing. She opens it, WhatsApp opens with the text filled in,
   she presses send. The message leaves from her own account.

   THIS IS THE DEFAULT, for the same reason the mail outbox is:
   with nothing configured, this system CANNOT message a real
   client. A half-set-up box, a fresh clone or a test run has to
   be incapable of it, not merely unlikely to.

   IT IS ALSO A REAL ANSWER, not a stub. It needs no Meta
   account, no registered number, no approved template and costs
   nothing — and for a solo practice, a message that visibly came
   from her rather than from software is arguably the better one.
   ============================================================ */
"use strict";

async function send(m) {
  if (!m.digits) {
    return { ok: false, error: "no usable phone number" };
  }

  /* wa.me takes digits with the country code and NO plus. The text
     is a query parameter, so it is encoded rather than pasted —
     a message carrying an ampersand would otherwise be truncated
     at it, and the link in this one is the part after it. */
  const link = `https://wa.me/${m.digits}?text=${encodeURIComponent(m.text || "")}`;

  /* Reported as a success because this provider did what it
     promises: it prepared the message. The row records
     provider='manual', which is what says on the Messages page
     that a human still has to press send — see how the CRM
     renders it. */
  return { ok: true, id: "manual", link };
}

module.exports = { name: "manual", send, needsHand: true };
