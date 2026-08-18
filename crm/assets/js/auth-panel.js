/* ============================================================
   AUTH PANEL — who is signed in, and the way out
   ------------------------------------------------------------
   The server has had a working, audited logout since the auth
   work; nothing in the CRM ever called it. A session she cannot
   end is a session that ends only when the cookie expires, on
   whatever machine she happened to use — a borrowed laptop, a
   clinic desktop, a phone handed to somebody to read a number
   off. This is the control that closes it.

   IT NAMES THE ACCOUNT. "Sign out" on its own is a button whose
   effect you have to already know; with the address above it,
   it says what is about to end. It also answers the question
   that brings people to a support conversation — "am I even
   logged in as the right person?" — before they ask it.

   SIGNING OUT CLOSES BOTH DOORS. The CRM and the raw tables are
   separate sessions on purpose, and that separation protects the
   database — but only on the way IN. On the way out it would be
   a trap: she presses Sign out, is returned to a login screen,
   and reasonably believes she has left, while a viewer session
   with SELECT on every table stays open behind her. So one press
   ends both, whether or not the second one was ever opened.
   ============================================================ */

const LOGIN = "./login.html";

/** End a session. Best-effort on purpose: the cookie is cleared by
    the server, so a network failure here must still send her to the
    login screen rather than leaving her on a page she thinks is
    signed out. */
async function end(role) {
  try {
    await fetch("/api/crm/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
  } catch {
    /* ignored — see above */
  }
}

export function mount() {
  const host = document.querySelector("[data-auth]");
  if (!host) return;

  /* Drawn only once the account is known. An empty shell that fills
     in a moment later makes the masthead jump, and a "Sign out"
     button that appears next to nobody's name is worse than one that
     arrives a beat late. */
  fetch("/api/crm/auth/me", { headers: { Accept: "application/json" } })
    .then((r) => r.json())
    .then((me) => {
      if (!me.signedIn) return;

      host.innerHTML = `
        <p class="auth-who"></p>
        <button class="btn quiet auth-out" type="button">Sign out</button>`;

      /* textContent, not interpolation: the address comes from the
         server, but it is still somebody's data going onto a page. */
      host.querySelector(".auth-who").textContent = me.email || "Signed in";

      host.querySelector(".auth-out").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Signing out…";

        await end("crm");
        await end("viewer");

        /* replace(), not assign(): Back must not return her to a
           workspace page. It would show the shell of the CRM she has
           just left, fail every request behind it, and read as the
           sign-out not having worked. */
        location.replace(LOGIN);
      });
    })
    .catch(() => {
      /* No panel rather than a broken one. Whether she is signed in
         is a question only the server can answer, and guessing "yes"
         would put a Sign out button on a page nobody is signed into. */
    });
}
