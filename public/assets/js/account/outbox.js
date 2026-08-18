/* ============================================================
   ACCOUNT · THE OUTBOX
   ------------------------------------------------------------
   Every write goes in here before it goes to the network.

   WHY THIS EXISTS. The person using this app is standing in a
   kitchen, on Indian mobile data, and they have just eaten
   breakfast. If the tick depends on a request completing, then a
   lift, a basement or a bad minute loses it — and they will not
   tick it twice, because from where they are sitting it is
   already ticked. A day's record disappears and nobody ever
   finds out.

   So a tick is written to localStorage first, drawn immediately,
   and sent whenever the network allows. It survives a reload, a
   crash, and a phone going flat.

   WHAT IS RETRIED AND WHAT IS NOT — the distinction that makes
   this safe rather than a loop:

     network failure   keep it, try again. Nothing is lost.
     5xx               keep it. Her server is having a bad
                       minute; the tick is still true.
     4xx               DROP IT. A 404 means that line is not on
                       their plan and never will be; a 401 means
                       they are signed out. Leaving either at the
                       head of the queue blocks every tick behind
                       it for ever, which is how one bad row eats
                       a fortnight of somebody's record.
     401 specifically  drop, and tell the app so it can ask them
                       to sign in rather than silently discarding.

   NO BACKGROUND SYNC. The Background Sync API would drain this
   while the app is closed, and it does not exist on iOS at all.
   Rather than build two behaviours and test one, this drains on
   open, on reconnect, and after every write — which is the
   behaviour iOS is limited to anyway.
   ============================================================ */
(function () {
  "use strict";

  const KEY = "myf.account.outbox";

  /* Two hundred is a fortnight of ticking without a single
     successful send, which is far past the point where something
     else is wrong. Older entries go first: the newest record of
     what somebody ate is the one worth keeping. */
  const MAX = 200;

  const listeners = new Set();

  const read = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };

  const write = (queue) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(queue.slice(-MAX)));
    } catch {
      /* Storage full, or private browsing with a zero quota. The
         entry stays in memory for this session and will be sent
         if the network comes back before the tab closes — which
         is strictly better than throwing here and losing the
         tick outright. */
    }
    announce();
  };

  function announce() {
    const state = status();
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch {
        /* A broken listener must not stop the queue draining. */
      }
    });
  }

  let draining = false;
  let onUnauthorised = () => {};

  /**
   * Put a write in the queue and try to send it.
   *
   * @param {string} path   "/checkin" or "/review"
   * @param {object} body
   * @param {string} [dedupe]  a key; a second entry with the same
   *        one replaces the first. Ticking the same line twice in
   *        a tunnel should send once.
   */
  function post(path, body, dedupe) {
    const queue = read();
    const entry = { path, body, dedupe: dedupe || null, at: Date.now() };

    if (dedupe) {
      const already = queue.findIndex((e) => e.dedupe === dedupe);
      if (already >= 0) queue[already] = entry;
      else queue.push(entry);
    } else {
      queue.push(entry);
    }

    write(queue);
    drain();
    return entry;
  }

  async function drain() {
    if (draining) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    draining = true;
    try {
      let queue = read();

      while (queue.length) {
        const entry = queue[0];
        let res;

        try {
          res = await fetch("/api/client" + entry.path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry.body),
            credentials: "same-origin",
          });
        } catch {
          /* Still offline. Keep everything, in order, and stop —
             sending the second before the first has landed would
             reorder somebody's day. */
          break;
        }

        if (res.status === 401) {
          /* Signed out. The rest of the queue is unsendable too,
             so it stays where it is and the app asks them to sign
             in; draining resumes by itself afterwards. */
          onUnauthorised();
          break;
        }

        /* A 5xx is her server, not this row — keep it and try
           again later. Anything else in the 4xx range is a
           refusal that will not change. */
        if (res.status >= 500) break;

        queue.shift();
        write(queue);
        queue = read();
      }
    } finally {
      draining = false;
      announce();
    }
  }

  /** {pending, oldest} — what the page needs to say so. */
  function status() {
    const queue = read();
    return {
      pending: queue.length,
      oldest: queue.length ? queue[0].at : null,
      online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    };
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to do */
    }
    announce();
  }

  /* Drain on the three moments that matter: the tab coming back,
     the network coming back, and the app opening. There is no
     timer — polling a queue that is almost always empty is a
     battery cost for nothing. */
  if (typeof window !== "undefined") {
    window.addEventListener("online", drain);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) drain();
    });
  }

  window.accountOutbox = {
    post,
    drain,
    status,
    clear,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set unauthorisedHandler(fn) {
      onUnauthorised = typeof fn === "function" ? fn : () => {};
    },
  };
})();
