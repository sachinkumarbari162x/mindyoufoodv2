/* ============================================================
   ACCOUNT · THE DOOR
   ------------------------------------------------------------
   An address, then six digits, then the panel.

   WHAT THIS FILE NEVER LEARNS: whether an address belongs to a
   client. The server answers "if that address is on our records,
   a code is on its way" every single time, so this screen has
   nothing to reveal even if somebody reads it — and the message
   below is the server's own words rather than one this file
   composes, so the two cannot drift apart.
   ============================================================ */
(function () {
  "use strict";

  const api = window.accountApi;

  const gate = document.getElementById("gate");
  const emailStep = document.getElementById("gate-email-step");
  const codeStep = document.getElementById("gate-code-step");
  const emailInput = document.getElementById("gate-email");
  const codeInput = document.getElementById("gate-code");
  const sendBtn = document.getElementById("gate-send");
  const openBtn = document.getElementById("gate-open");
  const againBtn = document.getElementById("gate-again");
  const said = document.getElementById("gate-said");
  const dev = document.getElementById("gate-dev");
  const sentTo = document.getElementById("gate-sent-to");

  let email = "";
  let onOpened = () => {};

  function say(message, bad) {
    said.textContent = message || "";
    said.classList.toggle("bad", !!bad);
    said.hidden = !message;
  }

  /* A button that is doing something says so and cannot be
     pressed again. Two codes in flight is two rows in the
     database and a client typing the one that was already
     replaced. */
  function busy(button, on, label) {
    button.disabled = on;
    button.textContent = on ? label : button.dataset.label;
  }

  [sendBtn, openBtn].forEach((b) => (b.dataset.label = b.textContent));

  emailStep.addEventListener("submit", async (e) => {
    e.preventDefault();
    email = emailInput.value.trim();
    if (!email) return;

    say("");
    busy(sendBtn, true, "Sending…");
    const out = await api.requestCode(email);
    busy(sendBtn, false);

    if (!out.ok) {
      say(
        out.error === "offline" || out.error === "timeout"
          ? "We could not reach the practice just now. Check your connection and try again."
          : out.message || "That did not work. Try again.",
        true
      );
      return;
    }

    emailStep.hidden = true;
    codeStep.hidden = false;
    sentTo.textContent = `If ${email} is on our records, a six-digit code is on its way. It is good for 15 minutes.`;
    say(out.message);

    /* Local development only, and the server decides. This appears
       when the BFF was started with CLIENT_CODE_ECHO=1, which it
       refuses to honour in production. */
    if (out.devCode) {
      dev.hidden = false;
      dev.textContent = `dev · your code is ${out.devCode}`;
    }

    codeInput.focus();
  });

  codeStep.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = codeInput.value.replace(/\D/g, "");
    if (code.length !== 6) {
      say("Six digits, from the email.", true);
      return;
    }

    say("");
    busy(openBtn, true, "Opening…");
    const out = await api.openSession(email, code);
    busy(openBtn, false);

    if (!out.ok) {
      say(out.message || "That code is not right.", true);
      codeInput.select();
      return;
    }

    /* The cookie is already set by the response. There is nothing
       to store, which is the point — reloading the page from here
       lands straight in the panel. */
    dev.hidden = true;
    say("");
    gate.hidden = true;
    onOpened();
  });

  againBtn.addEventListener("click", () => {
    codeStep.hidden = true;
    emailStep.hidden = false;
    dev.hidden = true;
    say("");
    emailInput.focus();
    emailInput.select();
  });

  /* Digits only, and submit itself the moment six of them are in.
     A six-digit code with a separate button to press is one extra
     tap on every sign-in for no benefit. */
  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
    if (codeInput.value !== digits) codeInput.value = digits;
    if (digits.length === 6) codeStep.requestSubmit();
  });

  window.accountGate = {
    /** Show the door. `then` runs once somebody is through it. */
    open(then) {
      onOpened = then || (() => {});
      gate.hidden = false;
      emailStep.hidden = false;
      codeStep.hidden = true;
      dev.hidden = true;
      say("");
      // Not on a phone: the keyboard covering the card on arrival
      // hides the sentence explaining what the screen is for.
      if (window.matchMedia("(min-width: 900px)").matches) emailInput.focus();
    },
  };
})();
