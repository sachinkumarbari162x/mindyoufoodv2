/* ============================================================
   SETTINGS PANEL — the four numbers every slot is built from
   ------------------------------------------------------------
   Each field states its consequence underneath. "Buffer: 0"
   tells her nothing about what changing it does to next week;
   "breathing room after each session" does.
   ============================================================ */

import { esc } from "./format.js";

const FIELDS = [
  {
    key: "consultMinutes",
    label: "Session length",
    note: "Every offered slot is this long.",
    min: 15, max: 180, step: 5,
  },
  {
    key: "bufferMinutes",
    label: "Gap between sessions",
    note: "Breathing room after each one, before the next may start.",
    min: 0, max: 60, step: 5,
  },
  {
    key: "maxPerDay",
    label: "Most per day",
    note: "A free afternoon will not become four back-to-back sessions.",
    min: 1, max: 12, step: 1,
  },
  {
    key: "minLeadHours",
    label: "Notice needed",
    note: "Hours before a slot that it stops being bookable.",
    min: 0, max: 72, step: 1,
  },
];

export function draw(host, settings) {
  if (!host) return;

  host.innerHTML = FIELDS.map(
    (f) => `
      <div class="field">
        <div>
          <div class="field-label">${esc(f.label)}</div>
          <div class="field-note">${esc(f.note)}</div>
        </div>
        <input type="number" data-set="${esc(f.key)}"
               min="${f.min}" max="${f.max}" step="${f.step}"
               value="${esc(settings[f.key])}">
      </div>`
  ).join("");
}
