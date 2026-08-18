/* ============================================================
   THE PRACTICE — how the whole thing is going
   ------------------------------------------------------------
   Behind the More button, with the machinery. Not a home, and
   that is the point: it was built as one of three front doors and
   it lost. At three sessions a day, a funnel of 4 -> 3 -> 3 -> 2
   -> 1 is five numbers pretending to be an analysis, and one
   cancellation swings it thirty per cent. She can name all fifteen
   people on a plan; reading the list beats reading a chart of it.

   "How is the practice going" is a MONTHLY question. Asking it of
   a Tuesday gets "seven sessions, same as last Tuesday", which is
   how a screen teaches you to stop opening it.

   NOT ONE ACTION ON IT, deliberately. Every figure links to the
   page that owns the thing it counts. A dashboard that also
   accepts input is two screens fighting over one purpose, and the
   input one always loses.

   ---- HOW IT IS DRAWN, AND WHY IT LOOKS RESTRAINED ----------
   The colours were checked with a validator rather than chosen by
   eye, on this exact beige, under all three kinds of colour
   blindness. Four hues failed. Three failed. Two passed
   comfortably — see the note in tokens.css.

   So colour carries at most two identities anywhere here, and
   everything with more categories than that is encoded by
   POSITION AND A DIRECT LABEL. That is not a compromise: a
   labelled bar is easier to read than a colour key for everybody,
   and it is the only version that works for a reader who cannot
   tell two of the colours apart.

   No pie charts, no dual axes, no gradients, no number that moves
   when you are not looking at it.

   ---- WHAT IS REAL AND WHAT IS NOT --------------------------
   Every figure is live except where it says otherwise. The site's
   own traffic — visitors, chats started — is NOT counted anywhere
   yet, so the funnel begins at the first thing this system
   actually records. It says so rather than drawing a box with a
   guess in it.
   ============================================================ */

import * as api from "../api.js";
import { start, markSource, $, $$ } from "../page.js";
import { esc, plural } from "../format.js";

let period = "7d";

/* ---- small drawing helpers --------------------------------------
   Bars are divs, not SVG. A bar chart is a row of rectangles with
   text in it, which is what HTML already is — reaching for SVG
   here would buy nothing and cost the text selection, the
   ellipsis and the reflow that come free. */

/** One row of the funnel or the outcome list. */
function bar(label, value, max, opts = {}) {
  const pct = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return `
    <div class="bar-row"${opts.href ? ` data-href="${esc(opts.href)}"` : ""}>
      <span class="bar-l">${esc(label)}</span>
      <span class="bar-track">
        <span class="bar-fill"${opts.step ? ` data-step="${opts.step}"` : ""}
              style="width:${pct.toFixed(1)}%"></span>
      </span>
      <span class="bar-v">${esc(value)}</span>
      ${opts.sub ? `<span class="bar-sub">${esc(opts.sub)}</span>` : ""}
    </div>`;
}

/* ---- the funnel -------------------------------------------------- */

function paintFunnel(d) {
  const host = $("[data-funnel]");
  const note = $("[data-funnel-note]");

  const asked = (d.waiting?.length || 0);
  const booked = (d.today?.length || 0) + (d.upcoming?.length || 0);
  const seenN = d.tally ? Object.values(d.tally).reduce((a, b) => a + b, 0) : 0;
  const planned = d.programmes?.length || 0;
  const running = (d.programmes || []).filter((p) => p.status === "active").length;

  const stages = [
    ["Asked for a session", asked, "./requests.html"],
    ["Booked in", booked, "./upcoming.html"],
    ["Seen", seenN, "./history.html"],
    ["Given a plan", planned, "./plan.html"],
    ["Following it", running, "./programme-monitor.html"],
  ];

  const max = Math.max(...stages.map(([, v]) => v), 1);

  /* The drop between each stage, which is the actual point of a
     funnel. Shown as "of the 12 above" rather than a percentage:
     a percentage of four people is a number that sounds more
     precise than it is. */
  host.innerHTML = stages
    .map(([label, v, href], i) => {
      const prev = i ? stages[i - 1][1] : null;
      const sub = prev !== null && prev > 0 && v <= prev ? `of ${prev}` : "";
      return bar(label, v, max, { step: i + 1, href, sub });
    })
    .join("");

  /* WHAT IS NOT IN HERE, said on the page and not only in a
     comment. The site's traffic is not recorded by this system, so
     the funnel starts at the first thing it genuinely knows. */
  note.textContent = "Starts at the first thing recorded — site visits are not counted yet";
}

/* ---- outcomes ---------------------------------------------------- */

/* Her words, and the keys are the ones the outcomes table actually
   uses — `rescheduled`, not `moved`, which is what the History page
   calls it and what I guessed first. Anything unrecognised falls
   through to its own key rather than being dropped: a count with no
   label is still a count, and silently hiding one would make the
   totals on this page disagree with History. */
const OUTCOME = {
  done: "Went ahead",
  no_show: "Did not come",
  cancelled: "Cancelled",
  rescheduled: "Moved",
};

function paintOutcomes(d) {
  const host = $("[data-outcomes]");
  const tally = d.tally || {};
  const rows = Object.entries(tally)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!rows.length) {
    host.innerHTML = `<p class="empty">Nothing has been recorded yet.</p>`;
    return;
  }

  const max = Math.max(...rows.map(([, n]) => n));
  const total = rows.reduce((a, [, n]) => a + n, 0);

  /* ONE HUE, SORTED BY SIZE. Four outcomes is more identities than
     colour can carry on this ground, so the ranking and the labels
     do the work. Sorting is not decoration — it is the encoding. */
  host.innerHTML =
    rows.map(([k, n]) => bar(OUTCOME[k] || k, n, max, {
      sub: `${Math.round((n / total) * 100)}%`,
    })).join("");
}

/* ---- programmes -------------------------------------------------- */

function paintProgrammes(d) {
  const host = $("[data-progs]");
  const live = (d.programmes || []).filter((p) => p.status === "active");

  if (!live.length) {
    host.innerHTML = `<p class="empty">Nobody is following a plan right now.</p>`;
    return;
  }

  const day = (a, b) =>
    Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
  const today = new Date().toISOString().slice(0, 10);

  /* Furthest through first. Somebody on day 88 of 90 needs a
     follow-up booked; somebody on day 2 does not, and the ordering
     is what makes that visible without reading every row. */
  const rows = live
    .map((p) => {
      const len = p.lengthDays || 30;
      const on = Math.min(len, Math.max(1, day(p.startedOn, today) + 1));
      return { ...p, len, on, left: len - on };
    })
    .sort((a, b) => b.on / b.len - a.on / a.len);

  host.innerHTML = rows
    .map(
      (p) => `
      <div class="prog">
        <div class="prog-top">
          <span class="prog-who">${esc(p.personName)}</span>
          <span class="prog-n">day ${p.on} of ${p.len}</span>
        </div>
        <span class="bar-track">
          <span class="bar-fill" data-step="4"
                style="width:${((p.on / p.len) * 100).toFixed(1)}%"></span>
        </span>
        <p class="prog-sub">${
          p.left <= 7
            ? `<b>${plural(p.left, "day")} left</b> — book the follow-up`
            : `${plural(p.left, "day")} left · opened ${p.openCount} times`
        }</p>
      </div>`
    )
    .join("");
}

/* ---- the week ---------------------------------------------------- */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function paintWeek(d) {
  const host = $("[data-week]");
  const legend = $("[data-week-legend]");

  /* Her open hours per weekday, from the rules, against what is
     actually booked into them. TWO SERIES — which is exactly the
     number the palette was validated for, and the only chart here
     that uses colour to tell two things apart. */
  const open = new Array(7).fill(0);
  for (const r of d.rules || []) {
    /* Go counts weekdays from Sunday; this grid starts on Monday,
       because her week does. The field names are `startsMin` and
       `endsMin` — not `startMin`, which is what I assumed first and
       which silently produced a week of NaN-wide bars. */
    const i = (Number(r.weekday) + 6) % 7;
    if (i >= 0 && i < 7) open[i] += Math.max(0, (r.endsMin - r.startsMin) / 60);
  }

  const booked = new Array(7).fill(0);
  for (const c of [...(d.today || []), ...(d.upcoming || [])]) {
    const at = c.startAt || c.start_at;
    if (!at) continue;
    const i = (new Date(at).getDay() + 6) % 7;
    booked[i] += (d.settings?.consultMinutes || 60) / 60;
  }

  if (!open.some(Boolean) && !booked.some(Boolean)) {
    host.innerHTML = `<p class="empty">No hours set, and nothing booked.</p>`;
    legend.innerHTML = "";
    return;
  }

  legend.innerHTML =
    `<span class="key"><i data-series="1"></i>Open</span>` +
    `<span class="key"><i data-series="2"></i>Booked</span>`;

  const max = Math.max(...open, ...booked, 1);

  host.innerHTML = `<div class="week-grid">${DAYS.map((name, i) => `
      <div class="week-day">
        <div class="week-cols">
          <span class="week-col" data-series="1"
                style="height:${((open[i] / max) * 100).toFixed(1)}%"
                title="${open[i].toFixed(1)} hours open"></span>
          <span class="week-col" data-series="2"
                style="height:${((booked[i] / max) * 100).toFixed(1)}%"
                title="${booked[i].toFixed(1)} hours booked"></span>
        </div>
        <span class="week-n">${name}</span>
      </div>`).join("")}</div>`;
}

/* ---- the machinery ----------------------------------------------- */

/** One line of the health list.

    A WORD AS WELL AS A COLOUR, always. A green dot on its own is
    not a message — it is a thing somebody has to have been taught,
    and it says nothing at all to a reader who cannot see the
    difference between it and the red one. */
const healthRow = (name, state, said) => `
  <div class="health-row" data-state="${esc(state)}">
    <span class="health-dot" aria-hidden="true"></span>
    <span class="health-n">${esc(name)}</span>
    <span class="health-s">${esc(said)}</span>
  </div>`;

function paintHealth(d, live) {
  const host = $("[data-health]");
  const sent = d.messages || [];
  const failed = sent.filter((m) => m.status === "failed").length;

  const rows = [
    healthRow("Data service", live ? "good" : "critical",
      live ? "answering" : "not answering"),
    healthRow("The desk", d.settings ? "good" : "warning",
      d.settings ? `${d.settings.consultMinutes} min sessions, ${d.settings.maxPerDay} a day` : "unknown"),
    healthRow("Messages", failed ? "warning" : "good",
      failed ? `${plural(failed, "failure")} in the last few` : `${sent.length} recent, none failed`),
    healthRow("Requests waiting", (d.waiting?.length || 0) > 3 ? "warning" : "good",
      plural(d.waiting?.length || 0, "person") + " unanswered"),
  ];

  host.innerHTML = rows.join("");
}

/* ---- the assistant ----------------------------------------------- */

function paintModel(d) {
  const host = $("[data-model]");
  const rows = d.accuracy || [];

  if (!rows.length) {
    host.innerHTML =
      `<p class="empty">The assistant has not read a plan yet, ` +
      `or none of its rows have been ruled on.</p>`;
    return;
  }

  /* Biggest sample first. A model judged on four rows and one judged
     on four hundred are not comparable, and putting the small one at
     the top invites reading it as the headline. */
  host.innerHTML = [...rows]
    .sort((a, b) => b.judged - a.judged)
    .map((a) => {
      const rate = a.untouchedRate === null || a.untouchedRate === undefined
        ? null
        : Math.round(a.untouchedRate * 100);
      return `
        <div class="model-row">
          <p class="model-name">${esc(a.model)}</p>
          <p class="model-rate">${rate === null ? "—" : rate + "%"}</p>
          <p class="model-sub">
            right first time, across ${plural(a.judged, "row")} you ruled on
            ${a.pending ? ` · ${a.pending} still to check` : ""}
          </p>
        </div>`;
    })
    .join("");
}

/* ---- the table under everything ---------------------------------- */

/** EVERY CHART HAS A TABLE. Not a fallback — a second way to read
    the same rows, for a screen reader, for a copy into an email,
    and for anybody who wants the number rather than the picture. */
function paintTable(d) {
  const host = $("[data-table]");
  const tally = d.tally || {};
  const live = (d.programmes || []).filter((p) => p.status === "active");

  const rows = [
    ["Asked for a session", d.waiting?.length || 0],
    ["Booked in", (d.today?.length || 0) + (d.upcoming?.length || 0)],
    ["Seen", Object.values(tally).reduce((a, b) => a + b, 0)],
    ["Given a plan", d.programmes?.length || 0],
    ["Following one now", live.length],
    ...Object.entries(tally).map(([k, n]) => [OUTCOME[k] || k, n]),
    ["People on file", d.people?.length || 0],
  ];

  host.innerHTML = `
    <table class="dash-tbl">
      <thead><tr><th>Figure</th><th>Count</th></tr></thead>
      <tbody>${rows
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`)
        .join("")}</tbody>
    </table>`;
}

/* ---- the sentence at the top -------------------------------------- */

function paintHeadline(d) {
  const el = $("[data-headline]");
  const waiting = d.waiting?.length || 0;
  const live = (d.programmes || []).filter((p) => p.status === "active").length;
  const seenN = Object.values(d.tally || {}).reduce((a, b) => a + b, 0);

  /* Built from the figures rather than a template with slots, so a
     zero reads as a sentence and not as "0 people are waiting". */
  const bits = [];
  bits.push(seenN ? `${plural(seenN, "session")} recorded` : "nothing recorded yet");
  if (live) bits.push(`${live} following a plan`);
  if (waiting) bits.push(`${plural(waiting, "request")} unanswered`);

  el.textContent = bits.join(" · ");
}

/* ---- painting the lot --------------------------------------------- */

function paintAll(d) {

  paintHeadline(d);
  paintFunnel(d);
  paintOutcomes(d);
  paintProgrammes(d);
  paintWeek(d);
  paintHealth(d, d.live !== false);
  paintModel(d);
  paintTable(d);
}

/* A bar row can carry you to the page that owns it. The whole row,
   not a link inside it — a 3px-tall link is a target nobody hits. */
document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-href]");
  if (row) location.href = row.dataset.href;
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-period]");
  if (!btn) return;
  period = btn.dataset.period;
  $$("[data-period]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.period === period))
  );
  await load();
});

/* ---- reading the system -------------------------------------------
   FOUR CALLS, RUN TOGETHER. The CRM's rule is one request per page,
   and this page is the exception that proves it: it is not showing
   one area, it is showing all of them, and four independent
   questions asked in parallel is one round trip's worth of waiting.

   Each one falls back on its own. A dashboard that shows nothing
   because the accuracy query failed is worse than one that shows
   everything else and says so in that panel. */
async function load() {
  const [over, hist, progs, acc] = await Promise.all([
    api.overview(period),
    api.history().catch(() => ({ data: { history: [], tally: {} }, live: false })),
    api.programmes("").catch(() => ({ programmes: [] })),
    api.planAccuracy().catch(() => ({ accuracy: [] })),
  ]);

  const d = {
    ...over.data,
    live: over.live,
    tally: hist.data?.tally || {},
    programmes: progs.programmes || [],
    accuracy: acc.accuracy || [],
  };
  paintAll(d);
  markSource(over.live);
  return d;
}

start("practice", () => load().then((d) => ({ data: d, live: d.live !== false })), () => {});
