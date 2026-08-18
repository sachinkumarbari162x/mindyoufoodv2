/* ============================================================
   STORAGE — where a photograph's bytes actually go
   ------------------------------------------------------------
   Three operations and nothing else: put, get, drop. Every caller
   works in keys and buffers and none of them knows whether the
   bytes are on this disk or in a bucket on the other side of the
   world.

   THE SEAM IS THE POINT, not the local provider behind it. The
   decision about production storage is deliberately still open —
   see docs/postConsultation.html — and the way to keep it open is
   to make it a file and an environment variable rather than a
   refactor. mail/providers and whatsapp/providers are the same
   shape for the same reason, and both have already been swapped
   once without touching a caller.

   THE KEY IS DERIVED, NEVER RECEIVED. It comes from the content
   hash, so nothing a client sends can choose a path, escape a
   directory, or overwrite somebody else's photograph. That rule
   belongs here rather than in the route, because there will be
   more than one route.
   ============================================================ */
"use strict";

const crypto = require("node:crypto");

/* Local disk unless something says otherwise — the same default as
   the mail outbox. A half-configured box must be incapable of
   posting a client's photographs to a third party, not merely
   unlikely to. */
function provider() {
  const want = (process.env.STORAGE_PROVIDER || "").trim().toLowerCase();
  if (want === "local" || want === "") return require("./providers/local");
  try {
    return require(`./providers/${want}`);
  } catch {
    console.warn(`[storage] no provider "${want}" — falling back to local disk`);
    return require("./providers/local");
  }
}

/* What we will accept, by MAGIC BYTES rather than by what the
   request claims. A Content-Type header is a client's opinion; the
   first few bytes of the file are a fact, and this is the one place
   in the system that takes a binary body from the open internet. */
const KINDS = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    ext: "png",
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) =>
      b.length > 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
];

/** What this actually is, or null. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  return KINDS.find((k) => k.test(buf)) || null;
}

/* Three megabytes. The app compresses to a couple of hundred
   kilobytes before it ever gets here, so anything near this ceiling
   is a phone that failed to compress or a caller that is not the
   app — and both should be refused rather than stored. */
const MAX_BYTES = 3 * 1024 * 1024;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * Store one image.
 *
 * @param {Buffer} buf   the raw bytes, exactly as received
 * @param {string} scope a folder to group by — the programme's id, so
 *                       one client's photographs sit together and can
 *                       be removed together
 * @returns {Promise<{ok:boolean, key?:string, mime?:string, bytes?:number,
 *                    sha256?:string, why?:string}>}
 */
async function put(buf, scope) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, why: "nothing arrived" };
  if (buf.length > MAX_BYTES) return { ok: false, why: "that photo is too large" };

  const kind = sniff(buf);
  if (!kind) return { ok: false, why: "that is not a photo" };

  const hash = sha256(buf);
  /* Sharded two levels, because a single folder with fifty thousand
     files in it is slow to list on every filesystem worth naming. */
  const key = `${scope}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${kind.ext}`;

  const out = await provider().put(key, buf);
  if (!out?.ok) return { ok: false, why: out?.why || "could not store that" };

  return { ok: true, key, mime: kind.mime, bytes: buf.length, sha256: hash };
}

/** Read one back. Returns { ok, body, mime } or { ok: false }. */
async function get(key) {
  /* Checked here as well as in the provider. A key should only ever
     come from our own database, but this is the function that turns
     a string into a filesystem read and it is worth being certain. */
  if (typeof key !== "string" || key.includes("..") || key.startsWith("/")) {
    return { ok: false, why: "no" };
  }
  const ext = key.split(".").pop();
  const kind = KINDS.find((k) => k.ext === ext);
  const out = await provider().get(key);
  if (!out?.ok) return { ok: false, why: "not found" };
  return { ok: true, body: out.body, mime: kind ? kind.mime : "application/octet-stream" };
}

/** Remove one. Used by erasure and by expiry — neither built yet. */
async function drop(key) {
  if (typeof key !== "string" || key.includes("..") || key.startsWith("/")) {
    return { ok: false };
  }
  return provider().drop(key);
}

/** What the console should say at boot, so nobody has to guess where
    a client's photographs are being written. */
function describe() {
  const p = provider();
  return `storage: ${p.name} — ${p.where()}`;
}

module.exports = { put, get, drop, describe, MAX_BYTES };
