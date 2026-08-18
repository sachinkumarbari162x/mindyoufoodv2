/* ============================================================
   THE NSF, AS MARKUP AND ARITHMETIC
   ------------------------------------------------------------
   form-spec.js says WHAT is asked. This says what each answer
   looks like on a screen and what can be worked out from the
   ones already given. Both places she fills this form — the
   assessment page at her desk and the panel beside a call — mount
   these same functions.

   THE REASON IT IS A MODULE AND NOT COPIED. Two renderers of one
   clinical form do not stay the same. Somebody widens a textarea
   in one of them, or fixes the BMI banding in one of them, and
   for a while the record she typed during a consultation and the
   record she typed at her desk are different records. The layout
   differs between the two — a 27rem panel cannot use the desk's
   two-column grid — but that is a stylesheet's job, and CSS is
   where it stays.

   NOTHING HERE TOUCHES THE NETWORK OR THE DOM'S STATE. It takes
   values and returns strings, or reads a root and paints the
   derived boxes. Saving, versioning and what a draft is all
   belong to whoever mounted it.
   ============================================================ */

import { SECTIONS, OPEN_BY_DEFAULT } from "./form-spec.js";
import { esc } from "./format.js";

/* Identity, never data. Typing over these inside a clinical note
   would detach the record from the person it belongs to — and for
   the phone, would change only this row while every message kept
   going to the old number. */
export const LOCKED = ["name", "email", "phone"];

export const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/* ---- what is derived, and never stored ------------------------
   Every one of these is arithmetic on answers that are already in
   the record. Storing them would mean a BMI that disagrees with
   the weight above it the moment somebody corrects the weight. */
export function derive(v, previousValues) {
  const out = {};

  const dob = v.dob && new Date(v.dob);
  const age = dob && !Number.isNaN(dob.getTime())
    ? Math.floor((Date.now() - dob.getTime()) / (365.2425 * 24 * 3600e3))
    : null;
  if (age !== null) out.age = age + " years";

  const w = num(v.weight_kg), h = num(v.height_cm);
  if (w && h) {
    const m = h / 100;
    const bmi = w / (m * m);
    /* Asian-Pacific cut-offs rather than the WHO default — the
       practice is in India and the thresholds genuinely differ. The
       basis is the judgement; the number is arithmetic. */
    const band = bmi < 18.5 ? "underweight" : bmi < 23 ? "healthy" : bmi < 25 ? "overweight" : "obese";
    out.bmi = bmi.toFixed(1) + " · " + band + " (Asian-Pacific)";
  }

  const waist = num(v.waist_cm), hip = num(v.hip_cm);
  if (waist && hip) out.whr = (waist / hip).toFixed(2);

  const before = previousValues && num(previousValues.weight_kg);
  if (w && before) {
    const d = w - before, pct = (d / before) * 100;
    out.weight_change = (d >= 0 ? "+" : "") + d.toFixed(1) + " kg · " +
      (d >= 0 ? "+" : "") + pct.toFixed(1) + "%";
  }

  if (w && h && age && (v.sex === "Female" || v.sex === "Male")) {
    const bmr = 10 * w + 6.25 * h - 5 * age + (v.sex === "Male" ? 5 : -161);
    out.bmr = Math.round(bmr) + " kcal";
    const factor = num(v.activity_factor);
    if (factor) out.energy_kcal = Math.round(bmr * factor) + " kcal";
  }
  return out;
}

/* ---- one answer ------------------------------------------------ */

export function fieldHTML(f, value, wasChanged) {
  const id = "f-" + f.id;
  const wide = f.wide || f.type === "long" ? " wide" : "";
  const label = esc(f.label) + (f.unit ? ` <span class="unit">(${esc(f.unit)})</span>` : "");
  let control;

  if (f.type === "calc") {
    control = `<div class="calc" data-calc="${f.id}" data-empty="true">—</div>`;
  } else if (f.type === "choice") {
    control = `<select id="${id}" data-field="${f.id}">` +
      (f.options || []).map((o) =>
        `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o || "—")}</option>`
      ).join("") + `</select>`;
  } else if (f.type === "long") {
    control = `<textarea id="${id}" data-field="${f.id}" rows="${f.rows || 2}">${esc(value || "")}</textarea>`;
  } else if (f.type === "scale") {
    control = `<input id="${id}" type="range" min="1" max="10" step="1" data-field="${f.id}" value="${esc(value || 5)}" />`;
  } else {
    const t = ["date", "email", "tel", "number"].includes(f.type) ? f.type : "text";
    control = `<input id="${id}" type="${t}" data-field="${f.id}" value="${esc(value || "")}"` +
      (f.step ? ` step="${f.step}"` : "") +
      (LOCKED.includes(f.id) ? ' readonly aria-readonly="true"' : "") + ` />`;
  }

  return `
    <div class="fld${wide}"${wasChanged ? ' data-changed="true"' : ""}>
      <label for="${id}">${label}</label>
      ${control}
      ${wasChanged ? `<span class="changed">changed in this amendment</span>` : ""}
      ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}
    </div>`;
}

/* ---- the whole form -------------------------------------------
   `open` is the list of section ids that should start expanded.
   Falling back to OPEN_BY_DEFAULT rather than to "all" is the one
   decision that makes this form usable while somebody is talking:
   twelve open sections is a form nobody fills. */
export function sectionsHTML(values, changed = new Set(), open = null) {
  const v = values || {};
  const shown = open?.length ? open : OPEN_BY_DEFAULT;

  return SECTIONS.filter((s) => s.fields).map((sec) => {
    const isOpen = shown.includes(sec.id);
    return `
      <section class="sec" data-sec="${sec.id}" data-open="${isOpen}">
        <button class="sec-head" type="button" data-toggle="${sec.id}" aria-expanded="${isOpen}">
          <span class="sec-n">${sec.n}</span>
          <span class="sec-title">${esc(sec.title)}</span>
          <span class="sec-when" data-when="${sec.when}">${sec.when === "now" ? "during" : "after"}</span>
          <span class="sec-caret">▶</span>
        </button>
        <div class="sec-body">
          ${sec.note ? `<p class="sec-note">${esc(sec.note)}</p>` : ""}
          <div class="fields">
            ${sec.fields.map((f) => fieldHTML(f, v[f.id], changed.has(f.id))).join("")}
          </div>
        </div>
      </section>`;
  }).join("");
}

/** Repaint the derived boxes inside `root` from the current answers.
    Called after every save rather than on every keystroke — a BMI
    that flickers as she types the second digit of a weight is worse
    than one that settles a moment later. */
export function paintCalcs(root, values, previousValues) {
  const got = derive(values || {}, previousValues);
  for (const el of root.querySelectorAll("[data-calc]")) {
    const val = got[el.dataset.calc];
    el.textContent = val || "—";
    el.dataset.empty = val ? "false" : "true";
  }
}
