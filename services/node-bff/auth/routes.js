/* ============================================================
   THE DOOR — logging in, and staying in
   ------------------------------------------------------------
   Until this existed, /crm and /api/crm/* answered 200 to anyone.

   The shape:
     POST /api/crm/auth/setup    once, when there is no account yet
     POST /api/crm/auth/login    email + password
     POST /api/crm/auth/totp     the six digits, if a device is enrolled
     POST /api/crm/auth/enrol    attach an authenticator app
     POST /api/crm/auth/logout
     GET  /api/crm/auth/me       who am I, and what is still needed

   TWO COOKIES, AND THE DIFFERENCE MATTERS. A correct password gets
   a PENDING cookie that opens nothing except the TOTP check. Only
   the six digits produce the real session. A password alone must
   never be a foot in the door.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const c = require("./crypto");
const data = require("../data-client");

const HOUR = 3600 * 1000;
const SESSION_MS = 12 * HOUR; // a working day, then she logs in again
const PENDING_MS = 5 * 60 * 1000; // long enough to read a phone screen

/* Two doors, two cookies. A session for the workspace is NOT a
   session for the raw tables, which is the entire point of asking
   for them to be separate: whoever can read every row of every
   table should have had to prove it separately. */
const COOKIE = { crm: "myf_crm", viewer: "myf_view" };
const PENDING = { crm: "myf_crm_pending", viewer: "myf_view_pending" };

const roleOf = (body) => (body?.role === "viewer" ? "viewer" : "crm");

/* The secret that signs sessions. From the environment in anything
   real; generated here otherwise, which is safe but means every
   restart logs her out. Said out loud at boot rather than left to be
   discovered as "the CRM keeps forgetting me". */
let SECRET = process.env.SESSION_SECRET || "";
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[bff] SESSION_SECRET is not set — sessions will not survive a restart");
}

const ISSUER = process.env.TOTP_ISSUER || "Mind Your Food";

/* ---- cookies --------------------------------------------------
   HttpOnly so no script can read it, SameSite=Strict so it is not
   sent on a request some other site made, Secure once there is TLS
   in front. Path=/ because the CRM is served from / and the API
   from /api — one cookie has to cover both. */
function setCookie(headers, name, value, maxAgeMs) {
  const bits = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (process.env.COOKIE_SECURE === "true") bits.push("Secure");
  const existing = headers["Set-Cookie"] || [];
  headers["Set-Cookie"] = [...(Array.isArray(existing) ? existing : [existing]), bits.join("; ")];
}

function clearCookie(headers, name) {
  const existing = headers["Set-Cookie"] || [];
  headers["Set-Cookie"] = [
    ...(Array.isArray(existing) ? existing : [existing]),
    `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  ];
}

/* One reader, in auth/crypto.js, shared with the site server. Two
   readers of one cookie is two chances to disagree. */
function readCookies(req) {
  return c.readCookie(req.headers.cookie);
}

/** The signed-in staff member for a door, or null. */
function current(req, role = "crm") {
  const token = readCookies(req)[COOKIE[role]];
  if (!token) return null;
  const payload = c.unsign(token, SECRET);
  // A session that never passed the second factor is not a session.
  if (!payload || payload.mfa !== true) return null;
  // And a session for the other door is not a session for this one,
  // however valid its signature.
  if ((payload.role || "crm") !== role) return null;
  return payload;
}

/* ---- the audit trail ------------------------------------------
   Fire and forget. A failure to record must never fail the thing
   being recorded — but it is logged, because an audit trail that
   quietly stops is worse than none at all. */
function record(req, action, target, before, after, actor) {
  /* `actor` is passed explicitly at login, because at that moment
     the cookie is being set on the RESPONSE and has not yet arrived
     on a request — so reading it here recorded every sign-in as
     "unknown", which is the one entry where the name matters most. */
  const who = actor || current(req)?.email || "unknown";
  data.crm
    .audit({
      actor: who,
      action,
      target: target || "",
      before: before ?? null,
      after: after ?? null,
      ipHash: hashIp(req),
    })
    .catch((err) => console.warn(`[bff] audit ${action} not recorded: ${err.message}`));
}

function hashIp(req) {
  const ip = req.socket?.remoteAddress || "";
  return ip ? crypto.createHash("sha256").update(ip + SECRET).digest("hex").slice(0, 16) : "";
}

/* ---- routes --------------------------------------------------- */

async function staffRow(email, role) {
  const out = await data.crm.staff(email, role || "crm");
  return out?.staff || null;
}

/** Is there an account at all? The login page asks before drawing. */
async function state(req, role = "crm") {
  const row = await staffRow(undefined, role);
  const who = current(req, role);
  return {
    status: 200,
    body: {
      role,
      setUp: !!row,
      signedIn: !!who,
      email: who?.email || null,
      // Whether a second factor is attached, so the page knows which
      // question comes next.
      totp: !!row?.totpConfirmedAt,
    },
  };
}

/** First run. Only possible while no account exists. */
async function setup(body) {
  const email = String(body?.email || "").trim();
  const password = String(body?.password || "");

  if (!email.includes("@")) return { status: 400, body: { error: "bad_email" } };
  if (password.length < 12) {
    /* Twelve, not eight. This is the one password guarding every
       client record in the practice, and it is typed once a day at
       most — length costs her almost nothing here. */
    return { status: 400, body: { error: "weak", message: "Twelve characters or more, please." } };
  }

  const out = await data.crm.staffCreate({
    email,
    passwordHash: c.hashPassword(password),
    role: roleOf(body),
  });
  if (!out?.ok) {
    return { status: out?.status || 409, body: { error: out?.error || "failed", message: out?.message } };
  }
  return { status: 201, body: { ok: true } };
}

async function login(req, body) {
  const role = roleOf(body);
  const email = String(body?.email || "").trim();
  const password = String(body?.password || "");
  const row = await staffRow(email, role);

  /* The same answer whether the address is unknown or the password
     is wrong. Saying which would turn this into a way to find out
     who has an account. */
  const no = { status: 401, body: { error: "no", message: "That email and password do not match." } };

  if (!row) return no;

  if (row.lockedUntil && Date.parse(row.lockedUntil) > Date.now()) {
    return {
      status: 429,
      body: { error: "locked", message: "Too many attempts. Try again in a few minutes." },
    };
  }

  if (!c.verifyPassword(password, row.passwordHash)) {
    const n = (row.failedAttempts || 0) + 1;
    /* Ten minutes after five wrong tries, and then it clears itself.
       A lock an attacker can trigger and she cannot lift is a way to
       take her practice offline without guessing anything. */
    const lockedUntil = n >= 5 ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : "";
    await data.crm.staffPatch(row.id, { failedAttempts: n, lockedUntil });
    return no;
  }

  await data.crm.staffPatch(row.id, { failedAttempts: 0, lockedUntil: "" });

  const headers = {};

  // A device is enrolled: the password has bought a chance to prove
  // the second factor, and nothing else.
  if (row.totpConfirmedAt) {
    setCookie(
      headers,
      PENDING[role],
      c.sign({ sub: row.id, email: row.email, role, exp: Date.now() + PENDING_MS, mfa: false }, SECRET),
      PENDING_MS
    );
    return { status: 200, headers, body: { ok: true, next: "totp" } };
  }

  // No device yet. Signed in, and told plainly what is missing.
  await data.crm.staffPatch(row.id, { touchLogin: true });
  setCookie(
    headers,
    COOKIE[role],
    c.sign({ sub: row.id, email: row.email, role, exp: Date.now() + SESSION_MS, mfa: true }, SECRET),
    SESSION_MS
  );
  record(req, "auth.login", `${row.email} (${role})`, null, { totp: false }, row.email);
  return { status: 200, headers, body: { ok: true, next: "enrol" } };
}

async function totp(req, body) {
  const role = roleOf(body);
  const pending = c.unsign(readCookies(req)[PENDING[role]], SECRET);
  if (!pending) return { status: 401, body: { error: "expired", message: "That took too long — sign in again." } };

  const row = await staffRow(pending.email, role);
  if (!row?.totpSecret) return { status: 401, body: { error: "no" } };

  if (!c.verifyTotp(row.totpSecret, body?.code)) {
    return { status: 401, body: { error: "no", message: "That code is not right." } };
  }

  await data.crm.staffPatch(row.id, { touchLogin: true });

  const headers = {};
  clearCookie(headers, PENDING[role]);
  setCookie(
    headers,
    COOKIE[role],
    c.sign({ sub: row.id, email: row.email, role, exp: Date.now() + SESSION_MS, mfa: true }, SECRET),
    SESSION_MS
  );
  record(req, "auth.login", `${row.email} (${role})`, null, { totp: true }, row.email);
  return { status: 200, headers, body: { ok: true } };
}

/** Attach an authenticator app. Two steps: take the secret, then
    prove the app has it — an unconfirmed secret is never trusted,
    because trusting one locks her out of her own CRM. */
async function enrol(req, body) {
  const role = roleOf(body);
  const who = current(req, role);
  if (!who) return { status: 401, body: { error: "sign_in_first" } };

  const row = await staffRow(who.email, role);
  if (!row) return { status: 401, body: { error: "no" } };

  if (body?.code) {
    if (!row.totpSecret) return { status: 400, body: { error: "start_again" } };
    if (!c.verifyTotp(row.totpSecret, body.code)) {
      return { status: 400, body: { error: "no", message: "That code is not right — check the clock on your phone." } };
    }
    await data.crm.staffPatch(row.id, { confirmTotp: true });
    record(req, "auth.totp.enrol", who.email, null, null);
    return { status: 200, body: { ok: true, confirmed: true } };
  }

  const secret = c.newTotpSecret();
  await data.crm.staffPatch(row.id, { totpSecret: secret });
  return {
    status: 200,
    body: {
      ok: true,
      secret,
      // The string a QR encodes. Shown as text as well, because
      // typing 32 characters beats being unable to scan.
      otpauth: c.otpauthURL(secret, who.email, ISSUER),
    },
  };
}

function logout(req, body) {
  const role = roleOf(body);
  const who = current(req, role);
  if (who) record(req, "auth.logout", `${who.email} (${role})`, null, null);
  const headers = {};
  clearCookie(headers, COOKIE[role]);
  clearCookie(headers, PENDING[role]);
  return { status: 200, headers, body: { ok: true } };
}

module.exports = { state, setup, login, totp, enrol, logout, current, record, COOKIE, SECRET: () => SECRET };
