/* ============================================================
   HER ASSISTANT — the panel
   ------------------------------------------------------------
   The one place in this CRM where a sentence was written by a
   model. Everything else on the page is the database, rendered.

   Three rules, all visible in the markup below:

   1. THE FACTS SIT UNDER THE SENTENCE, ALWAYS. Not behind a
      disclosure, not on hover. The sentence is a reading of
      those numbers and she can check it in the same glance.
      If the model is unavailable the panel still works — the
      numbers are the panel, the sentence is the convenience.

   2. A DRAFT IS LABELLED A DRAFT AND IS NEVER SENT FROM HERE.
      It copies to the clipboard; she pastes it into WhatsApp or
      mail as herself. A generated message that looked sent is
      the one genuinely dangerous thing this feature could do.

   3. NOTHING HERE WRITES TO THE DATABASE. No accept, no
      decline, no status change. Those live on rows she has
      read, one click each, in her hands.
   ============================================================ */

import * as api from "./api.js";
import { esc } from "./format.js";

const $ = (sel, root = document) => root.querySelector(sel);

/* ---- ids stay out of the DOM ----------------------------------
   The consultation id is a database primary key. Writing it into a
   data- attribute publishes it to anything that can read the page,
   and this panel has no more right to do that than any other. The
   API sends the ids beside the facts; they live here, in module
   scope. Buttons carry a POSITION, and the position resolves to an
   id at the moment of the click.

   (The real fix is a short opaque reference on the row, replacing
   the key everywhere. Until then this at least keeps it out of the
   markup.) */
let ids = [];

const key = (i) => ids[i] || null;

export async function mount(host) {
  if (!host) return;

  host.innerHTML = `
    <div class="assist">
      <p class="assist-line" data-assist-line>Reading your day…</p>
      <div class="assist-facts" data-assist-facts></div>

      <form class="assist-ask" data-assist-ask>
        <input type="text" name="q" autocomplete="off" spellcheck="false"
               placeholder="Ask about your day — who is waiting, what is booked" />
        <button class="btn" type="submit">Ask</button>
      </form>
      <p class="assist-answer" data-assist-answer hidden></p>

      <div class="assist-drafts" data-assist-drafts></div>
      <div class="draft" data-draft hidden></div>

      <p class="assist-foot" data-assist-foot></p>
    </div>`;

  wire(host);
  await load(host);
}

/* ---- the briefing ------------------------------------------- */
async function load(host) {
  const line = $("[data-assist-line]", host);
  try {
    const res = await api.assist();
    ids = res.waitingIds || [];

    /* The sentence only when there IS one. An empty string means the
       model is off or was screened; saying nothing is right, and a
       placeholder like "no summary available" is noise where a real
       summary would be. */
    if (res.text) {
      line.textContent = res.text;
      line.hidden = false;
    } else {
      line.hidden = true;
    }

    drawFacts($("[data-assist-facts]", host), res.facts);
    drawDraftButtons($("[data-assist-drafts]", host), res.facts);
    $("[data-assist-foot]", host).textContent = footNote(res);
  } catch {
    /* No sample, no invention. The panel says it could not read,
       and the six panels below it still show her real practice. */
    line.hidden = true;
    $("[data-assist-facts]", host).innerHTML =
      `<p class="empty">Could not reach the assistant. Everything below is still live.</p>`;
    $("[data-assist-foot]", host).textContent = "";
  }
}

/* The numbers, plainly. This is the part that has to be right. */
function drawFacts(host, f) {
  if (!f) return;
  /* The figure is its own element, so the label must NOT repeat it —
     `plural()` returns "3 requests" and would have read "3 · 3
     requests" beside it. Pluralised off the count, not carrying it. */
  const word = (n, s) => (n === 1 ? s : `${s}s`);

  const items = [
    [f.waiting.length, word(f.waiting.length, "request"), "waiting on you"],
    [f.today.length, word(f.today.length, "session"), "today"],
    [f.upcoming.length, word(f.upcoming.length, "session"), "ahead"],
  ];
  /* Only when it is non-zero. A hold quietly expiring is the one
     thing on this page with a deadline, so it earns its own figure
     — but a permanent "0 expiring" trains her to stop reading the
     row, which costs her the day it says 2. */
  if (f.holdsExpiringSoon > 0) {
    items.push([f.holdsExpiringSoon, word(f.holdsExpiringSoon, "hold"), "expiring within 12h", true]);
  }

  host.innerHTML = items
    .map(
      ([n, label, note, urgent]) => `
      <div class="assist-fact${urgent ? " is-urgent" : ""}">
        <span class="assist-n">${n}</span>
        <span class="assist-lab">${esc(label)}</span>
        <span class="assist-note">${esc(note)}</span>
      </div>`
    )
    .join("");
}

/* One button per person waiting, by first name. She picks a person,
   not a record — the id never appears. */
function drawDraftButtons(host, f) {
  const waiting = f?.waiting || [];
  if (!waiting.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML =
    `<span class="assist-drafts-lab">Draft a message to</span>` +
    waiting
      .map((w, i) => `<button class="btn" type="button" data-draft-at="${i}">${esc(w.name)}</button>`)
      .join("");
}

function footNote(res) {
  if (res.note) return `Assistant unavailable — ${res.note}. The figures above are live.`;
  if (res.model && res.model !== "none") return `Worded by ${res.model} from the figures above.`;
  return "";
}

/* ---- asking -------------------------------------------------- */
function wire(host) {
  const answer = $("[data-assist-answer]", host);

  $("[data-assist-ask]", host).addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.q;
    const q = input.value.trim();
    if (!q) return;

    answer.hidden = false;
    answer.textContent = "…";
    try {
      const res = await api.assistAsk(q);
      /* An empty reply is not silence — it means the model was
         screened or unreachable, and she is owed the difference. */
      answer.textContent =
        res.text || `No answer — ${res.note || "the assistant is unavailable"}.`;
    } catch {
      answer.textContent = "Could not reach the assistant.";
    }
    input.value = "";
  });

  /* ---- drafting ---- */
  const box = $("[data-draft]", host);

  host.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-draft-at]");
    if (!btn) return;

    const id = key(Number(btn.dataset.draftAt));
    if (!id) return;

    box.hidden = false;
    box.innerHTML = `<p class="draft-body">…</p>`;
    try {
      const res = await api.assistDraft(id);
      if (!res.draft) {
        box.innerHTML = `<p class="draft-body">No draft — ${esc(res.note || "the assistant is unavailable")}.</p>`;
        return;
      }
      /* Said in the markup, not just implied by the button: this
         has not been sent, and nothing here will send it. */
      box.innerHTML = `
        <div class="draft-head">
          <span class="draft-tag">Draft · not sent</span>
          <span class="draft-note">Read it, change it, send it as yourself.</span>
        </div>
        <p class="draft-body" data-draft-body>${esc(res.draft)}</p>
        <div class="draft-acts">
          <button class="btn" type="button" data-copy>Copy</button>
          <button class="btn" type="button" data-dismiss>Dismiss</button>
        </div>`;
    } catch {
      box.innerHTML = `<p class="draft-body">Could not reach the assistant.</p>`;
    }
  });

  box.addEventListener("click", async (e) => {
    if (e.target.closest("[data-dismiss]")) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (!copy) return;
    try {
      await navigator.clipboard.writeText($("[data-draft-body]", box).textContent);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1600);
    } catch {
      /* Clipboard is permissioned and can simply say no. The text is
         on screen and selectable either way. */
      copy.textContent = "Select and copy";
    }
  });
}
