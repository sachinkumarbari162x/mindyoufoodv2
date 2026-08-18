/* ============================================================
   PAGE — the boilerplate every CRM page shares
   ------------------------------------------------------------
   Each page does the same four things: draw the masthead, fetch
   ONE payload, paint it, and say whether it was real. This is
   that shape, so a page module contains only what is different
   about that page.
   ============================================================ */

import * as masthead from "./masthead.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Replace a list's contents. An empty result is left alone: the
 * empty state already written into the HTML says more than an
 * empty box would ("anything a visitor books lands here" tells
 * her the section works and is simply quiet).
 */
export function fill(name, items, render) {
  const host = $(`[data-list="${name}"]`);
  if (!host) return;
  if (!items || !items.length) return;
  host.innerHTML = items.map(render).join("");
}

export function setTally(name, n) {
  $$(`[data-count="${name}"]`).forEach((el) => (el.textContent = n));
}

/** A management screen must never leave you unsure whether the
    numbers in front of you are real. */
export function markSource(live) {
  const foot = $(".foot");
  if (!foot) return;
  foot.dataset.live = String(live);
  $("[data-source]").textContent = live
    ? "live · myf_trial"
    : "SAMPLE DATA — /api/crm is not wired up yet. Nothing on this page is real.";
}

/**
 * Boot a page.
 * @param {string}   id     which nav entry is current
 * @param {Function} load   () => Promise<{data, live}> — one call
 * @param {Function} paint  (data) => void
 */
export async function start(id, load, paint) {
  masthead.mount(id);

  const { data, live } = await load();
  masthead.setCounts(data.counts);
  paint(data);
  markSource(live);

  return data;
}
