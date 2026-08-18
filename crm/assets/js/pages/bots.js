/* ============================================================
   BOTS — the master panel
   ------------------------------------------------------------
   Item 13. Three questions, answered with counts:

     which lane is carrying the work
     what it costs when the deterministic lane cannot
     and is any of it currently switched off

   The switches write to crm.bot_switches and the orchestrator
   re-reads them on the next turn. No deploy, no restart — same
   shape as the knowledge base, and for the same reason.
   ============================================================ */

import * as masthead from "../masthead.js";
import { esc } from "../format.js";

const $ = (sel) => document.querySelector(sel);

const NAMES = {
  "front-desk": "Front desk",
  "desk-officer": "Desk officer",
  "crm-assistant": "Her assistant",
};

const WHAT = {
  "front-desk": "Answers what it knows, collects the booking. Needs nothing.",
  "desk-officer": "Explains process, fees and scope. Needs the model.",
  "crm-assistant": "Keeps track of her day. Needs nothing.",
};

async function load() {
  const res = await fetch("/api/crm/bots", { headers: { Accept: "application/json" } });
  if (res.status === 401) return (location.href = "./login.html");
  return res.json();
}

function drawBreaker(b) {
  const el = $("[data-breaker]");
  if (!b) return;
  el.textContent = b.open
    ? `Model withdrawn · retrying in ${b.retryInSec}s`
    : b.fails
    ? `${b.fails} recent failure${b.fails === 1 ? "" : "s"}`
    : "All lanes healthy";
}

function drawSwitches(host, registry, switches) {
  const off = new Set(switches.filter((s) => !s.enabled).map((s) => s.bot));

  host.innerHTML = registry
    .map(
      (b) => `
      <div class="lane" data-lane="${esc(b.lane)}">
        <div class="lane-id">
          <b>${esc(NAMES[b.id] || b.id)}</b>
          <span class="lane-tag">${esc(b.lane)}</span>
          ${b.needs ? `<span class="lane-needs">needs ${esc(b.needs)}</span>` : ""}
        </div>
        <p class="lane-what">${esc(WHAT[b.id] || "")}</p>
        <button class="btn" type="button" data-toggle="${esc(b.id)}"
                aria-pressed="${!off.has(b.id)}">
          ${off.has(b.id) ? "Switched off" : "On"}
        </button>
      </div>`
    )
    .join("");

  host.onclick = async (e) => {
    const btn = e.target.closest("[data-toggle]");
    if (!btn) return;
    const on = btn.getAttribute("aria-pressed") === "true";
    btn.disabled = true;
    await fetch("/api/crm/bots/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot: btn.dataset.toggle, enabled: !on }),
    });
    draw(await load());
  };
}

function drawStats(table, stats, reasons) {
  const total = stats.reduce((n, s) => n + s.turns, 0);
  const det = stats.filter((s) => s.lane === "deterministic").reduce((n, s) => n + s.turns, 0);

  /* The one sentence this page exists to produce. A percentage
     rather than a count, because "the deterministic lane handles
     three in five" is a decision you can act on and "1,412" is not. */
  $("[data-verdict]").textContent = total
    ? `${Math.round((det / total) * 100)}% answered without a model`
    : "Nothing yet";

  table.innerHTML =
    `<thead><tr><th>Bot</th><th>Lane</th><th class="num">Turns</th><th class="num">Average</th><th class="num">Slowest</th></tr></thead>` +
    `<tbody>${
      stats.length
        ? stats
            .map(
              (s) => `<tr>
                <td>${esc(NAMES[s.bot] || s.bot)}</td>
                <td>${esc(s.lane)}</td>
                <td class="num">${s.turns}</td>
                <td class="num">${s.avgMs} ms</td>
                <td class="num">${s.maxMs} ms</td>
              </tr>`
            )
            .join("")
        : `<tr><td colspan="5" class="empty">No turns recorded yet.</td></tr>`
    }</tbody>` +
    (Object.keys(reasons || {}).length
      ? `<tfoot><tr><td colspan="5">${Object.entries(reasons)
          .map(([k, n]) => `${esc(k)} ${n}`)
          .join(" · ")}</td></tr></tfoot>`
      : "");
}

function drawTurns(table, turns) {
  table.innerHTML =
    `<thead><tr><th>When</th><th>Lane</th><th>Why</th><th>Asked</th><th>Answered</th></tr></thead>` +
    `<tbody>${
      turns.length
        ? turns
            .map(
              (t) => `<tr>
                <td>${esc(t.at.slice(11, 19))}</td>
                <td>${esc(t.lane)}</td>
                <td>${esc(t.reason || "")}</td>
                <td>${esc(clip(t.input))}</td>
                <td>${esc(clip(t.output))}</td>
              </tr>`
            )
            .join("")
        : `<tr><td colspan="5" class="empty">Nothing yet.</td></tr>`
    }</tbody>`;
}

// Long enough to recognise the turn, short enough that the table
// stays a table. The whole text is in the database if it is needed.
const clip = (s) => (!s ? "—" : s.length > 60 ? s.slice(0, 59) + "…" : s);

function draw(data) {
  drawBreaker(data.breaker);
  drawSwitches($("[data-switches]"), data.registry || [], data.switches || []);
  drawStats($("[data-stats]"), data.stats || [], data.reasons);
  drawTurns($("[data-turns]"), data.turns || []);
  $("[data-source]").textContent = "Live from crm.bot_turns";
}

masthead.mount("bots");
load().then(draw).catch(() => {
  $("[data-source]").textContent = "Could not read the turns.";
});
