/* ============================================================
   SESSIONS SUB-NAV — one booking, at its three stages
   ------------------------------------------------------------
   Today, Upcoming and History are the same thing at different
   points in its life: about to happen, going to happen, happened.
   They belong together, and putting History in the main nav
   would have said it was a separate area of the practice rather
   than the far end of this one.

   IT IS ALSO WHAT KEEPS TODAY CLEAN. Today can drop a session
   the moment she says what became of it — so it never shows her
   anything she has already dealt with — precisely because this
   row says, on every one of the three pages, where the dealt-with
   ones went. A page that quietly loses rows with no visible
   destination is a page she stops trusting.

   Page links, not anchors. The sub-nav on Overview jumps within
   one page; this one moves between three. Same bar, same styling,
   different job — and `aria-current="page"` rather than "true"
   says which of the two it is.
   ============================================================ */

import { esc } from "./format.js";

export const STAGES = [
  { id: "today", href: "./today.html", label: "Today", count: "today" },
  { id: "upcoming", href: "./upcoming.html", label: "Upcoming", count: "upcoming" },
  { id: "history", href: "./history.html", label: "History" },
];

/**
 * Draw the row into <div data-sessions-nav>.
 * @param {string} currentId  which of the three this page is
 */
export function mount(currentId) {
  const host = document.querySelector("[data-sessions-nav]");
  if (!host) return;

  host.className = "subnav";
  host.innerHTML = `
    <nav class="subnav-in" aria-label="Sessions">
      ${STAGES.map(
        (s) => `
        <a href="${s.href}"${s.id === currentId ? ' aria-current="page"' : ""}>
          ${esc(s.label)}
          ${s.count ? `<span class="pip" data-pip="${s.count}">·</span>` : ""}
        </a>`
      ).join("")}
    </nav>`;
}
