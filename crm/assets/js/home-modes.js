/* ============================================================
   HOME MODES — RETIRED. The comparison is over.
   ------------------------------------------------------------
   This drew a switcher between three homes — Overview, Console,
   Dashboard — so they could be judged side by side for a week.
   They were, and the answer was:

     Console    kept, and promoted to index.html
     Dashboard  kept, moved to practice.html behind More
     Overview   retired to overview-classic.html, linked by nothing

   SO THE SWITCHER ITSELF WAS THE FIRST THING TO GO, and not
   because it stopped working. A choice offered every morning about
   a thing she does not care about is a cost with no benefit: she
   would have had to decide, before doing any work, which version
   of her own practice to look at. One front door.

   Nothing imports this. It is kept, like the page it switched
   between, because a decision a week old is not a decision yet —
   and because putting the comparison back should cost an import
   rather than a rewrite. The definitions below are still accurate.
   ============================================================ */

import { esc } from "./format.js";

export const MODES = [
  {
    id: "overview",
    href: "./overview-classic.html",
    label: "Overview",
    hint: "What has been happening",
    retired: true,
  },
  {
    id: "console",
    href: "./index.html",
    label: "Home",
    hint: "What needs you now",
  },
  {
    id: "practice",
    href: "./practice.html",
    label: "The practice",
    hint: "How the whole thing is going",
  },
];

/**
 * Draw the switcher into <nav data-modes>. Nothing calls this.
 * @param {string} current  which of the three this page is
 */
export function mount(current) {
  const host = document.querySelector("[data-modes]");
  if (!host) return;

  host.className = "modes";
  host.innerHTML = MODES.map((m) => {
    const here = m.id === current;
    /* The current one is not a link. A control that reloads the page
       you are already on has never done anything, and it is the
       commonest reason a tab bar feels broken. */
    const inner =
      `<span class="mode-l">${esc(m.label)}${
        m.retired ? '<span class="mode-tag">retired</span>' : ""
      }</span>` +
      `<span class="mode-h">${esc(m.hint)}</span>`;

    return here
      ? `<span class="mode" aria-current="page">${inner}</span>`
      : `<a class="mode" href="${m.href}">${inner}</a>`;
  }).join("");
}
