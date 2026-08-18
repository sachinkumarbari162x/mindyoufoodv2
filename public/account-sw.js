/* ============================================================
   ACCOUNT — SERVICE WORKER
   ------------------------------------------------------------
   Two jobs, and it is worth being clear which is which because
   they want opposite caching strategies.

     THE SHELL — the HTML, the four stylesheets, the five
     scripts, the icon. Never changes between deploys, and when
     it does the version below changes with it. Cache first: the
     app should open in the time it takes to draw, on a train,
     with no network at all.

     THE DATA — GET /api/client/me. Changes every time she edits
     a plan and every time they tick something. Network first,
     and the last good answer kept, so opening the app without
     signal shows yesterday's breakfast rather than a spinner.

   WHAT IT MUST NOT DO, and each of these has a reason:

     NEVER CACHE A POST. A cached check-in is a tick that looks
     recorded and is not. Writes go through the outbox in
     account/outbox.js, which survives a reload; this file does
     not touch them.

     NEVER CACHE A 401. The signed-out answer served from cache
     is a client who cannot get back in until they clear their
     browser data, and they will not know that is the fix.

     NEVER SERVE ANOTHER CLIENT'S DATA. This is single-user by
     construction — the cache lives in one browser profile behind
     one HttpOnly cookie — but signing out must still empty it,
     and it does: the page posts CLEAR_CACHE on the way out.

   CACHE VERSION: bump on any change to the shell list, or the
   old files are served for ever. Old caches are deleted on
   activate, so a bump is also the uninstall.
   ============================================================ */

/* Bumped whenever the shell list or any of its files changes —
   without it, the old ones are served for ever. v2: the outbox,
   the weigh-in and the day note. */
const VERSION = "account-v6";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;

/* Everything needed to draw a signed-in screen with no network.
   Listed rather than globbed: a service worker that guesses at
   its own dependencies caches half of them. */
const SHELL_FILES = [
  "/account.html",
  "/assets/css/account/tokens.css",
  "/assets/css/account/frame.css",
  "/assets/css/account/components.css",
  "/assets/css/account/phone.css",
  "/assets/css/account/gate.css",
  "/assets/js/account/api.js",
  "/assets/js/account/format.js",
  "/assets/js/account/outbox.js",
  "/assets/js/account/views.js",
  "/assets/js/account/phone.js",
  "/assets/js/account/gate.js",
  "/assets/js/account/app.js",
  "/assets/img/account-icon.svg",
  "/assets/account.webmanifest",
];

const ME = "/api/client/me";

/* ---- install ---------------------------------------------------
   `addAll` is atomic: one 404 in the list and the whole install
   fails, which is the behaviour to want. A partially cached shell
   is an app that opens offline and then breaks on a missing
   stylesheet, which is harder to diagnose than one that never
   claimed to work. */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

/* ---- activate --------------------------------------------------
   Delete every cache that is not this version's. This is how a
   deploy takes effect, and how a bad cache is recovered from. */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n !== SHELL && n !== DATA)
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---- fetch ----------------------------------------------------- */

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /* Writes are none of this file's business. Letting them fall
     through untouched is not laziness — it is the only correct
     handling. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* THE PAYLOAD. Network first, and the last good one kept.

     A 401 is passed through and NOT cached: the client is signed
     out and must be allowed to see that, or they sit looking at
     stale data wondering why nothing updates. */
  if (url.pathname === ME) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(DATA).then((cache) => cache.put(ME, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(ME);
          if (cached) {
            /* Marked, so the page can say "last updated at 08:14"
               rather than presenting yesterday as today. A client
               acting on a plan she changed this morning is the
               failure this header exists to prevent. */
            const body = await cached.text();
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-From-Cache": "1",
                "X-Cached-At": cached.headers.get("date") || "",
              },
            });
          }
          return new Response(
            JSON.stringify({ error: "offline", message: "You are offline." }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        })
    );
    return;
  }

  /* Every other API call goes to the network and is not cached.
     Sign-in especially: a cached code request would be a code
     nobody sent. */
  if (url.pathname.startsWith("/api/")) return;

  /* A NAVIGATION always resolves to the shell. Opening
     /account.html#diet with no network must give the app, not the
     browser's dinosaur. */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/account.html"))
    );
    return;
  }

  /* THE SHELL. Cache first, and a background refresh so a deploy
     lands on the second open rather than never. */
  event.respondWith(
    caches.match(request).then((cached) => {
      const live = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || live;
    })
  );
});

/* ---- signing out ----------------------------------------------
   The page asks for this on the way out. A health record left in
   a cache on a shared phone is the thing this handles, and it is
   the only reason this worker listens for messages at all. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.delete(DATA).then(() => {
        if (event.source) event.source.postMessage({ type: "CACHE_CLEARED" });
      })
    );
  }
});
