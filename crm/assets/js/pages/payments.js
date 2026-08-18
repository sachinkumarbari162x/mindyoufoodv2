/* ============================================================
   PAYMENTS — what came in
   ------------------------------------------------------------
   The page that had to exist the moment money started moving.
   She cannot be asked to take payments through a system that
   will not show her what arrived.

   IN HER WORDS, NOT THE DATABASE'S. The column is called
   `status` and holds 'paid', 'pending', 'refunded'. None of
   those words appear on this page: a payment either "came in",
   is "waiting on the bank", or "went back". `pending` in
   particular would read to her as "this person owes me money",
   when what it actually means is that a browser reported a
   payment and no signature has confirmed it yet — which is a
   thing the system is waiting on, not a thing she is.

   NOTHING IS CLICKABLE YET. Refund and resend are the next
   piece and both move money or send mail, so they are not
   arriving quietly at the bottom of a list.
   ============================================================ */

import * as api from "../api.js";
import * as masthead from "../masthead.js";
import { start, fill, markSource, $, $$ } from "../page.js";
import { esc } from "../format.js";

/** ₹5,000 — grouped the Indian way, and with no paise when there
    are none. She reads these figures; a trailing .00 on every one
    of them is noise in the way of the number. */
function money(minor, currency = "INR") {
  const major = Number(minor || 0) / 100;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(major);
  } catch {
    return `₹${major.toFixed(whole ? 0 : 2)}`;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Aug", or "14 Aug 2025" once it is not this year — the year
    is only worth the space when it is a surprise. */
function day(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const stem = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? stem : `${stem} ${d.getFullYear()}`;
}

function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${suffix}` : `${h}${suffix}`;
}

/* What each state is called on this page, and what it means when
   she hovers. The tone matters: two of these three are perfectly
   normal and only one is ever worth a second thought. */
const STATE = {
  paid:      { label: "Came in",        tone: "in",
               why: "The bank confirmed it. The hour is booked." },
  pending:   { label: "Waiting on the bank", tone: "wait",
               why: "Reported but not yet confirmed. Usually settles by itself within minutes." },
  refunded:  { label: "Went back",      tone: "back",
               why: "Returned to the client." },
  failed:    { label: "Did not go through", tone: "no",
               why: "Nothing was taken." },
  cancelled: { label: "Cancelled",      tone: "no",
               why: "Nothing was taken." },
};

function row(p) {
  const s = STATE[p.status] || { label: p.status, tone: "wait", why: "" };
  const when = p.paidAt || p.createdAt;

  /* The session the money was for. Without it a payments list is
     a bank statement, and she does not think in reference
     strings — she thinks in "that was Meera's Tuesday". */
  const forWhat = p.sessionAt
    ? `${day(p.sessionAt)} · ${clock(p.sessionAt)}`
    : "no hour yet";

  return `
    <article class="pay-row" data-tone="${s.tone}">
      <div class="pay-who">
        <b>${esc(p.name || "—")}</b>
        ${p.email ? `<span class="pay-email">${esc(p.email)}</span>` : ""}
      </div>

      <div class="pay-for">
        <span class="pay-for-label">for</span>
        <span>${esc(forWhat)}</span>
      </div>

      <div class="pay-amount">${esc(money(p.amountMinor, p.currency))}</div>

      <div class="pay-state">
        <span class="pay-pill" title="${esc(s.why)}">${esc(s.label)}</span>
        <span class="pay-when">${esc(day(when))}</span>
      </div>

      <div class="pay-ref">
        ${p.receiptNo ? `<span class="pay-receipt">${esc(p.receiptNo)}</span>` : ""}
        ${/test/i.test(p.provider || "") ? `<span class="pay-test">test</span>` : ""}
      </div>
    </article>`;
}

function tile(name, minor, count, noun) {
  const figure = $(`[data-tile="${name}"]`);
  const note = $(`[data-tile-note="${name}"]`);
  const card = $(`[data-tile-card="${name}"]`);
  if (figure) figure.textContent = money(minor);
  if (note) note.textContent = count ? `${count} ${noun}${count === 1 ? "" : "s"}` : "";
  /* A tile that would only ever say "₹0" is a worry she does not
     have. Shown when there is something in it, gone when there is
     not. */
  if (card) card.hidden = !count;
}

function paint(data) {
  const t = data.totals || {};
  tile("month", t.paidThisMonthMinor, t.paidThisMonthCount, "payment");
  tile("outstanding", t.outstandingMinor, t.outstandingCount, "payment");
  tile("refunded", t.refundedMinor, t.refundedCount, "refund");

  const month = $('[data-tile-note="month"]');
  if (month && !t.paidThisMonthCount) month.textContent = "nothing yet this month";

  fill("payments", data.payments, row);
}

start("payments", api.payments, paint).then(() => {
  /* Nothing to wire. Every action this page will grow — refund,
     resend the receipt — moves money or sends mail, and those are
     not arriving as an unannounced button on a list. */
});
