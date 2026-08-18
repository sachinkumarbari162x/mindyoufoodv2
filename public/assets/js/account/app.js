/* ============================================================
   ACCOUNT · APP
   ------------------------------------------------------------
   Boot, the router, and the three things a client can change.

   ONE FETCH ON LOAD. Everything on all nine screens comes from
   GET /api/client/me, so switching screen is instant and costs
   nothing — a client checking whether their session is on
   Thursday should not wait for a network round trip to find out.
   After a write, the panel re-reads once and redraws.
   ============================================================ */
(function () {
  "use strict";

  const api = window.accountApi;
  const views = window.accountViews;

  const shell = document.getElementById("shell");
  const main = document.getElementById("main");

  /* The payload, exactly as the server sent it. Nothing else in
     this file keeps state — a second copy of the truth is how a
     tick ends up showing on one screen and not on another. */
  let state = null;

  const ROUTES = {
    summary: views.summary,
    plan: views.plan,
    diet: views.diet,
    calendar: views.calendar,
    sleep: views.sleep,
    workout: views.workout,
    supplements: views.supplements,
    sessions: views.sessions,
    records: views.records,
    faq: views.faq,
    account: views.account,
  };

  let current = "summary";

  function show(route) {
    const name = ROUTES[route] ? route : "summary";
    current = name;

    if (state) ROUTES[name](state);

    document.querySelectorAll(".acc-view").forEach((v) => {
      v.hidden = v.id !== `view-${name}`;
    });
    document.querySelectorAll(".acc-nav").forEach((n) => {
      const on = n.dataset.route === name;
      if (on) n.setAttribute("aria-current", "page");
      else n.removeAttribute("aria-current");
    });

    /* The hash so a screen can be reloaded onto, and the back
       button works. It carries a screen name and nothing else —
       no id, nothing about who is looking. */
    if (location.hash.slice(1) !== name) {
      history.replaceState(null, "", `#${name}`);
    }
    main.scrollTop = 0;
    window.scrollTo(0, 0);

    /* The phone layer listens for this: it rebuilds the More sheet
       from whatever nav items are currently visible, and resets the
       compact title bar. Announced rather than called, so app.js
       does not have to know the phone layer exists — and the panel
       still works with phone.js absent. */
    window.dispatchEvent(new CustomEvent("account:drawn", { detail: { route: name } }));
  }

  /** Redraw whichever screen is open, from current state. */
  function redraw() {
    if (state) ROUTES[current](state);
  }

  /* ---- loading ------------------------------------------------- */

  /* THE LINK IN THEIR POCKET. /me/<token> serves this same page,
     so the token is in the address and nowhere else — read it,
     trade it for a session, and take it out of the URL so it does
     not sit in the history of a borrowed phone.

     A token session is narrow by construction: the server sends
     no receipts, no lab results, no documents and no contact
     details. See migration 0008. */
  async function fromLink() {
    const match = /^\/me\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location.pathname);
    if (!match) return false;

    const out = await api.openFromToken(match[1]);

    /* Out of the address either way. A token that did not work is
       still a token, and leaving a dead one in the history helps
       nobody. */
    history.replaceState(null, "", "/account.html" + (location.hash || ""));

    return out.ok === true;
  }

  async function load() {
    let out = await api.me();

    /* No session yet, but there may be a link. Tried once, and
       only on a 401 — a working session must never be traded down
       to a narrow one because somebody re-opened an old link. */
    if (!out.ok && out.status === 401 && /^\/me\//.test(location.pathname)) {
      if (await fromLink()) out = await api.me();
    }

    if (!out.ok) {
      if (out.status === 401) {
        shell.hidden = true;
        window.accountGate.open(load);
        return false;
      }
      // Everything else is a service problem, not a sign-in
      // problem, and saying "sign in again" would send a client
      // round a loop that cannot help them.
      shell.hidden = false;
      document.querySelector('[data-slot="greeting"]').textContent = "We could not load your account";
      document.querySelector('[data-slot="standing"]').textContent =
        "Something is wrong at our end, not yours. Try again in a minute — nothing you have recorded is lost.";
      return false;
    }

    state = out;
    shell.hidden = false;

    /* The service worker marks an answer it served from the
       cache. Saying so matters: a client acting this morning on a
       plan she rewrote last night is the failure a quiet stale
       screen causes. */
    paintState({ fromCache: out.fromCache === true, cachedAt: out.cachedAt || null });
    /* The name in the sidebar, once, on load. It used to be set by
       the Account screen's own render, which meant the sidebar
       read "Account" until somebody visited Account — the one
       screen where their own name is least surprising. */
    document.querySelectorAll('[data-slot="nav-name"]').forEach((el) => {
      el.textContent = out.person.firstName || "Account";
    });
    /* WHAT A TOKEN SESSION CANNOT REACH IS NOT SHOWN.

       The server has already withheld the data — these screens
       would render empty — but a nav item that opens an empty
       screen reads as something broken rather than something
       withheld. Hidden, with one line on Account saying why and
       how to get in properly. */
    const narrow = out.scope === "programme";
    document.querySelectorAll(".acc-nav").forEach((n) => {
      if (["records", "account"].includes(n.dataset.route)) n.hidden = narrow;
    });
    if (narrow && ["records", "account"].includes(location.hash.slice(1))) {
      location.hash = "#summary";
    }

    show(location.hash.slice(1) || "summary");
    return true;
  }

  /* ---- the three things a client can do ------------------------ */

  /* A TICK IS SHOWN IMMEDIATELY AND CONFIRMED AFTERWARDS.
     Waiting for the server before filling the circle makes the
     panel feel broken on a slow connection; showing it and never
     checking would let a failed write look like a recorded meal.
     So: fill it, mark it in flight, and put it back with an
     explanation if the server refuses. */
  async function tick(row) {
    const itemId = row.dataset.item;
    if (!itemId || row.classList.contains("saving")) return;

    const already = !!(state.today && state.today[itemId]);
    if (already) {
      // Untick is not a thing the API offers: a check-in is a
      // record of something that happened. Say so once rather
      // than silently doing nothing.
      flash(row, "Already recorded for today");
      return;
    }

    /* THROUGH THE OUTBOX, NOT STRAIGHT AT THE NETWORK.

       This used to await the POST and put the tick back if it
       failed. On a kitchen wifi that is right; in a basement it
       loses the tick, and the client will not tick it again
       because from where they are standing it is already ticked.

       The queue survives a reload and a flat battery. The tick is
       true the moment they made it; sending is this app's problem
       and not theirs. */
    row.classList.add("checked");
    window.accountOutbox.post("/checkin", { itemId, state: "done", note: "" }, itemId);

    state.today[itemId] = { state: "done", note: "" };
    redraw();
  }

  /* A one-line explanation next to the thing it is about, gone
     again in a few seconds. Not an alert: this panel is used with
     a plate in the other hand. */
  function flash(row, message) {
    const existing = row.querySelector(".flash");
    if (existing) existing.remove();
    const note = document.createElement("span");
    note.className = "flash reps";
    note.style.color = "var(--danger)";
    note.textContent = message;
    row.appendChild(note);
    setTimeout(() => note.remove(), 3200);
  }

  async function askForSession(button) {
    button.disabled = true;
    const note = document.querySelector('[data-slot="req-note"]');
    const text = document.querySelector('[data-slot="req-text"]');

    /* Queued like a tick, and deduped: pressing twice in a tunnel
       is one request, not two she has to work out are the same
       person asking the same thing. */
    window.accountOutbox.post("/review", { note: (text && text.value) || "" }, "review");

    button.textContent = "Request sent";
    if (note) {
      note.textContent = window.accountOutbox.status().pending
        ? "Saved. It will go as soon as you have signal."
        : "Sent. Khadija reads every request herself and will offer you a time.";
    }
  }

  /* A WEIGHT AND A NOTE — the two things the token app at /me/
     could do and this one could not. Both go through the outbox
     like a tick: somebody weighing themselves at seven in the
     morning in a flat with bad signal should not lose the number.

     Bounds are checked here as well as on the server, not instead
     of it. The point of doing it here is the SENTENCE — "that
     does not look like a weight" arrives instantly and next to
     the box, rather than as a round trip and a status code. */
  async function saveWeight(button) {
    const input = document.getElementById("weigh-kg");
    const said = document.querySelector('[data-slot="weigh-said"]');
    const kg = Number(input && input.value);

    const say = (text, bad) => {
      if (!said) return;
      said.textContent = text;
      said.hidden = !text;
      said.classList.toggle("bad", !!bad);
    };

    if (!Number.isFinite(kg) || kg < 20 || kg > 400) {
      say("That does not look like a weight.", true);
      if (input) input.focus();
      return;
    }

    window.accountOutbox.post("/weight", { kg }, "weight");
    button.disabled = true;
    if (input) input.value = "";

    /* Drawn straight onto the series so the "Last:" line and the
       chart move now, rather than after the next full reload. The
       server is the one that decides the date; this is today by
       construction because it was just typed. */
    const today = new Date().toISOString().slice(0, 10);
    state.weight = (state.weight || []).filter((p) => p.on !== today);
    state.weight.push({ on: today, value: kg });

    say(
      window.accountOutbox.status().pending
        ? "Saved. It will go as soon as you have signal."
        : `Recorded — ${kg} kg.`
    );
    setTimeout(() => redraw(), 1200);
  }

  async function saveNote(button) {
    const box = document.querySelector('[data-slot="day-note"]');
    const said = document.querySelector('[data-slot="note-said"]');
    const text = (box && box.value ? box.value : "").trim();

    if (!text) {
      if (box) box.focus();
      return;
    }

    window.accountOutbox.post("/note", { body: text });
    button.disabled = true;
    if (box) box.value = "";
    if (said) {
      said.hidden = false;
      said.textContent = window.accountOutbox.status().pending
        ? "Saved. It will go as soon as you have signal."
        : "Sent. She reads these before your review.";
    }
  }

  async function signOut(button) {
    button.disabled = true;
    button.textContent = "Signing out…";
    await api.logout();

    /* THE CACHE GOES WITH THE SESSION. A health record left in a
       service worker cache on a shared phone is the thing that
       makes "sign out" a lie. The outbox goes too — anything
       still queued belongs to the person signing out. */
    window.accountOutbox.clear();
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "CLEAR_CACHE" });
    }

    state = null;
    shell.hidden = true;
    window.accountGate.open(load);
  }

  /* ---- one listener for the whole panel -------------------------
     Every screen is rebuilt from scratch on each draw, so binding
     handlers to elements would mean rebinding them constantly —
     and the one that gets missed is the bug. This delegates from
     the container instead, and nothing below it ever needs to
     know it was replaced. */

  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-route]");
    if (nav) {
      show(nav.dataset.route);
      return;
    }

    const head = event.target.closest(".acc-head");
    if (head) {
      const panel = head.closest(".acc");
      const open = panel.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
      return;
    }

    const row = event.target.closest(".item");
    if (row) {
      tick(row);
      return;
    }

    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "ask-session") askForSession(action);
      if (action.dataset.action === "sign-out") signOut(action);
      if (action.dataset.action === "save-weight") saveWeight(action);
      if (action.dataset.action === "save-note") saveNote(action);
      return;
    }

    /* Documents are not downloadable yet — the bytes live in the
       storage service and the route to fetch one as a client is
       not built. Saying so plainly beats a button that appears to
       do nothing, and beats a link to a 404. */
    const download = event.target.closest("[data-download]");
    if (download) {
      const holder = download.closest(".rec").querySelector(".rm-meta small");
      if (holder && !holder.dataset.was) {
        holder.dataset.was = holder.textContent;
        holder.textContent = "Downloading is not ready yet — ask Khadija for a copy.";
        setTimeout(() => {
          holder.textContent = holder.dataset.was;
          delete holder.dataset.was;
        }, 3600);
      }
    }
  });

  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (name && name !== current) show(name);
  });

  /* Adding a document is the same story as downloading one: the
     upload route is not built, and the honest thing is to say so
     rather than to accept a file and drop it. */
  const file = document.getElementById("rec-file");
  if (file) {
    file.addEventListener("change", () => {
      if (!file.files.length) return;
      file.value = "";
      const zone = document.getElementById("dropzone");
      const line = zone.querySelector("p");
      if (line.dataset.was) return;
      line.dataset.was = line.textContent;
      line.textContent = "Uploading is not switched on yet — email it to her for now.";
      setTimeout(() => {
        line.textContent = line.dataset.was;
        delete line.dataset.was;
      }, 4000);
    });
  }

  /* ============================================================
     INSTALLING IT, AND SAYING SO WHEN IT IS OFFLINE
     ------------------------------------------------------------
     Three small things that only matter on a phone, which is
     where this app is actually used.
     ============================================================ */

  /* ---- the service worker --------------------------------------
     Registered after load so it never competes with the first
     paint for bandwidth. Failure is not reported: an app that
     works online and cannot cache is an app that works. */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/account-sw.js").catch(() => {
        /* Unsupported, or served over plain http from somewhere
           that is not localhost. Fine without it. */
      });
    });
  }

  /* ---- what the strip at the top says --------------------------
     One line, and it appears only when there is something true to
     say: they are offline, or something they did has not been
     sent yet, or what they are looking at came out of the cache.
     Silence the rest of the time. */
  /* WHAT THE STRIP KNOWS, in order of how much it can be trusted.

     `navigator.onLine` IS NOT THE TEST, and this is not a corner
     case. It reports the browser's link state, not whether her
     server is reachable: a captive portal, a hotel wifi that has
     stopped forwarding, a dead cell in a lift — every one of them
     reports `true` while nothing gets through. Chrome's own
     network emulation does the same thing, which is how this was
     found: eleven of thirteen checks passed and the app quietly
     told nobody it was offline.

     So the definitive signal is that the SERVICE WORKER SERVED
     FROM CACHE. That only happens when a real request to a real
     server really failed. `onLine` is kept as a last resort for
     the case where nothing has been fetched yet. */
  let servedFromCache = null;

  function paintState(cache) {
    const strip = document.getElementById("state-strip");
    if (!strip) return;

    if (cache !== undefined) servedFromCache = cache;

    const { pending, online } = window.accountOutbox.status();
    const stale = servedFromCache && servedFromCache.fromCache;
    const when = stale && servedFromCache.cachedAt ? ` ${servedFromCache.cachedAt}` : "";
    const things = (n) => `${n} thing${n === 1 ? "" : "s"}`;

    let message = "";

    if (stale && pending) {
      message = `Offline — showing what we last had${when}. ${things(pending)} you ticked will be sent when you are back.`;
    } else if (stale) {
      message = `Offline — showing what we last had${when}.`;
    } else if (!online && pending) {
      message = `Offline — ${things(pending)} you ticked will be sent when you are back.`;
    } else if (!online) {
      message = "Offline. This is what we last had.";
    } else if (pending) {
      message = `Sending ${things(pending)}…`;
    }

    strip.textContent = message;
    strip.hidden = !message;
  }

  /* Undefined, not null: these repaint with whatever is already
     known about where the last payload came from. Passing null
     would erase it and the strip would forget it is offline the
     moment a tick is queued. */
  window.accountOutbox.onChange(() => paintState());
  window.addEventListener("online", () => paintState());
  window.addEventListener("offline", () => paintState());

  /* A 401 from the queue means the cookie has gone. The tick is
     kept — they did eat it — and they are asked to sign in. */
  window.accountOutbox.unauthorisedHandler = () => {
    shell.hidden = true;
    window.accountGate.open(load);
  };

  /* ---- installing ---------------------------------------------
     Two entirely different jobs, because the two platforms are
     entirely different.

     ANDROID fires beforeinstallprompt and lets us show a button,
     so we show one.

     iOS HAS NO PROMPT AT ALL. Safari can install this — Share
     then Add to Home Screen — but nothing fires and no API can
     trigger it. The only honest thing is to tell them where the
     button is, and only on the browser that has it: Chrome on
     iOS cannot install a web app, so showing the instructions
     there would be sending somebody looking for a menu item that
     is not in their browser. */
  let installPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    const card = document.getElementById("install-card");
    const button = document.getElementById("install-button");
    if (card && button) {
      card.hidden = false;
      button.hidden = false;
      document.getElementById("install-ios").hidden = true;
    }
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    const card = document.getElementById("install-card");
    if (card) card.hidden = true;
  });

  const installButton = document.getElementById("install-button");
  if (installButton) {
    installButton.addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      const card = document.getElementById("install-card");
      if (card) card.hidden = true;
    });
  }

  /* Real Safari on a real iPhone or iPad, and not already
     installed. Chrome and Firefox on iOS are WebKit too, so the
     engine cannot be the test — the absence of their own vendor
     strings is. */
  function isIosSafari() {
    const ua = navigator.userAgent;
    const ios =
      /iPad|iPhone|iPod/.test(ua) ||
      // iPadOS 13+ reports itself as a Mac; the touch points give it away.
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const safari = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    const installed =
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    return ios && safari && !installed;
  }

  if (isIosSafari()) {
    const card = document.getElementById("install-card");
    const ios = document.getElementById("install-ios");
    if (card && ios) {
      card.hidden = false;
      ios.hidden = false;
    }
  }

  load();
})();
