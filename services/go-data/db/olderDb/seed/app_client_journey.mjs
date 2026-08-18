/* ============================================================
   ONE CLIENT, THE WHOLE WAY THROUGH, ENDING IN THE APP
   ------------------------------------------------------------
   The other seeds paint a practice. This makes a single person to
   develop /me/ against, and takes them along every step that has
   to have happened before that screen can exist:

     registered -> booked -> confirmed -> seen
     -> plan written -> rows built -> issued -> plan link minted
     -> programme started -> two weeks of use

   WHY THE WHOLE WAY AND NOT A SHORTCUT. A programme with no plan
   behind it, or a plan with no consultation, is a row that could
   not exist in real use — and a screen built against impossible
   data is a screen that breaks the first time it meets the real
   thing. Every step that CAN go through the API does, so the
   constraints that would have refused a shortcut get their say.

   IT PRINTS THE LINK AND WRITES IT DOWN. The programme token is
   returned once and never listed again in the CRM; that is right
   for a client's credential and inconvenient for development, so
   this puts it in var/app-client.txt.

   THE LINK IS RECOVERABLE, worth knowing before anybody panics:
   starting a programme is mint-or-return, so running this again —
   or calling POST /crm/plans/{id}/programme — hands back the same
   token rather than a new one.

     node services/go-data/db/seed/app_client_journey.mjs
   ============================================================ */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..");

const DATA = "http://127.0.0.1:5504";
const SITE = process.env.PUBLIC_BASE_URL || "http://localhost:5501";
const BY = "khadija@mindyourfood.co.in";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(DATA + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const iso = (d) => d.toISOString().slice(0, 10);
const step = (n, s) => console.log(`\n${n}  ${s}\n   ${"-".repeat(s.length)}`);

/* ---- the two things the API is right to refuse ----------------
   A consultation for a person who ALREADY exists — /crm/consultations
   is the chatbot's booking path and writes both in one transaction,
   assigning its own ids — and check-ins dated before today, because
   a client may only fill in today and that rule is the feature.

   Both go to psql, and nothing else does. */
const env = {};
for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const PSQL = process.env.PSQL || String.raw`C:\Program Files\PostgreSQL\15\bin\psql.exe`;

/** Run SQL, and STOP on the first error. Without ON_ERROR_STOP psql
    reports a failed statement and carries on — so a broken insert
    here surfaces as a confusing 500 three steps later, which is
    exactly how a missing consultation presented the first time. */
const sql = (text) =>
  execFileSync(PSQL, ["-d", env.DATABASE_URL, "-q", "-v", "ON_ERROR_STOP=1", "-c", text],
    { stdio: ["ignore", "ignore", "inherit"] });

/* ---- who ------------------------------------------------------ */

const EMAIL = "sofia.dsouza@example.com";
const NAME = "Sofia D'Souza";

/* The consultation keeps a fixed id so a re-run replaces it rather
   than filling the diary with duplicates. The person needs none —
   her email is the identity there, so the upsert finds her. */
const CONSULT = "c1000000-0000-4000-8000-0000000000f1";

/* Thirteen days in, ninety long. Far enough that the calendar has
   something in it and the month has turned; early enough that most
   of the plan is still ahead, which is the state the app is
   actually used in. */
const DAYS_IN = 13;
const LENGTH = 90;

/* EVERY KIND, because the app draws them differently: meals carry
   a camera, activity and sleep do not, a habit has no amount. A
   demo client with four meals leaves three code paths untested by
   anybody looking at the screen. */
const ROWS = [
  ["meal", "Two idlis with sambar", 2, "idlis", "breakfast, before 9am"],
  ["meal", "A boiled egg and a fruit", 1, "egg", "mid-morning"],
  ["meal", "One cup rice, dal and a vegetable", 1, "cup", "lunch"],
  ["meal", "Buttermilk instead of tea", 1, "glass", "4pm"],
  ["meal", "Two chapatis with sabzi and salad", 2, "chapatis", "dinner, by 8pm"],
  ["supplement", "Vitamin D 60,000 IU", 60000, "IU", "weekly, Sunday"],
  ["activity", "Walk", 30, "minutes", "after dinner, daily"],
  ["habit", "Water", 2.5, "l", "through the day"],
  ["sleep", "Bed by 11pm", 7, "hours", "nightly"],
];

const PLAN_BODY = ROWS.map(([, label, qty, unit, when]) => {
  let l = `- ${label}`;
  const amount = [qty ?? "", unit].filter((x) => x !== "" && x !== null).join(" ").trim();
  const has = (s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(l);
  if (amount && !has(amount)) l += ` (${amount})`;
  if (when && !has(when)) l += `, ${when}`;
  return l;
}).join("\n") + "\n\nCome back in six weeks and bring the last month of readings.";

/* ---- 1 · she exists -------------------------------------------- */

step("1", "The person");

/* THE ID COMES BACK FROM THE REGISTER, it is not sent to it.
   upsertPerson assigns its own and keys on the email, so running
   this twice updates one Sofia rather than making a second. And
   /crm/people/exists answers with a boolean and nothing else — it
   is reachable from the booking form and must never become a way
   to turn an email address into a database key. */
const registered = await call("/crm/people", {
  method: "POST",
  body: {
    name: NAME, email: EMAIL, phone: "+919833077701",
    dob: "1991-06-18", country: "IN", source: "chatbot",
  },
});
const person = registered.personId;
if (!person) throw new Error("no person id came back from /crm/people");
console.log(`   ${NAME} · ${EMAIL}`);

/* ---- 2 · the consultation -------------------------------------- */

step("2", "Booked, confirmed, and seen");

sql(`
  DELETE FROM crm.consultation_outcomes WHERE consultation_id = '${CONSULT}';
  DELETE FROM crm.consultations WHERE id = '${CONSULT}';
  INSERT INTO crm.consultations
    (id, person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
     confirmed_at, timezone, notes, created_at)
  VALUES ('${CONSULT}', '${person}', 'Weight management and energy', 'video', 'completed',
          (current_date - ${DAYS_IN + 1})::timestamptz + time '07:30',
          (current_date - ${DAYS_IN + 1})::timestamptz + time '08:30',
          now() - interval '${DAYS_IN + 3} days', 'Asia/Kolkata',
          'Tired by mid-afternoon every day. Two young children, cooks for the family.',
          now() - interval '${DAYS_IN + 5} days');
  INSERT INTO crm.consultation_outcomes
    (consultation_id, outcome, was_scheduled_at, note, recorded_by, recorded_at)
  VALUES ('${CONSULT}', 'done',
          (current_date - ${DAYS_IN + 1})::timestamptz + time '07:30',
          'Seen. Plan to follow.', '${BY}',
          (current_date - ${DAYS_IN + 1})::timestamptz + time '09:00');
`);
console.log(`   seen ${DAYS_IN + 1} days ago`);

/* ---- 3 · the plan ---------------------------------------------- */

step("3", "The plan she wrote");

const opened = await call("/crm/plans", {
  method: "POST",
  body: {
    personId: person, consultationId: CONSULT,
    targets: { energy_kcal: 1600, protein_g: 75, weight_kg: 74 },
    by: BY,
  },
});
const plan = opened.plan;

await call(`/crm/plans/${plan.id}`, {
  method: "PATCH",
  body: {
    body: PLAN_BODY,
    privateNote:
      "Energy dip is almost certainly the 4pm tea and biscuits plus a late dinner. " +
      "Ferritin 18 — worth rechecking at six weeks before we call it diet alone.",
    targets: { energy_kcal: 1600, protein_g: 75, weight_kg: 74 },
  },
});

/* Built, not read: the same route the Build button uses, so these
   rows are exactly what pressing it produces. Model "syntax", not a
   model name — the accuracy panel must not credit a language model
   for a seed. */
const built = await call("/crm/plan-items", {
  method: "POST",
  body: {
    planId: plan.id,
    model: "syntax",
    items: ROWS.map(([kind, label, quantity, unit, schedule], i) => ({
      line: i, kind, label, quantity, unit, schedule,
    })),
  },
});

for (const it of built.items) {
  await call(`/crm/plan-items/${it.id}`, {
    method: "PATCH", body: { status: "confirmed", by: BY },
  });
}

if (plan.status === "draft") await call(`/crm/plans/${plan.id}/issue`, { method: "POST" });
const planLink = await call(`/crm/plans/${plan.id}/link`, { method: "POST" });
console.log(`   ${plan.ref} · ${built.items.length} rows · issued`);

/* ---- 4 · the app ----------------------------------------------- */

step("4", "The programme");

const started = await call(`/crm/plans/${plan.id}/programme`, {
  method: "POST", body: { days: LENGTH },
});
const programme = started.programme.id;
const token = started.token;
console.log(`   ${LENGTH} days · programme ${programme.slice(0, 8)}`);

/* ---- 5 · two weeks of use --------------------------------------
   TODAY IS LEFT EMPTY on purpose. Opening the app to a day already
   ticked shows nothing about what ticking feels like, and the
   screen worth developing against is the one with work on it.

   One day mid-run is missing entirely, and her last message has no
   answer — both are states the app has to handle and neither
   appears in a tidy seed. */

sql(`
BEGIN;
UPDATE crm.programmes
   SET started_on = current_date - ${DAYS_IN},
       opened_at  = (current_date - ${DAYS_IN})::timestamptz + interval '9 hours',
       open_count = ${DAYS_IN * 2}
 WHERE id = '${programme}';

DELETE FROM crm.checkins        WHERE programme_id = '${programme}';
DELETE FROM crm.programme_notes WHERE programme_id = '${programme}';
DELETE FROM crm.measurements    WHERE programme_id = '${programme}';

INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note, at)
SELECT '${programme}', i.id, d.day,
       CASE WHEN (abs(hashtext(i.id::text || d.day::text)) % 100) < 74 THEN 'done'
            WHEN (abs(hashtext(i.id::text || d.day::text)) % 100) < 91 THEN 'part'
            ELSE 'skip' END,
       '',
       d.day + time '21:10'
  FROM crm.plan_items i
  JOIN crm.plans pl ON pl.id = i.plan_id
  CROSS JOIN (SELECT generate_series(current_date - ${DAYS_IN}, current_date - 1, '1 day')::date AS day) d
 WHERE pl.id = '${plan.id}' AND i.status IN ('confirmed','edited')
   AND d.day <> current_date - 6;

INSERT INTO crm.measurements
  (person_id, kind, metric, value, unit, method, source, programme_id, taken_at)
VALUES ('${person}','body','weight_kg',76.4,'kg','Self-reported','self','${programme}',
        (current_date - ${DAYS_IN})::timestamptz + time '07:10'),
       ('${person}','body','weight_kg',75.9,'kg','Self-reported','self','${programme}',
        (current_date - 6)::timestamptz + time '07:05');

INSERT INTO crm.programme_notes (programme_id, on_date, body, author, by, at, seen_at)
VALUES ('${programme}', current_date - 8,
        'The 4pm buttermilk is working, I am not raiding the biscuit tin any more. Still very tired around three though.',
        'client', NULL, (current_date - 8)::timestamptz + time '21:30',
        (current_date - 7)::timestamptz + time '08:00'),
       ('${programme}', current_date - 7,
        'Good. Three o''clock is often the late lunch rather than the food itself - try eating by half past one and tell me next week.',
        'practitioner', '${BY}', (current_date - 7)::timestamptz + time '18:40',
        (current_date - 7)::timestamptz + time '20:00'),
       ('${programme}', current_date - 2,
        'Ate by 1.30 all week and the afternoons are much better. Missed the walk twice, it rained.',
        'client', NULL, (current_date - 2)::timestamptz + time '22:05', NULL);
COMMIT;
`);

const days = await call(`/crm/programme/days?programmeId=${programme}&days=120`);
const notes = await call(`/crm/programme/notes?programmeId=${programme}`);
console.log(`   ${days.checkins.length} check-ins · ${notes.notes.length} messages · today is empty`);

/* ---- the link --------------------------------------------------- */

const appUrl = `${SITE}/me/${token}`;
const planUrl = `${SITE}/p/${planLink.token}`;

const note = [
  `Sofia D'Souza — the client to develop /me/ against`,
  ``,
  `  the app     ${appUrl}`,
  `  her plan    ${planUrl}`,
  ``,
  `  person      ${person}`,
  `  plan        ${plan.id}  (${plan.ref})`,
  `  programme   ${programme}`,
  `  day ${DAYS_IN + 1} of ${LENGTH}, ends ${iso(new Date(Date.now() + (LENGTH - DAYS_IN - 1) * 864e5))}`,
  ``,
  `Today is deliberately unticked. One day mid-run is missing entirely,`,
  `and her last message has not been answered.`,
  ``,
  `The token is returned once by the CRM and never listed again — that is`,
  `right for a client's credential. It is recoverable: re-run this script,`,
  `or POST /crm/plans/${plan.id}/programme, and the same token comes back.`,
  ``,
].join("\n");

mkdirSync(join(ROOT, "var"), { recursive: true });
writeFileSync(join(ROOT, "var", "app-client.txt"), note, "utf8");

console.log("\n" + "=".repeat(66));
console.log(note.split("\n").slice(0, 5).join("\n"));
console.log("=".repeat(66));
console.log("written to var/app-client.txt\n");
