/* ============================================================
   THE BOOKING FORM — everything at once, checked at once
   ------------------------------------------------------------
   The desk used to collect the booking one question at a time.
   That reads well and it has two problems that showed up in use:
   the review card never appeared for the person who reported it,
   and a visitor six answers deep has no idea how many are left.

   So the details are a FORM now. The desk still talks — it greets,
   answers questions, offers times, and says what it needs — but
   when somebody wants to book, they get all the fields together,
   see the whole ask, and fill it in any order they like.

   WHAT DOES NOT CHANGE: the same validators. Every value that
   arrives here goes through rules/validate.js, exactly as it did
   when it was typed into the chat. A form is a different way of
   asking, not a different standard of checking.

   The draft lives on the SESSION, server-side, which is what makes
   item 11 nearly free: a killed tab, a reload, a crash — the
   answers were never in the page to begin with.
   ============================================================ */
"use strict";

const v = require("./rules/validate");
const { config } = require("./config");

const P = config.practice;

/* Which fields the form shows, in the order it shows them.

   The order is the conversational one and not the database one:
   name, then what they came for, then how to reach them, then the
   details she needs to prepare. Asking for an email address first
   reads like a lead-capture form, which is what this is not. */
const FIELDS = [
  { id: "name", label: "Your name", type: "text", required: true, autocomplete: "name" },
  {
    id: "focusArea",
    label: "What would you like help with?",
    type: "choice",
    required: true,
    options: () => v.FOCUS_AREAS.map((f) => ({ value: f.label, label: f.label })),
  },
  { id: "email", label: "Email", type: "email", required: true, autocomplete: "email" },
  {
    /* A calendar, not a text box.

       The parser handles "12 March 1990", "12/03/1990" and four other
       shapes, and it still had to guess between 03/12 and 12/03 — a
       guess that silently ages somebody by nine months. A date picker
       cannot be ambiguous and cannot be mistyped, so the parsing
       stops being a judgement call. */
    id: "dob",
    label: "Date of birth",
    type: "date",
    required: true,
    hint: "She uses it to set your nutritional requirements — they differ quite a bit by age.",
  },
  // Rendered by CountryPicker, not as a text box. The whole point of
  // item 2 is that this value is chosen, never spelled.
  { id: "country", label: "Country", type: "country", required: true },
  {
    id: "mode",
    label: "How would you like to meet?",
    type: "choice",
    required: false,
    options: () => v.MODES.map((m) => ({ value: m.label, label: m.label })),
  },
  {
    /* A DIALLING CODE BESIDE THE BOX, not inferred from the country.

       This was a plain tel input, and the numbers it collected are
       not reliably sendable: "8850545140" is a complete Indian
       mobile, but it was filed against a person living in Saudi
       Arabia, so nothing downstream can tell whose number it is.
       Three of the first eight people on file are unusable that way.

       The country field means WHERE SOMEBODY LIVES. For this
       practice — Indian families across the Gulf and the UK — that
       is routinely not where their phone is registered, so deriving
       one from the other is wrong for exactly the clients it would
       be used on most. The only fix is to ask, which costs one tap
       because it is pre-filled from their country and usually right.

       The value arrives as `phoneDial` alongside `phone`, and the
       two are combined below into one E.164 number. */
    id: "phone",
    label: "Phone number",
    type: "phone",
    required: false,
    hint: "Optional. It gives her a quicker way to reach you — most people use WhatsApp.",
  },
  {
    id: "notes",
    label: "Anything else she should know?",
    type: "textarea",
    required: false,
  },
];

/**
 * The form as the client should draw it, with whatever the visitor
 * has already given filled in.
 *
 * Offered slots come from the same engine the chat uses, so the form
 * cannot show a time the desk would refuse.
 */
function spec(s, offers) {
  const d = s.draft || {};
  return {
    title: "Book a consultation",
    // Said plainly on the form itself: she confirms, not the visitor.
    note: `${P.consultationMins || 60} minutes. She confirms every booking herself — you will get an email once she has.`,
    fields: FIELDS.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: !!f.required,
      hint: f.hint || null,
      placeholder: f.placeholder || null,
      autocomplete: f.autocomplete || null,
      options: f.options ? f.options() : null,
      value: valueFor(d, f.id),
    })),
    /* A slot is identified by the instant it starts. Not an invented
       id — that instant IS its identity, and it is exactly what the
       partial unique index keys on when the booking is written. Two
       names for one thing would be one too many. */
    slots: (offers || []).map((o) => ({ id: o.startAt, label: o.label })),
    chosenSlot: d.chosenSlot?.startAt || null,
  };
}

function valueFor(d, id) {
  if (id === "mode") return d.modeLabel || "";
  return d[id] || "";
}

/**
 * Check a whole form at once.
 *
 * Returns EVERY error, not the first. A form that reveals one
 * problem per submit is the same interrogation the form replaced,
 * with worse manners.
 *
 * @returns {{ok: boolean, errors: Object<string,string>, values: Object}}
 */
function check(values) {
  const raw = values && typeof values === "object" ? values : {};
  const errors = {};
  const out = {};

  const run = (id, fn, required) => {
    const given = String(raw[id] ?? "").trim();
    if (!given) {
      if (required) errors[id] = "This one is needed.";
      return;
    }
    const r = id === "dob" ? fn(given, new Date()) : fn(given);
    if (r.ok) out[id] = r.value;
    else errors[id] = r.message;
    // The country check also yields the ISO-2 code, which is the
    // value the database actually wants.
    if (r.ok && r.iso2) out.countryIso2 = r.iso2;
    if (r.ok && r.id) out[id + "Id"] = r.id;
    if (r.ok && r.label) out[id + "Label"] = r.label;
  };

  run("name", v.name, true);
  run("focusArea", v.focusArea, true);
  run("email", v.email, true);
  run("dob", v.dob, true);
  run("country", v.country, true);
  run("mode", v.mode, false);

  /* PHONE IS THE ONE FIELD ASSEMBLED FROM TWO CONTROLS. The code and
     the number are separate on screen because they are separately
     known — she picks one, types the other — and a single value here
     because everything downstream wants one number.

     Stored in E.164 with the +, which is the form that needs no
     country to interpret it later. Every number collected this way
     is sendable on WhatsApp without a guess. */
  const dial = String(raw.phoneDial ?? "").trim();
  const typed = String(raw.phone ?? "").trim();
  if (typed) {
    const national = typed.replace(/\D/g, "").replace(/^0+/, "");
    const joined = dial && !typed.startsWith("+") ? `${dial}${national}` : typed;
    const r = v.phone(joined, dial || undefined);
    if (r.ok) out.phone = r.value;
    else errors.phone = r.message;
  }

  run("notes", v.notes, false);

  return { ok: Object.keys(errors).length === 0, errors, values: out };
}

module.exports = { spec, check, FIELDS };
