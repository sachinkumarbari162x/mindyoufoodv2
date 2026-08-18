/* ============================================================
   ACCOUNT · API
   ------------------------------------------------------------
   The only module here that knows the network exists.

   THE CREDENTIAL IS NOT IN THIS FILE, and cannot be. It is an
   HttpOnly cookie: the browser attaches it, no script reads it,
   and `credentials: "same-origin"` is all this module says about
   authentication. That is the whole reason the panel can be
   plain JavaScript on a static page — there is nothing on the
   client worth stealing.

   Every call answers {ok, ...} or {ok:false, error}. Nothing
   here throws at its caller: a screen that half-renders because
   a fetch rejected is worse than a screen that says it could
   not load.
   ============================================================ */
(function () {
  "use strict";

  const BASE = "/api/client";

  /* Long enough for a phone on a train, short enough that a dead
     connection is reported rather than spun over for ever. */
  const TIMEOUT_MS = 12000;

  async function call(path, options) {
    const opts = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(BASE + path, {
        method: opts.body ? "POST" : "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        // Sends the cookie; sends nothing else.
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, ...data };

      /* WHERE THIS ANSWER CAME FROM. The service worker marks a
         reply it served out of the cache, and the page says so —
         a client acting this morning on a plan she rewrote last
         night is exactly the harm a silent stale screen does. */
      const fromCache = res.headers.get("X-From-Cache") === "1";
      const cachedAt = fromCache ? whenCached(res.headers.get("X-Cached-At")) : null;

      return { ok: true, status: res.status, fromCache, cachedAt, ...data };
    } catch (err) {
      /* A network failure and a refusal are different things and
         are reported differently: the panel retries one and asks
         the client to sign in again for the other. */
      return {
        ok: false,
        status: 0,
        error: err.name === "AbortError" ? "timeout" : "offline",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* "at 08:14" / "on 17 August" — near things get a time, older
     ones get a date, because "at 08:14" three days later is worse
     than no answer at all. */
  function whenCached(header) {
    if (!header) return null;
    const at = new Date(header);
    if (isNaN(at)) return null;
    const sameDay = at.toDateString() === new Date().toDateString();
    if (sameDay) {
      let h = at.getHours();
      const m = String(at.getMinutes()).padStart(2, "0");
      const suffix = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return `at ${h}:${m} ${suffix}`;
    }
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `on ${at.getDate()} ${months[at.getMonth()]}`;
  }

  window.accountApi = {
    /** Ask for a six-digit code. Answers the same either way. */
    requestCode: (email) => call("/code", { body: { email } }),

    /** Trade the code for a session. The cookie arrives in the
        response headers; nothing is returned to store. */
    openSession: (email, code) => call("/session", { body: { email, code } }),

    /** The link in their pocket, /me/<token>, traded for a narrow
        session. Never widens: the server decides the scope. */
    openFromToken: (token) => call("/session/from-token", { body: { token } }),

    /** A weight, a note about the day, and a photo for a tick. */
    weight: (kg) => call("/weight", { body: { kg } }),
    note: (body) => call("/note", { body: { body } }),

    /** Everything the panel draws. */
    me: () => call("/me"),

    /** One line of the plan, ticked. */
    checkin: (itemId, state, note) =>
      call("/checkin", { body: { itemId, state, note: note || "" } }),

    /** Ask to be seen again. Does not book anything. */
    askForSession: (note) => call("/review", { body: { note: note || "" } }),

    logout: () => call("/logout", { body: {} }),
  };
})();
