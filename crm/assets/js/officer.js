/* ============================================================
   HER ASSISTANT — the square icon, on every page
   ------------------------------------------------------------
   Item 1. Pinned to the corner of every CRM page, so what needs
   her is one click away from wherever she happens to be — not
   only from Overview, which is the page she is least likely to be
   on when she is actually working.

   Square, like everything else here. A round bubble is the house
   style of a support widget bolted onto somebody else's product,
   and this is not that.

   IT CALLS NO MODEL. Every line it shows is derived from live
   state by /api/crm/officer, which is arithmetic. The number on
   the icon is a fact, not a guess, which is what makes it worth
   glancing at.
   ============================================================ */

import { esc } from "./format.js";

const POLL_MS = 90 * 1000; // she is working, not watching

let panel = null;
let fab = null;
let open = false;

export function mount() {
  if (document.querySelector("[data-officer]")) return;

  fab = document.createElement("button");
  fab.type = "button";
  fab.className = "officer-fab";
  fab.setAttribute("data-officer", "");
  fab.setAttribute("aria-label", "What needs you");
  fab.setAttribute("aria-expanded", "false");
  /* DRAWN, NOT TYPED. This was U+2301 ⌁, which almost no shipped font
     has a glyph for — so the one floating control in the CRM rendered
     as an empty box with a fallback mark in it, on every page. A
     path has no font to be missing. */
  fab.innerHTML =
    `<span class="officer-mark" aria-hidden="true">` +
    `<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9` +
    `M3 12h4M17 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9"/>` +
    `<circle cx="12" cy="12" r="3.2"/></svg>` +
    `</span><span class="officer-pip" data-pip hidden>0</span>`;

  panel = document.createElement("aside");
  panel.className = "officer-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="officer-head">
      <h2>What needs you</h2>
      <button class="officer-x" type="button" data-close aria-label="Close">&times;</button>
    </div>
    <div class="officer-body" data-body><p class="officer-quiet">Reading the practice…</p></div>
    <p class="officer-foot" data-foot></p>`;

  document.body.append(fab, panel);

  fab.addEventListener("click", () => toggle());
  panel.querySelector("[data-close]").addEventListener("click", () => toggle(false));

  // Escape closes it, like everything else that opens over a page.
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) toggle(false);
  });

  refresh();
  setInterval(refresh, POLL_MS);
}

function toggle(next) {
  open = next === undefined ? !open : next;
  panel.hidden = !open;
  fab.setAttribute("aria-expanded", String(open));
  if (open) refresh();
}

async function refresh() {
  try {
    const res = await fetch("/api/crm/officer", { headers: { Accept: "application/json" } });
    if (res.status === 401) return; // the page itself will deal with that
    draw(await res.json());
  } catch {
    /* Silent. This is an assistant, not the page — if it cannot
       reach the desk it should get out of the way rather than
       plant an error over her work. */
  }
}

function draw(d) {
  const pip = fab.querySelector("[data-pip]");
  /* Only the urgent count, and only when there is one. A badge that
     permanently reads a number teaches you to stop seeing it, which
     costs you the day it means something. */
  pip.hidden = !d.urgent;
  pip.textContent = d.urgent || "";

  const body = panel.querySelector("[data-body]");

  if (d.clear) {
    body.innerHTML = `
      <p class="officer-clear">${esc(d.clear.what)}</p>
      <p class="officer-quiet">${esc(d.clear.detail)}</p>`;
  } else {
    body.innerHTML = (d.tasks || [])
      .map(
        (t) => `
        <article class="task" data-urgency="${esc(t.urgency)}">
          <p class="task-what">${esc(t.what)}</p>
          ${t.detail ? `<p class="task-detail">${esc(t.detail)}</p>` : ""}
          <a class="task-go" href="${esc(t.go)}">${esc(t.action)} →</a>
        </article>`
      )
      .join("");
  }

  panel.querySelector("[data-foot]").textContent = d.office || "";
}
