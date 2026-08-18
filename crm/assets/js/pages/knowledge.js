/* ============================================================
   KNOWLEDGE — the answers, the phrasings, and the miss queue
   ------------------------------------------------------------
   The queue is at the top because it is the only part with work
   in it. Answers and phrasings are reference material she visits
   when something needs changing; the queue is a list of visitors
   the desk has already failed, and it should be the first thing
   she sees.
   ============================================================ */

import * as api from "../api.js";
import * as masthead from "../masthead.js";
import { esc } from "../format.js";
import { start, setTally, markSource, $ } from "../page.js";

let topics = []; // [{intent, label}] — every topic that has an answer

/* ---- the miss queue ------------------------------------------
   Each row offers the two things she can do about it: attach the
   phrasing to a topic the desk already answers, or dismiss it as
   not worth answering. Both clear it from the list. */
function missRow(m) {
  const options = topics
    .map((t) => `<option value="${esc(t.intent)}">${esc(t.label)}</option>`)
    .join("");
  return `
    <div class="row is-waiting">
      <div class="row-main">
        <div class="row-top">
          <span class="who">${esc(m.text)}</span>
          <span class="tag">${m.seen}×</span>
        </div>
        <p class="row-sub">Teach it which topic answers this, or dismiss it.</p>
      </div>
      <div class="row-acts">
        <select class="btn" data-teach-topic="${esc(m.id)}" aria-label="Topic for this question">
          <option value="">Pick a topic…</option>
          ${options}
          <!-- The third outcome. Until now a missed question could
               only be bent into an existing topic or dismissed, and
               "do you do keto meal prep" is neither. -->
          <option value="__custom">Write a new answer…</option>
        </select>
        <button class="btn go" type="button" data-teach="${esc(m.id)}"
                data-text="${esc(m.text)}">Teach</button>
        <button class="btn quiet" type="button" data-dismiss="${esc(m.id)}">Dismiss</button>
      </div>

      <!-- Shown only when "Write a new answer…" is chosen. The
           question itself becomes the topic name, so she writes the
           answer and nothing else. -->
      <div class="custom-answer" data-custom="${esc(m.id)}" hidden>
        <label for="ca-${esc(m.id)}">Your answer — the desk will say this, word for word</label>
        <textarea id="ca-${esc(m.id)}" rows="3" maxlength="600"
                  placeholder="She works with athletes on meal timing and recovery — the first consultation covers what you are training for."></textarea>
        <p class="custom-count" data-count="${esc(m.id)}">0 / 50 words</p>
      </div>
    </div>`;
}

/* ---- the custom answer ----------------------------------------
   Fifty words, counted as she types and enforced again in Go.

   Not an arbitrary cap. The desk reads this out to somebody deciding
   whether to book; past a short paragraph it stops being read, and a
   long answer in a chat window looks like a page of terms. The count
   is shown rather than the text being truncated — cutting somebody's
   sentence off mid-word is a worse answer than telling them it is
   long. */
const WORD_LIMIT = 50;

const countWords = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;

function wireCustom(host) {
  host.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-teach-topic]");
    if (!pick) return;
    const id = pick.dataset.teachTopic;
    const box = host.querySelector(`[data-custom="${id}"]`);
    if (!box) return;
    box.hidden = pick.value !== "__custom";
    if (!box.hidden) box.querySelector("textarea")?.focus();
  });

  host.addEventListener("input", (e) => {
    const area = e.target.closest("[data-custom] textarea");
    if (!area) return;
    const id = area.closest("[data-custom]").dataset.custom;
    const n = countWords(area.value);
    const label = host.querySelector(`[data-count="${id}"]`);
    if (label) {
      label.textContent = `${n} / ${WORD_LIMIT} words`;
      label.dataset.over = n > WORD_LIMIT ? "true" : "false";
    }
  });
}

/* ---- answers --------------------------------------------------
   Edited in place. Saved on demand rather than on every keystroke:
   this is prose she is composing, and a save per character would
   store half-written sentences the desk would then say. */
function answerRow(a) {
  return `
    <form class="answer" data-answer="${esc(a.intent)}">
      <div class="answer-head">
        <span class="answer-topic">${esc(a.label)}</span>
        <span class="answer-intent">${esc(a.intent)}</span>
      </div>
      <textarea name="answer" rows="4" spellcheck="true">${esc(a.answer)}</textarea>
      <div class="answer-foot">
        <button class="btn go" type="submit">Save</button>
        <span class="answer-note" data-note></span>
      </div>
    </form>`;
}

/* ---- phrasings ------------------------------------------------ */
function phrasingBlock(list) {
  const byIntent = new Map();
  for (const p of list) {
    if (!byIntent.has(p.intent)) byIntent.set(p.intent, []);
    byIntent.get(p.intent).push(p);
  }

  const options = topics
    .map((t) => `<option value="${esc(t.intent)}">${esc(t.label)}</option>`)
    .join("");

  const groups = [...byIntent.entries()]
    .map(
      ([intent, items]) => `
      <div class="day">
        <span class="day-name">${esc(intent)}</span>
        <div class="bands">
          ${items
            .map(
              (p) => `
            <span class="band-chip">
              ${esc(p.phrase)}
              <button class="band-drop" type="button" data-drop-phrase="${esc(p.id)}"
                      aria-label="Remove ${esc(p.phrase)}">×</button>
            </span>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");

  return `
    ${groups || `<p class="empty">None yet. Teaching one from the queue above adds it here.</p>`}
    <form class="editor" data-phrase-form>
      <div class="editor-row">
        <label>Topic
          <select name="intent" required>
            <option value="">Pick one…</option>
            ${options}
          </select>
        </label>
        <label class="grow">Phrase
          <input type="text" name="phrase" maxlength="80" placeholder="meal plan" required>
        </label>
        <button class="btn" type="submit">Add</button>
      </div>
      <p class="editor-note" data-phrase-error></p>
    </form>`;
}

/* ---- painting -------------------------------------------------- */
function paint(data) {
  topics = (data.answers || []).map((a) => ({ intent: a.intent, label: a.label }));

  const missHost = $('[data-list="missed"]');
  missHost.innerHTML = (data.unrecognised || []).length
    ? data.unrecognised.map(missRow).join("")
    : `<p class="empty">Nothing outstanding. Anything the desk cannot place appears here.</p>`;

  $('[data-list="answers"]').innerHTML = (data.answers || []).map(answerRow).join("");
  $('[data-list="phrasings"]').innerHTML = phrasingBlock(data.phrasings || []);

  setTally("missed", (data.unrecognised || []).length);
}

async function reload() {
  const { data, live } = await api.knowledge();
  masthead.setCounts(data.counts);
  paint(data);
  markSource(live);
}

start("knowledge", api.knowledge, paint).then(() => {
  /* Bound to the document, not to a row, because the rows are
     redrawn on every reload and a listener attached to one of them
     would stop working the first time she taught anything. */
  wireCustom(document);

  /* ---- a topic from nothing ---------------------------------
     The teach queue covers "somebody asked this and the desk could
     not answer". This covers the other half: she knows a question
     is coming and would rather write the answer before it does. */
  const newTopic = document.querySelector("[data-new-topic]");
  const ntCount = document.querySelector("[data-nt-count]");
  const ntSaid = document.querySelector("[data-nt-said]");

  newTopic?.addEventListener("input", () => {
    const n = countWords(newTopic.answer.value);
    ntCount.textContent = `${n} / ${WORD_LIMIT} words`;
    ntCount.dataset.over = n > WORD_LIMIT ? "true" : "false";
  });

  newTopic?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = newTopic.label.value.trim();
    const answer = newTopic.answer.value.trim();
    ntSaid.textContent = "";
    ntSaid.dataset.tone = "";

    if (!label || !answer) return;
    if (countWords(answer) > WORD_LIMIT) {
      ntCount.dataset.over = "true";
      newTopic.answer.focus();
      return;
    }

    const btn = newTopic.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const made = await api.addTopic({ label, answer });
      newTopic.reset();
      ntCount.textContent = `0 / ${WORD_LIMIT} words`;
      ntCount.dataset.over = "false";
      /* Named, because the id is what the phrasings list below is
         keyed by — she has just been told which entry to attach a
         phrasing to. */
      ntSaid.textContent = `Added as “${made.label}”. Give it a phrasing below so the desk can recognise it.`;
      ntSaid.dataset.tone = "ok";
      await reload();
    } catch (ex) {
      ntSaid.textContent = ex.message || "That did not save.";
      ntSaid.dataset.tone = "warn";
    } finally {
      btn.disabled = false;
    }
  });

  /* One delegated listener: everything on this page is re-rendered
     wholesale after a change, so per-element handlers would need
     re-binding every time. */
  document.addEventListener("click", async (e) => {
    const teach = e.target.closest("[data-teach]");
    const dismiss = e.target.closest("[data-dismiss]");
    const dropPhrase = e.target.closest("[data-drop-phrase]");
    if (!teach && !dismiss && !dropPhrase) return;

    const btn = teach || dismiss || dropPhrase;
    btn.disabled = true;
    try {
      if (teach) {
        const id = teach.dataset.teach;
        let intent = document.querySelector(`[data-teach-topic="${id}"]`)?.value;
        if (!intent) {
          btn.disabled = false;
          return; // no topic chosen — nothing to teach yet
        }

        /* A new topic in her own words. Created FIRST, because the
           phrasing has to point at something: attach it to an intent
           that does not exist and the desk has a question it
           recognises and cannot answer, which is worse than not
           recognising it. */
        if (intent === "__custom") {
          const area = document.querySelector(`[data-custom="${id}"] textarea`);
          const answer = (area?.value || "").trim();
          const words = countWords(answer);

          if (!answer) {
            btn.disabled = false;
            area?.focus();
            return;
          }
          if (words > WORD_LIMIT) {
            const label = document.querySelector(`[data-count="${id}"]`);
            if (label) label.dataset.over = "true";
            btn.disabled = false;
            area?.focus();
            return;
          }

          // The question she was asked becomes the topic's name.
          const made = await api.addTopic({ label: teach.dataset.text, answer });
          intent = made.intent;
        }

        // Teach the phrasing, THEN clear it from the queue. If the
        // first fails the row stays, which is the honest outcome.
        await api.addPhrasing({ intent, phrase: teach.dataset.text, source: "missed" });
        await api.missedDone(id);
      } else if (dismiss) {
        await api.missedDone(dismiss.dataset.dismiss);
      } else {
        await api.dropPhrasing(dropPhrase.dataset.dropPhrase);
      }
      await reload();
    } catch {
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });

  document.addEventListener("submit", async (e) => {
    const answerForm = e.target.closest("[data-answer]");
    const phraseForm = e.target.closest("[data-phrase-form]");
    if (!answerForm && !phraseForm) return;
    e.preventDefault();

    if (answerForm) {
      const note = answerForm.querySelector("[data-note]");
      note.textContent = "";
      try {
        await api.setAnswer(answerForm.dataset.answer, { answer: answerForm.answer.value });
        // Said plainly, because the change is not instant: the desk
        // re-reads its answers on a timer, so "saved" without the
        // caveat would look broken to anyone who tested it straight
        // away in the chat.
        note.textContent = "Saved — live within a minute.";
      } catch (ex) {
        note.textContent = ex.message || "That did not save.";
      }
      return;
    }

    const err = phraseForm.querySelector("[data-phrase-error]");
    err.textContent = "";
    try {
      await api.addPhrasing({
        intent: phraseForm.intent.value,
        phrase: phraseForm.phrase.value,
      });
      await reload();
    } catch (ex) {
      err.textContent = ex.message || "That did not save.";
    }
  });
});
