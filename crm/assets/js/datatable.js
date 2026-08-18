/* ============================================================
   DATATABLE — pick a table, read its rows
   ------------------------------------------------------------
   Shared by both viewers: the master page lists every table,
   the CRM page lists only the crm schema. Same component, one
   filter's difference.

   Values are shown as stored. Nothing is formatted, rounded or
   prettified, because the only reason to open this page is to
   find out what is genuinely in the row — a tidied value would
   answer a different question.
   ============================================================ */

import { esc } from "./format.js";

const API = "/api/db";

let current = null; // { schema, table }
let offset = 0;
let limit = 50;

/* ---- fetching ------------------------------------------------ */
async function getJSON(path) {
  const res = await fetch(API + path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---- rendering ----------------------------------------------- */

/** NULL, "" and a value are three different things and must look it. */
function cell(v) {
  if (v === null || v === undefined) return `<span class="nul">null</span>`;
  if (v === "") return `<span class="empty-str">""</span>`;
  if (typeof v === "object") return esc(JSON.stringify(v));
  return esc(String(v));
}

function drawTables(host, tables, onPick) {
  host.innerHTML = tables
    .map(
      (t) => `
      <button class="tcard" type="button"
              data-schema="${esc(t.schema)}" data-table="${esc(t.name)}"
              aria-pressed="false">
        <span class="tcard-schema">${esc(t.schema)}</span>
        <span class="tcard-name">${esc(t.name)}</span>
        <span class="tcard-meta">${t.rows} row${t.rows === 1 ? "" : "s"} · ${t.columns} cols</span>
      </button>`
    )
    .join("");

  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".tcard");
    if (!btn) return;
    [...host.querySelectorAll(".tcard")].forEach((b) =>
      b.setAttribute("aria-pressed", String(b === btn))
    );
    onPick({ schema: btn.dataset.schema, table: btn.dataset.table });
  });
}

function drawRows(host, data) {
  if (!data.rows.length) {
    host.innerHTML = `<p class="empty">${esc(data.schema)}.${esc(data.table)} is empty.</p>`;
    return;
  }

  host.innerHTML = `
    <div class="grid-wrap">
      <table class="grid">
        <thead>
          <tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${data.rows
            .map(
              (r) =>
                `<tr>${data.columns
                  .map((c) => {
                    const raw = r[c];
                    const text = raw === null || raw === undefined ? "null" : String(raw);
                    // Clipped for width, but the whole value stays on
                    // the title — a cut-off cell must never be the
                    // only copy of what is stored.
                    return `<td title="${esc(text)}">${cell(raw)}</td>`;
                  })
                  .join("")}</tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function drawPager(host, data) {
  const from = data.total ? data.offset + 1 : 0;
  const to = Math.min(data.offset + data.limit, data.total);
  host.innerHTML = `
    <button class="btn quiet" type="button" data-page="prev" ${data.offset ? "" : "disabled"}>← Back</button>
    <button class="btn quiet" type="button" data-page="next" ${to >= data.total ? "disabled" : ""}>Next →</button>
    <span class="spacer">${from}–${to} of ${data.total}</span>`;
}

/* ---- wiring --------------------------------------------------- */
export async function mount({ tablesHost, rowsHost, pagerHost, titleHost, filter }) {
  const { tables } = await getJSON("/tables");
  const shown = filter ? tables.filter(filter) : tables;

  drawTables(tablesHost, shown, (pick) => {
    current = pick;
    offset = 0;
    load();
  });

  async function load() {
    if (!current) return;
    const data = await getJSON(
      `/rows?schema=${encodeURIComponent(current.schema)}&table=${encodeURIComponent(
        current.table
      )}&limit=${limit}&offset=${offset}`
    );
    if (titleHost) titleHost.textContent = `${data.schema}.${data.table}`;
    drawRows(rowsHost, data);
    drawPager(pagerHost, data);
  }

  pagerHost.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-page]");
    if (!btn || btn.disabled) return;
    offset = Math.max(0, offset + (btn.dataset.page === "next" ? limit : -limit));
    load();
  });

  // Open the first table straight away. A viewer that starts empty
  // makes you click once before it has told you anything.
  if (shown.length) {
    tablesHost.querySelector(".tcard")?.setAttribute("aria-pressed", "true");
    current = { schema: shown[0].schema, table: shown[0].name };
    await load();
  }

  return { count: shown.length };
}
