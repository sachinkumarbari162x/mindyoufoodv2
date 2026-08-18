/* ============================================================
   RAZORPAY — test mode, and nothing decided
   ------------------------------------------------------------
   Item 7. You said nothing is settled and to try test mode and
   see how it works, so this is plumbing rather than a decision.
   It is OFF unless RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are
   both set, and in test mode no money can move.

   ABOUT "NO API KEY SHOULD APPEAR ANYWHERE" — one thing you need
   to know, because it is a genuine exception rather than a
   shortcut:

     RAZORPAY_KEY_SECRET  never leaves this process. It signs and
                          verifies, and it is never sent anywhere.

     RAZORPAY_KEY_ID      is PUBLIC BY DESIGN. Razorpay's checkout
                          runs in the visitor's browser and cannot
                          work without it. It is an identifier, not
                          a credential — on its own it authorises
                          nothing, in the way a bank account number
                          lets money in and never out.

   If that is not acceptable, the alternative is the UPI link from
   the proposal: no gateway, no key in the browser at all, and
   manual reconciliation. That is a real choice and it is still
   open.

   THE PART THAT ACTUALLY MATTERS IS THE SIGNATURE. A payment is
   only believed once its signature verifies against the secret.
   Anything a browser says about a payment is a claim, and treating
   a claim as a receipt is how a gateway integration gets robbed.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const data = require("../data-client");

const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const API = "https://api.razorpay.com/v1";

/** Both halves, or it is not configured. */
const configured = () => !!(KEY_ID && KEY_SECRET);

/** Test keys are prefixed rzp_test_. Worth saying out loud on every
    response, so nobody has to guess whether a payment was real. */
const isTestMode = () => KEY_ID.startsWith("rzp_test_");

/* ---- the signature --------------------------------------------
   Razorpay signs `order_id|payment_id` with the key secret. This is
   the whole of the trust model: the browser reports a payment, and
   only this makes it a fact.

   timingSafeEqual, because comparing signatures with === leaks how
   much of a forged one was right. */
function verifyPayment({ orderId, paymentId, signature }) {
  if (!configured() || !orderId || !paymentId || !signature) return false;
  const want = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(String(signature));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Webhooks are signed over the RAW body. Parsing first and
    re-serialising changes the bytes and the signature stops
    matching — which is why this takes a string, not an object. */
function verifyWebhook(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || KEY_SECRET;
  if (!secret || !signature) return false;
  const want = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(String(signature));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---- creating an order ----------------------------------------
   Server side, always. An amount decided in the browser is an
   amount the visitor can edit, and a checkout that trusts one is
   a shop with no prices. */
async function createOrder({ amountMinor, currency = "INR", reference, notes }) {
  if (!configured()) return { ok: false, error: "not_configured" };
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, error: "bad_amount" };
  }

  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");

  try {
    const res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountMinor, // paise, and integers only — never a float
        currency,
        receipt: reference || undefined,
        payment_capture: 1,
        /* THE WEBHOOK'S ONLY WAY BACK TO THE BOOKING. Razorpay
           returns an order's notes on every webhook about it, so
           the checkout token travels with the money rather than in
           a table this service would have to keep in step. When a
           visitor pays and then closes the tab before the browser
           can report it, this is what lets the webhook still find
           the hour and confirm it. */
        notes: notes || undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[bff] razorpay order failed ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, error: "gateway_refused" };
    }

    const order = await res.json();
    return {
      ok: true,
      orderId: order.id,
      amountMinor: order.amount,
      currency: order.currency,
      // The browser needs this to open checkout. Sent deliberately,
      // and it is the only part of the credential that ever leaves.
      keyId: KEY_ID,
      testMode: isTestMode(),
    };
  } catch (err) {
    console.warn(`[bff] razorpay unreachable: ${err.message}`);
    return { ok: false, error: "gateway_unreachable" };
  }
}

/**
 * Record a payment, but only once its signature has verified.
 *
 * The order matters: verify, then write. A payment written first
 * and checked afterwards is a payment that exists in the database
 * for as long as it takes somebody to notice.
 */
async function confirm({ consultationId, orderId, paymentId, signature, amountMinor, currency }) {
  if (!verifyPayment({ orderId, paymentId, signature })) {
    return { ok: false, status: 400, error: "bad_signature" };
  }

  const out = await data.crm.recordPayment({
    consultationId,
    provider: isTestMode() ? "razorpay-test" : "razorpay",
    reference: paymentId,
    amountMinor,
    currency: currency || "INR",
    /* 'pending', which is the schema's existing word for exactly
       this: claimed, not confirmed. Never 'paid' on the strength of
       a browser callback — a receipt nobody checked is a hopeful
       message. It becomes paid when the webhook agrees or she sees
       it on her statement.

       The first draft wrote 'claimed'/'test' here, which the CHECK
       constraint on crm.payments would have refused. The schema
       already had the right word. */
    status: "pending",
  });

  if (!out?.ok) return { ok: false, status: 500, error: "not_recorded" };
  return { ok: true, status: 201, testMode: isTestMode() };
}

module.exports = { configured, isTestMode, createOrder, confirm, verifyPayment, verifyWebhook };
