/* ============================================================
   PROGRAMME MONITOR — her side of the daily app
   ------------------------------------------------------------
   The client's app is glass, black and iOS. THIS IS NOT THAT.
   It is the CRM: beige, square-edged, Noto, the same masthead as
   every other page. The two are opposite ends of one feature and
   they should look nothing alike — she is reading a record, they
   are filling one in on a phone.

   The BORROWING from iPad Files is the shape, not the skin. A
   month of check-ins really is a folder of days; a day really is
   a folder of rows; some of those rows really do have a
   photograph attached. So it is browsed like a filesystem —
   locations, a path, tiles or columns, and one selected thing
   explained on the right — and painted like the CRM.

   THREE READS, ONCE PER PROGRAMME. The CRM's rule is one request
   per page, and the page's request is the programme list. Opening
   somebody then costs three parallel calls — days, weights,
   photographs — which are three genuinely different questions,
   and the answers are kept so moving between folders costs
   nothing.

   NO SAMPLE FALLBACK anywhere in here. An invented week of ticks
   is indistinguishable from a real one, and this is the record
   she would change somebody's plan on the strength of.
   ============================================================ */

import * as api from "../api.js";
import { esc, fmtDay, fmtTime } from "../format.js";
import { start, $, $$ } from "../page.js";

/* ---- what is on screen ------------------------------------------ */

let programmes = [];
let current = null;              // the chosen programme
let record = null;               // { checkins, weights, media } for it
let where = { view: "days", day: null };
let picked = null;               // { type, id } — what the panel explains

/* Icons or columns. Remembered, because it is a preference about
   how she reads rather than a fact about the data. */
const VIEW_KEY = "myf.pm.view";
let asGrid = localStorage.getItem(VIEW_KEY) !== "list";

let sortBy = "date";
let finding = "";

/* ---- glyphs -----------------------------------------------------
   Drawn here rather than fetched: fourteen bytes of path data does
   not deserve a network request, and an icon that fails to load on
   a bad connection leaves a row that cannot be read. */

const GLYPH = {
  folder: `<path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.2l1.3 1.5h5.5A1.5 1.5 0 0 1 14 5v7.5A1.5 1.5 0 0 1 12.5 14h-10A1.5 1.5 0 0 1 1 12.5z"/>`,
  meal: `<path d="M8 2a5 5 0 0 1 5 5H3a5 5 0 0 1 5-5M2 8.5h12a1 1 0 0 1 0 2H2a1 1 0 0 1 0-2m1.5 3.5h9l-.8 1.6a1 1 0 0 1-.9.5H5.2a1 1 0 0 1-.9-.5z"/>`,
  supplement: `<path d="M4.6 2.6a3.7 3.7 0 0 1 5.2 5.2L7.8 9.8 2.6 4.6zM8.2 11.4l1.9-2 3.3 3.3a2.6 2.6 0 0 1-3.7 3.7z" transform="scale(.86) translate(1 -.5)"/>`,
  activity: `<path d="M9.4 1.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8M7.6 5.1l2.6-.7 2.4 2 1.6.5-.4 1.4-2.2-.7-1.2-1-.7 2.6 2 1.9.9 3.9-1.5.3-.8-3.3-2.6-2.3-1 3-2.6 1.7-.8-1.3 2.1-1.4z"/>`,
  sleep: `<path d="M13.6 9.9A5.6 5.6 0 0 1 6.1 2.4a6 6 0 1 0 7.5 7.5"/>`,
  habit: `<path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>`,
  other: `<path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1"/>`,
  photo: `<path d="M2 4h3l1-1.5h4L11 4h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1m6 2.2A3.3 3.3 0 1 0 8 12.8 3.3 3.3 0 0 0 8 6.2"/>`,
  scale: `<path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1m5 2.2a3.8 3.8 0 0 0-3.6 5h7.2A3.8 3.8 0 0 0 8 4.2m0 1.3l1.4 2.4H6.6z"/>`,
  fix: `<path d="M8 1.6A6.4 6.4 0 1 0 14.4 8h-1.6A4.8 4.8 0 1 1 8 3.2v2.2l3.2-2.4L8 .6z"/>`,
  note: `<path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7A1.5 1.5 0 0 1 12.5 11H6.6L3 14.4a.6.6 0 0 1-1-.44zm2.2 2.1h7.6v1.2H4.2zm0 2.6h5.2v1.2H4.2z"/>`,
};

const icon = (name, cls = "pm-glyph") =>
  `<svg class="${cls}" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"
        aria-hidden="true">${GLYPH[name] || GLYPH.other}</svg>`;

/* Her words for the row kinds, not the column's. */
const KIND = {
  meal: "Meal",
  supplement: "Supplement",
  activity: "Movement",
  sleep: "Sleep",
  habit: "Habit",
  other: "Other",
};

const STATE = { done: "Done", part: "Some", skip: "No" };

/* ---- reading the record ------------------------------------------ */

/** Every day that has anything on it, newest first, each one
    carrying its rows, its photographs and how it went. */
function days() {
  if (!record) return [];
  const by = new Map();

  for (const c of record.checkins) {
    if (!by.has(c.date)) by.set(c.date, { date: c.date, rows: [], shots: [], fixes: 0 });
    const day = by.get(c.date);
    day.rows.push(c);
    if (c.revisions > 1) day.fixes += 1;
  }
  for (const m of record.media) {
    const key = m.onDate;
    if (!key) continue;
    if (!by.has(key)) by.set(key, { date: key, rows: [], shots: [], fixes: 0 });
    by.get(key).shots.push(m);
  }

  /* A note makes a day exist even if nothing was ticked on it —
     "could not do any of this, I was ill" is a day, and a folder
     that only appears when somebody managed a tick would hide
     exactly the days she most needs to see. */
  for (const n of record.notes || []) {
    if (!by.has(n.date)) by.set(n.date, { date: n.date, rows: [], shots: [], fixes: 0 });
    const day = by.get(n.date);
    day.notes = (day.notes || 0) + 1;
  }

  for (const day of by.values()) {
    day.rows.sort((a, b) => a.seq - b.seq);
    day.notes = day.notes || 0;
    const done = day.rows.filter((r) => r.state === "done").length;
    const skip = day.rows.filter((r) => r.state === "skip").length;
    day.done = done;
    /* HOW THE DAY WENT, in one word, for the stripe on the tile.
       Every row done is the only thing that counts as done — a day
       that is mostly right is "part", because rounding somebody's
       week up is how a plan stops matching the person on it. */
    /* A day with no rows at all — a note and nothing else — is not
       "all done". It gets no stripe, because there is nothing to
       report and a green edge on an empty day would be a lie told
       by an off-by-one. */
    day.how = !day.rows.length
      ? "none"
      : done === day.rows.length ? "done" : skip > done ? "skip" : "part";
  }

  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}

const dayOf = (iso) => days().find((d) => d.date === iso) || null;

const shotsFor = (checkinId) =>
  (record?.media || []).filter((m) => m.checkinId === checkinId);

/* ---- what folder are we in --------------------------------------- */

/** The current folder as a flat list of things, already sorted and
    filtered. One function, so grid and list can never disagree
    about what is in the folder. */
function contents() {
  let out = [];

  /* A day is a day whichever location it was opened from — reached
     through Corrections it is still the same folder, and going back
     returns to the list she was actually looking at. */
  if (where.day) {
    const day = dayOf(where.day);
    out = (day?.rows || []).map((r) => ({
      type: "item",
      id: r.checkinId,
      name: r.label,
      kind: r.kind,
      date: r.date,
      at: r.at,
      row: r,
      shots: shotsFor(r.checkinId),
    }));

    /* Anything they wrote that day sits in the day, alongside the
       rows. It is the same folder — the note is about the day, not
       about a row, and filing it somewhere else would mean reading
       two screens to find out what happened on the fourth. */
    out = out.concat(
      (record?.notes || [])
        .filter((n) => n.date === where.day)
        .map((n) => ({
          type: "note",
          id: n.id,
          name: n.body.split("\n")[0].slice(0, 80),
          kind: "note",
          date: n.date,
          at: n.at,
          note: n,
        }))
    );
  } else if (where.view === "days") {
    out = days().map((d) => ({
      type: "day",
      id: d.date,
      name: fmtDay(d.date),
      kind: "folder",
      date: d.date,
      at: d.date,
      day: d,
    }));
  } else if (where.view === "photos") {
    out = (record?.media || []).map((m) => ({
      type: "photo",
      id: m.id,
      name: m.itemLabel || "Photograph",
      kind: "photo",
      date: m.onDate,
      at: m.takenAt,
      shot: m,
    }));
  } else if (where.view === "notes") {
    out = (record?.notes || []).map((n) => ({
      type: "note",
      id: n.id,
      /* The first line is the name. A note has no title, and a folder
         of items all called "Note" is a folder you cannot scan. */
      name: n.body.split("\n")[0].slice(0, 80),
      kind: "note",
      date: n.date,
      at: n.at,
      note: n,
    }));
  } else if (where.view === "weights") {
    out = (record?.weights || []).map((w, i) => ({
      type: "weight",
      id: `w${i}`,
      name: `${w.kg} kg`,
      kind: "scale",
      date: w.date,
      at: w.at,
      weight: w,
    }));
  } else if (where.view === "corrections") {
    /* Days somebody went back and changed their mind about. Worth a
       location of its own: a corrected day and a day answered once
       look identical in a tally, and they are not the same thing. */
    out = days()
      .filter((d) => d.fixes > 0)
      .map((d) => ({
        type: "day",
        id: d.date,
        name: fmtDay(d.date),
        kind: "folder",
        date: d.date,
        at: d.date,
        day: d,
      }));
  }

  const q = finding.trim().toLowerCase();
  if (q) out = out.filter((x) => x.name.toLowerCase().includes(q));

  const by = {
    date: (a, b) => String(b.at).localeCompare(String(a.at)),
    "date-asc": (a, b) => String(a.at).localeCompare(String(b.at)),
    name: (a, b) => a.name.localeCompare(b.name),
    kind: (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  };
  return out.sort(by[sortBy] || by.date);
}

/* ---- painting ---------------------------------------------------- */

function paintSide() {
  const host = $("[data-people]");
  if (!programmes.length) {
    host.innerHTML = `<p class="pm-empty">No programme has been started yet.</p>`;
    return;
  }

  host.innerHTML = programmes
    .map(
      (p) => `
      <button class="pm-side-item" type="button" data-programme="${esc(p.id)}"
              data-status="${esc(p.status)}"
              aria-current="${current?.id === p.id ? "true" : "false"}">
        ${icon("folder")}
        <span class="pm-side-name">${esc(p.personName)}</span>
        <span class="pm-side-n">${p.status === "active" ? "" : "stopped"}</span>
      </button>`
    )
    .join("");

  const views = $("[data-views]");
  const head = $("[data-views-head]");
  if (!current) {
    views.hidden = true;
    head.hidden = true;
    return;
  }

  const fixes = days().filter((d) => d.fixes > 0).length;
  /* Unread notes carry a count that is not a total. Everywhere else
     on this page the number beside a location is "how many are in
     there"; here it is "how many you have not seen", because that is
     the only version of the number that would make her open it. */
  const unread = (record?.notes || [])
    .filter((n) => n.author !== "practitioner" && !n.seenAt).length;

  const list = [
    { id: "days", label: "All days", glyph: "folder", n: days().length },
    { id: "notes", label: "What they said", glyph: "note", n: record?.notes.length || 0, hot: unread },
    { id: "photos", label: "Photographs", glyph: "photo", n: record?.media.length || 0 },
    { id: "weights", label: "Weights", glyph: "scale", n: record?.weights.length || 0 },
    { id: "corrections", label: "Corrections", glyph: "fix", n: fixes },
  ];

  views.hidden = false;
  head.hidden = false;
  views.innerHTML = list
    .map(
      (v) => `
      <button class="pm-side-item" type="button" data-view="${v.id}"
              aria-current="${where.view === v.id ? "true" : "false"}">
        ${icon(v.glyph)}
        <span class="pm-side-name">${esc(v.label)}</span>
        ${v.hot
          ? `<span class="pm-side-hot">${v.hot} new</span>`
          : `<span class="pm-side-n">${v.n}</span>`}
      </button>`
    )
    .join("");

  const note = $("[data-side-note]");
  note.hidden = false;
  note.textContent = current.status === "active"
    ? `Started ${fmtDay(current.startedOn)} · opened ${current.openCount} times`
    : `Started ${fmtDay(current.startedOn)} · stopped`;
}

function paintCrumbs() {
  const host = $("[data-crumbs]");
  const trail = [{ label: current ? current.personName : "—", to: null }];

  const viewName = {
    days: "All days",
    notes: "What they said",
    photos: "Photographs",
    weights: "Weights",
    corrections: "Corrections",
  }[where.view];
  trail.push({ label: viewName, to: where.day ? "view" : null });

  if (where.day) trail.push({ label: fmtDay(where.day), to: null });

  host.innerHTML = trail
    .map((c, i) => {
      const last = i === trail.length - 1;
      const tag = c.to
        ? `<button class="pm-crumb" type="button" data-up="${c.to}">${esc(c.label)}</button>`
        : `<span class="pm-crumb"${last ? ' aria-current="page"' : ""}>${esc(c.label)}</span>`;
      return (i ? `<span class="pm-sep">›</span>` : "") + tag;
    })
    .join("");
}

function paintSummary() {
  const host = $("[data-summary]");
  if (!record) { host.hidden = true; return; }

  const all = days();
  const rows = record.checkins.length;
  const done = record.checkins.filter((c) => c.state === "done").length;
  const w = record.weights;

  /* A change is only a change if there are two of them. One reading
     is a number, not a direction, and drawing an arrow from it would
     be inventing a trend out of a single point. */
  let move = "—";
  if (w.length > 1) {
    const d = w[w.length - 1].kg - w[0].kg;
    move = `${d > 0 ? "+" : ""}${d.toFixed(1)} kg`;
  } else if (w.length === 1) {
    move = `${w[0].kg} kg`;
  }

  const figures = [
    [all.length, all.length === 1 ? "day" : "days"],
    [rows ? `${Math.round((done / rows) * 100)}%` : "—", "done"],
    [record.media.length, record.media.length === 1 ? "photo" : "photos"],
    [move, w.length > 1 ? "since the start" : "weighed"],
  ];

  host.hidden = false;
  host.innerHTML = figures
    .map(([b, s]) => `<div class="pm-figure"><b>${esc(b)}</b><span>${esc(s)}</span></div>`)
    .join("");
}

/** The art on a tile: a photograph if there is one, a drawn folder
    if not — which is how Files shows a folder of pictures. */
function art(x) {
  if (x.type === "photo") {
    return `<img src="${api.photoUrl(x.shot.id)}" loading="lazy" decoding="async"
                 alt="Photograph for ${esc(x.name)}" />`;
  }
  if (x.type === "day" && x.day.shots.length) {
    return `<img src="${api.photoUrl(x.day.shots[0].id)}" loading="lazy" decoding="async"
                 alt="" />`;
  }
  if (x.type === "item" && x.shots.length) {
    return `<img src="${api.photoUrl(x.shots[0].id)}" loading="lazy" decoding="async"
                 alt="" />`;
  }
  const g = x.type === "day" ? "folder" : x.type === "weight" ? "scale" : x.kind;
  return `<svg width="34" height="34" viewBox="0 0 16 16" fill="currentColor"
               aria-hidden="true">${GLYPH[g] || GLYPH.other}</svg>`;
}

function tileMeta(x) {
  if (x.type === "day") {
    const bits = [`${x.day.done}/${x.day.rows.length} done`];
    if (x.day.shots.length) bits.push(`${x.day.shots.length} photo${x.day.shots.length === 1 ? "" : "s"}`);
    if (x.day.notes) bits.push(x.day.notes === 1 ? "a note" : `${x.day.notes} notes`);
    return bits.join(" · ");
  }
  if (x.type === "item") return `${STATE[x.row.state]} · ${fmtTime(x.row.at)}`;
  if (x.type === "photo") return fmtDay(x.date);
  if (x.type === "weight") return fmtDay(x.date);
  if (x.type === "note") return `${fmtDay(x.date)} · ${fmtTime(x.at)}`;
  return "";
}

function paintGrid(list) {
  return `<div class="pm-grid" role="listbox" aria-label="Folder">${list
    .map((x) => {
      const badge =
        x.type === "day" && x.day.shots.length
          ? `<span class="pm-badge">${icon("photo")}${x.day.shots.length}</span>`
          : x.type === "item" && x.shots.length
          ? `<span class="pm-badge">${icon("photo")}${x.shots.length}</span>`
          : "";
      const bar =
        x.type === "day"
          ? `<span class="pm-bar" data-how="${esc(x.day.how)}"></span>`
          : x.type === "item"
          ? `<span class="pm-bar" data-how="${esc(x.row.state)}"></span>`
          : "";
      return `
        <div class="pm-tile" role="option" tabindex="0"
             data-pick="${esc(x.type)}" data-id="${esc(x.id)}"
             aria-selected="${picked?.id === x.id ? "true" : "false"}">
          <span class="pm-art">${art(x)}${badge}${bar}</span>
          <p class="pm-name">${esc(x.name)}</p>
          <p class="pm-meta">${esc(tileMeta(x))}</p>
        </div>`;
    })
    .join("")}</div>`;
}

function paintList(list) {
  const cols =
    where.view === "weights"
      ? ["Weight", "Day", "Recorded"]
      : where.day || where.view === "photos" || where.view === "notes"
      ? ["Name", "Kind", "State", "Recorded"]
      : ["Day", "Answered", "Photos", "How it went"];

  const body = list
    .map((x) => {
      const cells =
        x.type === "day"
          ? [
              `<div class="pm-cell">${icon("folder")}<span>${esc(x.name)}</span></div>`,
              `<span class="num">${x.day.done}/${x.day.rows.length}</span>`,
              `<span class="num">${x.day.shots.length || "—"}</span>`,
              `<span class="pm-state" data-state="${esc(x.day.how)}">${esc(STATE[x.day.how])}</span>`,
            ]
          : x.type === "item"
          ? [
              `<div class="pm-cell">${icon(x.kind)}<span>${esc(x.name)}</span></div>`,
              esc(KIND[x.kind] || x.kind),
              `<span class="pm-state" data-state="${esc(x.row.state)}">${esc(STATE[x.row.state])}</span>`,
              `<span class="num">${esc(fmtTime(x.row.at))}</span>`,
            ]
          : x.type === "note"
          ? [
              `<div class="pm-cell">${icon("note")}<span>${esc(x.name)}</span></div>`,
              "Note",
              x.note.seenAt ? "" : `<span class="pm-state" data-state="part">New</span>`,
              `<span class="num">${esc(fmtDay(x.date))} ${esc(fmtTime(x.at))}</span>`,
            ]
          : x.type === "photo"
          ? [
              `<div class="pm-cell"><img class="pm-thumb" src="${api.photoUrl(x.shot.id)}"
                   loading="lazy" alt="" /><span>${esc(x.name)}</span></div>`,
              "Photograph",
              `<span class="num">${Math.round(x.shot.bytes / 1024)} KB</span>`,
              `<span class="num">${esc(fmtDay(x.date))} ${esc(fmtTime(x.at))}</span>`,
            ]
          : [
              `<div class="pm-cell">${icon("scale")}<span>${esc(x.name)}</span></div>`,
              `<span class="num">${esc(fmtDay(x.date))}</span>`,
              `<span class="num">${esc(fmtTime(x.at))}</span>`,
            ];

      return `<tr data-pick="${esc(x.type)}" data-id="${esc(x.id)}"
                  aria-selected="${picked?.id === x.id ? "true" : "false"}">
        ${cells.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}
      </tr>`;
    })
    .join("");

  return `<div class="pm-scroll"><table class="pm-list">
    <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function paintFolder() {
  const host = $("[data-folder]");
  const list = contents();

  if (!list.length) {
    host.innerHTML = `<p class="pm-empty">${
      finding ? "Nothing here matches that." : "Nothing in this folder yet."
    }</p>`;
    return;
  }
  host.innerHTML = asGrid ? paintGrid(list) : paintList(list);
}

/* ---- the info panel ---------------------------------------------- */

const fact = (k, v) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;

/** One day's conversation, oldest first — both sides of it. */
function threadHTML(date) {
  const thread = (record?.notes || [])
    .filter((n) => n.date === date)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  if (!thread.length) return `<p class="pm-empty">Nothing was said about this day.</p>`;

  return `<div class="pm-thread">${thread
    .map(
      (n) => `
      <div class="pm-said" data-from="${n.author === "practitioner" ? "her" : "them"}">
        <p class="pm-said-who">${
          n.author === "practitioner" ? "You" : "They wrote"
        } · ${esc(fmtTime(n.at))}</p>
        <p class="pm-said-body">${esc(n.body)}</p>
      </div>`
    )
    .join("")}</div>`;
}

/** The box she answers in.

    ON THE DAY, not on the note. A reply belongs to a date — she
    reads Tuesday's note on Thursday and answers about Tuesday —
    and tying it to one note would mean two notes on one day
    produce two half-conversations.

    No date window here, unlike a check-in: a check-in is a record
    of what somebody did and backfilling makes it a memory test, but
    a reply is an answer ABOUT a day, and refusing a late one would
    make the feature useless in exactly the case it exists for. */
function replyHTML(date) {
  return `
    <div class="pm-reply" data-reply-for="${esc(date)}">
      <label class="pm-reply-l" for="pm-reply">Answer them</label>
      <textarea id="pm-reply" data-reply rows="3"
        placeholder="They see this in their app, on this day."></textarea>
      <div class="pm-reply-row">
        <span class="pm-reply-why">Goes straight to their phone. It cannot be edited afterwards.</span>
        <button class="btn go" type="button" data-reply-send disabled>Send</button>
      </div>
      <p class="pm-reply-said" data-reply-said hidden aria-live="polite"></p>
    </div>`;
}

function paintInfo() {
  const host = $("[data-info]");
  if (!picked) {
    host.innerHTML = `<p class="pm-empty">Nothing selected.</p>`;
    return;
  }

  const x = contents().find((c) => c.id === picked.id);
  if (!x) {
    host.innerHTML = `<p class="pm-empty">Nothing selected.</p>`;
    return;
  }

  if (x.type === "day") {
    const d = x.day;
    host.innerHTML = `
      <h3>${esc(fmtDay(d.date))}</h3>
      <p class="pm-info-kind">Day</p>
      <dl class="pm-facts">
        ${fact("Rows answered", d.rows.length)}
        ${fact("Done", `${d.done} of ${d.rows.length}`)}
        ${fact("Photographs", d.shots.length)}
        ${fact("Date", d.date)}
      </dl>
      ${d.fixes ? `<p class="pm-revised">${d.fixes} row${d.fixes === 1 ? " was" : "s were"} answered more than once.</p>` : ""}
      ${threadHTML(d.date)}
      ${replyHTML(d.date)}`;
    return;
  }

  if (x.type === "item") {
    const r = x.row;
    const shot = x.shots[0];
    host.innerHTML = `
      ${shot ? `<img class="pm-info-shot" src="${api.photoUrl(shot.id)}" alt="Photograph for ${esc(r.label)}" />` : ""}
      <h3>${esc(r.label)}</h3>
      <p class="pm-info-kind">${esc(KIND[r.kind] || r.kind)}</p>
      <dl class="pm-facts">
        ${fact("Answer", STATE[r.state])}
        ${fact("Day", fmtDay(r.date))}
        ${fact("Recorded", fmtTime(r.at))}
        ${x.shots.length ? fact("Photographs", x.shots.length) : ""}
      </dl>
      ${r.note ? `<p class="pm-note">${esc(r.note)}</p>` : ""}
      ${r.revisions > 1
        ? `<p class="pm-revised">Answered ${r.revisions} times — this is the last one. The earlier answers are kept.</p>`
        : ""}`;
    return;
  }

  if (x.type === "note") {
    const n = x.note;
    /* THE WHOLE DAY'S CONVERSATION, not the one line that was
       clicked. A tile shows an opening so the folder can be
       scanned; the panel is where it is read — and answering a note
       without seeing what was already said about that day is how
       she replies twice to the same question. */
    host.innerHTML = `
      <h3>${esc(fmtDay(n.date))}</h3>
      <p class="pm-info-kind">What was said</p>
      ${threadHTML(n.date)}
      ${replyHTML(n.date)}`;
    return;
  }

  if (x.type === "photo") {
    const m = x.shot;
    host.innerHTML = `
      <img class="pm-info-shot" src="${api.photoUrl(m.id)}" alt="Photograph for ${esc(x.name)}" />
      <h3>${esc(x.name)}</h3>
      <p class="pm-info-kind">Photograph</p>
      <dl class="pm-facts">
        ${fact("Day", fmtDay(m.onDate))}
        ${fact("Taken", fmtTime(m.takenAt))}
        ${fact("Size", `${Math.round(m.bytes / 1024)} KB`)}
        ${fact("Type", m.mime)}
      </dl>`;
    return;
  }

  const w = x.weight;
  host.innerHTML = `
    <h3>${esc(w.kg)} kg</h3>
    <p class="pm-info-kind">Weight · self-reported</p>
    <dl class="pm-facts">
      ${fact("Day", fmtDay(w.date))}
      ${fact("Recorded", fmtTime(w.at))}
    </dl>
    <p class="pm-revised">From their phone, not your scale. It is kept apart from the clinic readings on the assessment.</p>`;
}

function repaint() {
  paintSide();
  paintCrumbs();
  paintSummary();
  paintFolder();
  paintInfo();
}

/* ---- opening one ------------------------------------------------- */

async function choose(id) {
  const p = programmes.find((x) => x.id === id);
  if (!p) return;

  current = p;
  where = { view: "days", day: null };
  picked = null;
  record = null;

  $("[data-blank]").hidden = true;
  $("[data-browser]").hidden = false;
  $("[data-bar-who]").textContent = p.personName;
  $("[data-folder]").innerHTML = `<p class="pm-empty">Reading their days…</p>`;
  paintSide();
  paintCrumbs();

  try {
    const [d, w, m, n] = await Promise.all([
      api.programmeDays(p.id, 400),
      api.programmeWeights(p.id),
      api.media(p.id),
      api.programmeNotes(p.id),
    ]);
    record = {
      checkins: d.checkins || [],
      weights: w.weights || [],
      media: m.media || [],
      notes: n.notes || [],
    };
  } catch (err) {
    /* No invented fallback. If the record cannot be read, the page
       says so — a blank folder would read as "they did nothing". */
    $("[data-folder]").innerHTML =
      `<p class="pm-empty">Their record could not be read. ${esc(err.message)}</p>`;
    return;
  }
  repaint();
}

/* ---- what she touches -------------------------------------------- */

/* Only a day is a folder. A photograph, a weight and a single row
   are leaves — opening one would have to mean something, and there
   is nothing inside them that the panel is not already showing. */
function open(type, id) {
  if (type !== "day") return;
  where = { view: where.view, day: id };
  picked = null;
  finding = "";
  $("[data-find]").value = "";
  repaint();
}

document.addEventListener("click", (e) => {
  const prog = e.target.closest("[data-programme]");
  if (prog) return choose(prog.dataset.programme);

  const view = e.target.closest("[data-view]");
  if (view) {
    where = { view: view.dataset.view, day: null };
    picked = null;
    return repaint();
  }

  const up = e.target.closest("[data-up]");
  if (up) {
    where = { ...where, day: null };
    picked = null;
    return repaint();
  }

  const as = e.target.closest("[data-as]");
  if (as) {
    asGrid = as.dataset.as === "grid";
    localStorage.setItem(VIEW_KEY, asGrid ? "grid" : "list");
    $$("[data-as]").forEach((b) =>
      b.setAttribute("aria-pressed", String((b.dataset.as === "grid") === asGrid))
    );
    return paintFolder();
  }

  if (e.target.closest("[data-reply-send]")) return sendReply();

  const pick = e.target.closest("[data-pick]");
  if (pick) {
    picked = { type: pick.dataset.pick, id: pick.dataset.id };
    paintFolder();
    return paintInfo();
  }
});

/* Double-click opens, single click selects — the muscle memory is
   already there and this page should not ask her to learn a new one. */
document.addEventListener("dblclick", (e) => {
  const pick = e.target.closest("[data-pick]");
  if (pick) open(pick.dataset.pick, pick.dataset.id);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && picked) return open(picked.type, picked.id);
  if ((e.key === "Escape" || e.key === "Backspace") && where.day) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    where = { ...where, day: null };
    picked = null;
    repaint();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-find]")) {
    finding = e.target.value;
    picked = null;
    paintFolder();
    paintInfo();
    return;
  }

  /* Send is dead until there is something to send. */
  if (e.target.matches("[data-reply]")) {
    const btn = $("[data-reply-send]");
    if (btn) btn.disabled = !e.target.value.trim();
  }
});

/** Her answer. Appended to the thread in memory rather than
    refetching — the server has already agreed by the time this
    returns, and a panel that blanks and redraws loses her place in
    a conversation she is in the middle of reading. */
async function sendReply() {
  const box = $("[data-reply]");
  const wrap = $("[data-reply-for]");
  const said = $("[data-reply-said]");
  const body = (box?.value || "").trim();
  if (!body || !wrap || !current) return;

  const date = wrap.dataset.replyFor;
  const btn = $("[data-reply-send]");
  btn.disabled = true;

  try {
    const out = await api.replyOnDay(current.id, date, body);
    record.notes.push({
      id: out.id,
      date,
      body,
      at: new Date().toISOString(),
      author: "practitioner",
      seenAt: null,
    });
    box.value = "";
    paintFolder();
    paintInfo();
    /* paintInfo redrew the panel, so the element this was written
       into is gone — the message goes on the fresh one. */
    const fresh = $("[data-reply-said]");
    if (fresh) {
      fresh.hidden = false;
      fresh.textContent = "Sent. They will see it on this day in their app.";
    }
  } catch (err) {
    btn.disabled = false;
    if (said) {
      said.hidden = false;
      said.textContent = err.message || "That did not send.";
    }
  }
}

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-sort]")) {
    sortBy = e.target.value;
    paintFolder();
  }
});

/* The programme list as a panel on a narrow screen — the same
   control as the plan and the assessment, so it is not learned
   three times. */
function wireAside() {
  const btn = $("[data-aside-btn]");
  const panel = $("[data-aside]");
  const veil = $("[data-aside-veil]");
  if (!btn || !panel || !veil) return;

  const shut = () => {
    panel.dataset.open = "false";
    veil.dataset.open = "false";
    btn.setAttribute("aria-expanded", "false");
    setTimeout(() => { if (panel.dataset.open !== "true") veil.hidden = true; }, 320);
  };

  btn.addEventListener("click", () => {
    if (panel.dataset.open !== "true") {
      veil.hidden = false;
      requestAnimationFrame(() => {
        panel.dataset.open = "true";
        veil.dataset.open = "true";
      });
      btn.setAttribute("aria-expanded", "true");
    } else shut();
  });

  veil.addEventListener("click", shut);
  addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });
  panel.addEventListener("click", (e) => {
    if (e.target.closest("[data-programme]")) shut();
  });
}

/* ---- boot --------------------------------------------------------- */

start(
  "programme",
  async () => {
    try {
      const out = await api.programmes("");
      return { data: { programmes: out.programmes || [] }, live: true };
    } catch {
      return { data: { programmes: [], failed: true }, live: false };
    }
  },
  (data) => {
    programmes = data.programmes;
    $$("[data-as]").forEach((b) =>
      b.setAttribute("aria-pressed", String((b.dataset.as === "grid") === asGrid))
    );
    paintSide();
    wireAside();

    /* THE BAR'S REAL HEIGHT, PUBLISHED.

       The path bar and the table pane both stick beneath the work
       bar, and both were computing that offset from
       --work-bar-h — which no code on this page ever set. They
       were using the 3rem fallback, so on any viewport where the
       bar wrapped to two lines the path bar sat under the
       masthead and the folder scrolled behind it.

       Measured rather than assumed, and re-measured when it
       changes: the bar grows a line the moment a long client name
       or a narrow window makes it wrap. Every other workspace
       page does this — the assessment, the room and the plan —
       and this one was simply missed. */
    const bar = document.querySelector(".work-bar");
    if (bar) {
      const set = () =>
        document.documentElement.style.setProperty("--work-bar-h", `${bar.offsetHeight}px`);
      set();
      if ("ResizeObserver" in window) new ResizeObserver(set).observe(bar);
      else addEventListener("resize", set);
    }

    /* Straight into the only one, when there is only one. A list of
       one that has to be clicked is a click that carries no
       information. */
    if (programmes.length === 1) choose(programmes[0].id);
  }
);
