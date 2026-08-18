/* ============================================================
   PUSH TO SUPABASE — the whole sequence, once, checked
   ------------------------------------------------------------
     node services/go-data/db/push-to-supabase.cjs
     node services/go-data/db/push-to-supabase.cjs --dry-run

   Reads .env, works out which project and which region, applies
   the schema and the configuration, gives myf_client a password,
   and then proves the boundary actually holds before saying it
   worked. Writes the two connection strings back into .env so no
   credential is ever printed to a terminal.

   ---- WHY IT PROBES FOR THE REGION --------------------------
   The first project this was pointed at turned out to be in
   Tokyo. Nothing said so: the dashboard URL does not carry it,
   the API hostname is behind Cloudflare and resolves to whatever
   edge is nearest YOU, and the response headers name that edge —
   which read "BOM" from Mumbai and meant nothing at all.

   It cost 218 ms a query against 42 ms from the right region,
   on every round trip, for a practice whose clients are all in
   India. Supabase cannot move a project after it is created.

   So the region is not taken from anybody's memory. Supavisor's
   tenant lookup is per region: connect to the wrong one and it
   says "tenant/user not found", connect to the right one and it
   asks for a password instead. That difference is a probe, and
   this walks the regions until one of them asks for a password.

   ---- AND WHY IT REFUSES A SLOW ONE -------------------------
   Having found the region it measures it, and stops if the round
   trip is slow enough to matter. Discovering that after the push,
   with client data already in the database, is the expensive
   version of the same conversation.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..", "..", "..");
const ENV = path.join(ROOT, ".env");
const DRY = process.argv.includes("--dry-run");

/* Every region Supabase runs Supavisor in. Both prefixes: newer
   projects land on aws-1. */
const REGIONS = [
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-northeast-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1",
  "eu-north-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "sa-east-1", "ca-central-1",
];

/* Above this, the distance is the application's performance. The
   CRM makes several round trips per page, so 200 ms a query is a
   second of staring at a spinner that no amount of code fixes. */
const SLOW_MS = 120;

const say = (s = "") => console.log(s);
const die = (s) => { console.error(`\n  ${s}\n`); process.exit(1); };

/* ---- .env, read and written in place ------------------------ */
function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) {
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Replace a key if present, append it if not. Never reorders. */
function writeEnv(pairs) {
  let text = fs.readFileSync(ENV, "utf8");
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text = text.replace(/\s*$/, `\n${k}=${v}\n`);
  }
  fs.writeFileSync(ENV, text, "utf8");
}

/* ---- psql, with the password never on a command line -------- */
function psql(pw, host, user, args, { quiet = false } = {}) {
  const r = spawnSync("psql", [
    "-h", host, "-p", "5432", "-U", user, "-d", "postgres", ...args,
  ], {
    env: { ...process.env, PGPASSWORD: pw, PGCLIENTENCODING: "UTF8",
           PGCONNECT_TIMEOUT: "15", PGSSLMODE: "require" },
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const out = String(r.stdout || "") + String(r.stderr || "");
  if (!quiet && r.status !== 0) return { ok: false, out };
  return { ok: r.status === 0, out };
}

/* ============================================================ */
say("\n  PUSH TO SUPABASE\n  " + "-".repeat(58));

const env = readEnv();

/* ---- 1. which project ---------------------------------------
   The reference is inside the anon key. A JWT is base64, not
   encryption, so this needs no network call and no dashboard. */
const key = env.SUPABASE_ANON_KEY || "";
const parts = key.split(".");
if (parts.length !== 3) die("SUPABASE_ANON_KEY is missing or is not a JWT.");

let claims;
try {
  claims = JSON.parse(
    Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
} catch { die("SUPABASE_ANON_KEY does not decode."); }

const REF = claims.ref;
if (!REF) die("SUPABASE_ANON_KEY carries no project ref.");
if (claims.role !== "anon") {
  die(`SUPABASE_ANON_KEY is a ${claims.role} key, not anon. ` +
      `A service_role key bypasses row-level security and must not be here.`);
}

const PW = env.DATABASE_PASSWORD;
if (!PW) die("DATABASE_PASSWORD is not set. Supabase dashboard → Project Settings → Database.");

say(`  project    ${REF}`);
say(`  password   ${PW.length} characters`);

/* ---- 2. which region ---------------------------------------- */
say("\n  Finding the region (Supavisor's tenant lookup is per region)…");

let host = null, region = null;
for (const r of REGIONS) {
  for (const n of [0, 1]) {
    const h = `aws-${n}-${r}.pooler.supabase.com`;
    const res = psql(PW, h, `postgres.${REF}`, ["-t", "-A", "-c", "SELECT 1"], { quiet: true });
    if (res.ok) { host = h; region = r; break; }
    /* The tenant exists here if it complains about the PASSWORD
       rather than about the tenant. Worth separating: one means
       "wrong region", the other means "right region, wrong
       password", and they need different fixes. */
    if (/password authentication failed/i.test(res.out)) {
      /* NOT NECESSARILY THE PASSWORD. Supavisor answers the first
         connection to a cold tenant with an auth failure often
         enough to have derailed this script once already — the
         same credentials succeeded five times in a row a minute
         later. So a refusal is only believed if it survives being
         asked again. */
      let refusals = 1, retry = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { timeout: 5000 });
        retry = psql(PW, h, `postgres.${REF}`, ["-t", "-A", "-c", "SELECT 1"], { quiet: true });
        if (retry.ok) break;
        if (/password authentication failed/i.test(retry.out)) refusals++;
      }
      if (retry && retry.ok) {
        say(`    (${h} refused once and then accepted — a cold tenant, not the password)`);
        host = h; region = r; break;
      }
      die(`Found the project in ${r}, but the password was refused ${refusals} times.\n\n` +
          `  DATABASE_PASSWORD in .env is not this project's database password.\n` +
          `  Supabase dashboard → Project Settings → Database → Database password.\n` +
          `  It is shown once when the project is created; reset it there if it was missed.`);
    }
    if (!/tenant.*not found|Tenant or user not found/i.test(res.out)
        && !/could not translate|Name or service not known|getaddrinfo/i.test(res.out)) {
      /* Something other than a miss — worth showing rather than
         swallowing while walking sixteen regions. */
      say(`    ${h}: ${res.out.trim().split("\n")[0].slice(0, 110)}`);
    }
  }
  if (host) break;
}
if (!host) die("Could not find this project in any known Supabase region.");
say(`  region     ${region}   (${host})`);

/* ---- 3. is it close enough to be worth using? --------------- */
/* ONE child process, five connections INSIDE it. The first version
   spawned a fresh node per sample and reported ~96 ms for a link
   that measures 42 ms — it was timing Node's own startup, about
   50 ms of it, and would have refused a perfectly good region as
   too slow. A measurement that includes the measuring is not a
   measurement of the thing. */
function handshakeMs(h) {
  const r = spawnSync(process.execPath, ["-e", `
    const net = require("net");
    const host = ${JSON.stringify(h)};
    const times = [];
    (function next() {
      if (times.length === 5) {
        times.sort((a, b) => a - b);
        process.stdout.write(String(times[2]));
        return process.exit(0);
      }
      const t = process.hrtime.bigint();
      const s = net.connect(5432, host, () => {
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
        s.destroy(); next();
      });
      s.on("error", () => process.exit(1));
      s.setTimeout(8000, () => { s.destroy(); process.exit(1); });
    })();
  `], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return null;
  const ms = Number(String(r.stdout).trim());
  return Number.isFinite(ms) ? Math.round(ms) : null;
}
const rtt = handshakeMs(host);
if (rtt !== null) {
  say(`  round trip ${rtt} ms`);
  if (rtt > SLOW_MS) {
    die(`${rtt} ms per round trip is too far away.\n\n` +
        `  The CRM makes several queries per page, so this is seconds of waiting\n` +
        `  on every screen, and Supabase cannot move a project after creation.\n` +
        `  Create the project in the region nearest her clients and try again.\n\n` +
        `  Override with SLOW_OK=1 if this is deliberate.`);
  }
}

if (DRY) { say("\n  --dry-run: stopping before anything is written.\n"); process.exit(0); }

/* ---- 4. the schema ------------------------------------------ */
const OWNER = `postgres.${REF}`;
const run = (file, extra = []) => {
  const res = psql(PW, host, OWNER, ["-q", "-v", "ON_ERROR_STOP=1", ...extra, "-f", path.join(HERE, file)]);
  if (!res.ok) die(`${file} failed:\n\n${res.out.trim().split("\n").slice(0, 6).join("\n")}`);
  return res.out;
};

say("\n  Applying…");
const schemaOut = psql(PW, host, OWNER,
  ["-q", "-v", "ON_ERROR_STOP=1", "-f", path.resolve(HERE, "..", "schema.sql")]);
if (!schemaOut.ok) die(`schema.sql failed:\n\n${schemaOut.out.trim().split("\n").slice(0, 8).join("\n")}`);
say("    schema.sql   35 tables, indexes, policies, the myf_client role");

run("config.sql");
say("    config.sql   the country list, the knowledge base, her hours");

/* ---- 5. the client role ------------------------------------- */
const clientPw = crypto.randomBytes(24).toString("base64url");
const roles = psql(PW, host, OWNER,
  ["-v", `pw='${clientPw}'`, "-f", path.join(HERE, "roles.sql")]);
if (!roles.ok) die(`roles.sql refused:\n\n${roles.out.trim().split("\n").slice(0, 8).join("\n")}`);
say("    roles.sql    myf_client can log in, and was checked");

/* ---- 6. prove the boundary, do not assume it ----------------
   roles.sql already refused to proceed on a role that could see
   past a policy. This is the other half: connect AS that role,
   with no identity set, and require that it sees nothing. */
say("\n  Checking the boundary from the client's own connection…");

const CLIENT_USER = `myf_client.${REF}`;
const who = psql(clientPw, host, CLIENT_USER, ["-t", "-A", "-c", "SELECT current_user"]);
if (!who.ok) {
  die(`myf_client cannot connect on the pooler.\n\n${who.out.trim().split("\n")[0]}\n\n` +
      `  The pooler username is <role>.<ref> — here, ${CLIENT_USER}.`);
}
say(`    connects as  ${who.out.trim()}`);

const blind = psql(clientPw, host, CLIENT_USER, ["-t", "-A", "-c",
  `SELECT count(*) FROM crm.people`]);
if (!blind.ok) die(`the isolation check could not run:\n\n${blind.out}`);
if (blind.out.trim() !== "0") {
  die(`WITH NO IDENTITY SET, myf_client CAN SEE ${blind.out.trim()} ROWS in crm.people.\n\n` +
      `  It should see none. Every row-level policy is inert. NOT SAFE.`);
}
say("    with no identity, it sees 0 rows — the policies are live");

/* ---- 7. write the connection strings ------------------------ */
const enc = encodeURIComponent;
writeEnv({
  DATABASE_URL:
    `postgres://${OWNER}:${enc(PW)}@${host}:5432/postgres?sslmode=require`,
  DATABASE_URL_CLIENT:
    `postgres://${CLIENT_USER}:${enc(clientPw)}@${host}:5432/postgres?sslmode=require`,
});

say("\n  Written to .env: DATABASE_URL and DATABASE_URL_CLIENT.");
say("  (the client password is generated here and stored only there)");
say("\n  " + "-".repeat(58));
say("  Restart the stack. Look for:");
say("    [go-data] row-level security: ON — a client's requests run as myf_client");
say("\n  Then, for something to look at:");
say(`    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f services/go-data/db/dump.sql\n`);
