/* ============================================================
   MASTHEAD — the nav, defined once and rendered on every page
   ------------------------------------------------------------
   Eight pages, one definition. Writing this markup into eight
   HTML files would guarantee that one of them keeps an old
   label the day a section is renamed.

   Counts ride in the nav on EVERY page, not just Overview, so
   "three people are waiting" is visible from wherever she is.
   They come back with each page's own payload rather than from
   a second request — one call per page, no extra round trip.
   ============================================================ */

import { esc } from "./format.js";
import * as officer from "./officer.js";
import * as authPanel from "./auth-panel.js";

/* ============================================================
   WHAT IS ON THE BAR, AND WHAT IS BEHIND IT
   ------------------------------------------------------------
   There were thirteen entries across the top, which is not a nav
   — it is a list she has to read. A bar that has to be READ has
   stopped being navigation and become another thing to learn.

   So: the four she touches every day stay on the bar, and
   everything else lives one tap away in a panel. The split is by
   FREQUENCY, not by category — Hours matters enormously and she
   changes it once a month, so it belongs behind the button; the
   Assessment is the most important table in the system and she
   opens it daily, so it does not.
   ============================================================ */

/** Always visible. `count` names a key in the counts payload. */
export const PRIMARY = [
  { id: "overview", href: "./index.html", label: "Overview" },
  { id: "requests", href: "./requests.html", label: "Requests", count: "waiting" },
  { id: "today", href: "./today.html", label: "Today", count: "today" },
  { id: "upcoming", href: "./upcoming.html", label: "Upcoming", count: "upcoming" },
  { id: "assessment", href: "./assessment.html", label: "Assessment" },
  { id: "plan", href: "./plan.html", label: "Plan" },
  /* Her read of the client's daily app. On the bar rather than behind
     the button because it is checked daily once anybody is on a
     programme — the split above is by frequency, and this is the one
     page that tells her whether a plan is actually being followed.

     "programme-monitor" on disk and not "programme": public/programme
     .html is the CLIENT'S app, and two files a directory apart with
     one name is how you open the wrong one. */
  { id: "programme", href: "./programme-monitor.html", label: "Programme" },
  { id: "consultation-room", href: "./consultation-room.html", label: "Room" },
];

/** One tap away, grouped so the panel can be scanned rather than read. */
export const MORE = [
  {
    group: "Sessions",
    items: [
      { id: "payments", href: "./payments.html", label: "Payments" },
      { id: "history", href: "./history.html", label: "History" },
      { id: "hours", href: "./hours.html", label: "Hours" },
    ],
  },
  {
    group: "People and messages",
    items: [
      { id: "people", href: "./people.html", label: "People" },
      { id: "messages", href: "./messages.html", label: "Messages" },
      { id: "knowledge", href: "./knowledge.html", label: "Knowledge", count: "missed" },
    ],
  },
  {
    group: "The machinery",
    items: [
      /* HOW THE WHOLE THING IS GOING. Behind the button rather than
         on the bar, and that placement is the decision rather than a
         leftover: it is a monthly question, and a screen that
         answers "seven sessions, same as last Tuesday" every morning
         is a screen you stop opening. */
      { id: "practice", href: "./practice.html", label: "The practice" },
      { id: "settings", href: "./settings.html", label: "Settings" },
      { id: "bots", href: "./bots.html", label: "Bots" },
      // Raw storage. Last on purpose — a tool for checking, not part
      // of the day's work.
      { id: "database", href: "./database.html", label: "Database" },
    ],
  },
];

/** Every page, for whatever needs the flat list. */
export const PAGES = [...PRIMARY, ...MORE.flatMap((g) => g.items)];

/* crm-tables.html is reached from the Database page rather than the
   nav: two entries a row apart, both leading to a table browser,
   would read as two different tools. It marks Database as current so
   the nav still says where you are. */
const ALIASES = { "crm-tables": "database" };

function link(p, currentId) {
  const here = p.id === currentId;
  return `
    <a href="${p.href}"${here ? ' aria-current="page"' : ""}>
      ${esc(p.label)}
      ${p.count ? `<span class="pip" data-pip="${p.count}">·</span>` : ""}
    </a>`;
}

/**
 * Render the masthead into <header data-masthead>.
 * @param {string} currentId  which page this is
 */
export function mount(pageId) {
  const host = document.querySelector("[data-masthead]");
  if (!host) return;
  const currentId = ALIASES[pageId] || pageId;

  host.className = "masthead";
  host.innerHTML = `
    <div class="mast-in">
      <div class="mast-id">
        <h1>Front desk</h1>
        <p class="mast-sub" data-clock>—</p>
      </div>

      <nav class="jump" aria-label="Sections">
        ${PRIMARY.map((p) => link(p, currentId)).join("")}
      </nav>

      <!-- Everything else. A button rather than nine more links,
           because a bar you have to read is not a bar. -->
      <button class="more-btn" type="button" data-more
              aria-expanded="false" aria-controls="crm-more">
        <span class="more-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        More
      </button>

      <!-- Who is signed in, and the way out. Filled by auth-panel.js
           once the server has said so. -->
      <div class="mast-auth" data-auth></div>
    </div>`;


  /* THE PANEL LIVES ON <body>, NOT IN THE MASTHEAD.

     .masthead carries `backdrop-filter: blur(12px)`, and a
     backdrop-filter creates a CONTAINING BLOCK for
     position:fixed descendants — exactly as `transform` does. A
     panel inside it was therefore not fixed to the viewport at
     all: it was fixed to a header three and a half rems tall,
     collapsed to nothing inside it, and displayed nothing.

     Moving it to the body is the fix, and it is the only one:
     the blur is what makes the masthead readable over scrolling
     content, so removing that to accommodate the panel would be
     the tail wagging the dog. */
  mountMore(currentId);

  document.querySelector("[data-clock]").textContent = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  /* No theme toggle. One look, off-white, everywhere — decided
     rather than offered. theme.js stays on disk and is simply no
     longer called. */
  measure(host);

  /* Her assistant, on every page rather than only on Overview —
     which is the page she is least likely to be on when she is
     actually working. Mounted here because this is the one call
     every CRM page already makes. */
  officer.mount();

  /* The way out, on every page. Mounted here for the same reason as
     her assistant: this is the one call every CRM page already makes,
     so a page added tomorrow gets it without anybody remembering. */
  authPanel.mount();
}

/** Build the panel once, on <body>, and replace it on re-mount. */
function mountMore(currentId) {
  document.querySelector("[data-more-panel]")?.remove();
  document.querySelector("[data-more-veil]")?.remove();

  const veil = document.createElement("div");
  veil.className = "more-veil";
  veil.dataset.moreVeil = "";
  veil.hidden = true;

  const panel = document.createElement("aside");
  panel.className = "more-panel";
  panel.id = "crm-more";
  panel.dataset.morePanel = "";
  panel.hidden = true;
  panel.setAttribute("aria-label", "More sections");
  panel.innerHTML = `
    <div class="more-head">
      <p>Everything else</p>
      <button class="more-shut" type="button" data-more-shut aria-label="Close">×</button>
    </div>
    ${MORE.map((g) => `
      <div class="more-group">
        <p class="more-group-name">${esc(g.group)}</p>
        ${g.items.map((p) => `
          <a href="${p.href}"${p.id === currentId ? ' aria-current="page"' : ""}>
            ${esc(p.label)}
            ${p.count ? `<span class="pip" data-pip="${p.count}">·</span>` : ""}
          </a>`).join("")}
      </div>`).join("")}`;

  document.body.append(veil, panel);
  wireMore();
}

/* ============================================================
   THE PANEL
   ------------------------------------------------------------
   Slides in from the right over a sheet of dark. `hidden` is
   removed a frame before the class is added, because an element
   that is display:none cannot animate FROM anywhere — setting
   both in the same tick makes it appear instantly, which is the
   commonest reason a transition looks broken.

   Closing waits for the transition rather than guessing at it, so
   the panel is never hidden mid-slide.
   ============================================================ */
function wireMore() {
  const btn = document.querySelector("[data-more]");
  const panel = document.querySelector("[data-more-panel]");
  const veil = document.querySelector("[data-more-veil]");
  if (!btn || !panel || !veil) return;

  let open = false;

  function show() {
    open = true;
    panel.hidden = false;
    veil.hidden = false;
    // A frame, so the browser has a starting position to move from.
    requestAnimationFrame(() => {
      panel.dataset.open = "true";
      veil.dataset.open = "true";
    });
    btn.setAttribute("aria-expanded", "true");
    panel.querySelector("a")?.focus({ preventScroll: true });
  }

  function hide() {
    if (!open) return;
    open = false;
    panel.dataset.open = "false";
    veil.dataset.open = "false";
    btn.setAttribute("aria-expanded", "false");

    const done = () => {
      if (!open) { panel.hidden = true; veil.hidden = true; }
      panel.removeEventListener("transitionend", done);
    };
    panel.addEventListener("transitionend", done);
    // A belt for the case where the transition never fires — a
    // reduced-motion setting, or a background tab.
    setTimeout(done, 400);
  }

  btn.addEventListener("click", () => (open ? hide() : show()));
  veil.addEventListener("click", hide);
  panel.querySelector("[data-more-shut]")?.addEventListener("click", hide);
  addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

/* Publish the masthead's real height so anything pinned beneath it
   — Overview's sub-nav, every panel's scroll-margin — sits exactly
   under it. Hard-coding the offset leaves a gap or an overlap the
   moment the font, the date string or the viewport changes. */
function measure(host) {
  const set = () =>
    document.documentElement.style.setProperty("--mast-h", `${host.offsetHeight}px`);
  set();
  if ("ResizeObserver" in window) new ResizeObserver(set).observe(host);
  else addEventListener("resize", set);
}

/**
 * Fill the nav counts. Until a page's payload arrives they show "·"
 * rather than "0" — an unknown count and a count of zero are
 * different facts, and showing the wrong one for half a second
 * teaches her to distrust the number.
 */
export function setCounts(counts) {
  if (!counts) return;
  for (const [key, n] of Object.entries(counts)) {
    document.querySelectorAll(`[data-pip="${key}"]`).forEach((pip) => {
      pip.textContent = n;
      // Zero is not news; a badge permanently showing 0 trains you
      // to stop looking at it, which costs you the one time it is 3.
      pip.dataset.live = n > 0 ? "true" : "false";
    });
  }
}
