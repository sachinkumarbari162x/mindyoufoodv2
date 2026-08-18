/* ============================================================
   BOOKING CONFIRMED — the WhatsApp message
   ------------------------------------------------------------
   ONE FILE, TWO SENDERS. The same message has to exist in two
   forms: free text for the deep link she taps herself, and a
   structured reference to a Meta-approved template for the Cloud
   API. Keeping them in one file is what stops the two drifting —
   a wording change she makes for one sender and forgets for the
   other is a client getting a different message depending on
   which route happened to be configured.

   THE LINK IS A BUTTON, NOT BODY TEXT. Meta's dynamic URL button
   takes a fixed base and one variable appended to it, which is
   exactly the shape of this design: the base is our own domain,
   the variable is the token. Putting a raw URL in the body is
   also possible and reviews worse — a bare link in message text
   is what phishing looks like, to filters and to people.

   WHAT THE TEXT MUST CARRY, whichever sender is used: the
   practice name, and the appointment in plain words. An opaque
   link is the point of the design and is also, unavoidably, what
   a scam looks like. The context around it is what makes it
   trustworthy, so it is not optional decoration.

   ---------------------------------------------------------------
   SUBMIT THIS TO META EXACTLY AS WRITTEN, category UTILITY:

     Name:      booking_confirmed
     Language:  English
     Body:
       Hi {{1}}, your consultation with Khadija is confirmed for
       {{2}}. She will call you — nothing to install.
     Button:    Visit website · dynamic
       https://mindyourfood.co.in/c/{{1}}
     Footer:    Mind Your Food

   A mismatch between this file and what Meta approved is rejected
   at send time, not at deploy time — so change both together.
   ---------------------------------------------------------------
   ============================================================ */
"use strict";

const { when } = require("../../mail/render");

module.exports = {
  id: "booking-confirmed",
  version: 1,

  /** The name as approved in WhatsApp Manager. */
  metaName: process.env.WHATSAPP_TEMPLATE_CONFIRMED || "booking_confirmed",
  language: process.env.WHATSAPP_TEMPLATE_LANG || "en",

  /**
   * @param {object} d { name, startAt, timezone, practice, token, linkBase }
   */
  view(d) {
    const first = String(d.name || "").trim().split(/\s+/)[0] || "there";
    const slot = when(d.startAt, d.timezone);
    return {
      first,
      whenText: slot ? slot.full : "a time she will confirm with you",
      url: d.token ? `${d.linkBase}/c/${d.token}` : null,
    };
  },

  /** Body variables, IN THE ORDER {{1}}, {{2}} — position is the
      whole contract with Meta, so this array is the template. */
  bodyParams(d) {
    const v = this.view(d);
    return [v.first, v.whenText];
  },

  /** The dynamic half of the URL button — the token, nothing else. */
  buttonParam: (d) => d.token || "",

  /** What she sends when it goes from her own WhatsApp. Says the same
      thing in the same order, so the two senders are indistinguishable
      to whoever receives them. */
  text(d) {
    const v = this.view(d);
    return [
      `Hi ${v.first}, your consultation with ${d.practice.dietitian} is confirmed for ${v.whenText}.`,
      `She will call you — nothing to install.`,
      ...(v.url ? ["", v.url] : []),
      "",
      `— ${d.practice.name}`,
    ].join("\n");
  },
};
