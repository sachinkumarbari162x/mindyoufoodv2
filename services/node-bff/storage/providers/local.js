/* ============================================================
   LOCAL DISK — where photographs live while we develop
   ------------------------------------------------------------
   The interim provider, and interim is exactly the kind of thing
   that quietly becomes permanent — so the two rules that stop
   that being a disaster are enforced here rather than remembered:

     IT IS OUTSIDE ANYTHING THE STATIC SERVER CAN REACH. The
     folder is a sibling of public/, never inside it. Every byte
     leaves through an authenticated route or it does not leave.

     IT IS IGNORED BY GIT before the first file is written. The
     directory is created with its own .gitignore, so a client's
     meal photographs cannot be committed by somebody running
     `git add -A` in a hurry.

   Production replaces this file and nothing else. See
   storage/index.js for the seam.
   ============================================================ */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

/* Two levels up from services/node-bff/storage/providers → the repo
   root, then var/uploads. Configurable, because on the box this
   should be a mounted disk rather than the deploy directory. */
const ROOT = path.resolve(
  process.env.STORAGE_DIR || path.join(__dirname, "..", "..", "..", "..", "var", "uploads")
);

let readied = false;

/** Make the folder, and make it ignorable, once. */
async function ready() {
  if (readied) return;
  await fs.mkdir(ROOT, { recursive: true });

  /* Written every time the folder is created rather than checked
     for, so a fresh clone or a wiped var/ cannot end up holding
     clinical photographs inside a tracked tree. */
  const ignore = path.join(ROOT, ".gitignore");
  try {
    await fs.access(ignore);
  } catch {
    await fs.writeFile(
      ignore,
      "# Client photographs. Never commit these.\n*\n!.gitignore\n",
      "utf8"
    );
  }
  readied = true;
}

/** Resolve a key inside ROOT, or refuse. */
function resolve(key) {
  const full = path.resolve(path.join(ROOT, key));
  /* The belt to index.js's braces. Even with a derived key, the one
     function that turns a string into a filesystem path should be
     the one that proves it stayed inside the box. */
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

async function put(key, buf) {
  await ready();
  const full = resolve(key);
  if (!full) return { ok: false, why: "bad key" };

  await fs.mkdir(path.dirname(full), { recursive: true });

  /* wx — fail if it exists. The key is the content hash, so a file
     that is already there is byte-for-byte the same photograph, and
     a phone retrying a queued upload should cost nothing. */
  try {
    await fs.writeFile(full, buf, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") return { ok: false, why: err.message };
  }
  return { ok: true };
}

async function get(key) {
  const full = resolve(key);
  if (!full) return { ok: false };
  try {
    return { ok: true, body: await fs.readFile(full) };
  } catch {
    return { ok: false };
  }
}

async function drop(key) {
  const full = resolve(key);
  if (!full) return { ok: false };
  try {
    await fs.unlink(full);
    return { ok: true };
  } catch (err) {
    // Already gone is the outcome that was wanted.
    return { ok: err.code === "ENOENT" };
  }
}

module.exports = { name: "local", put, get, drop, where: () => ROOT };
