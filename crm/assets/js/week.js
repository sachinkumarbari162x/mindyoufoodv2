/* ============================================================
   WEEK — her working pattern, seven rows
   ------------------------------------------------------------
   Not a calendar. The pattern repeats every week, so a month
   grid would draw the same answer four times and invite her to
   edit one occurrence when she meant to change the rule.

   A day with no bands says "closed" rather than showing an
   empty row — blank reads as "not set up yet", which is a
   different and more worrying thing.
   ============================================================ */

import { hhmm } from "./format.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function draw(host, rules) {
  if (!host) return;

  host.innerHTML = DAYS.map((label, weekday) => {
    const bands = (rules || []).filter((r) => r.weekday === weekday);
    /* Each band carries its own remove. Editing a band in place would
       need a form per row; removing and re-adding is two clicks and
       cannot leave a half-changed rule behind. */
    const chips = bands.length
      ? bands
          .map(
            (b) => `
            <span class="band-chip">
              ${hhmm(b.startsMin)}–${hhmm(b.endsMin)}
              <button class="band-drop" type="button" data-drop-band="${b.id}"
                      aria-label="Remove ${hhmm(b.startsMin)} to ${hhmm(b.endsMin)} on ${label}">×</button>
            </span>`
          )
          .join("")
      : `<span class="band-chip">closed</span>`;

    return `
      <div class="day ${bands.length ? "" : "shut"}">
        <span class="day-name">${label}</span>
        <div class="bands">${chips}</div>
      </div>`;
  }).join("");
}
