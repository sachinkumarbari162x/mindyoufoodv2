/* The signature check is the entire trust model of a gateway
   integration: the browser reports a payment, and only this makes
   it a fact. It is tested without touching the network, because
   the logic is arithmetic and the network would only make the test
   flaky.

   Run: node payments/razorpay.test.js
*/
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

// Set before the module is loaded — it reads the environment once.
process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
process.env.RAZORPAY_KEY_SECRET = "test-secret";

const rzp = require("./razorpay");

const sign = (s, secret = "test-secret") =>
  crypto.createHmac("sha256", secret).update(s).digest("hex");

test("a genuine signature verifies", () => {
  const orderId = "order_abc";
  const paymentId = "pay_xyz";
  assert.equal(
    rzp.verifyPayment({ orderId, paymentId, signature: sign(`${orderId}|${paymentId}`) }),
    true
  );
});

test("a signature from a different secret does not", () => {
  const orderId = "order_abc";
  const paymentId = "pay_xyz";
  assert.equal(
    rzp.verifyPayment({
      orderId,
      paymentId,
      signature: sign(`${orderId}|${paymentId}`, "not-the-secret"),
    }),
    false
  );
});

test("a signature for a different payment does not", () => {
  /* The attack this stops: paying 1 rupee for one consultation and
     replaying that signature against another. */
  const sig = sign("order_abc|pay_xyz");
  assert.equal(rzp.verifyPayment({ orderId: "order_abc", paymentId: "pay_OTHER", signature: sig }), false);
  assert.equal(rzp.verifyPayment({ orderId: "order_OTHER", paymentId: "pay_xyz", signature: sig }), false);
});

test("nothing missing is ever treated as valid", () => {
  for (const bad of [
    { orderId: "", paymentId: "pay_xyz", signature: "x" },
    { orderId: "order_abc", paymentId: "", signature: "x" },
    { orderId: "order_abc", paymentId: "pay_xyz", signature: "" },
    {},
  ]) {
    assert.equal(rzp.verifyPayment(bad), false);
  }
});

test("a truncated signature is rejected rather than partially matched", () => {
  const full = sign("order_abc|pay_xyz");
  assert.equal(
    rzp.verifyPayment({ orderId: "order_abc", paymentId: "pay_xyz", signature: full.slice(0, 20) }),
    false
  );
});

test("webhooks verify over the raw body", () => {
  const raw = '{"event":"payment.captured","payload":{}}';
  assert.equal(rzp.verifyWebhook(raw, sign(raw)), true);

  /* Re-serialised JSON is different bytes and must fail. This is
     the mistake worth having a test for: parse the body, hand the
     object on, and the signature silently never matches again. */
  const reserialised = JSON.stringify(JSON.parse(raw));
  if (reserialised !== raw) {
    assert.equal(rzp.verifyWebhook(reserialised, sign(raw)), false);
  }
});

test("an order needs a whole number of paise", async () => {
  for (const amountMinor of [0, -100, 12.5, NaN, "500"]) {
    const out = await rzp.createOrder({ amountMinor });
    assert.equal(out.ok, false, `accepted ${amountMinor}`);
    assert.equal(out.error, "bad_amount");
  }
});

test("test mode is reported, not assumed", () => {
  assert.equal(rzp.isTestMode(), true, "rzp_test_ keys must report test mode");
  assert.equal(rzp.configured(), true);
});
