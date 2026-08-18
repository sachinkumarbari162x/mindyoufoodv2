/* ============================================================
   CHECKOUT — the hour becomes hers once the money is real
   ------------------------------------------------------------
   Four steps, and only one of them decides anything:

     start    reserve the hour, hand back an opaque token
     view     what the page may show (no ids, no email)
     order    a Razorpay order, made when they reach the till
     paid     VERIFY the signature, then record, confirm, receipt

   THE ORDER OF `paid` IS THE WHOLE SECURITY MODEL. A browser
   saying "I paid" is a claim. It becomes a fact only when the
   signature over `order_id|payment_id` verifies against the key
   secret, which never leaves this process. Everything after that
   line is bookkeeping; everything before it is untrusted input.

   AND IT HAPPENS TWICE ON PURPOSE. The browser reports the
   payment when checkout closes, and Razorpay's webhook reports it
   again moments later. Both run this same path, because the
   browser is the fast one and the webhook is the one that still
   arrives when somebody pays and immediately shuts the laptop.
   Every step below is idempotent so the second report changes
   nothing: the payment insert collapses on its provider
   reference, the confirm is a no-op on an already-confirmed hour,
   and the receipt is unique per payment.
   ============================================================ */
"use strict";

const data = require("../data-client");
const rz = require("./razorpay");
const { config } = require("../config");

/** What a consultation costs, from the database rather than here.
    Falls back to nothing bookable rather than to a guessed price:
    a checkout that invents its own amount is worse than one that
    refuses to open. */
async function feeFor(view) {
  const minor = Number(view?.amountMinor || 0);
  if (!Number.isInteger(minor) || minor <= 0) return null;
  return { amountMinor: minor, currency: view.currency || "INR" };
}

/* ---- 1. reserve the hour --------------------------------------
   Called the moment the visitor commits to a time. The hold and
   the link expire together, in Go. */
async function start(consultationId) {
  if (!consultationId) return { ok: false, status: 400, error: "no_booking" };
  const out = await data.crm.checkoutMint(consultationId);
  if (!out?.ok) return { ok: false, status: 409, error: "no_checkout" };
  return {
    ok: true, status: 201,
    token: out.token, expiresAt: out.expiresAt, secondsLeft: out.secondsLeft,
  };
}

/* ---- 2. what the page shows ----------------------------------- */
async function view(token) {
  const out = await data.crm.checkoutResolve(token);
  if (!out?.ok) return { ok: false, status: 404, error: "unknown" };

  const fee = await feeFor(out.checkout);
  if (!fee) return { ok: false, status: 409, error: "no_price" };

  return {
    ok: true, status: 200,
    checkout: { ...out.checkout, ...fee, testMode: rz.isTestMode() },
  };
}

/* ---- 3. the order ---------------------------------------------
   Made here, server side, from the price in the database. An
   amount that arrives from the browser is an amount the browser
   can edit.

   Not persisted, and not idempotent, deliberately: an unpaid
   Razorpay order costs nothing and expires on its own, so a
   reloaded page making a second one is cheaper than a table this
   service would have to keep in step with theirs. What must not
   be duplicated is the HOUR, and that is held in Postgres under a
   unique index, not here. */
async function order(token) {
  if (!rz.configured()) return { ok: false, status: 503, error: "not_configured" };

  const v = await view(token);
  if (!v.ok) return v;

  const made = await rz.createOrder({
    amountMinor: v.checkout.amountMinor,
    currency: v.checkout.currency,
    reference: `MYF-${token.slice(0, 12)}`,
    notes: { checkoutToken: token },
  });
  if (!made.ok) return { ok: false, status: 502, error: made.error };

  return {
    ok: true, status: 201,
    orderId: made.orderId,
    amountMinor: made.amountMinor,
    currency: made.currency,
    keyId: made.keyId,
    testMode: made.testMode,
    name: config.practice?.name || "Mind Your Food",
    description: "Consultation",
    prefill: { name: v.checkout.firstName || "" },
  };
}

/* ---- picking up a lapsed checkout -----------------------------
   The hold ran out and the sweeper gave the hour back. If it is
   still free, take it again — the visitor is still here and still
   wants it, and making them start over from the front desk to
   find out is a way to lose somebody who had already decided.

   Go does the taking, under the partial unique index, so this
   only carries the answer. */
async function resume(token) {
  const out = await data.crm.checkoutResume(token);
  if (!out) return { ok: false, status: 503, error: "unavailable" };
  if (!out.ok) {
    /* "Somebody else booked it" is a different thing from "no
       such checkout", and the card says something different for
       each. */
    return { ok: false, status: out.status || 404, error: out.error || "unknown" };
  }
  return { ok: true, status: 200, expiresAt: out.expiresAt, secondsLeft: out.secondsLeft };
}

/* ---- 4. the money is real ------------------------------------- */
async function paid({ token, orderId, paymentId, signature, source }) {
  /* THE LINE. Nothing below it runs on a claim. */
  if (!rz.verifyPayment({ orderId, paymentId, signature })) {
    return { ok: false, status: 400, error: "bad_signature" };
  }

  const v = await data.crm.checkoutResolve(token);
  /* An already-confirmed hour resolves as unknown — which is
     correct for a visitor reloading the page, and is also what the
     webhook sees when the browser got there first. Not an error. */
  if (!v?.ok) return { ok: true, status: 200, already: true };

  const amountMinor = Number(v.checkout?.amountMinor || 0);
  const currency = v.checkout?.currency || "INR";

  const confirmed = await data.crm.checkoutPaid(token, paymentId);
  if (!confirmed?.ok) return { ok: false, status: 409, error: "hour_gone" };

  const payment = await data.crm.recordPayment({
    consultationId: confirmed.consultationId,
    provider: rz.isTestMode() ? "razorpay-test" : "razorpay",
    reference: paymentId,
    amountMinor,
    currency,
    /* 'paid', and only here. The browser's word alone never got
       further than 'pending'; this ran because a signature made
       by the key secret verified. */
    status: "paid",
  });
  if (!payment?.ok) return { ok: false, status: 500, error: "not_recorded" };

  const receipt = await data.crm.issueReceipt(payment.id, "Consultation");

  return {
    ok: true, status: 200,
    consultationId: confirmed.consultationId,
    receipt: receipt?.ok ? { id: receipt.id, number: receipt.number } : null,
    testMode: rz.isTestMode(),
    source: source || "browser",
  };
}

/* ---- the webhook ----------------------------------------------
   Signed over the RAW body, so this takes the bytes rather than a
   parsed object — re-serialising changes them and the signature
   stops matching.

   It is the backstop, not the primary path: it exists for the
   visitor who pays and closes the tab before their browser can
   say so. Everything it calls is idempotent, so when the browser
   did get there first this changes nothing at all. */
async function webhook(rawBody, signature) {
  if (!rz.verifyWebhook(rawBody, signature)) {
    return { ok: false, status: 400, error: "bad_signature" };
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return { ok: false, status: 400, error: "bad_json" }; }

  if (event?.event !== "payment.captured" && event?.event !== "order.paid") {
    /* Acknowledged and ignored. A 200 stops Razorpay retrying an
       event we were never going to act on. */
    return { ok: true, status: 200, ignored: event?.event || "unknown" };
  }

  const payment = event?.payload?.payment?.entity || {};
  const token = payment?.notes?.checkoutToken
    || event?.payload?.order?.entity?.notes?.checkoutToken;

  if (!token || !payment.order_id || !payment.id) {
    return { ok: true, status: 200, ignored: "no_checkout_token" };
  }

  /* THE SIGNATURE IS ALREADY PROVEN — over the whole body, by the
     webhook secret. Re-checking the order|payment signature here
     would be checking a different thing with a value Razorpay
     does not send on webhooks. So this path records directly
     rather than going through paid(). */
  const v = await data.crm.checkoutResolve(token);
  if (!v?.ok) return { ok: true, status: 200, already: true };

  const confirmed = await data.crm.checkoutPaid(token, payment.id);
  if (!confirmed?.ok) return { ok: true, status: 200, already: true };

  const rec = await data.crm.recordPayment({
    consultationId: confirmed.consultationId,
    provider: rz.isTestMode() ? "razorpay-test" : "razorpay",
    reference: payment.id,
    amountMinor: Number(payment.amount || v.checkout.amountMinor || 0),
    currency: payment.currency || v.checkout.currency || "INR",
    status: "paid",
  });
  if (rec?.ok) await data.crm.issueReceipt(rec.id, "Consultation");

  return { ok: true, status: 200, source: "webhook" };
}

module.exports = { start, view, order, paid, webhook, resume };
