/* ============================================================
   ASSESSMENTS — the CRM's half of the clinical record
   ------------------------------------------------------------
   Thin on purpose. Go owns the versioning, the amend-forward
   rule and the split between narrative and trend; this moves
   strings and attaches the name of whoever is signed in.

   ONE THING IT DOES DECIDE: what the page is handed. The form
   works in fields, and the record is stored as a narrative
   document plus a set of measurements — so the measurements are
   folded back into field shape here, in one place, rather than
   in the browser where a second copy of that rule would drift.
   ============================================================ */
"use strict";

const data = require("../data-client");

const ok = (body) => ({ status: 200, body });

const unavailable = {
  status: 503,
  body: { error: "data_unavailable", message: "The data service is not answering." },
};

const pass = (out) =>
  out
    ? out.ok
      ? null
      : { status: out.status || 400, body: { error: out.error, message: out.message } }
    : unavailable;

/** Measurements back into the flat shape the form edits.
 *
 *  The database keeps a weight as a row so it can be drawn as a
 *  curve; the form wants `weight_kg` in a box. Folding them back
 *  together here means the page never learns that distinction and
 *  cannot get it wrong. */
function flatten(a) {
  if (!a) return a;
  const values = { ...(a.answers || {}) };
  for (const m of a.measurements || []) {
    if (m.kind === "body") values[m.metric] = String(m.value);
  }
  return { ...a, values };
}

async function list(personId) {
  const out = await data.crm.assessments({ personId });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ assessments: (out.assessments || []).map(flatten) });
}

async function one(id) {
  const out = await data.crm.assessment(id);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ assessment: flatten(out.assessment) });
}

/** Open her current draft for this person, or start the next visit.
    Idempotent in Go, so a double click is harmless. */
async function open(body, who) {
  const out = await data.crm.assessmentOpen({
    personId: body?.personId,
    consultationId: body?.consultationId || null,
    by: who || "unknown",
  });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ assessment: flatten(out.assessment), opened: out.opened });
}

async function save(id, body) {
  const out = await data.crm.assessmentSave(id, {
    answers: body?.values && typeof body.values === "object" ? body.values : {},
    openSections: Array.isArray(body?.openSections) ? body.openSections : [],
    notes: typeof body?.notes === "string" ? body.notes : "",
  });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

async function final(id) {
  const out = await data.crm.assessmentFinal(id);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

/** The only way to change a finalised version: write the next one. */
async function amend(id, who) {
  const out = await data.crm.assessmentAmend(id, { by: who || "unknown" });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ assessment: flatten(out.assessment) });
}

module.exports = { list, one, open, save, final, amend };
