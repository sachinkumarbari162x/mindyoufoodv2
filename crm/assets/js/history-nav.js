/* ============================================================
   HISTORY SUB-NAV — the four ways a session ends
   ------------------------------------------------------------
   History is a page in the main nav; this is the row inside it,
   and the two are different levels of the same idea. The main
   nav moves between areas of the practice. This moves between
   ways of reading one of them.

   REAL LINKS, NOT BUTTONS. Each one is an honest href carrying
   its filter in the URL, so the browser's back button works,
   a view can be bookmarked, and the page still functions if a
   script fails to load. JavaScript intercepts them to filter
   without a round trip — an enhancement on top of something
   that already worked, rather than the only thing holding it up.

   THE FILTER IS NEVER TRUSTED FROM HERE. Whatever ends up in
   the URL is checked against a fixed list in the BFF before it
   reaches a query, so a hand-edited address can only ever
   produce "everything" — see GET /api/crm/history.
   ============================================================ */

import { esc } from "./format.js";

/* Her words, and the same ones the Today row uses. A session she
   marked "Didn't come" must not be filed under "No show" one page
   later — the same event has to have the same name everywhere or
   she is left wondering whether they are two different things. */
export const KINDS = [
  { kind: "", label: "Everything" },
  { kind: "done", label: "Done" },
  { kind: "no_show", label: "Didn’t come" },
  { kind: "cancelled", label: "Cancelled" },
  { kind: "rescheduled", label: "Rescheduled" },
];

/** Which filter the address bar is asking for, sanitised. */
export function fromUrl() {
  const asked = new URLSearchParams(location.search).get("kind") || "";
  return KINDS.some((k) => k.kind === asked && k.kind) ? asked : "";
}

/**
 * Draw the row into <div data-history-nav>.
 * @param {string}   current  the active filter ("" for everything)
 * @param {Function} onPick   called with the new filter
 */
export function mount(current, onPick) {
  const host = document.querySelector("[data-history-nav]");
  if (!host) return;

  host.className = "subnav";
  host.innerHTML = `
    <nav class="subnav-in" aria-label="Ways a session ended">
      ${KINDS.map(
        (k) => `
        <a href="./history.html${k.kind ? `?kind=${k.kind}` : ""}"
           data-kind="${esc(k.kind)}"${k.kind === current ? ' aria-current="page"' : ""}>
          ${esc(k.label)}
        </a>`
      ).join("")}
    </nav>`;

  host.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-kind]");
    if (!pick) return;
    e.preventDefault();

    const kind = pick.dataset.kind;
    /* The address bar keeps up, so refreshing or coming back to the
       page lands on the view she was reading rather than resetting
       to everything. */
    history.pushState({ kind }, "", pick.getAttribute("href"));
    mark(host, kind);
    onPick(kind);
  });

  /* The browser's own back button, which the pushState above would
     otherwise have broken. */
  addEventListener("popstate", () => {
    const kind = fromUrl();
    mark(host, kind);
    onPick(kind);
  });
}

function mark(host, kind) {
  host.querySelectorAll("[data-kind]").forEach((a) => {
    if (a.dataset.kind === kind) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}
