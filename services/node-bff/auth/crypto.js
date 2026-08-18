/* ============================================================
   AUTH CRYPTO — passwords, one-time codes, signed sessions
   ------------------------------------------------------------
   Everything here comes out of node:crypto. Nothing is installed.

   WHY SCRYPT AND NOT ARGON2ID.
   argon2id was the choice on the sheet and it is the better
   algorithm. Every argon2 for Node is a compiled dependency, and
   this project has none — not as an aesthetic, but because a
   native module is a thing that breaks on a Node upgrade, on a
   different architecture, and at the worst possible time.

   scrypt is memory-hard, it is in the standard library, and at the
   parameters below it is a serious obstacle. The gap between
   scrypt and argon2id is much smaller than the gap between either
   of them and a dependency that fails to build on the server.

   TOTP is RFC 6238 in about forty lines, which is the whole
   algorithm — an HMAC, a truncation, and a modulo.
   ============================================================ */
"use strict";

const crypto = require("crypto");

/* ---- passwords ------------------------------------------------
   N=2^15 is roughly 32MB and ~100ms on a small server. High enough
   to hurt an attacker, low enough that she is not waiting for her
   own CRM. maxmem has to be raised explicitly or Node refuses the
   very parameters it was asked for. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  // The parameters travel WITH the hash, so raising them later does
  // not invalidate every password already stored.
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    // Constant time, so a wrong password cannot be narrowed down by
    // how long it took to be rejected.
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---- TOTP · RFC 6238 ------------------------------------------ */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function newTotpSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(secret) {
  const clean = String(secret).toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The six digits for one 30-second step. */
function totpAt(secret, step) {
  const key = b32decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const mac = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * Check a code against the current step and one either side.
 *
 * The window is what makes this usable: her phone's clock and the
 * server's are never exactly aligned, and a code typed at 29 seconds
 * arrives at 31. One step of tolerance costs 30 seconds of validity
 * and saves a support conversation every week.
 */
function verifyTotp(secret, code, now = Date.now()) {
  const given = String(code || "").replace(/\D/g, "");
  if (given.length !== 6 || !secret) return false;
  const step = Math.floor(now / 1000 / 30);
  for (const s of [step - 1, step, step + 1]) {
    const want = Buffer.from(totpAt(secret, s));
    const got = Buffer.from(given);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return true;
  }
  return false;
}

/** The string a QR code encodes, for her authenticator app. */
function otpauthURL(secret, email, issuer = "Mind Your Food") {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return (
    `otpauth://totp/${label}?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

/* ---- sessions -------------------------------------------------
   A signed value rather than a row in a table. There is one user
   and one server; a session store would be a second thing to keep,
   expire and back up in exchange for nothing.

   Signed, NOT encrypted. The payload is not a secret — it says who
   and until when — and the signature is what stops it being edited. */
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function unsign(token, secret) {
  try {
    const [body, mac] = String(token).split(".");
    if (!body || !mac) return null;
    const want = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    // An expired session is not a valid one, however good its signature.
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---- reading a cookie ------------------------------------------
   Shared, because the BFF and the site server both read the SAME
   cookie and have to agree about it. They did not, and it cost
   hours: the site built its lookup with a regex inside a template
   literal — `(?:^|;\s*)` — where \s collapses to a literal "s".
   The pattern only matched when the cookie happened to be FIRST in
   the header.

   Every curl test passed, because a fresh jar sends one cookie. A
   browser mid-sign-in sends two: myf_crm_pending and myf_crm. So
   the API said "signed in" and the site said "not signed in", which
   is a redirect loop that reads as a flickering page and a hot CPU.

   Split on ";", split each part on the FIRST "=", last value wins
   for a repeated name — which is what a browser means when it sends
   two cookies of one name from different paths. */
function readCookie(header, name) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return name ? out[name] : out;
}

module.exports = {
  readCookie,
  hashPassword, verifyPassword,
  newTotpSecret, verifyTotp, totpAt, otpauthURL,
  sign, unsign,
};
