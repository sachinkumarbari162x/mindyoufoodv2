/* ============================================================
   HOME — the screen she opens in the morning
   ------------------------------------------------------------
   This was the console trial. It is now the front door: index.html,
   the entry the nav's Overview points at, and the only home there
   is. The digest layout it replaced is kept at overview-classic.html
   — unrouted, reachable by address, referred to by nothing.

   WHY THIS ONE WON. Three homes were built and compared. Overview
   was a digest, this is a work surface, and a third was a measured
   dashboard. At this practice's actual scale — three sessions a day
   at most, fifteen people on a plan she can name — the dashboard
   answers a monthly question and the digest answers none in
   particular. This answers the one asked every morning: does
   anything need me.

   THE DASHBOARD IS NOT GONE. It moved to practice.html, behind the
   More button, where a monthly question belongs. It stopped being a
   thing to choose between every day.

   AND THERE IS NO SWITCHER ANY MORE. A choice offered every morning
   about a thing she does not care about is a cost with no benefit.
   One front door.

   IT IS ALMOST ENTIRELY READ-ONLY, on purpose. Every action here is
   a link to the page that owns it. Accepting a request or recording
   an outcome from two different places means two implementations of
   one rule, and the second one drifts.

   BUILT FOR AN iPAD. That is the device she actually uses, and it is
   neither a phone nor a desktop: touch targets throughout, no
   hover-only affordances, and a grid that works at 768 wide in
   portrait and 1024 in landscape without a rail eating the width.
   ============================================================ */

import * as api from "../api.js";
import * as assistant from "../assistant.js";
import { start, $ } from "../page.js";
import { esc, MODE, fmtDay, fmtTime } from "../format.js";

/* ---- reading the day ------------------------------------------- */

const began = (iso) => iso && new Date(iso).getTime() <= Date.now();

const sameDay = (a, b) =>
  a && b && new Date(a).toDateString() === new Date(b).toDateString();

/** Her hour, in the practice's own reckoning rather than the
    browser's idea of a date string. */
function today() {
  const d = new Date();
  return d.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });
}

/* ---- the sentence at the top -----------------------------------
   THE WHOLE POINT OF THE PAGE IS THIS LINE. A console that makes
   her count things has failed; it should say the number and say
   what it is made of.

   "Needs you" is deliberately narrow: a request nobody has
   answered, and a session from an earlier day nobody has closed
   off. Both are things that stay broken until she touches them.
   A booking later today is not on the list — it is not a problem,
   it is her afternoon. */
function attention(data, overdue) {
  const waiting = data.waiting?.length || 0;
  const behind = overdue.length;
  const bits = [];
  if (waiting) bits.push(`${waiting} request${waiting === 1 ? "" : "s"} waiting`);
  if (behind) bits.push(`${behind} session${behind === 1 ? "" : "s"} unanswered`);
  return { total: waiting + behind, bits };
}

/* ---- cards ------------------------------------------------------ */

function paintToday(list) {
  const host = $("[data-list-today]");
  $("[data-n-today]").textContent = list.length;

  if (!list.length) {
    host.innerHTML = `<p class="empty">Nothing booked today.</p>`;
    return;
  }

  host.innerHTML = list
    .map((b) => {
      /* A session that has started is the one she is most likely to
         be reaching for, so it is marked rather than merely ordered.

         ONLY A VIDEO SESSION OFFERS A ROOM, and that is the same rule
         the room page itself applies when it decides whether to mint
         a link. A phone consultation she rings; an in-person one
         happens in a chair. Offering "Room" on either is how somebody
         ends up waiting at a screen for a person who is expecting
         them somewhere else. */
      const live = began(b.startAt);
      const video = b.mode === "video";
      const going = video ? "Room" : b.mode === "in_person" ? "Clinic" : "Ring";
      return `
        <a class="line${live ? " is-now" : ""}" href="${video
          ? `./consultation-room.html?booking=${encodeURIComponent(b.id)}`
          : "./today.html"}">
          <span class="line-t">${esc(fmtTime(b.startAt))}</span>
          <span class="line-who">${esc(b.name)}</span>
          <span class="tag ${esc(b.mode)}">${esc(MODE[b.mode] || b.mode)}</span>
          <span class="line-go">${going}</span>
        </a>`;
    })
    .join("");
}

function paintNeeds(data, overdue) {
  const host = $("[data-list-needs]");
  const { total } = attention(data, overdue);
  $("[data-n-needs]").textContent = total;

  const rows = [];

  for (const b of data.waiting || []) {
    rows.push(`
      <a class="line" href="./requests.html">
        <span class="line-mark is-wait" aria-hidden="true"></span>
        <span class="line-who">${esc(b.name)}</span>
        <span class="line-sub">wants ${esc(b.startAt ? fmtDay(b.startAt) + " " + fmtTime(b.startAt) : "a time")}</span>
        <span class="line-go">Answer</span>
      </a>`);
  }

  for (const b of overdue) {
    rows.push(`
      <a class="line" href="./today.html">
        <span class="line-mark is-late" aria-hidden="true"></span>
        <span class="line-who">${esc(b.name)}</span>
        <span class="line-sub">${esc(fmtDay(b.startAt))} — never closed off</span>
        <span class="line-go">Say</span>
      </a>`);
  }

  host.innerHTML = rows.length
    ? rows.join("")
    : `<p class="empty is-clear">Nothing is waiting on you.</p>`;
}

function paintAhead(list) {
  const host = $("[data-list-ahead]");
  $("[data-n-ahead]").textContent = list.length;

  if (!list.length) {
    host.innerHTML = `<p class="empty">Nothing booked ahead.</p>`;
    return;
  }

  /* Grouped by day rather than listed by hour. Ahead is a glance —
     "Tuesday has three" is the useful shape, and fourteen individual
     rows is the shape that makes her scroll a card she came to
     skim. */
  const days = [];
  for (const b of list) {
    const last = days[days.length - 1];
    if (last && sameDay(last.at, b.startAt)) last.items.push(b);
    else days.push({ at: b.startAt, items: [b] });
  }

  host.innerHTML = days
    .slice(0, 6)
    .map(
      (d) => `
      <a class="line" href="./upcoming.html">
        <span class="line-who">${esc(fmtDay(d.at))}</span>
        <span class="line-sub">${d.items.map((b) => esc(b.name)).join(", ")}</span>
        <span class="line-n">${d.items.length}</span>
      </a>`
    )
    .join("");
}

/** The machinery, said in her words rather than the column's.
 *
 *  A message that failed is the only thing on this card that is a
 *  problem, so it is the only thing allowed to be loud. */
function paintDesk(data) {
  const host = $("[data-list-desk]");
  const msgs = data.messages || [];
  const failed = msgs.filter((m) => m.status === "failed").length;
  const sent = msgs.filter((m) => m.status === "sent").length;
  const rules = data.rules || [];

  const openDays = new Set(rules.map((r) => r.weekday)).size;

  host.innerHTML = `
    <a class="line" href="./messages.html">
      <span class="line-mark ${failed ? "is-late" : "is-ok"}" aria-hidden="true"></span>
      <span class="line-who">Messages</span>
      <span class="line-sub">${failed
        ? `${failed} did not go out`
        : sent
        ? `${sent} sent lately`
        : "nothing recent"}</span>
      <span class="line-go">Open</span>
    </a>
    <a class="line" href="./hours.html">
      <span class="line-mark is-ok" aria-hidden="true"></span>
      <span class="line-who">Your week</span>
      <span class="line-sub">${openDays
        ? `open on ${openDays} day${openDays === 1 ? "" : "s"}`
        : "no hours set"}</span>
      <span class="line-go">Hours</span>
    </a>
    <a class="line" href="./knowledge.html">
      <span class="line-mark is-ok" aria-hidden="true"></span>
      <span class="line-who">What the desk knows</span>
      <span class="line-sub">answers it gives visitors</span>
      <span class="line-go">Open</span>
    </a>`;
}

function paintTiles(data) {
  const host = $("[data-tiles]");
  const stats = data.stats || [];
  host.innerHTML = stats
    .map(
      (s) => `
      <div class="tile">
        <span class="tile-n">${esc(s.value)}</span>
        <span class="tile-l">${esc(s.label)}</span>
        <span class="tile-s">${esc(s.note || "")}</span>
      </div>`
    )
    .join("");
}

/* ---- paint ------------------------------------------------------ */

function paint(data, overdue) {
  $("[data-day]").textContent = today();

  const { total, bits } = attention(data, overdue);
  const say = $("[data-say]");
  const cta = $("[data-cta]");

  if (total === 0) {
    say.textContent = (data.today?.length || 0)
      ? "Nothing needs you — just the day ahead."
      : "Nothing needs you.";
    say.dataset.tone = "clear";
    cta.hidden = !(data.today?.length);
  } else {
    say.textContent = bits.join(", ") + ".";
    say.dataset.tone = "attention";
    cta.hidden = false;
  }

  paintToday(data.today || []);
  paintNeeds(data, overdue);
  paintAhead(data.upcoming || []);
  paintDesk(data);
  paintTiles(data);
}

/* ---- boot -------------------------------------------------------
   TWO REQUESTS, NOT ONE, and it is worth saying why. Overview is
   built as a single pass over the whole practice and that is most
   of what this page needs. The one thing it does not carry is the
   set of sessions that fell off the end of an earlier day, which
   lives on Today — and "nobody has answered for this" is precisely
   the kind of thing a console home exists to surface.

   The second request is allowed to fail on its own. A console that
   will not draw because one of its five cards is short of a number
   is worse than one that draws with a gap in it. */
start("overview", api.overview, async (data) => {
  let overdue = [];
  try {
    const t = await api.today();
    overdue = t.data?.overdue || [];
  } catch {
    overdue = [];
  }
  paint(data, overdue);

  /* HER ASSISTANT, MOUNTED LAST AND NEVER AWAITED.

     It is the first card on the page and the last thing to arrive,
     and that ordering is the whole point: it calls a model, which
     can take a second or fail outright, and the five cards below it
     are the database. They must not wait on it to appear.

     No `await`, so nothing after this is held up. The panel draws
     its own "reading your day…" and then either a sentence or a
     line saying it could not be reached — see assistant.js, which
     has no sample data and invents nothing. */
  assistant.mount($("[data-assistant]"));
});
