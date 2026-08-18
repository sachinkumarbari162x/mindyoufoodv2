/* ============================================================
   CLIENT ACCOUNT ROUTES — the panel's whole back end
   ------------------------------------------------------------
   Six routes. The browser sends a cookie and nothing else; every
   id, token and address stays on this side of the wire.

     POST /api/client/code      "send me a code"
     POST /api/client/session   "here is the code"
     GET  /api/client/me        everything the panel draws
     POST /api/client/checkin   a tick on one line of the plan
     POST /api/client/review    ask to be seen again
     POST /api/client/logout    sign out

   THE COOKIE IS THE ONLY CREDENTIAL, and it is HttpOnly. No
   script on the page can read it, so the panel's JavaScript never
   holds anything worth stealing — which is the whole reason the
   markup carries no identifiers. Nothing in account.html says who
   is looking at it, and view-source on a signed-in session is as
   empty as one on a signed-out one.

   WHY THE CODE IS HASHED HERE AND NOT IN GO
   The same rule as staff passwords: one module owns scrypt, and
   it is auth/crypto.js. Go stores what it is given and compares
   nothing.

   WHAT THIS DELIBERATELY WILL NOT SAY
   "Send me a code" answers identically for an address that is a
   client and one that is not. The difference is real — a code is
   only ever stored and sent for a real one — but it is not
   observable, so the form cannot be used to find out who her
   clients are.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const c = require("../auth/crypto");
const data = require("../data-client");

const COOKIE = "myf_client";

/* Matches the session lifetime in client_auth.go. The two are
   written down twice on purpose — Go decides when the session
   dies, this only decides when the browser stops bothering to
   send it, and a browser that sends a dead cookie is a 401 the
   panel already handles. */
const COOKIE_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/* WHETHER A CODE IS EMAILED AT ALL. Off by default and
   deliberately so: mail that goes out is the one thing in this
   system nobody can take back, and the rule on this project is
   that send behaviour is flagged before it changes rather than
   after. Until this is turned on, sign-in works locally through
   CLIENT_CODE_ECHO below and sends nothing to anybody. */
const EMAIL_ON = process.env.CLIENT_CODE_EMAIL === "on";

/* Local development only: hand the code back in the response so
   there is something to type without a mail provider. Guarded
   twice — the flag AND not-production — because a flag left on
   by accident in production would print a working credential to
   anybody who asked for one. */
const ECHO =
  process.env.CLIENT_CODE_ECHO === "1" && process.env.NODE_ENV !== "production";

/* ---- cookies --------------------------------------------------
   Same shape as the CRM's, one difference: SameSite=Lax rather
   than Strict. A client will arrive here from a link in her
   email, and Strict drops the cookie on that first cross-site
   navigation — they land signed out, on the account they are
   signed in to. Lax sends it on a top-level GET and still
   withholds it from a cross-site POST, which is the case that
   matters. */
function setCookie(headers, value) {
  const bits = [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(COOKIE_LIFE_MS / 1000)}`,
  ];
  if (process.env.COOKIE_SECURE === "true") bits.push("Secure");
  const existing = headers["Set-Cookie"] || [];
  headers["Set-Cookie"] = [...(Array.isArray(existing) ? existing : [existing]), bits.join("; ")];
}

function clearCookie(headers) {
  const existing = headers["Set-Cookie"] || [];
  headers["Set-Cookie"] = [
    ...(Array.isArray(existing) ? existing : [existing]),
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
}

const tokenOf = (req) => c.readCookie(req.headers.cookie)[COOKIE] || "";

/* ---- the code -------------------------------------------------
   Six digits from crypto.randomInt, which is uniform — a
   `Math.random() * 900000` is not, and a code generator with a
   bias is a code generator with fewer codes than it claims. */
function sixDigits() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/* One answer for every outcome. Written once so it cannot drift
   apart between the branches below — which is exactly how this
   kind of leak normally appears. */
const SENT = {
  status: 200,
  body: {
    ok: true,
    message: "If that address is on our records, a code is on its way. It is good for 15 minutes.",
  },
};

/* ---- rate limiting --------------------------------------------
   Per address, in memory. Enough to stop a form being held down;
   the real ceiling is the five-guess burn in Go, which survives a
   restart because it is a column rather than a Map. */
const asked = new Map();
const ASK_WINDOW_MS = 10 * 60 * 1000;
const ASK_MAX = 5;

function tooMany(email) {
  const now = Date.now();
  const key = email.toLowerCase();
  const hits = (asked.get(key) || []).filter((t) => now - t < ASK_WINDOW_MS);
  hits.push(now);
  asked.set(key, hits);
  // Unbounded growth is a memory leak with a slow fuse; sweep on
  // the way past rather than running a timer for it.
  if (asked.size > 5000) {
    for (const [k, v] of asked) if (!v.some((t) => now - t < ASK_WINDOW_MS)) asked.delete(k);
  }
  return hits.length > ASK_MAX;
}

/* ---- POST /api/client/code ------------------------------------ */

async function requestCode(body) {
  const email = String(body?.email || "").trim();
  if (!email.includes("@") || email.length > 200) {
    // A malformed address is not a lookup, so it can be told apart
    // from a real one without leaking anything about who is a client.
    return { status: 400, body: { error: "bad_email", message: "That does not look like an email address." } };
  }
  if (tooMany(email)) return SENT;

  const code = sixDigits();
  const hash = c.hashPassword(code);

  const out = await data.client.codeStore({ email, hash, channel: "email" });
  if (!out?.ok) return SENT; // including "the data service is down"
  if (!out.found) return SENT; // nobody by that address — say the same thing

  if (EMAIL_ON) {
    try {
      const mail = require("../mail");
      await mail.send("client-code", { to: email, code, firstName: out.firstName });
    } catch (err) {
      // A code that was stored but not delivered is a code nobody
      // can use. Worth a line in the log; not worth telling the
      // browser, which would turn a mail outage into an oracle.
      console.warn(`[bff] client code not sent: ${err.message}`);
    }
  }

  if (ECHO) {
    return {
      status: 200,
      body: { ...SENT.body, devCode: code, devNote: "CLIENT_CODE_ECHO is on — local only" },
    };
  }
  return SENT;
}

/* ---- POST /api/client/session --------------------------------- */

async function openSession(req, body, ipHash) {
  const email = String(body?.email || "").trim();
  const code = String(body?.code || "").replace(/\D/g, "");
  if (!email || code.length !== 6) {
    return { status: 400, body: { error: "bad_code", message: "Six digits, from the email." } };
  }

  const found = await data.client.codeGet(email);
  if (!found?.ok || !found.code) {
    return {
      status: 400,
      body: { error: "no_code", message: "That code has expired. Ask for another." },
    };
  }

  if (!c.verifyPassword(code, found.code.hash)) {
    const miss = await data.client.codeMiss(found.code.id);
    const left = miss?.triesLeft ?? 0;
    return {
      status: 400,
      body: {
        error: "wrong_code",
        message: left > 0
          ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`
          : "That code is not right, and it has now expired. Ask for another.",
        triesLeft: left,
      },
    };
  }

  const out = await data.client.codeUse(found.code.id, {
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    ipHash: ipHash || "",
  });
  if (!out?.ok || !out.token) {
    return { status: 400, body: { error: "no_session", message: "Could not sign you in. Ask for another code." } };
  }

  const headers = {};
  setCookie(headers, out.token);
  /* The token goes in the cookie and NOWHERE in the body. The
     panel is told a first name so it can say hello and nothing
     else it could store, leak, or be tricked into sending on. */
  return {
    status: 200,
    headers,
    body: { ok: true, firstName: out.person?.firstName || "" },
  };
}

/* ---- POST /api/client/session/from-token ----------------------
   The link in their pocket. /me/<token> opens the account panel
   now, so the token has to become a session the panel can use.

   IT MINTS A NARROW ONE. Go writes `scope = programme` onto the
   session row and withholds the receipts, the labs, the documents
   and the contact details from every later read. That is not
   belt-and-braces for the hidden nav items — it is the actual
   control, because a token in a URL gets forwarded, screenshotted
   and read aloud, and somebody who finds one should get somebody's
   breakfast and not their haemoglobin. */
async function openFromToken(req, body, ipHash) {
  const token = String(body?.token || "").trim();
  if (token.length < 16 || token.length > 64) {
    return { status: 404, body: { error: "not_found", message: "That link is not valid." } };
  }

  const out = await data.client.sessionFromToken({
    token,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    ipHash: ipHash || "",
  });

  if (!out?.ok || !out.token) {
    /* One refusal for every failure — unknown, revoked, ended,
       expired — because telling them apart says whether a token
       was ever real. */
    return { status: 404, body: { error: "not_found", message: "That link is not valid." } };
  }

  const headers = {};
  setCookie(headers, out.token);
  return {
    status: 200,
    headers,
    body: { ok: true, scope: "programme", firstName: out.person?.firstName || "" },
  };
}

/* ---- GET /api/client/me --------------------------------------- */

async function me(req) {
  const token = tokenOf(req);
  if (!token) return { status: 401, body: { error: "no_session" } };

  const out = await data.client.me(token);
  if (!out?.ok) {
    /* A dead cookie is cleared on the way out. Leaving it means
       every load of the page starts with a 401 the panel has to
       recover from, for a credential that will never work again. */
    const headers = {};
    if (out?.status === 401) clearCookie(headers);
    return { status: out?.status || 502, headers, body: { error: out?.error || "unavailable" } };
  }
  return { status: 200, body: out };
}

/* ---- POST /api/client/checkin --------------------------------- */

async function checkin(req, body) {
  const token = tokenOf(req);
  if (!token) return { status: 401, body: { error: "no_session" } };

  const out = await data.client.checkin(token, {
    itemId: String(body?.itemId || ""),
    state: String(body?.state || ""),
    note: String(body?.note || "").slice(0, 500),
    date: String(body?.date || ""),
  });
  if (!out?.ok) return { status: out?.status || 400, body: { error: out?.error || "not_saved" } };
  return { status: 201, body: { ok: true } };
}

/* ---- POST /api/client/review ---------------------------------- */

async function review(req, body) {
  const token = tokenOf(req);
  if (!token) return { status: 401, body: { error: "no_session" } };

  const out = await data.client.review(token, {
    note: String(body?.note || "").slice(0, 1000),
  });
  if (!out?.ok) return { status: out?.status || 400, body: { error: out?.error || "not_saved" } };
  /* `already` is not a failure and is not reported as one. Asking
     twice gets the same calm answer as asking once, because from
     where the client is sitting it is the same request. */
  return { status: 200, body: { ok: true, already: out.already === true } };
}

/* ---- the three the panel was missing --------------------------
   Recording a weight, writing a note against the day, and
   attaching a photograph. The token app at /me/ has had all
   three since it was built; the account panel had none of them,
   which is what made collapsing the two apps into one a removal
   rather than a merge. */

async function weight(req, body) {
  const token = tokenOf(req);
  if (!token) return { status: 401, body: { error: "no_session" } };

  const kg = Number(body && body.kg);
  if (!Number.isFinite(kg)) {
    return { status: 400, body: { error: "invalid", message: "That does not look like a weight." } };
  }

  const out = await data.client.weight(token, { kg });
  if (!out?.ok) {
    return {
      status: out?.status || 400,
      body: { error: out?.error || "not_saved", message: out?.message },
    };
  }
  return { status: 201, body: { ok: true } };
}

async function note(req, body) {
  const token = tokenOf(req);
  if (!token) return { status: 401, body: { error: "no_session" } };

  const out = await data.client.note(token, {
    body: String(body?.body || "").slice(0, 2000),
    date: String(body?.date || ""),
  });
  if (!out?.ok) {
    return {
      status: out?.status || 400,
      body: { error: out?.error || "not_saved", message: out?.message },
    };
  }
  return { status: 201, body: { ok: true, noteId: out.noteId } };
}

/* THE BYTES GO TO STORAGE FIRST, THEN THE ROW IS WRITTEN. If the
   store accepts the file and the database call then fails, the
   worst outcome is an orphan file — recoverable, and cheap. The
   other order gives a row pointing at nothing, which is a broken
   image on her screen with no way to tell which client it was.

   `raw` is the request body as bytes: an image posted with its
   own Content-Type rather than as multipart or base64, which is
   how the token app has always done it. */
async function media(req, raw, checkinId, takenAt) {
  const token = tokenOf(req);
  if (!token) return { status: 401, body: { error: "no_session" } };
  if (!checkinId) return { status: 400, body: { error: "invalid", message: "Which day?" } };

  /* The folder comes from the SESSION, never from the request.
     Nothing a caller sends chooses where a file lands. */
  const storage = require("../storage");
  const crypto = require("crypto");
  const scope = "c/" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);

  const kept = await storage.put(raw, scope);
  if (!kept.ok) {
    return { status: 400, body: { error: "rejected", message: kept.why } };
  }

  const out = await data.client.media(token, {
    checkinId,
    storageKey: kept.key,
    mime: kept.mime,
    bytes: kept.bytes,
    sha256: kept.sha256,
    takenAt: takenAt || null,
  });
  if (!out?.ok) {
    return {
      status: out?.status || 400,
      body: { error: out?.error || "not_saved", message: out?.message },
    };
  }
  return { status: 201, body: { ok: true, id: out.id } };
}

/* ---- POST /api/client/logout ---------------------------------- */

async function logout(req) {
  const token = tokenOf(req);
  if (token) await data.client.revoke(token);
  const headers = {};
  clearCookie(headers);
  return { status: 200, headers, body: { ok: true } };
}

module.exports = {
  requestCode, openSession, openFromToken, me, checkin, review,
  weight, note, media, logout, COOKIE,
};
