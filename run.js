/* ============================================================
   MIND YOUR FOOD · v2.0.0 — start everything

       node run.js                 → http://localhost:5501
       node run.js --no-ai         → skip the Python service
       PORT=4000 node run.js

   Boots three processes and keeps them together:

       5501  server.js              static site + /api proxy
       5502  services/node-bff      sessions, rules, booking
       5503  services/py-ai         Groq (Python)

   Only 5501 is meant to be reachable from a browser; the other
   two bind to loopback. In production Caddy fronts 5501 and the
   same two stay internal.

   Reads .env from this directory if one exists — plain KEY=value,
   no dependency, no interpolation. Nothing here NEEDS a .env: with
   no GROQ_API_KEY the desk runs its scripted flow, and with no
   APPOINTMENTS_API_URL bookings are dry-run, which is the correct
   default for local work.
   ============================================================ */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const withAi = !process.argv.includes("--no-ai");

/* ---- .env ---------------------------------------------------- */
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    // Anything already in the real environment wins — that is what
    // makes `GROQ_API_KEY=… node run.js` work as an override.
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    n++;
  }
  return n;
}

const loaded = loadEnv();

/* ---- python ---------------------------------------------------
   Windows ships `py`, most Linux boxes only `python3`. Try in
   order and use the first that answers. */
function pythonCmd() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const { execFileSync } = require("node:child_process");
  for (const cmd of process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore" });
      return cmd;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/* ---- one session secret, shared and persistent ----------------
   Every child is spawned with a copy of this process's environment,
   so setting it HERE means the BFF (which signs the cookie) and the
   site server (which checks it on /crm) can never disagree.

   They used to. The BFF generated a random secret when the variable
   was unset; the site server saw an empty one. Any arrangement where
   those two differ produces a redirect loop that is very hard to read
   from the outside: the API says "signed in", the static server says
   "not signed in", and the login page bounces between them several
   times a second. That is what "one moment, blinking, CPU climbing"
   was.

   Persisted to a file rather than regenerated, because a secret that
   changes on restart signs everybody out every time the stack is
   restarted — which during a build is constantly.

   A real deployment sets SESSION_SECRET in the environment and this
   never runs. */
if (!process.env.SESSION_SECRET) {
  const secretFile = path.join(ROOT, ".session-secret");
  try {
    process.env.SESSION_SECRET = fs.readFileSync(secretFile, "utf8").trim();
  } catch {
    /* ignore — first run */
  }
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = require("node:crypto").randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(secretFile, process.env.SESSION_SECRET, { mode: 0o600 });
      console.log("  session: generated .session-secret (git-ignored, keep it out of the repo)");
    } catch (err) {
      console.warn(`  session: could not save a secret (${err.message}) — sessions end at restart`);
    }
  }
}

/* ---- children ------------------------------------------------ */
const children = [];
let shuttingDown = false;

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, {
    cwd: opts?.cwd || ROOT,
    env: { ...process.env, ...(opts?.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const tag = `\x1b[2m${name.padEnd(8)}\x1b[0m`;
  const pipe = (stream, to) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) if (line.trim()) to.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`${tag} exited (${signal || code}) — shutting the rest down.`);
    stopAll(code || 1);
  });

  child.on("error", (err) => {
    console.error(`${tag} failed to start: ${err.message}`);
    if (!shuttingDown) stopAll(1);
  });

  children.push({ name, child });
  return child;
}

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  }
  // Give them a beat to close listeners before the parent goes.
  setTimeout(() => process.exit(code ?? 0), 250);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stopAll(0));

/* ---- go ------------------------------------------------------- */
console.log("\n\x1b[1mMind Your Food · v2.0.0\x1b[0m");
if (loaded) console.log(`  .env: ${loaded} variable${loaded === 1 ? "" : "s"} loaded`);

if (withAi) {
  const py = pythonCmd();
  if (!py) {
    console.warn(
      "  \x1b[33m!\x1b[0m No Python found — starting without the AI service.\n" +
        "    The desk still takes bookings using its scripted flow."
    );
  } else {
    start("ai", py, ["app.py"], { cwd: path.join(ROOT, "services", "py-ai") });
  }
} else {
  console.log("  ai: skipped (--no-ai)");
}

/* The Go data service, when a database is configured. No
   DATABASE_URL means no data service — the desk still books, it
   just loses the BMI warm-start and the trial mirror. Prebuilt
   binary if one exists (fast), otherwise `go run` (convenient). */
if (process.env.DATABASE_URL) {
  const goDir = path.join(ROOT, "services", "go-data");
  const built = path.join(goDir, process.platform === "win32" ? "godata.exe" : "godata");
  if (fs.existsSync(built)) {
    start("data", built, [], { cwd: goDir });
  } else {
    start("data", "go", ["run", "."], { cwd: goDir });
  }
} else {
  console.log("  data: skipped (no DATABASE_URL — BMI handoff disabled)");
}

start("bff", process.execPath, [path.join(ROOT, "services", "node-bff", "server.js")]);
start("site", process.execPath, [path.join(ROOT, "server.js")]);

setTimeout(() => {
  console.log(`\n  \x1b[32m→\x1b[0m http://localhost:${process.env.PORT || 5501}\n`);
}, 600);
