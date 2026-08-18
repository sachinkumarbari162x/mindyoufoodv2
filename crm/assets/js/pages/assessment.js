/* ============================================================
   ASSESSMENT — the clinical record, in the CRM
   ------------------------------------------------------------
   The trial's shape, now backed by Postgres instead of this
   browser. What changed is where it writes; what did not change
   is how it feels — open it, type, it saves.

   THE RULES IT ENFORCES ARE NOT ITS OWN. Versioning, the
   amend-forward policy and the refusal to edit a finalised
   version all live in Go. This page reflects them: if it were
   the only thing stopping an edit, a modified page would be
   enough to rewrite a clinical note.
   ============================================================ */

import * as api from "../api.js";
import { esc } from "../format.js";
import { start, $, $$ } from "../page.js";

/* The form's markup and its arithmetic live in nsf-form.js, because
   the consulting-room panel mounts the same form beside a call. Two
   renderers of one clinical record do not stay the same. */
import * as nsf from "../nsf-form.js";

let people = [];
let chain = [];        // every version of the open visit
let current = null;
let saveTimer = null;

/* ---- the version chain --------------------------------------- */
const sameVisit = (a) => chain.filter((x) => x.visit === a.visit)
  .sort((x, y) => x.amendment - y.amendment);

function supersededBy(a) {
  const line = sameVisit(a);
  const i = line.findIndex((x) => x.id === a.id);
  return i >= 0 && i < line.length - 1 ? line[line.length - 1] : null;
}

/** What this amendment altered — the reason it is worth reading. */
function changedIn(a) {
  const line = sameVisit(a);
  const i = line.findIndex((x) => x.id === a.id);
  if (i <= 0) return new Set();
  const before = line[i - 1];
  const changed = new Set();
  for (const k of new Set([...Object.keys(before.values || {}), ...Object.keys(a.values || {})])) {
    if ((before.values?.[k] ?? "") !== (a.values?.[k] ?? "")) changed.add(k);
  }
  return changed;
}

/* ---- rendering ------------------------------------------------ */

function renderSections() {
  $("[data-sections]").innerHTML = nsf.sectionsHTML(
    current.values,
    changedIn(current),
    current.openSections
  );
  paintCalcs();
}

/** The previous VISIT, for "change since last". An amendment of this
    same visit is not a previous weighing — it is this weighing,
    written down again. */
const previousValues = () =>
  chain.find((a) => a.visit === current.visit - 1)?.values || null;

function paintCalcs() {
  nsf.paintCalcs(document, current.values, previousValues());
}

function renderVersions(a) {
  const bar = $("[data-versions]");
  const notice = $("[data-superseded]");
  const line = sameVisit(a);
  const newer = supersededBy(a);

  bar.hidden = line.length < 2;
  if (!bar.hidden) {
    bar.innerHTML = `<span class="versions-label">Versions</span>` +
      line.map((v) => `
        <button class="ver" type="button" data-version="${esc(v.id)}"
                aria-current="${v.id === a.id}">${esc(v.ref)}</button>`).join("");
  }

  /* READ-ONLY, and said before she types into it. Going back to edit
     a version that has already been corrected would undo the reason
     for amending in the first place. */
  const readOnly = !!newer || a.status === "final";
  document.body.dataset.readonly = String(readOnly);
  notice.hidden = !readOnly;
  if (readOnly) {
    notice.innerHTML = newer
      ? `An earlier version, kept as written. Superseded by <b>${esc(newer.ref)}</b> — ` +
        `<button class="ver-link" type="button" data-version="${esc(newer.id)}">open the current one</button>.`
      : `This version is final. <b>Amend</b> writes the next one and leaves this exactly as it is.`;
  }

  $("[data-final]").textContent = a.status === "final" ? "Amend" : "Mark final";
  $("[data-final]").disabled = !!newer;
  $("[data-free]").readOnly = readOnly;
}

function paint(a) {
  current = a;
  $("[data-blank]").hidden = true;
  $("[data-sheet]").hidden = false;

  $("[data-kind]").textContent =
    a.ref + (a.amendsRef ? ` · amends ${a.amendsRef}` : "") +
    (a.status === "final" ? " · final" : " · draft");
  $("[data-who]").textContent = a.personName || "—";
  $("[data-meta]").textContent =
    (a.kind === "follow_up" ? "Follow-up" : "First visit") + " · " +
    new Date(a.startedAt).toLocaleString("en-GB", {
      weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    });
  $("[data-free]").value = a.notes || "";

  /* The bar carries who and which version, because once she has
     scrolled into section nine the top of the page is long gone and
     "whose record am I typing into" is not a question worth having. */
  $("[data-bar-who]").textContent = `${a.personName} · ${a.ref}`;
  // Actions belong to an open record, so they arrive with one.
  $("[data-acts]").hidden = false;

  renderVersions(a);
  renderSections();
  markSaved();
}

/* ---- saving --------------------------------------------------- */
function markSaving() {
  const el = $("[data-saved]");
  el.dataset.state = "saving";
  el.textContent = "Saving…";
}

function markSaved(text) {
  const el = $("[data-saved]");
  el.dataset.state = "saved";
  el.textContent = text || "Saved";
}

function touch() {
  markSaving();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api.saveAssessment(current.id, {
        values: current.values,
        openSections: current.openSections,
        notes: current.notes,
      });
      markSaved();
      paintCalcs();
    } catch (err) {
      /* Said plainly rather than swallowed. A clinical note that
         silently failed to save is the worst thing this page can do. */
      markSaved("Not saved — " + (err.message || "try again"));
      $("[data-saved]").dataset.state = "failed";
    }
  }, 400);
}

/* ---- the client list ------------------------------------------ */
function renderList() {
  const q = ($("[data-find]").value || "").trim().toLowerCase();
  const shown = people.filter((p) => !q || (p.name + " " + p.email).toLowerCase().includes(q));

  $("[data-list]").innerHTML = shown.length
    ? shown.map((p) => `
        <button class="row" type="button" data-person="${esc(p.id)}"
                aria-current="${current?.personId === p.id}">
          <span class="who">${esc(p.name)}</span>
          <span class="sub">${esc(p.email)}</span>
        </button>`).join("")
    : `<p class="empty">Nobody matches that.</p>`;
}

async function openFor(personId) {
  markSaving();
  const opened = await api.openAssessment({ personId });
  const all = await api.assessments(personId);
  chain = all.assessments || [];
  paint(chain.find((a) => a.id === opened.assessment.id) || opened.assessment);
  renderList();
}

/* ---- export ---------------------------------------------------- */
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function exportCSV() {
  const rows = [...chain].reverse();
  if (!rows.length) return;

  const keys = [];
  for (const a of rows) for (const k of Object.keys(a.values || {})) if (!keys.includes(k)) keys.push(k);

  const lines = [["reference", "date", "kind", "status", ...keys, "notes"].map(csvCell).join(",")];
  for (const a of rows) {
    lines.push([
      a.ref, a.startedAt.slice(0, 10), a.kind, a.status,
      ...keys.map((k) => a.values?.[k] ?? ""), a.notes || "",
    ].map(csvCell).join(","));
  }

  // A BOM, so Excel opens UTF-8 rather than mangling every accent.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `assessments-${(current?.personName || "client").replace(/\W+/g, "-").toLowerCase()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---- wiring ---------------------------------------------------- */
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-find]")) return renderList();
  if (!current || document.body.dataset.readonly === "true") return;

  const field = e.target.closest("[data-field]");
  if (field) {
    current.values = { ...current.values, [field.dataset.field]: field.value };
    return touch();
  }
  if (e.target.matches("[data-free]")) {
    current.notes = e.target.value;
    return touch();
  }
});

/* ---- the client list, as a panel on a narrow screen ------------
   Below 860px the two-column layout has nowhere to put a sidebar,
   so it becomes something she opens. Above it, the button is not
   rendered at all and the list is simply there. */
function wireClients() {
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
    const open = panel.dataset.open !== "true";
    if (open) {
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

  // Choosing somebody is the reason it was open.
  panel.addEventListener("click", (e) => { if (e.target.closest("[data-person]")) shut(); });
}

document.addEventListener("click", async (e) => {
  const version = e.target.closest("[data-version]");
  if (version) {
    const want = chain.find((a) => a.id === version.dataset.version);
    if (want) return paint(want);
  }

  const person = e.target.closest("[data-person]");
  if (person) return openFor(person.dataset.person);

  const toggle = e.target.closest("[data-toggle]");
  if (toggle && current) {
    const sec = $(`[data-sec="${toggle.dataset.toggle}"]`);
    const open = sec.dataset.open !== "true";
    sec.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    current.openSections = $$("[data-sec]")
      .filter((s) => s.dataset.open === "true")
      .map((s) => s.dataset.sec);
    if (document.body.dataset.readonly !== "true") touch();
    return;
  }

  if (e.target.closest("[data-export]")) return exportCSV();
  if (e.target.closest("[data-print]")) return print();

  const finalBtn = e.target.closest("[data-final]");
  if (finalBtn && current) {
    finalBtn.disabled = true;
    try {
      if (current.status === "final") {
        /* NOT A REOPEN. The finalised version stays exactly as it is
           and this opens its successor. */
        const out = await api.amendAssessment(current.id);
        const all = await api.assessments(current.personId);
        chain = all.assessments || [];
        return paint(chain.find((a) => a.id === out.assessment.id) || out.assessment);
      }
      await api.finaliseAssessment(current.id);
      const all = await api.assessments(current.personId);
      chain = all.assessments || [];
      return paint(chain.find((a) => a.id === current.id) || current);
    } catch (err) {
      markSaved(err.message || "That did not work");
      $("[data-saved]").dataset.state = "failed";
      finalBtn.disabled = false;
    }
  }
});

/* ---- boot ------------------------------------------------------ */
start("assessment", api.people, (data) => {
  people = data.people || [];
  renderList();
  wireClients();

  /* The sheet's head sticks beneath the bar, so it needs the bar's
     real height rather than a number in the stylesheet that is
     wrong the moment the font or the viewport changes. */
  const bar = document.querySelector(".work-bar");
  if (bar) {
    const set = () =>
      document.documentElement.style.setProperty("--work-bar-h", `${bar.offsetHeight}px`);
    set();
    if ("ResizeObserver" in window) new ResizeObserver(set).observe(bar);
    else addEventListener("resize", set);
  }

  // Deep link: /assessment.html?person=<id>, from a person's row.
  const want = new URLSearchParams(location.search).get("person");
  if (want && people.some((p) => p.id === want)) openFor(want);
});
