/* ============================================================
   SIGN IN — one panel at a time
   ------------------------------------------------------------
   Which panel shows is decided by the SERVER's answer to
   /auth/me, never by the page guessing. A login screen that
   works out its own state is a login screen that can be talked
   into showing the wrong one.

   Nothing here validates a password or knows what a valid code
   looks like. It collects, it posts, it reports what came back.
   Every decision is made behind the door.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const panels = {};

/* Which door. The CRM workspace and the raw tables are separate
   accounts with separate sessions, so the page has to know which
   one it is opening — and say so, because two doors that look
   identical are two doors somebody will try the wrong key in. */
const DOOR = new URLSearchParams(location.search).get("door") === "viewer" ? "viewer" : "crm";
/* Where to land after signing in.

   A session that expires mid-task sends her here with ?next= naming
   the page she was on, so she comes back to it rather than to
   Overview and has to find her way again.

   THE VALUE IS NOT TRUSTED. `next` arrives in the address bar, which
   means anybody can put anything in it — and a login page that
   forwards to whatever it is handed is an open redirect: a link that
   looks like her own CRM, ends on somebody else's copy of this login
   screen, and collects the password she types into it. So it is
   accepted only when it names a page inside this CRM: one segment,
   ending .html, no slashes, no scheme, no host. Anything else is
   ignored in favour of the ordinary home. */
const DEFAULT_HOME = DOOR === "viewer" ? "./database.html" : "./index.html";

function safeNext() {
  const asked = new URLSearchParams(location.search).get("next") || "";
  // Strip the CRM's own directory prefix if it came through absolute.
  const trimmed = asked.replace(/^\/crm\//, "").replace(/^\.\//, "");
  return /^[a-z0-9-]{1,40}\.html(\?[\w=&%.-]{0,200})?$/i.test(trimmed)
    ? `./${trimmed}`
    : DEFAULT_HOME;
}

const HOME = DOOR === "viewer" ? DEFAULT_HOME : safeNext();

for (const el of document.querySelectorAll("[data-panel]")) panels[el.dataset.panel] = el;

function show(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
  const focusable = panels[name]?.querySelector("input");
  if (focusable) focusable.focus();
}

function fail(message) {
  const box = $("[data-err]");
  box.hidden = !message;
  box.textContent = message || "";
}

async function post(path, body) {
  const res = await fetch("/api/crm/auth/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(body || {}), role: DOOR }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/* ---- where are we? ---- */
async function begin() {
  try {
    const res = await fetch(DOOR === "viewer" ? "/api/crm/auth/viewer" : "/api/crm/auth/me", {
      headers: { Accept: "application/json" },
    });
    const me = await res.json();

    /* Signed in, so go to the workspace — but never more than once.

       If the API believes there is a session and the static server
       does not, this navigates, is handed the login page back, and
       navigates again, several times a second, for ever. It is a
       nasty failure to diagnose from the outside: the page reads
       "One moment", flickers, and the CPU climbs.

       The cause is fixed (run.js now gives both processes the same
       signing key). This is the guard that makes the SYMPTOM
       impossible whatever causes the disagreement next time —
       one bounce, then it stops and says so. */
    if (me.signedIn) {
      const bounced = sessionStorage.getItem("myf-bounced");
      if (!bounced) {
        sessionStorage.setItem("myf-bounced", "1");
        location.href = HOME;
        return;
      }
      sessionStorage.removeItem("myf-bounced");
      fail(
        "You are signed in, but this page will not open. Sign in again — " +
          "and if it keeps happening, the server was restarted with a different key."
      );
      show("login");
      return;
    }

    // A clean arrival clears the guard.
    sessionStorage.removeItem("myf-bounced");

    // Say which door this is, so nobody types the wrong password
    // into an identical-looking form.
    if (DOOR === "viewer") {
      document.querySelector(".login-card h1").textContent = "Raw tables";
      const note = document.createElement("p");
      note.className = "login-note";
      note.textContent = "This is a separate sign-in from the CRM. Read-only, and its own password.";
      document.querySelector(".login-card h1").after(note);
    }
    show(me.setUp ? "login" : "setup");
  } catch {
    fail("The desk is not answering. Is the server running?");
    show("login");
  }
}

/* ---- first run ---- */
panels.setup.addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("");
  const { ok, data } = await post("setup", {
    email: e.target.email.value.trim(),
    password: e.target.password.value,
  });
  if (!ok) return fail(data.message || "That did not work.");
  // Straight in, rather than making her type the same thing twice.
  const login = await post("login", {
    email: e.target.email.value.trim(),
    password: e.target.password.value,
  });
  location.href = HOME;
});

/* ---- the ordinary way in ---- */
panels.login.addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("");
  const { ok, data } = await post("login", {
    email: e.target.email.value.trim(),
    password: e.target.password.value,
  });
  if (!ok) return fail(data.message || "That did not work.");
  if (data.next === "totp") return show("totp");
  // No authenticator attached yet — set one up before going in.
  if (data.next === "enrol") return startEnrol();
  location.href = HOME;
});

/* ---- the second factor ---- */
panels.totp.addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("");
  const { ok, data } = await post("totp", { code: e.target.code.value });
  if (!ok) return fail(data.message || "That code is not right.");
  location.href = HOME;
});

/* ---- attaching an app ---- */
async function startEnrol() {
  const { ok, data } = await post("enrol", {});
  if (!ok) return (location.href = HOME);
  /* In groups of four. Thirty-two unbroken characters is a string
     nobody can check they typed correctly, and this is the one place
     a typo costs a locked account. */
  $("[data-secret]").textContent = data.secret.replace(/(.{4})/g, "$1 ").trim();
  show("enrol");
}

$("[data-enrol-confirm]").addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("");
  const { ok, data } = await post("enrol", { code: e.target.code.value });
  if (!ok) return fail(data.message || "That code is not right.");
  location.href = HOME;
});

/* Skipping is allowed and says what it costs. Forcing enrolment here
   is how somebody ends up locked out of their own practice by a phone
   they have not set up yet. */
$("[data-skip]").addEventListener("click", () => {
  location.href = HOME;
});

begin();
