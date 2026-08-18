/* ============================================================
   PLAN AI — reading her plan into rows
   ------------------------------------------------------------
   A SEPARATE ACCESS POINT FROM THE FRONT DESK, and the separation
   is the point rather than tidiness. The desk answers strangers
   about opening hours over ai-client.js and services/py-ai. This
   reads a named client's nutrition plan. Sharing one client
   between them means a single misrouted call sends a clinical
   document down a path built for public questions — and nobody
   catches that in review a year later, because by then it looks
   like sensible reuse.

   So: its own module, its own key, its own model setting, its own
   prompt, its own log prefix, its own timeout. Nothing in here is
   imported by the desk and nothing in the desk is imported here.

   IT PROPOSES AND NOTHING ELSE. This module returns candidate rows
   and never writes one. Confirming is a separate route, driven by
   a human, and the schema refuses a confirmed row that has nobody
   attached to it. If this file were the last word on what a client
   is told to eat, the whole design would be wrong.

   OFF BY DEFAULT. No key means no calls — the same rule as the
   mail outbox and the WhatsApp manual provider. A half-configured
   box must be incapable of sending a clinical note to a third
   party, not merely unlikely to.
   ============================================================ */
"use strict";

const { recover, VERSION: RECOVER_VERSION } = require("./recover");
const budget = require("../rules/budget");

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/* Its own key first. Falling back to the desk's is allowed, because
   one practice on one Groq account is the realistic case — but it
   is announced at boot rather than assumed, so "these are separate"
   never quietly stops being true. */
const KEY = (process.env.GROQ_PLAN_API_KEY || process.env.GROQ_API_KEY || "").trim();
const SHARED = !process.env.GROQ_PLAN_API_KEY && !!process.env.GROQ_API_KEY;

/* ITS OWN MODEL, AND NOT THE DESK'S.

   The front desk answers strangers in prose and wants a big
   conversational model. This does one narrow, mechanical job —
   turn a dietitian's sentences into rows of JSON — and an
   open-weight 20B is the right size for it: cheaper per call,
   faster to come back, and measurably good at extraction, which
   is the only thing being asked.

   IT DOES NOT FALL BACK TO GROQ_MODEL any more. That fallback
   quietly gave plan work whatever the desk happened to be set to,
   so changing the desk's model changed how clinical text was read
   without anybody deciding to. Set GROQ_PLAN_MODEL to override;
   otherwise it is this, whatever the desk is doing.

   The accuracy panel groups by model name, so switching here does
   not average the new one into the old one's score — it starts a
   fresh row and the two can be compared. */
const MODEL = process.env.GROQ_PLAN_MODEL || "openai/gpt-oss-20b";
const TIMEOUT = Number(process.env.GROQ_PLAN_TIMEOUT_MS) || 20000;

/* Deterministic. This is not a writing task — the same plan read
   twice should give the same rows, and a model inventing variety in
   a clinical reading is a model producing noise. */
const TEMPERATURE = 0;

/* `filler` IS ITS OWN KIND, not a meal with a flag on it.

   What somebody eats when they are hungry at 4pm and the next meal
   is at 7:30 is a different instruction from a meal: it has no
   time, it is conditional, and it is the single most common reason
   a plan falls apart in week two. Giving it a kind means the CRM
   can count it, she can see at a glance whether a plan has any,
   and the client's screen can put it under "if you are hungry"
   rather than pretending it is a fifth meal they missed. */
const KINDS = new Set([
  "meal", "filler", "supplement", "activity", "sleep", "habit", "other",
]);

/* The five ways a supplement sits against food. Anything else the
   model invents is dropped — see clean(). */
const TIMINGS = new Set([
  "empty_stomach", "before_meal", "with_meal", "after_meal", "bedtime",
]);

/* ---- the prompt -------------------------------------------------
   Kept here rather than in a file so it is versioned with the code
   that parses its output. The two are one contract and drifting
   them apart is how a schema change silently starts producing
   rows nobody validates. */
const SYSTEM = `You convert a dietitian's care plan into structured rows.

You are READING, not advising. Never add an instruction she did not
write. Never correct, improve, complete or expand anything. If a line
is vague, keep it vague — she will have meant it.

Return JSON only, shaped:
{"items":[{"line":0,"kind":"meal","label":"...","quantity":2,"unit":"eggs","schedule":"daily"}]}

Rules:
- "line" is the zero-based index of the line of her plan the row came from.
- "kind" is one of: meal, supplement, activity, sleep, habit, other.
- "label" is what to do, in HER words, shortened only by removing filler.
- "quantity" is a number or null. Never guess one. "a bowl" has no number.
- "unit" is a short word or "". "g", "ml", "eggs", "minutes", "steps".
- "schedule" is when, in her words: "daily", "five days a week",
  "after dinner", "weekly", or "" if she did not say.
- One row per instruction. A line with two instructions makes two rows.
- A heading, a greeting or a comment is not an instruction. Skip it.
- If the plan contains no instructions, return {"items":[]}.

PUNCTUATION IS A HINT, NOT A REQUIREMENT.
A dash at the start of a line, a colon after the occasion and
brackets around detail all make a line easier to read. Most plans
will not have them. She is writing for a person, not for you, so a
line with none of that is normal and must be read just as well.

- Do not require a leading dash to treat a line as an instruction.
- Do not require a colon to find the occasion. "Breakfast two eggs"
  and "two eggs at breakfast" and "have two eggs first thing" are
  the same row.
- A sentence carrying several instructions makes several rows even
  with no separator: "two eggs and toast before nine then a walk
  after dinner" is a meal and an activity.
- Prose is fine. "She should aim for about fifteen almonds
  mid-morning" is a row; strip "she should aim for" and keep the
  rest.
- Never add punctuation to the label. Return her words.
- If a line genuinely has no instruction in it, still skip it. Poor
  punctuation is not a reason to invent a row, and a heading with no
  colon is still a heading.`;

/* WORKED EXAMPLES, and they are all deliberately unpunctuated. The
   rules above describe the behaviour; these demonstrate it, which is
   what actually moves a model. Passed as a completed exchange rather
   than pasted into the system text so the shape of the answer is
   modelled as well as its content. */
const SHOTS = [
  {
    role: "user",
    content:
      "0: Breakfast two eggs and a slice of toast before nine\n" +
      "1: she should aim for about fifteen almonds mid morning\n" +
      "2: walk for half an hour after dinner every day\n" +
      "3: Notes from the session",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      items: [
        { line: 0, kind: "meal", label: "Two eggs and a slice of toast", quantity: 2, unit: "eggs", schedule: "breakfast, before 9am" },
        { line: 1, kind: "meal", label: "Almonds", quantity: 15, unit: "almonds", schedule: "mid-morning" },
        { line: 2, kind: "activity", label: "Walk", quantity: 30, unit: "minutes", schedule: "after dinner, daily" },
      ],
    }),
  },
  {
    role: "user",
    content:
      "0: one cup rice with dal and a vegetable at lunch half the plate should be the vegetable\n" +
      "1: vitamin D 60000 IU once a week on Sunday as her GP prescribed",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      items: [
        { line: 0, kind: "meal", label: "One cup rice with dal and a vegetable", quantity: 1, unit: "cup", schedule: "lunch" },
        { line: 0, kind: "habit", label: "Half the plate should be the vegetable", quantity: null, unit: "", schedule: "lunch" },
        { line: 1, kind: "supplement", label: "Vitamin D 60,000 IU", quantity: 60000, unit: "IU", schedule: "weekly, Sunday" },
      ],
    }),
  },
];

/** What the console should say at boot, so the mode is never a guess. */
function describe() {
  if (!KEY) return "plan ai: OFF — no key, nothing is sent anywhere";
  return SHARED
    ? `plan ai: groq ${MODEL} — SHARING the front desk's key (set GROQ_PLAN_API_KEY to separate them)`
    : `plan ai: groq ${MODEL} — own key`;
}

/** Numbered lines, so the model can point at one and the panel can
    show its proposal beside the sentence that produced it. */
function numbered(body) {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, i) => `${i}: ${line}`)
    .join("\n");
}

/* ---- what comes back is not trusted ------------------------------
   A model returning JSON is a model that usually returns JSON. Every
   field is checked, clamped and coerced here, because the next stop
   is a clinical table and "it worked in testing" is not a validation
   strategy. */
/* WHITESPACE THE MODEL INVENTED, TURNED BACK INTO SPACES.

   gpt-oss writes "Vitamin D 60 000 IU" with a NARROW NO-BREAK SPACE
   between the thousands and a NON-BREAKING SPACE after "Vitamin",
   which is typographically correct and completely wrong here: the
   string goes into a clinical row, onto the client's app, and back
   through the parser, and none of those three agree about what
   U+202F is. A search for "vitamin d" did not match it.

   plan-punctuation.js already substitutes these away — but it runs
   in the browser on what SHE types, and its own header says it is a
   typing aid rather than a boundary. Model output never went near
   it. This is the boundary. */
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u2028\u2029\t]/g;

/* AND THE DASHES SHE DID NOT TYPE. The same argument as SPACES:
   gpt-oss writes "Protein‑rich" with a NON-BREAKING HYPHEN, which
   looks identical on screen and is a different character to every
   search, every parser and plan-punctuation's own allow-list. The
   CRM folds these for what she types; this folds them for what the
   model writes. */
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;

const flat = (v, max) =>
  String(v ?? "").replace(SPACES, " ").replace(DASHES, "-").replace(/\s{2,}/g, " ").trim().slice(0, max);

function clean(raw, lineCount) {
  if (!raw || !Array.isArray(raw.items)) return [];

  const out = [];
  for (const it of raw.items.slice(0, 60)) {
    if (!it || typeof it !== "object") continue;

    const label = flat(it.label, 300);
    if (!label) continue;

    const kind = KINDS.has(it.kind) ? it.kind : "other";

    /* A line number outside the plan means the model has lost its
       place. Dropped to null rather than clamped — a proposal
       pointing at the wrong sentence is worse than one pointing at
       none, because she would check it against the wrong line. */
    let line = Number.isInteger(it.line) ? it.line : null;
    if (line !== null && (line < 0 || line >= lineCount)) line = null;

    let quantity = null;
    if (it.quantity !== null && it.quantity !== undefined && it.quantity !== "") {
      const n = Number(it.quantity);
      if (Number.isFinite(n) && n >= 0 && n < 1e6) quantity = n;
    }

    /* ---- how it is actually taken --------------------------------
       Four fields that turn a list of foods into an instruction
       somebody can follow. All optional, all clamped, and all
       dropped rather than guessed when the model leaves them out.

       `household` is the measure in a kitchen — "one katori" beside
       the 150 g. `how` is the intake instruction — "with the lemon,
       never with tea". `timing` is when a supplement is taken
       relative to food, as one of five words. `gapMinutes` is how
       far it must sit from the thing before it.

       THE ENUM IS CHECKED AGAINST A LIST, not trusted. A model
       returning "post-meal" instead of "after_meal" would otherwise
       put a value in a jsonb column that no screen has a case for,
       and it would render as nothing at all. */
    const household = flat(it.household, 40);
    const how = flat(it.how, 200);
    const timing = TIMINGS.has(it.timing) ? it.timing : "";

    let gapMinutes = null;
    if (it.gapMinutes != null && it.gapMinutes !== "") {
      const g = Number(it.gapMinutes);
      // Ten minutes to twelve hours. Anything outside that is a
      // misreading, and a misread gap on an iron tablet matters.
      if (Number.isFinite(g) && g >= 5 && g <= 720) gapMinutes = Math.round(g);
    }

    /* Sets and reps, for the movement rows. Bounded at numbers a
       human body does — 40 sets is a parse error, not a workout. */
    const num = (v, max) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n) : null;
    };
    const sets = num(it.sets, 20);
    const reps = flat(it.reps, 20); // "8-12" is a rep range, not a number
    const restSeconds = num(it.restSeconds, 600);

    out.push({
      line,
      kind,
      label,
      quantity,
      /* Through the same normaliser as the label. A schedule of
         "weekly,<U+00A0>Sunday" is one the parser cannot split back
         out, and a unit is printed straight onto the client's row. */
      unit: flat(it.unit, 24),
      schedule: flat(it.schedule, 80),
      household,
      how,
      timing,
      gapMinutes,
      sets,
      reps,
      restSeconds,
    });
  }
  return out;
}

/**
 * Read a plan's text into candidate rows.
 *
 * @param {string} body  the plan, exactly as she wrote it
 * @returns {Promise<{ok:boolean, items?:object[], model?:string, why?:string}>}
 */
async function propose(body) {
  if (!KEY) return { ok: false, why: "the assistant is switched off" };

  const text = String(body || "").trim();
  if (!text) return { ok: true, items: [], model: MODEL };
  if (text.length > 20000) return { ok: false, why: "that plan is too long to read" };

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const lineCount = lines.length;

  /* ============================================================
     ONE RETRY, AND ONLY FOR THE FAILURE THAT DESERVES IT
     ------------------------------------------------------------
     gpt-oss occasionally answers a strict-JSON request with
     nothing at all: Groq returns 400 json_validate_failed and an
     empty `failed_generation`. It is the model spending its
     completion budget on reasoning and never getting to the
     answer — reasoning_effort and max_completion_tokens below
     make it rare, and rare is not never.

     From her side that arrives as "the assistant refused", on a
     button she is allowed to press three times, having spent one
     of them on a shrug. So the same request goes again once.

     NOTHING ELSE IS RETRIED. A 401 is a wrong key and will be
     wrong twice; a 429 is a rate limit and hammering it is the
     worst possible response; a timeout has already cost her the
     wait. Only the failure that is known to be transient. */
  const res = await askJSON([
    { role: "system", content: SYSTEM },
    ...SHOTS,
    { role: "user", content: numbered(text) },
  ]);

  return finish(res, lines, lineCount);
}

/** One attempt at any JSON-only completion. Null when the network
    refused to carry it. */
async function askOnce(messages, temperature = TEMPERATURE) {
  try {
    return await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        response_format: { type: "json_object" },

        /* ---- TWO KNOBS THAT ARE NOT TUNING ----------------------
           gpt-oss reasons before it answers, and the reasoning comes
           out of the same completion budget as the JSON. With the
           full prompt below — a long system message and two worked
           examples — it spent the budget thinking and returned
           NOTHING: Groq answered 400 json_validate_failed with an
           empty `failed_generation`, about two attempts in three.
           A shorter prompt passed six times out of six, which is
           what identified the cause.

           So: think less, and have room to write. Neither is a
           quality trade here — extracting rows from a sentence is
           not a problem that needs deliberation, and the answer is
           a few hundred tokens of JSON. */
        reasoning_effort: "low",
        max_completion_tokens: 8192,

        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    console.warn(`[plan-ai] unreachable: ${err.message}`);
    return null;
  }
}

/* ONE RETRY, AND ONLY FOR THE FAILURE THAT DESERVES IT — the long
   note above propose() sets out why. Lifted out of propose so the
   other job in this folder gets the same treatment: writing a first
   draft from an assessment is a bigger prompt and therefore MORE
   likely to spend its budget reasoning, not less. */
async function askJSON(messages, temperature = TEMPERATURE) {
  /* HER OWN CEILING, and it is a different one from the desk's.
     If they shared a pot, somebody hammering the public front desk
     could exhaust it and stop her issuing a plan to a client
     sitting in front of her. A public surface must never be able
     to starve a private one. */
  if (!budget.spend("plan").ok) return null;

  let res = await askOnce(messages, temperature);
  if (res && res.status === 400) {
    const peek = await res.clone().text().catch(() => "");
    if (/json_validate_failed/.test(peek)) {
      console.warn("[plan-ai] empty generation — asking once more");
      res = await askOnce(messages, temperature);
    }
  }
  return res;
}

/** What came back, turned into rows — or an honest refusal. */
async function finish(res, lines, lineCount) {
  if (!res) return { ok: false, why: "the assistant did not answer" };

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn(`[plan-ai] ${res.status}: ${detail.slice(0, 200)}`);
    return { ok: false, why: `the assistant refused (${res.status})` };
  }

  let parsed;
  try {
    const data = await res.json();
    parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return { ok: false, why: "the assistant did not answer in a readable form" };
  }

  const read = clean(parsed, lineCount);

  /* THE GAPS, FILLED FROM HER OWN WORDS. The model is good at
     finding the instructions and less reliable at pulling a number
     or a time out of prose that has no colon in it — so what it
     leaves empty is looked for again, deterministically, in the
     text it was reading. It fills blanks only and invents nothing;
     see recover.js.

     The model string carries the recovery version, so the accuracy
     figure on the plan page compares like with like rather than
     silently crediting the model for this pass. */
  const { items, filled } = recover(read, lines);

  console.log(
    `[plan-ai] read ${lineCount} lines into ${items.length} row(s)` +
    (filled ? `, filled gaps in ${filled}` : "")
  );
  return { ok: true, items, model: `${MODEL}+${RECOVER_VERSION}` };
}

/* Shared with from-assessment.js, which does the OTHER job in this
   folder. Exported rather than copied because `clean` is the
   validation boundary between a model's JSON and a clinical table —
   two copies of that is one copy that stops being updated. */
module.exports = { propose, describe, MODEL, KEY, clean, askJSON };
