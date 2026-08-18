/* ============================================================
   CONTACT LINKS — how she reaches somebody
   ------------------------------------------------------------
   Deep links, every one. Her own dialler, her own mail app, her
   own WhatsApp — nothing metered, nothing to get approved, and
   the message arrives from a person rather than from software.

   The number goes into a URL, so it is encoded rather than
   concatenated. A name or number carrying the right punctuation
   could otherwise break out of the parameter and change where
   the link points.
   ============================================================ */

import { esc } from "./format.js";

/** Digits only, no plus — the form wa.me expects. */
export const waNumber = (phone) => String(phone || "").replace(/\D/g, "");

/**
 * Buttons for one person. Offers only what it can actually do:
 * a number stored without its country code cannot be messaged,
 * and a broken button is worse than a missing one.
 */
export function contactLinks(person) {
  const out = [];

  if (person.phone) {
    out.push(`<a class="btn" href="tel:${encodeURIComponent(person.phone)}">Call</a>`);

    const wa = waNumber(person.phone);
    // Below ~10 digits it is a local number with no country code.
    if (wa.length >= 10) {
      out.push(
        `<a class="btn" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>`
      );
    }
  }

  if (person.email) {
    out.push(`<a class="btn quiet" href="mailto:${encodeURIComponent(person.email)}">Email</a>`);
  }

  return out.join("");
}
