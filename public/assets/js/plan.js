/* ============================================================
   THE CLIENT'S PLAN
   ------------------------------------------------------------
   Opened from an email or a WhatsApp message, usually on a phone,
   usually weeks after the consultation. It reads one thing and
   does nothing else: no account, no tracking, no tickboxes. Those
   arrive in phase four and this page is deliberately finished
   without them.

   ALWAYS THE CURRENT VERSION. The token points at the plan rather
   than at a version of it, so if Khadija corrected the plan after
   sending this link, this shows the correction. A client following
   superseded advice is the exact failure the amend-forward rule
   exists to prevent, and it would be a strange thing to build a
   record around and then defeat with a URL.

   TEXT, NEVER MARKUP. The plan is written into textContent line by
   line. She types into a plain textarea, so there is no formatting
   to preserve and nothing to gain from innerHTML — and a clinical
   document is the last place to start trusting stored strings.
   ============================================================ */

/* /p/<token> — a path, not a query string, for the same reasons as
   the consultation room: it is what a dynamic URL button appends
   to, and query strings are what proxies and access logs record
   most eagerly. */
const TOKEN = location.pathname.replace(/^\/p\//, "").replace(/\/+$/, "");

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function show(name) {
  for (const el of $$("[data-view]")) el.hidden = el.dataset.view !== name;
}

/** "Saturday 15 August 2026" — in the reader's own locale, because
    this is read by the client and not by the practice. */
function readable(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/* ---- the figures ------------------------------------------------
   WHAT THE PLAN PROVIDES, never what it will achieve. "1,500 kcal"
   is a property of the plan and can be checked; "you will lose 4 kg"
   is a prediction about a person that no formula holds. Only the
   first kind of number is on this page, and the labels are written
   so the second kind cannot be read into them. */
const LABEL = {
  energy_kcal: "Energy a day",
  protein_g: "Protein a day",
  fluid_ml: "Fluid a day",
};
const UNIT = { energy_kcal: "kcal", protein_g: "g", fluid_ml: "ml" };

function paintTargets(targets) {
  const host = $("[data-targets]");
  const rows = Object.entries(targets || {}).filter(
    ([k, v]) => LABEL[k] && v !== null && v !== "" && v !== undefined
  );

  host.hidden = !rows.length;
  if (!rows.length) return;

  /* Built with the DOM rather than a template string. Nothing here
     is attacker-controlled today, but this page is the one that
     renders stored text to an unauthenticated reader, and the habit
     is cheaper than the audit. */
  for (const [k, v] of rows) {
    const cell = document.createElement("div");
    cell.className = "target";

    const val = document.createElement("span");
    val.className = "target-v";
    val.textContent = String(v) + (UNIT[k] ? " " + UNIT[k] : "");

    const key = document.createElement("span");
    key.className = "target-k";
    key.textContent = LABEL[k];

    cell.append(val, key);
    host.append(cell);
  }
}

/** The plan, line by line. Blank lines become spacing rather than
    empty paragraphs, so the shape she typed survives without any
    markup being involved. */
function paintBody(text) {
  const host = $("[data-body]");
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");

  let gap = false;
  for (const line of lines) {
    if (!line.trim()) { gap = true; continue; }
    const p = document.createElement("p");
    p.textContent = line;
    if (gap) p.className = "spaced";
    gap = false;
    host.append(p);
  }
}

/* ---- boot -------------------------------------------------------- */
(async function open() {
  if (!TOKEN || TOKEN.length < 16) return show("gone");

  let plan;
  try {
    const res = await fetch(`/api/plan?t=${encodeURIComponent(TOKEN)}`, {
      headers: { Accept: "application/json" },
    });
    plan = res.ok ? await res.json() : null;
  } catch {
    plan = null;
  }

  if (!plan?.ok) return show("gone");

  $("[data-who]").textContent = plan.firstName ? `, ${plan.firstName}` : "";
  $("[data-when]").textContent = plan.issuedAt
    ? `Written by Khadija on ${readable(plan.issuedAt)}`
    : "Written by Khadija";
  $("[data-ref]").textContent = plan.ref || "";

  paintTargets(plan.targets);
  paintBody(plan.body);
  show("plan");

  /* The token goes out of the address bar once it has been used, so
     a screenshot of this page — the thing somebody is most likely to
     take of their own diet plan — does not carry the key to it.
     replaceState leaves no history entry, so Back does not walk into
     the tokenised URL again. */
  history.replaceState(null, "", "/p/");
})();

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-print]")) print();
});
