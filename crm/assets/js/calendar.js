/* ============================================================
   THE MONTH — what her pattern actually comes to
   ------------------------------------------------------------
   The week above it says what the pattern IS. This says what it
   produces: which Tuesdays are genuinely open, which days she
   closed, and who is in the diary. Those are different questions
   and she asks both — a weekly pattern cannot tell her that the
   Tuesday after next is the one she is away for.

   IT DRAWS, IT DOES NOT DECIDE. Every fact here comes from
   GET /crm/calendar, which reads the same two availability
   tables the booking engine reads. Nothing is computed in the
   browser, because a second opinion about a Tuesday is exactly
   how a visitor gets offered an hour she is not working.
   ============================================================ */

import * as api from "./api.js";
import { esc } from "./format.js";

const $ = (s, r = document) => r.querySelector(s);

const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/* Monday-first. The week starts on Monday for somebody running a
   practice — a grid that puts Sunday first splits her working week
   across two rows. */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

let shown = new Date();   // any day inside the month being drawn
let days = [];

const iso = (d) => d.toISOString().slice(0, 10);

function monthRange(when) {
  const first = new Date(when.getFullYear(), when.getMonth(), 1);
  const last = new Date(when.getFullYear(), when.getMonth() + 1, 0);
  /* Built from local parts rather than by slicing a UTC string: a
     first-of-the-month at 00:00 IST is the previous month in UTC,
     which would quietly fetch and draw the wrong four weeks. */
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(first), to: fmt(last), first, last };
}

function cell(day, todayIso) {
  const date = new Date(day.date + "T12:00:00");
  /* PAST DAYS ARE READABLE, NOT SCHEDULABLE. She should absolutely be
     able to look at last Tuesday — that is half of why the calendar
     reads a range rather than a forward window. What she cannot do is
     schedule into it, so the cell is dimmed and says so on the day
     panel rather than being made unclickable. */
  const past = day.date < todayIso;
  const open = day.bands.length > 0 && !day.closed;
  const extra = day.bands.some((b) => b.source === "one-off");
  const n = day.bookings.length;

  const hours = day.closed
    ? "closed"
    : day.bands.length
    ? day.bands.map((b) => `${hhmm(b.startMin)}–${hhmm(b.endMin)}`).join(", ")
    : "";

  return `
    <button class="cal-cell" type="button" data-day="${esc(day.date)}"
            data-open="${open}" data-closed="${day.closed}"
            data-extra="${extra}" data-today="${day.date === todayIso}"
            data-past="${past}"
            aria-label="${esc(date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }))}">
      <span class="cal-n">${date.getDate()}</span>
      ${hours ? `<span class="cal-hours">${esc(hours)}</span>` : ""}
      ${n ? `<span class="cal-count">${n}</span>` : ""}
      ${day.reason ? `<span class="cal-why">${esc(day.reason)}</span>` : ""}
    </button>`;
}

function render() {
  const { from, first } = monthRange(shown);
  const grid = $("[data-cal-grid]");

  $("[data-cal-title]").textContent = first.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  /* Blanks before the first, so the 1st lands under its real weekday.
     Without them a month reads as starting on Monday every time. */
  const lead = MONDAY_FIRST.indexOf(first.getDay());
  const blanks = Array.from({ length: lead }, () => `<span class="cal-cell is-blank"></span>`);

  grid.innerHTML = blanks.join("") + days.map((d) => cell(d, todayIso)).join("");
}

/** One day, opened underneath. Nothing here is editable — the forms
    above already do that, and a second way to close a Tuesday is a
    second thing to keep in step. */
function openDay(date) {
  const day = days.find((d) => d.date === date);
  const host = $("[data-cal-day]");
  if (!day) return;

  const when = new Date(day.date + "T12:00:00").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const hours = day.closed
    ? `<p class="cal-day-shut">Closed${day.reason ? ` — ${esc(day.reason)}` : ""}</p>`
    : day.bands.length
    ? `<p class="cal-day-hours">${day.bands
        .map((b) => `<span${b.source === "one-off" ? ' class="is-extra"' : ""}>${hhmm(b.startMin)}–${hhmm(b.endMin)}</span>`)
        .join("")}</p>`
    : `<p class="cal-day-shut">Not a working day.</p>`;

  const list = day.bookings.length
    ? day.bookings
        .map((b) => {
          const t = new Date(b.startAt).toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit",
          });
          return `
            <li>
              <span class="t">${t}</span>
              <span class="who">${esc(b.name)}</span>
              <span class="tag ${esc(b.status)}">${esc(b.status)}</span>
            </li>`;
        })
        .join("")
    : `<li class="none">Nobody booked.</li>`;

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const past = day.date < todayIso;

  host.hidden = false;
  host.dataset.past = String(past);
  host.innerHTML = `
    <div class="cal-day-head">
      <h4>${esc(when)}${past ? ` <span class="cal-gone">already been</span>` : ""}</h4>
      <button class="btn quiet" type="button" data-day-shut aria-label="Close">×</button>
    </div>
    ${hours}
    <ul class="cal-day-list">${list}</ul>
    ${past
      ? `<p class="cal-day-note">A day that has gone cannot be closed or opened —
         it changes nothing anybody can book, and would put a claim in the
         record about a day that already happened.</p>`
      : ""}`;
}

async function load() {
  const { from, to } = monthRange(shown);
  const grid = $("[data-cal-grid]");
  try {
    const out = await api.calendar(from, to);
    days = out.days || [];
    render();
  } catch (err) {
    /* Said, not swallowed. A calendar that silently shows an empty
       month is a calendar that says she is free all month. */
    grid.innerHTML = `<p class="empty">Could not read the month — ${esc(err.message || "try again")}.</p>`;
  }
}

export function mount() {
  if (!$("[data-cal]")) return;

  $("[data-cal]").addEventListener("click", (e) => {
    const step = e.target.closest("[data-month]");
    if (step) {
      const by = Number(step.dataset.month);
      shown = by === 0 ? new Date() : new Date(shown.getFullYear(), shown.getMonth() + by, 1);
      $("[data-cal-day]").hidden = true;
      return load();
    }

    const pick = e.target.closest("[data-day]");
    if (pick) return openDay(pick.dataset.day);
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-day-shut]")) $("[data-cal-day]").hidden = true;
  });

  load();
}

/** Called after she changes her week, so the month reflects it
    without a reload. The pattern and its consequences must never be
    showing two different answers on one screen. */
export const refresh = load;
