/* ============================================================
   FRONT DESK · CRM — boot
   ------------------------------------------------------------
   Wiring only. Every piece of behaviour lives in its own module
   under ./js/; this file decides what runs and in what order.

   ES modules, so nothing lands on `window` and each part names
   exactly what it needs.
   ============================================================ */

import * as theme from "./js/theme.js";
import * as api from "./js/api.js";
import * as rows from "./js/rows.js";
import * as insights from "./js/insights.js";
import * as week from "./js/week.js";
import * as settingsPanel from "./js/settings-panel.js";
import * as tracker from "./js/section-tracker.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---- painting ------------------------------------------------ */

/** Replace a list's contents, or leave the empty state alone. */
function fill(name, items, render) {
  const host = $(`[data-list="${name}"]`);
  if (!host) return;
  if (!items || !items.length) return; // the empty state already in the HTML says more
  host.innerHTML = items.map(render).join("");
}

function setCount(name, n) {
  $$(`[data-count="${name}"]`).forEach((el) => (el.textContent = n));
  const pip = $(`[data-pip="${name}"]`);
  if (pip) {
    pip.textContent = n;
    // Zero is not news. A badge permanently showing "0" trains you
    // to stop looking at it, which costs you the one time it is 3.
    pip.dataset.live = n > 0 ? "true" : "false";
  }
}

function paint(data, live) {
  insights.draw($("[data-stats]"), data.stats);

  fill("waiting", data.waiting, rows.request);
  fill("today", data.today, rows.session);
  fill("upcoming", data.upcoming, rows.session);
  fill("people", data.people, rows.person);
  fill("messages", data.messages, rows.message);
  fill("exceptions", data.exceptions, rows.exception);

  setCount("waiting", data.waiting.length);
  setCount("today", data.today.length);
  setCount("upcoming", data.upcoming.length);
  setCount("people", data.people.length);
  setCount("messages", data.messages.length);

  week.draw($("[data-week]"), data.rules);
  settingsPanel.draw($("[data-settings]"), data.settings);

  const auto = $("[data-auto-accept]");
  if (auto) auto.checked = !!data.settings.autoAccept;

  const foot = $(".foot");
  foot.dataset.live = String(live);
  $("[data-source]").textContent = live
    ? "live · myf_trial"
    : "SAMPLE DATA — /api/crm is not wired up yet. Nothing on this page is real.";
}

/* ---- actions -------------------------------------------------
   One delegated listener rather than a handler per button: the
   rows are re-rendered wholesale, and per-element listeners
   would be re-bound every refresh. */
function wireActions() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-accept], [data-decline], [data-retry]");
    if (!btn) return;

    const { accept, decline, retry } = btn.dataset;
    btn.disabled = true;
    try {
      if (accept) await api.accept(accept);
      else if (decline) await api.decline(decline);
      else if (retry) await api.retryMessage(retry);
      await load();
    } catch {
      btn.disabled = false;
      // Nothing changed, so say nothing changed. A row that quietly
      // stays put after a click reads as "it worked" and is worse
      // than an error.
      btn.textContent = "Try again";
    }
  });

  $("[data-auto-accept]")?.addEventListener("change", (e) => {
    api.saveSettings({ autoAccept: e.target.checked }).catch(() => {
      e.target.checked = !e.target.checked;
    });
  });
}

/* ---- boot ---------------------------------------------------- */
let period = "7d";

async function load() {
  const { data, live } = await api.overview(period);
  paint(data, live);
}

async function boot() {
  theme.mount();
  tracker.mount();
  wireActions();

  insights.mountPeriods($("[data-periods]"), (next) => {
    period = next;
    load();
  });

  $("[data-clock]").textContent = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  await load();
}

boot();
