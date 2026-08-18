/* ============================================================
   MAKE-DUMP — lift the practice out of the database into a file
   ------------------------------------------------------------
   The database is about to become the schema and nothing else, so
   that what goes to Supabase is a clean structure rather than a
   year of invented clients. Everything person-shaped and every
   trace of a visitor moves into db/dump.sql, which reloads it.

   TWO FILES, because there are two kinds of data here and mixing
   them makes the good one useless:

     dump.sql            the seeded practice — 19 people with
                         months of history, and the visitor
                         traffic. This is a fixture: you reload
                         it to have something to look at.

     dump-harness.sql    what the test suites minted today.
                         "Rereads79zmx4 Testclient". Reproducible
                         by re-running the suites, kept only
                         because deleting it is not mine to do.

   The discriminator is the one already written down in
   clear_harness_clients.sql: @example.com is the practice,
   .invalid and .org are harnesses. A convention that already
   exists beats a new one that is only in my head.

   FORMAT IS COPY, not INSERT. It is what pg_dump emits, it is
   exact about types and NULLs, and it loads in one statement per
   table instead of five hundred.

   ORDER IS PARENTS FIRST, and within a table oldest first — an
   amendment refers to the plan it amends, and COPY checks each
   row as it lands, so the amended row has to be in already.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/* Next to the files it writes, so it works from any cwd and
   survives the scratchpad it was first written in. */
const OUT = __dirname + "/";

/* Reads DATABASE_URL from the environment or from .env, so this
   dumps whichever database the stack is actually pointed at rather
   than one hardcoded here. */
const DSN = (() => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, "..", "..", "..", ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL is not set and was not found in .env");
})();

const psql = (args) =>
  execFileSync("psql", ["-d", DSN, ...args], {
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });

const q = (sql) => psql(["-t", "-A", "-c", sql]).trim();

/* WHO IS A HARNESS. Written once, as SQL, and used for both the
   "practice" and the "harness" pass so the two files cannot
   overlap or leave a row in neither. */
const HARNESS = `(email LIKE '%.invalid' OR email LIKE '%.org')`;

/* ---- the load order, with how each table finds its people ----
   `scope` takes the SQL predicate that selects the people for
   this pass and returns the table's WHERE clause. A table with
   no person at all (visitor traffic, the audit log) says `all`. */
const all = () => "TRUE";
const TABLES = [
  ["crm.people",       (p) => `id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.consultations",(p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.assessments",  (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.programmes",   (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.plans",        (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.plan_items",   (p) => `plan_id IN (SELECT id FROM crm.plans WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.checkins",     (p) => `programme_id IN (SELECT id FROM crm.programmes WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.checkin_media",(p) => `checkin_id IN (SELECT id FROM crm.checkins WHERE programme_id IN (SELECT id FROM crm.programmes WHERE person_id IN (SELECT id FROM crm.people WHERE ${p})))`],
  ["crm.measurements", (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.programme_notes",(p) => `programme_id IN (SELECT id FROM crm.programmes WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.goals",        (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.consultation_links",   (p) => `consultation_id IN (SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.consultation_outcomes",(p) => `consultation_id IN (SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.plan_links",   (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.messages",     (p) => `person_id IN (SELECT id FROM crm.people WHERE ${p})`],
  ["crm.payments",     (p) => `consultation_id IN (SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.ratings",      (p) => `consultation_id IN (SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.room_sessions",(p) => `consultation_id IN (SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM crm.people WHERE ${p}))`],
  ["crm.room_participants",(p) => `session_id IN (SELECT id FROM crm.room_sessions WHERE consultation_id IN (SELECT id FROM crm.consultations WHERE person_id IN (SELECT id FROM crm.people WHERE ${p})))`],

  /* ---- no person attached: visitor traffic and the log ---- */
  ["crm.audit",            all,   "practice-only"],
  ["crm.bot_turns",        all,   "practice-only"],
  ["crm.unrecognised",     all,   "practice-only"],
  ["public.bmi_snapshots", all, "practice-only"],
  ["public.appointments",  all, "practice-only"],
  ["public.handoff_tokens",all, "practice-only"],
  ["public.notifications", all,   "practice-only"],
];

/** Declared column order, so the COPY header matches SELECT *. */
function columnList(qualified) {
  const [schema, table] = qualified.split(".");
  return q(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
              FROM information_schema.columns
             WHERE table_schema='${schema}' AND table_name='${table}'`).split(",");
}

function columns(qualified) {
  return columnList(qualified).map((c) => `"${c}"`).join(", ");
}

/* WHEN A ROW WAS MADE, whatever this table happens to call it.
   Guessing per table got `created_at` wrong on assessments, which
   is the sort of mistake that is invisible until the reload of an
   amendment fails. Ask the table instead — and fall back to the
   first column, which is always the key, so the order is at least
   deterministic between runs. */
const WHEN = ["created_at", "started_at", "taken_at", "at", "first_at", "seen", "updated_at"];
function orderBy(qualified) {
  const cols = columnList(qualified);
  const when = WHEN.find((c) => cols.includes(c));
  return when ? `"${when}"` : `"${cols[0]}"`;
}

/** One COPY block: header, the rows as Postgres writes them, terminator.
 *
 *  LINE ENDINGS ARE FORCED TO \n. psql on Windows writes CRLF, and
 *  COPY refuses a stream whose end-of-copy marker does not match the
 *  newline style of the rows above it — "end-of-copy marker does not
 *  match previous newline style", which is COPY noticing exactly this
 *  and being right about it. Stripping \r is safe because the text
 *  format escapes a carriage return INSIDE a value as \r, two
 *  characters: any real one left in the stream is a line terminator,
 *  never data. */
function block(qualified, where, order) {
  const cols = columns(qualified);
  const body = psql(["-q", "-c",
    `\\copy (SELECT ${cols} FROM ${qualified} WHERE ${where} ORDER BY ${order}) TO STDOUT`])
    .replace(/\r\n/g, "\n");
  const rows = body === "" ? 0 : body.replace(/\n$/, "").split("\n").length;
  if (rows === 0) return { rows, text: `-- ${qualified}: nothing\n\n` };
  return {
    rows,
    text: `-- ${qualified} — ${rows} row${rows === 1 ? "" : "s"}\n` +
          `COPY ${qualified} (${cols}) FROM stdin;\n${body}\\.\n\n`,
  };
}

/* THE FOOTGUN THIS EXISTS TO DISARM.
 *
 *  Once clear_practice.sql has run, the database has no people in
 *  it — and running this script then would write an empty dump.sql
 *  over the one holding nineteen clients and months of history. The
 *  loss would be silent and total: a valid file, correct syntax,
 *  nothing in it, discovered the next time somebody tried to load
 *  the practice back and got a working CRM with nobody in it.
 *
 *  So: writing fewer rows than the file already contains stops the
 *  run. Growth is normal and passes without comment; shrinkage is
 *  always worth a human deciding about. FORCE=1 says you decided. */
function guard(file, rows) {
  if (!fs.existsSync(file)) return;
  const had = (fs.readFileSync(file, "utf8").match(/^-- \S+ — (\d+) rows?$/gm) || [])
    .reduce((n, l) => n + Number(/(\d+)/.exec(l)[1]), 0);
  if (rows >= had || process.env.FORCE === "1") return;

  throw new Error(
    `\n  ${path.basename(file)} already holds ${had} rows and this run found only ${rows}.\n` +
    `  Refusing to overwrite it.\n\n` +
    `  The usual cause is that the database has been cleared — the practice\n` +
    `  lives in this file now, not in Postgres. Load it back before dumping:\n\n` +
    `    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ${path.basename(file)}\n\n` +
    `  If the shrinkage is intended, re-run with FORCE=1.\n`);
}

function build({ file, people, includeUnscoped, title, blurb }) {
  const parts = [];
  let total = 0;
  const counts = [];

  for (const [name, scope, onlyPractice] of TABLES) {
    if (onlyPractice && !includeUnscoped) continue;
    const b = block(name, scope(people), orderBy(name));
    parts.push(b.text);
    total += b.rows;
    if (b.rows) counts.push(`${name} ${b.rows}`);
  }

  /* SEQUENCES, AFTER THE ROWS.
   *
   *  COPY writes crm.audit ids 1…137 straight into the column and
   *  never touches the sequence behind it, which is still sitting
   *  at 1. Nothing complains at load time. The failure arrives
   *  later and somewhere else: the first CRM action after a
   *  restore tries to write audit id 1, hits the primary key, and
   *  reports that saving failed — for a reason nobody would think
   *  to look for in a dump they loaded yesterday.
   *
   *  So every table whose key comes from a sequence gets its
   *  sequence moved past the rows just inserted. Written to work
   *  on an empty table too (max of nothing is NULL → next is 1),
   *  and pg_get_serial_sequence covers both a serial default and
   *  an identity column, so this survives the schema rewrite. */
  /*  Asked of the catalog rather than table by table:
      pg_get_serial_sequence RAISES on a table with no `id` at all
      — crm.consultation_links is keyed by its token — so probing
      each one in turn fails on the first such table instead of
      reporting that it has no sequence. This covers both spellings
      of the same thing: an identity column (attidentity) and an
      older serial (a nextval default). */
  const withSeq = new Set(q(`
    SELECT n.nspname || '.' || c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id'
                         AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relkind = 'r' AND n.nspname IN ('crm','public')
       AND (a.attidentity IN ('a','d')
            OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%')`)
    .split("\n").map((s) => s.trim()).filter(Boolean));

  const bumped = [];
  for (const [name, , onlyPractice] of TABLES) {
    if (onlyPractice && !includeUnscoped) continue;
    if (withSeq.has(name)) bumped.push(name);
  }
  if (bumped.length) {
    parts.push(
      "-- ---- move each sequence past the rows above ----\n" +
      bumped.map((t) =>
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'),` +
        ` coalesce(max(id), 0) + 1, false) FROM ${t};`).join("\n") + "\n\n");
  }

  /* Before writing a single byte. */
  guard(file, total);

  const header =
`-- ============================================================
--  ${title}
-- ------------------------------------------------------------
${blurb.split("\n").map((l) => "--  " + l).join("\n")}
--
--  Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")}Z
--  ${total} rows across ${counts.length} tables.
--
--  LOAD IT WITH:
--    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ${path.basename(file)}
--
--  Data only — the schema must already exist. Wrapped in a
--  transaction, so a load that fails half way leaves the
--  database exactly as it was rather than half a practice.
--
--  Load order is parents before children and, within a table,
--  oldest first: an amended plan points at the plan it amends,
--  and COPY checks every row as it arrives.
-- ============================================================

\\set ON_ERROR_STOP on
BEGIN;

`;

  fs.writeFileSync(file, header + parts.join("") + "COMMIT;\n", "utf8");
  return { total, counts };
}

const PRACTICE = build({
  file: OUT + "dump.sql",
  people: `email NOT LIKE '%.invalid' AND email NOT LIKE '%.org'`,
  includeUnscoped: true,
  title: "THE PRACTICE — every invented client, and every visitor",
  blurb:
`The main database holds the schema and its configuration: the
country list, her weekly hours, the knowledge base, her login.
Everything that is a PERSON, or the trace of somebody who
visited the site, lives here instead.

That split is what lets the schema be pushed somewhere new
without nineteen fictional women going with it — and it is why
this file exists rather than a DROP: the practice took months
of invented history to build and is what every screen in the
CRM is judged against.

Reload it whenever you want something to look at. The test
suites need it: they are written against Sofia D'Souza.`,
});

const HARNESSF = build({
  file: OUT + "dump-harness.sql",
  people: HARNESS,
  includeUnscoped: false,
  title: "HARNESS RESIDUE — what the test suites left behind",
  blurb:
`Not a fixture. Every suite in scratchpad/ mints its own client
so two runs cannot collide, which is correct and which means
these rows accumulate: "Rereads79zmx4 Testclient" and forty
more like it.

Re-running the suites produces them again, so this file is
kept for completeness rather than for use. You almost
certainly want dump.sql instead.`,
});

console.log(`\ndump.sql          ${String(PRACTICE.total).padStart(5)} rows`);
for (const c of PRACTICE.counts) console.log(`                  ${c}`);
console.log(`\ndump-harness.sql  ${String(HARNESSF.total).padStart(5)} rows`);
for (const c of HARNESSF.counts) console.log(`                  ${c}`);
console.log();
