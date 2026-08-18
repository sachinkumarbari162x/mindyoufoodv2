/* ============================================================
   INSIGHTS — the headline numbers
   ------------------------------------------------------------
   Stat tiles rather than charts. Each answers one question with
   one number, and a plot would add ink without adding meaning.
   Charts belong here when there is a trend worth reading; a
   total is not one.

   Direction is never colour alone: every change carries an
   arrow and a sign, so it still reads for a colourblind reader,
   in print, and in forced-colours mode.
   ============================================================ */

import { esc } from "./format.js";

const ARROW = { up: "↑", down: "↓", flat: "→" };

function direction(change) {
  if (!change || change === 0) return "flat";
  return change > 0 ? "up" : "down";
}

function tile(s) {
  const dir = direction(s.change);
  const sign = s.change > 0 ? "+" : "";
  return `
    <div class="stat">
      <div class="stat-label">${esc(s.label)}</div>
      <div class="stat-value">${esc(s.value)}${s.unit ? `<span class="stat-unit">${esc(s.unit)}</span>` : ""}</div>
      <div class="stat-change" data-dir="${dir}">
        <span aria-hidden="true">${ARROW[dir]}</span>
        <span>${sign}${esc(s.change ?? 0)}${s.suffix || ""}</span>
        <span class="stat-change-note">${esc(s.note || "")}</span>
      </div>
    </div>`;
}

export function draw(host, stats) {
  if (!host) return;
  host.innerHTML = stats.map(tile).join("");
}

/** The period control lives in the pinned header, so changing the
    window never means scrolling back up to find it. */
export function mountPeriods(host, onChange) {
  if (!host) return;
  host.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-period]");
    if (!btn) return;
    [...host.querySelectorAll("button")].forEach((b) =>
      b.setAttribute("aria-pressed", String(b === btn))
    );
    onChange(btn.dataset.period);
  });
}
