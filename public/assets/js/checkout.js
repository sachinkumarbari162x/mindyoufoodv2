/* ============================================================
   CHECKOUT — a card, mounted wherever it is needed
   ------------------------------------------------------------
   This was a page. It is now a card that knows how to render
   itself into any container, because the till belongs INSIDE the
   front desk: a visitor who has just said yes should not watch a
   page load, a background repaint and a window disappear in order
   to be shown a price they already agreed to.

   Two callers, one definition:

     the desk        swaps its chat window for this card, in
                     place, on the same room. No navigation.

     checkout.html   a thin shell for the same card, for anybody
                     arriving from the email link later — which is
                     a real entrance and needs a real page.

   THE MARKUP LIVES HERE, not in either of them, so the two
   cannot drift into two slightly different tills.

   ---- WHAT IS TRUSTED ----------------------------------------
   Nothing this file says is believed by the server. It reports
   what Razorpay handed back; the server checks that against the
   key secret it alone holds. Editing anything here changes what
   the visitor is shown and nothing about what is true.
   ============================================================ */
(() => {
  "use strict";

  const TEMPLATE = `
    <section class="state" data-state="loading" hidden>
      <div class="pulse" aria-hidden="true"></div>
      <p class="quiet">Finding your booking…</p>
    </section>

    <section class="state" data-state="ready" hidden>
      <p class="eyebrow">Confirm your consultation</p>
      <h1 class="when">
        <span class="when-day" data-day></span>
        <span class="when-time" data-time></span>
      </h1>
      <p class="how" data-how></p>
      <div class="rule" role="presentation"></div>
      <div class="price">
        <span class="price-label">Consultation fee</span>
        <span class="price-figure" data-amount></span>
      </div>
      <button class="pay" type="button" data-pay><span data-pay-label>Pay</span></button>
      <p class="held">This hour is held for you for <strong data-countdown>&nbsp;</strong>.</p>
      <p class="testing" data-testing hidden>
        Test mode — no money will move. Use any test card.
      </p>
    </section>

    <section class="state" data-state="done" hidden>
      <div class="tick" aria-hidden="true">
        <svg viewBox="0 0 44 44" width="44" height="44" role="img" aria-label="Paid">
          <circle class="tick-ring" cx="22" cy="22" r="20" fill="none" stroke-width="1.25"/>
          <path class="tick-mark" d="M13.5 22.5 L19.5 28.5 L31 17" fill="none"
                stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h1 class="done-title">Your consultation is booked.</h1>
      <p class="done-when" data-done-when></p>
      <div class="rule" role="presentation"></div>
      <p class="quiet">A confirmation is on its way to your inbox, with the receipt.</p>
      <p class="receipt-no" data-receipt hidden></p>
    </section>

    <section class="state" data-state="gone" hidden>
      <h1 class="gone-title" data-gone-title>That hour has been released.</h1>
      <p class="quiet" data-gone-note>
        Nobody was charged. If nobody else has taken it, you can still have it.
      </p>
      <button class="pay" type="button" data-resume>Take that time again</button>
      <a class="back" href="/consult.html">Choose another time</a>
    </section>

    <section class="state" data-state="error" hidden>
      <h1 class="gone-title">That didn't go through.</h1>
      <p class="quiet" data-error-note>
        No money has been taken. Please try once more — if it happens again,
        write to us and we'll sort the time out by hand.
      </p>
      <button class="back back-btn" type="button" data-retry>Try again</button>
    </section>`;

  /* ---- saying things the way a person would ------------------- */

  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];

  function sayDay(d) {
    const now = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    const tomorrow = new Date(now.getTime() + 86400000);
    if (same(d, now)) return "Today";
    if (same(d, tomorrow)) return "Tomorrow";
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  function sayTime(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const suffix = h < 12 ? "am" : "pm";
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, "0")}${suffix}` : `${h}${suffix}`;
  }

  const HOW = {
    video: "By video call",
    audio: "By phone",
    in_person: "In person",
    undecided: "Video or phone — she'll confirm which",
  };

  /** ₹5,000 — grouped the Indian way, and with no paise when there
      are none. A price with a trailing .00 reads as a form field
      rather than a number somebody chose. */
  function money(minor, currency) {
    const major = minor / 100;
    const whole = Number.isInteger(major);
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency", currency: currency || "INR",
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }).format(major);
    } catch {
      return `${currency || "INR"} ${major.toFixed(whole ? 0 : 2)}`;
    }
  }

  function sayLeft(seconds) {
    if (seconds <= 0) return "no time";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m <= 0 ? `${s} second${s === 1 ? "" : "s"}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  /* ---- one till ---------------------------------------------- */

  /**
   * Draw the checkout into a container and run it.
   *
   * @param {Element} root   where the card's sections go
   * @param {object}  opts
   * @param {string}  opts.token     the checkout token
   * @param {function} [opts.onPaid] told when the money is real,
   *                                 so the desk can do whatever a
   *                                 desk does next
   */
  function mount(root, opts) {
    if (!root) return;
    const token = (opts && opts.token) || "";
    const onPaid = (opts && opts.onPaid) || (() => {});

    root.innerHTML = TEMPLATE;

    const $ = (sel) => root.querySelector(sel);
    const states = {};
    for (const el of root.querySelectorAll("[data-state]")) states[el.dataset.state] = el;

    let view = null;
    let ticking = null;

    function show(name) {
      for (const [key, el] of Object.entries(states)) el.hidden = key !== name;
      if (name !== "ready" && ticking) { clearInterval(ticking); ticking = null; }
    }

    /* The hour really is released when this reaches zero — the
       sweeper on the server does it — so when it does, the card
       stops offering to sell something that is no longer for sale. */
    function startCountdown(expiresAt) {
      const el = $("[data-countdown]");
      const wrap = $(".held");
      const ends = new Date(expiresAt).getTime();
      const tick = () => {
        const left = Math.round((ends - Date.now()) / 1000);
        el.textContent = sayLeft(left);
        wrap.classList.toggle("is-urgent", left <= 120);
        if (left <= 0) { clearInterval(ticking); ticking = null; show("gone"); }
      };
      tick();
      ticking = setInterval(tick, 1000);
    }

    async function load() {
      show("loading");
      if (!token) return show("gone");

      let res;
      try {
        res = await fetch(`/api/checkout?t=${encodeURIComponent(token)}`,
          { headers: { Accept: "application/json" } }).then((r) => r.json());
      } catch { return show("error"); }

      /* An unknown token and an expired one answer the same way on
         purpose — both are "that hour is not for sale", which is
         all a visitor needs. */
      if (!res || !res.ok) return show("gone");

      view = res.checkout;
      const start = new Date(view.startAt);
      $("[data-day]").textContent = sayDay(start);
      $("[data-time]").textContent = sayTime(start);
      $("[data-how]").textContent = HOW[view.mode] || HOW.undecided;
      $("[data-amount]").textContent = money(view.amountMinor, view.currency);
      $("[data-pay-label]").textContent = `Pay ${money(view.amountMinor, view.currency)}`;
      $("[data-testing]").hidden = !view.testMode;

      startCountdown(view.expiresAt);
      show("ready");
    }

    async function pay() {
      const button = $("[data-pay]");
      button.disabled = true;

      let order;
      try {
        order = await fetch("/api/pay/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }).then((r) => r.json());
      } catch { button.disabled = false; return show("error"); }

      if (!order || !order.ok) {
        button.disabled = false;
        return show(order && order.error === "unknown" ? "gone" : "error");
      }

      if (typeof window.Razorpay !== "function") {
        /* Their script did not load — an ad blocker, or no network.
           Better to say so than leave a dead button. */
        button.disabled = false;
        $("[data-error-note]").textContent =
          "The payment window could not load. If you use an ad blocker, " +
          "allow checkout.razorpay.com and try again.";
        return show("error");
      }

      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        name: order.name,
        description: order.description,
        prefill: order.prefill || {},
        theme: { color: "#A35C66" },
        /* Closing the window is not a failure. The hour is still
           held and the countdown still running. */
        modal: { ondismiss: () => { button.disabled = false; } },
        handler: async (out) => {
          button.disabled = true;
          $("[data-pay-label]").textContent = "Confirming…";
          await confirm(out);
        },
      });

      rzp.on("payment.failed", () => {
        button.disabled = false;
        $("[data-error-note]").textContent =
          "That payment didn't go through, and nothing has been taken. " +
          "The hour is still held — you can try again.";
        show("error");
      });

      rzp.open();
    }

    /** Hand what Razorpay said to the server, which is the only
        party that can tell whether it is true. */
    async function confirm(out) {
      let res;
      try {
        res = await fetch("/api/pay/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            orderId: out.razorpay_order_id,
            paymentId: out.razorpay_payment_id,
            signature: out.razorpay_signature,
          }),
        }).then((r) => r.json());
      } catch {
        /* The money may well have moved — the webhook is the
           backstop for exactly this. Never tell somebody a payment
           failed when what failed was our own request about it. */
        $("[data-error-note]").textContent =
          "We couldn't reach the server to finish this. If your payment went " +
          "through, the booking will still be confirmed and you'll get an email.";
        return show("error");
      }

      if (!res || !res.ok) {
        $("[data-error-note]").textContent =
          "The payment came back, but we couldn't confirm the hour. Nothing is " +
          "lost — write to us and it will be sorted by hand.";
        return show("error");
      }

      if (view) {
        const start = new Date(view.startAt);
        $("[data-done-when]").textContent = `${sayDay(start)}, ${sayTime(start)}`;
      }
      if (res.receipt && res.receipt.number) {
        const el = $("[data-receipt]");
        el.textContent = `Receipt ${res.receipt.number}`;
        el.hidden = false;
      }
      show("done");
      try { onPaid(res); } catch {}
    }

    /* ---- picking it back up ------------------------------------
       The hold ran out while they were finding a card. The hour
       went back to the diary, which is right — but they are still
       here. If nobody else has taken it, they can have it again,
       and the server decides that under the unique index rather
       than by looking first and writing after. */
    async function resume() {
      const button = $("[data-resume]");
      if (button) button.disabled = true;

      let res;
      try {
        res = await fetch("/api/pay/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }).then((r) => r.json());
      } catch {
        if (button) button.disabled = false;
        return;
      }

      if (res && res.ok) return load();   // held again; back to the till

      /* Somebody else booked it. That is a different sentence from
         "your link is broken", and the person who was about to pay
         deserves the real one. */
      if (button) button.remove();
      if (res && res.error === "hour_taken") {
        $("[data-gone-title]").textContent = "That time has just been booked.";
        $("[data-gone-note]").textContent =
          "Somebody else took it while it was free. Nobody was charged — " +
          "pick another time and it is yours.";
      } else {
        $("[data-gone-note]").textContent =
          "Nobody was charged. Pick another time and it is yours.";
      }
    }

    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-pay]") && !e.target.closest("[data-resume]")) pay();
      if (e.target.closest("[data-resume]")) resume();
      if (e.target.closest("[data-retry]")) load();
    });

    load();
    return { reload: load };
  }

  window.Checkout = { mount };

  /* THE STANDALONE PAGE. checkout.html is a shell with one empty
     container; if it is here, this is that page and the token is
     in the URL. Inside the desk there is no such container and
     nothing happens until the desk asks. */
  const standalone = document.querySelector("[data-checkout-root]");
  if (standalone) {
    mount(standalone, { token: new URL(location.href).searchParams.get("t") || "" });
  }
})();
