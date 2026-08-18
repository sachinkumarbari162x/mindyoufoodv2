/* ============================================================
   BUSINESS RULES · RATE LIMITING

   In-memory sliding windows. Deliberately not Redis: this box
   runs one process (see backend-deploy-target — 512 MB Lightsail,
   inline mode), and a limiter that needs another service to be up
   is a limiter that fails open on the day it matters.

   Buckets are keyed by hashed IP, never raw — the same rule the
   upstream API follows.
   ============================================================ */
"use strict";

const crypto = require("node:crypto");
const { config } = require("../config");

const buckets = new Map(); // key → number[] (timestamps)

function hashIp(ip) {
  return crypto
    .createHash("sha256")
    .update(String(ip || "unknown") + config.privacy.ipSalt)
    .digest("hex")
    .slice(0, 24);
}

/**
 * @returns {{ok:boolean, retryAfter:number, remaining:number}}
 */
function take(key, points, windowMs, now) {
  const t = now || Date.now();
  const cutoff = t - windowMs;
  let hits = buckets.get(key);
  if (!hits) buckets.set(key, (hits = []));

  // Drop expired entries in place — these arrays stay tiny (bounded
  // by `points`), so a filter per call is cheaper than any index.
  let keep = 0;
  for (const ts of hits) if (ts > cutoff) hits[keep++] = ts;
  hits.length = keep;

  if (hits.length >= points) {
    return { ok: false, retryAfter: Math.ceil((hits[0] + windowMs - t) / 1000), remaining: 0 };
  }
  hits.push(t);
  return { ok: true, retryAfter: 0, remaining: points - hits.length };
}

const L = config.limits;

const perSessionMessage = (sid) => take(`msg:${sid}`, L.messagesPerMinute, 60_000);
const perIpMessage = (ipHash) => take(`ipmsg:${ipHash}`, L.messagesPerIpPer10Min, 600_000);
const perIpBooking = (ipHash) => take(`book:${ipHash}`, L.bookingsPerIpPerHour, 3_600_000);
/* Twenty new conversations an hour from one address is generous for
   a stranger and nothing at all for a machine that is being worked
   on: a morning of testing exhausts it, and the desk then refuses to
   start for everybody on that connection — including her.

   That is what happened. The desk looked broken when it was doing
   exactly what it was told, and the only symptom was an empty chat
   window, because a 429 on /session leaves nothing to draw.

   Loopback is exempt. A limit exists to stop a stranger flooding the
   desk; nobody reaches it over 127.0.0.1 except the person building
   it. Every other address is limited exactly as before. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

const perIpSession = (ipHash, ip) =>
  LOOPBACK.has(ip) ? { ok: true, local: true } : take(`sess:${ipHash}`, L.sessionsPerIpPerHour, 3_600_000);

/* Empty buckets accumulate for every IP that ever visited. Swept
   on the same timer as sessions rather than on every request, so a
   burst never pays for the cleanup. */
function sweep(now) {
  const t = now || Date.now();
  for (const [key, hits] of buckets) {
    if (!hits.length || hits[hits.length - 1] < t - 3_600_000) buckets.delete(key);
  }
}

module.exports = {
  hashIp, take, sweep,
  perSessionMessage, perIpMessage, perIpBooking, perIpSession,
  size: () => buckets.size,
};
