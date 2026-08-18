/* ============================================================
   SUB-NAV — moving around inside Overview
   ------------------------------------------------------------
   Overview shows every area at once, so it needs its own way of
   getting around that is clearly NOT the main nav: one row down,
   smaller, and marking a panel rather than a page.

   Anchors rather than tabs. Tabs would hide five of the six
   panels, which is the opposite of what an overview is for —
   the whole value is seeing the state of everything without
   clicking. These jump, and the spy says where you are.
   ============================================================ */

import { esc } from "./format.js";
import * as tracker from "./section-tracker.js";

export const PANELS = [
  { id: "p-assistant", label: "Assistant" },
  { id: "p-requests", label: "Requests", count: "waiting" },
  { id: "p-today", label: "Today", count: "today" },
  { id: "p-upcoming", label: "Upcoming", count: "upcoming" },
  { id: "p-people", label: "People" },
  { id: "p-messages", label: "Messages" },
  { id: "p-hours", label: "Hours" },
];

export function mount() {
  const host = document.querySelector("[data-subnav]");
  if (!host) return;

  host.className = "subnav";
  host.innerHTML = `
    <nav class="subnav-in" aria-label="On this page">
      ${PANELS.map(
        (p) => `
        <a href="#${p.id}">
          ${esc(p.label)}
          ${p.count ? `<span class="pip" data-pip="${p.count}">·</span>` : ""}
        </a>`
      ).join("")}
    </nav>`;

  // Reused from the old single-page CRM, now given selectors so it
  // can spy on panels instead of whole sections.
  tracker.mount(".subnav a", ".panel");

  /* The pinned section header has to clear BOTH bars on this page.
     Measured rather than assumed: this is the only page with a
     sub-nav, so a fixed value in the stylesheet would be wrong on
     the other seven. */
  const settle = () => {
    const total = (document.querySelector("[data-masthead]")?.offsetHeight || 0) + host.offsetHeight;
    document.documentElement.style.setProperty("--pin-top", `${total + 16}px`);
  };
  settle();
  if ("ResizeObserver" in window) new ResizeObserver(settle).observe(host);
}
