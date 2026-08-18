/* ============================================================
   PROGRAMME — SERVICE WORKER, RETIRED
   ------------------------------------------------------------
   This worker used to run the old /me/ programme app. There is
   one client app now — the account panel — and /me/<token> opens
   it instead.

   THIS FILE CANNOT SIMPLY BE DELETED, and that is the whole
   reason it still exists.

   A client who added the old app to their home screen has this
   worker installed and CONTROLLING every request they make to
   this origin. It is cache-first. Left alone it would keep
   serving them the old programme.html out of its own cache for
   as long as the phone lasts — they would tap their icon, get an
   app that no longer exists, and have no way of knowing why.
   Deleting the file makes that worse rather than better: the
   browser keeps the last worker it successfully fetched, so a
   404 changes nothing at all.

   So the file stays and its job is now to remove itself. The
   browser checks for an updated worker on navigation; it will
   find this one, install it, and this one:

     1. deletes every cache the old app made,
     2. unregisters itself,
     3. reloads any open window, which — with no worker left —
        goes to the network and lands on the account panel.

   One visit and the old app is gone from that device. The next
   time they tap the icon they get the new one.

   The previous contents are kept beside this file as
   programme-sw.js.retired-2026-08-18, so nothing is lost.
   ============================================================ */

self.addEventListener("install", () => {
  // Do not wait for the old worker to be released. There is
  // nothing to hand over carefully to — this one only cleans up.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /* Everything, not a named list. This worker is being
         removed and none of what it cached will ever be wanted
         again — and the account panel's caches live under their
         own names, created by their own worker after this one has
         gone. */
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));

      await self.registration.unregister();

      /* And send whatever is open back through the network. Without
         this they sit looking at the old app until they close it —
         which on a home-screen app can be weeks. */
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((client) => client.navigate(client.url));
    })()
  );
});

/* NOTHING IS INTERCEPTED. No fetch handler at all, so every
   request goes straight to the network from the moment this
   activates — including the one that replaces the page. */
