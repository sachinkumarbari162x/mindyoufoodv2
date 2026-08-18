/* ============================================================
   PLAN — the pad she writes a care plan on
   ------------------------------------------------------------
   Phase one of the post-consultation programme, and deliberately
   the whole of it: free text, versioned, hers. No assistant, no
   structured rows, no client app. Those come later and every one
   of them will be derived from this text rather than replacing
   it — so this page has to be right first.

   THE RULES ARE NOT ITS OWN. Versioning, the amend-forward
   policy, and the refusal to edit an issued plan all live in Go,
   in the WHERE clause of the save. This page reflects them: if it
   were the only thing stopping an edit, a modified page would be
   enough to rewrite a document somebody is already following.

   TWO BOXES, AND THEY MUST NEVER BE CONFUSED. `body` is handed to
   the client. `privateNote` is not, and is never printed. They
   are visually distinct on purpose — the cost of typing the wrong
   thing in the wrong one is a client reading a note about
   themselves that was written for her own eyes.
   ============================================================ */

import * as api from "../api.js";
import * as punctuation from "../plan-punctuation.js";
import * as composer from "../plan-compose.js";
import { esc } from "../format.js";
import { start, $, $$ } from "../page.js";

let people = [];
let chain = [];      // every version of this person's plans
let current = null;
let saveTimer = null;
let items = [];      // the assistant's reading of the current plan

/* ---- the version chain ---------------------------------------- */

const samePlan = (p) =>
  chain.filter((x) => x.planNo === p.planNo).sort((a, b) => a.amendment - b.amendment);

function supersededBy(p) {
  const line = samePlan(p);
  const i = line.findIndex((x) => x.id === p.id);
  return i >= 0 && i < line.length - 1 ? line[line.length - 1] : null;
}

/* ---- saying so ------------------------------------------------- */

function markSaving() {
  const el = $("[data-saved]");
  el.dataset.state = "saving";
  el.textContent = "Saving…";
}

function markSaved(text) {
  const el = $("[data-saved]");
  el.dataset.state = "saved";
  el.textContent = text || "Saved";
}

function markFailed(text) {
  const el = $("[data-saved]");
  el.dataset.state = "failed";
  el.textContent = text;
}

/* ---- the strip under the pad ------------------------------------
   Its resting state is the list of marks she may use, and that is
   almost all it ever says. It exists so the rule is visible rather
   than discovered.

   WHY IT SPEAKS AT ALL. Dropping a keystroke in total silence is
   the worst version of this: she presses `#`, nothing appears, and
   there is no way to tell a rule from a broken keyboard. So the
   strip names what it threw away, in the same faint grey, and goes
   back to the list a few seconds later. No colour, no toast, no
   dialogue — the plan does not stop being written.

   Substitutions are NOT announced. A curly quote becoming a straight
   one lost nothing, and a page that congratulates itself on tidying
   punctuation would be unbearable within a day. */
let punctTimer = null;

/** Its resting state: the marks, and the shape that reads best. The
    example is there because the marks alone do not tell her that a
    leading dash is what makes a line into a row. */
function punctRest(el) {
  el.dataset.said = "false";
  el.innerHTML =
    `<span class="pad-foot-marks">${esc(punctuation.FOOTER)}</span>` +
    `<span class="pad-foot-eg">${esc(punctuation.SHAPE)}</span>`;
}

/** The long version, drawn once from the same module that enforces
    the rule. Guidance kept anywhere else drifts from the code, and
    a help text that has drifted is worse than none: she follows it,
    it does not work, and she stops believing the page. */
function paintPunctGuide() {
  const host = $("[data-punct-guide-body]");
  if (!host || host.childElementCount) return;

  host.innerHTML = punctuation.GUIDE.map(
    (g) => `
    <div class="pg-item">
      <p class="pg-mark" aria-hidden="true">${esc(g.mark)}</p>
      <div class="pg-text">
        <p class="pg-title">${esc(g.title)}</p>
        <p class="pg-body">${esc(g.body)}</p>
        ${g.good ? `<p class="pg-eg" data-tone="good">${esc(g.good)}</p>` : ""}
        ${g.poor ? `<p class="pg-eg" data-tone="poor">${esc(g.poor)}</p>` : ""}
      </div>
    </div>`
  ).join("");
}

function sayPunctuation(dropped) {
  const el = $("[data-punct]");
  if (!el) return;

  if (!dropped.length) {
    if (!punctTimer) punctRest(el);
    return;
  }

  el.dataset.said = "true";
  el.textContent = `Not used in a plan: ${dropped.join(" ")}`;

  clearTimeout(punctTimer);
  punctTimer = setTimeout(() => {
    punctTimer = null;
    punctRest(el);
  }, 3000);
}

/* ---- painting -------------------------------------------------- */

/** The figures as they stood when the plan was opened. Shown, not
    recomputed — the whole reason they are stored on the row. */
function paintTargets(p) {
  const host = $("[data-targets]");
  const t = p.targets || {};
  const bits = Object.entries(t).filter(([, v]) => v !== null && v !== "");

  host.hidden = !bits.length;
  if (!bits.length) return;

  const LABEL = {
    energy_kcal: "Energy",
    protein_g: "Protein",
    fluid_ml: "Fluid",
    bmr: "BMR",
    weight_kg: "Weight",
    activity_factor: "Activity",
  };
  const UNIT = { energy_kcal: "kcal", protein_g: "g", fluid_ml: "ml", bmr: "kcal", weight_kg: "kg" };

  host.innerHTML =
    `<span class="targets-l">When this was written</span>` +
    bits
      .map(
        ([k, v]) => `
      <span class="target">
        <span class="target-k">${esc(LABEL[k] || k)}</span>
        <span class="target-v">${esc(v)}${UNIT[k] ? " " + UNIT[k] : ""}</span>
      </span>`
      )
      .join("");
}

function paintVersions(p) {
  const bar = $("[data-versions]");
  const notice = $("[data-superseded]");
  const line = samePlan(p);
  const newer = supersededBy(p);

  /* EVERY PLAN THIS PERSON HAS EVER HAD, not just the amendments
     of the one on screen.

     It listed `samePlan(p)` — versions sharing a plan number — so
     the moment a second plan was started the first one had no
     route back to it. A client on their third plan had two
     documents in their record that the CRM could not open.

     Shown whenever there is more than one, which is the same rule
     as before; it is the definition of "more than one" that was
     too narrow. */
  const every = [...chain].sort((a, b) => a.planNo - b.planNo || a.amendment - b.amendment);

  bar.hidden = every.length < 2;
  if (!bar.hidden) {
    bar.innerHTML =
      `<span class="versions-label">Plans</span>` +
      every
        .map(
          (v) => `
        <button class="ver" type="button" data-version="${esc(v.id)}"
                data-state="${esc(v.status)}"
                title="${v.status === "draft" ? "Not issued yet" : "Issued"}"
                aria-current="${v.id === p.id}">${esc(v.ref)}</button>`
        )
        .join("");
  }

  /* READ-ONLY, AND SAID BEFORE SHE TYPES INTO IT. An issued plan is
     in somebody's hands; going back to edit it would change what
     they were given after they had started following it. */
  const readOnly = !!newer || p.status === "issued";
  document.body.dataset.readonly = String(readOnly);
  notice.hidden = !readOnly;
  if (readOnly) {
    notice.innerHTML = newer
      ? `An earlier version, kept as it was given. Superseded by <b>${esc(newer.ref)}</b> — ` +
        `<button class="ver-link" type="button" data-version="${esc(newer.id)}">open the current one</button>.`
      : `This plan has been issued. <b>Amend</b> writes the next version and leaves this one exactly as they received it.`;
  }

  $("[data-body]").readOnly = readOnly;
  $("[data-note]").readOnly = readOnly;

  const act = $("[data-issue]");
  act.textContent = p.status === "issued" ? "Amend" : "Issue";
  act.disabled = !!newer;

  /* A NEW PLAN, only when there is not already an unissued one.
     Two open drafts for one person is a state the partial unique
     index refuses anyway, so offering it would be offering a
     button that fails. */
  const fresh = $("[data-new-plan]");
  if (fresh) {
    const draft = chain.find((x) => x.status === "draft");
    fresh.disabled = !!draft;
    fresh.title = draft
      ? `${draft.ref} is still a draft — issue it before starting another`
      : "Start the next plan for this client";
  }
}


/* ---- what the assistant read -----------------------------------
   THREE ANSWERS, AND THE DIFFERENCE BETWEEN TWO OF THEM IS THE
   POINT. "Confirm" means it was right as written; saving an edited
   row means it was nearly right; "No" means it was wrong. Collapsing
   the first two into one button would throw away the only number
   this phase exists to produce.

   Every row shows the line of HER TEXT it came from, so she is
   checking a proposal against a sentence rather than against her
   memory of what she meant. */

const VERDICT = {
  proposed:  { label: "",           tone: "" },
  confirmed: { label: "confirmed",  tone: "yes" },
  edited:    { label: "you fixed it", tone: "yes" },
  rejected:  { label: "wrong",      tone: "no" },
};

/** The line of the plan a row was read out of. Split on the same
    boundary the server numbered them by, or a Windows newline would
    shift every proposal one line down the page. */
function sourceText(line) {
  if (line === null || line === undefined) return "";
  const lines = String(current?.body || "").split(/\r?\n/);
  return lines[line] || "";
}

function itemRow(it) {
  const v = VERDICT[it.status] || VERDICT.proposed;
  const src = sourceText(it.sourceLine);
  const settled = it.status !== "proposed";

  return `
    <tr class="item" data-item="${esc(it.id)}" data-status="${esc(it.status)}">
      <td class="cell-label">
        <input class="item-label" data-f="label" value="${esc(it.label)}"
               aria-label="What to do" />
        ${
          /* THE SENTENCE IT CAME OUT OF, under the row it produced.
             She is checking a proposal against her own words rather
             than against her memory of what she meant — which is the
             difference between reviewing and rubber-stamping. */
          src ? `<p class="item-src">${esc(src)}</p>` : ""
        }
      </td>
      <td class="cell-n">
        <input class="item-qty" data-f="quantity" inputmode="decimal"
               value="${it.quantity ?? ""}" placeholder="—" aria-label="How much" />
      </td>
      <td>
        <input class="item-unit" data-f="unit" value="${esc(it.unit)}"
               placeholder="unit" aria-label="Unit" />
      </td>
      <td>
        <input class="item-when" data-f="schedule" value="${esc(it.schedule)}"
               placeholder="when" aria-label="When" />
      </td>
      <td class="cell-kind"><span class="item-kind">${esc(it.kind)}</span></td>

      <td class="cell-acts">
      <div class="item-acts">
        ${v.label ? `<span class="item-verdict" data-tone="${v.tone}">${esc(v.label)}</span>` : ""}
        ${
          /* DELETE, AND ONLY BEFORE SHE HAS RULED. A row she never
             judged carries no evidence, so throwing it away costs
             nothing. Once she has said "No", that row IS the record
             that the assistant got something wrong — deleting it
             would walk its score up every time it annoyed her.

             So the button is here and disappears the moment a verdict
             lands. Go refuses it either way; this only stops her
             pressing something that would be refused. */
          settled
            ? ""
            : `<button class="btn quiet is-drop" type="button" data-drop
                       title="Remove this row — it should not be here at all">Delete</button>`
        }
        <button class="btn quiet" type="button" data-verdict="rejected"
                ${it.status === "rejected" ? "disabled" : ""}>No</button>
        <button class="btn go" type="button" data-verdict="confirmed"
                ${settled ? "disabled" : ""}>Confirm</button>
      </div>
      </td>
    </tr>`;
}

function paintTally() {
  const n = (s) => items.filter((i) => i.status === s).length;
  const judged = n("confirmed") + n("edited") + n("rejected");
  const el = $("[data-tally]");
  if (!items.length) { el.textContent = ""; return; }
  el.textContent = judged
    ? `${n("confirmed")} right · ${n("edited")} fixed · ${n("rejected")} wrong · ${n("proposed")} to check`
    : `${items.length} to check`;
}

/* ============================================================
   THE TABLE
   ------------------------------------------------------------
   These were cards — one boxed row per instruction, four inputs
   stacked inside it. That reads well for three rows and badly for
   twelve: a plan is a LIST OF COMPARABLE THINGS, and the question
   she is answering is "is this right" twelve times in a row. A
   table puts the same field of every row in the same column, so
   the eye runs down `2 eggs / 15 almonds / 1 cup` instead of
   hunting for the amount in each card.

   IT IS A REAL TABLE, not a grid of divs. Screen readers announce
   the column when the cell is reached, which is the whole reason
   somebody who cannot see the layout can still check a plan.

   STILL EDITABLE IN PLACE. The inputs did not become read-only
   cells: she fixes an amount where she reads it, and the verdict
   buttons are on the same line as the thing they judge.
   ============================================================ */
function paintItems() {
  const host = $("[data-rows]");

  if (!items.length) {
    host.innerHTML =
      `<p class="empty">Nothing read yet. Press <b>Read the plan</b> and check what it finds.</p>`;
    paintTally();
    paintButtons();
    return;
  }

  host.innerHTML = `
    <div class="rows-scroll">
      <table class="rows-tbl">
        <thead>
          <tr>
            <th scope="col">What to do</th>
            <th scope="col" class="col-n">How much</th>
            <th scope="col">Unit</th>
            <th scope="col">When</th>
            <th scope="col">Kind</th>
            <th scope="col">Your verdict</th>
          </tr>
        </thead>
        <tbody>${items.map(itemRow).join("")}</tbody>
      </table>
    </div>`;

  paintTally();
  paintButtons();
}

/** Clear the reading and start again.

    NO CONFIRMATION DIALOGUE, because there is nothing to lose: it
    removes rows nobody has agreed to, and pressing Build plan puts
    back whatever the text still supports. What it KEPT is the part
    worth saying, and it says it. */
async function clearRows() {
  if (!current) return;
  try {
    const out = await api.clearPlanItems(current.id);
    const fresh = await api.planItems(current.id);
    items = fresh.items || [];
    hideRewrite();
    paintItems();

    const el = $("[data-tally]");
    if (el) {
      /* Her words. "Cleared 12 · kept 4 you had ruled on" is a
         database telling her what it did to its rows; this is a
         sentence about her plan. */
      el.textContent = out.kept
        ? `Started again — ${out.kept} row${out.kept === 1 ? "" : "s"} you kept are still here`
        : "Started again — the table is empty";
      setTimeout(paintTally, 4000);
    }
  } catch (err) {
    markFailed(err.message || "Could not clear those rows");
  }
}

/** Her verdict on one row, with whatever she typed into it. */
async function rule(id, status) {
  const box = $(`[data-item="${CSS.escape(id)}"]`);
  const it = items.find((x) => x.id === id);
  if (!it || !box) return;

  const field = (f) => box.querySelector(`[data-f="${f}"]`)?.value ?? "";
  const qty = field("quantity").trim();

  /* CONFIRMED OR EDITED IS NOT HER CHOICE TO MAKE — it is a fact
     about whether she changed anything, so it is worked out here by
     comparing what is in the boxes against what the model proposed.
     Asking her to classify her own correction would be asking her to
     do the measurement's bookkeeping. */
  const changed =
    status === "confirmed" &&
    (field("label").trim() !== it.label ||
      field("unit").trim() !== it.unit ||
      field("schedule").trim() !== it.schedule ||
      (qty === "" ? it.quantity !== null : Number(qty) !== it.quantity));

  const body = { status: changed ? "edited" : status };
  if (status !== "rejected") {
    body.label = field("label").trim();
    body.unit = field("unit").trim();
    body.schedule = field("schedule").trim();
    if (qty !== "" && Number.isFinite(Number(qty))) body.quantity = Number(qty);
  }

  try {
    await api.itemVerdict(id, body);
    const fresh = await api.planItems(current.id);
    items = fresh.items || [];
    paintItems();
  } catch (err) {
    markFailed(err.message || "Could not record that");
  }
}

/** What the reading did, in a sentence. Silence after a re-read is
    the thing that made the old duplicate bug so hard to see: the
    panel simply redrew and she was left to diff two screens. */
function saySwept(changed) {
  const el = $("[data-tally]");
  if (!el || !changed) return;

  const bits = [];
  if (changed.added) bits.push(`${changed.added} new`);
  if (changed.refreshed) bits.push(`${changed.refreshed} updated`);
  if (changed.kept) bits.push(`${changed.kept} you had already checked`);
  if (changed.gone) bits.push(`${changed.gone} no longer in the plan`);

  el.textContent = bits.length ? bits.join(" · ") : "Nothing has changed since the last read";
  // And back to the running count, which is what the strip is for.
  setTimeout(paintTally, 4000);
}

/* ============================================================
   WRITING THE PLAN OUT FROM THE ROWS
   ------------------------------------------------------------
   The second half of the round trip. Prose in, rows out, rows
   back to prose — and the point of closing it is that the two
   audiences stop disagreeing: the client's app shows the ROWS,
   the plan link shows the TEXT, and when one is written from the
   other they cannot drift.

   NOTHING IS REPLACED UNTIL SHE HAS READ THE REPLACEMENT. The
   easy version rewrites the pad and offers an undo, and it is the
   wrong one: this pad holds the document somebody receives, and
   asking her to spot what changed in a wall of text she was just
   looking at is not a review. Both versions, side by side, and
   Keep is the default.
   ============================================================ */
let rewriteText = null;

/**
 * Lay a set of proposed rows out as text, beside what is in the pad.
 *
 * @param {object[]} modelItems  what the assistant proposed
 * @param {object} [opts]
 * @param {string} [opts.title]     where it came from, in her words
 * @param {boolean} [opts.replace]  true to offer it INSTEAD of the
 *        pad rather than merged into it — a first draft written from
 *        the assessment is a whole plan, not an edit of one
 * @param {string[]} [opts.warnings] what the safety check found
 */
function showRewrite(modelItems, opts = {}) {
  const box = $("[data-rewrite]");
  if (!box || !current) return;

  const title = $("[data-rewrite-title]");
  if (title) title.textContent = opts.title || "Written out from your rows";

  paintWarnings(opts.warnings || []);

  /* EVERY ROW THE MODEL READ, and none of them ruled on.

     Nothing has been confirmed at this point and nothing should
     have been: rows do not exist until Build, which runs on the
     text she accepts here. So the preview lays out the whole
     reading and she judges it as TEXT — which is the right unit,
     because text is what the client's plan link shows. */
  const read = (modelItems || []).map((i) => ({ ...i, status: "confirmed" }));

  const was = current.body || "";
  /* Anything that produced no row is carried through untouched —
     "come back in six weeks" is not an instruction and no row will
     ever be made from it. Losing that to a tidy-up would be the
     worst thing this button could do.

     EXCEPT ON A FIRST DRAFT. Those rows were written from the
     assessment rather than read out of the pad, so `leftovers`
     would find every line of whatever is in the pad unaccounted
     for and staple the old plan underneath the new one. She is
     being offered a REPLACEMENT here, and the panel shows both
     sides so she can see exactly what she would be giving up. */
  const keep = opts.replace ? "" : composer.leftovers(was, read);
  const next = composer.compose(read, { keep });

  if (!next.trim()) {
    markFailed("The assistant found no instructions in this plan.");
    return;
  }

  rewriteText = next;
  $("[data-rewrite-was]").textContent = was;
  $("[data-rewrite-now]").textContent = next;

  /* WHAT IT DID, SAID BEFORE SHE ACCEPTS IT. The counts describe
     this reading, not the table below — there is no table yet, and
     that is the sequence rather than an oversight. */
  const bits = opts.replace
    ? [
        `${read.length} row${read.length === 1 ? "" : "s"} written`,
        was.trim()
          ? "this would REPLACE what is in the pad — read both sides"
          : "the pad is empty, so nothing would be lost",
        "nothing is saved until you press Build",
      ]
    : [
        `${read.length} instruction${read.length === 1 ? "" : "s"} found`,
        ...(keep ? ["anything that was not an instruction is kept as you wrote it"] : []),
        "nothing is saved until you press Build",
      ];
  $("[data-rewrite-why]").textContent = bits.join(" · ") + ".";

  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** WHERE THE ASSISTANT DISAGREED WITH THE RECORD.

    Nothing is removed on the strength of this — she is the
    clinician, and a machine quietly deleting a row from a plan is
    exactly the behaviour that would make the rest of it
    untrustworthy. It is put in front of her, in words, before she
    has agreed to anything. */
function paintWarnings(list) {
  const box = $("[data-warns]");
  const host = $("[data-warns-list]");
  if (!box || !host) return;

  host.replaceChildren();
  box.hidden = !list.length;
  if (!list.length) return;

  for (const line of list) {
    const li = document.createElement("li");
    li.textContent = line;   // her record's words and the model's; both are text
    host.append(li);
  }
}

function hideRewrite() {
  rewriteText = null;
  const box = $("[data-rewrite]");
  if (box) box.hidden = true;
  paintWarnings([]);
}

/** Take it. The pad is the source of truth for what is issued, so
    this goes through the same save path as typing does — including
    the punctuation rules, which the composed text already obeys. */
async function useRewrite() {
  if (!rewriteText || !current) return;
  const pad = $("[data-body]");
  pad.value = rewriteText;
  current.body = rewriteText;
  hideRewrite();

  /* SAVED NOW, NOT IN 400ms. The next thing she does is press
     Build, which reads the plan from the DATABASE rather than from
     this page — deliberately, so the rows describe the document
     that was actually stored. With the ordinary debounce that read
     could arrive first and find the old prose, and Build would
     answer "no instructions found" about a plan full of them. */
  await flush();

  /* AND THE BUTTONS RECOMPUTED. Build is disabled until the text
     has instructions in it, and that state is derived from the body
     — so accepting a generated plan without repainting left the
     button dead over text that was now full of dashes. This was the
     whole of "Build is not working after Generate". */
  paintButtons();
  markSaved("Written out");
}

/** Remove a proposal outright. The row goes from the screen first,
    because the server has already agreed by the time this returns
    and a list that waits a round trip to lose one row feels broken. */
async function dropRow(id) {
  try {
    await api.dropPlanItem(id);
    items = items.filter((x) => x.id !== id);
    paintItems();
  } catch (err) {
    markFailed(err.message || "Could not remove that row");
  }
}

/* THREE READS PER VERSION, and the button says so rather than
   discovering it on the fourth press.

   The count is the server's — this only reflects it. A limit that
   exists in a page is a limit that goes away when the page is
   reloaded, and this one is the difference between "the assistant
   misread a line" and "keep pressing until it agrees".

   The wording at zero names the actual fix: the sentence is the
   problem, not the reading of it. */
const READ_CAP = 3;

/* And a separate three for writing a first draft from the finalised
   assessment. Not a share of the reads — migration 0029 sets out why
   pooling them would mean one press of the expensive button
   disabling the cheap one she needs afterwards. Go holds the
   authoritative copy; this one only draws the label. */
const DRAFT_CAP = 3;

/* ============================================================
   THE THREE BUTTONS, AND WHY THEIR ORDER IS ENFORCED
   ------------------------------------------------------------
     Generate   her prose -> the model -> structured text
     Build      that text -> the syntax reviewer -> the rows
     Clear      throw the rows away and start again

   BUILD IS OFF UNTIL THERE IS STRUCTURE TO READ, and that is not
   an arbitrary sequence. Build calls no model: it reads lines that
   begin with a dash. On raw prose it would find nothing, so the
   button says so by being disabled rather than by failing when
   pressed. Generate is what puts the dashes in.

   She can edit in between, which is the point of two steps rather
   than one: the generated text is hers to correct before any row
   exists, and because the syntax is strict her corrections parse
   exactly as the model's output did.
   ============================================================ */
function paintButtons() {
  if (!current) return;
  const readOnly = document.body.dataset.readonly === "true";

  /* ---- Generate: the only model call, and the only capped one -- */
  const gen = $("[data-generate]");
  const used = current.reads || 0;
  const left = Math.max(0, READ_CAP - used);

  if (gen) {
    gen.disabled = left === 0 || readOnly || !(current.body || "").trim();
    gen.textContent = used === 0 ? "Generate plan" : `Generate plan · ${left} left`;
    gen.title = left
      ? `The assistant may read this version ${left} more time${left === 1 ? "" : "s"}`
      : "Read three times already. Edit the wording and press Build, or issue and amend.";
  }

  /* ---- Fetch and create: needs a finalised assessment ---------- */
  const draft = $("[data-draft]");
  if (draft) {
    const spent = current.drafts || 0;
    const leftD = Math.max(0, DRAFT_CAP - spent);
    const issued = current.status !== "draft";

    /* THE REASON IS ON THE BUTTON, not discovered by pressing it.
       Four different noes, and they need four different sentences —
       "no finalised assessment" and "you have used your three" send
       her to completely different places. */
    draft.disabled = !finalAssessment || leftD === 0 || issued || readOnly;
    draft.textContent = spent === 0 ? "Fetch and create" : `Fetch and create · ${leftD} left`;

    draft.title = issued
      ? "This plan has been issued. Amend it to write a new draft."
      : !finalAssessment
      ? "No finalised assessment for this client yet. Finish the assessment and mark it final."
      : leftD === 0
      ? "Three drafts written from this assessment already. Edit what it gave you, or amend."
      : `Write a first draft from ${finalAssessment.ref}` +
        (leftD < DRAFT_CAP ? ` · ${leftD} left` : "");
  }

  /* ---- Build: off until the text has instructions in it -------- */
  const btn = $("[data-read]");
  if (!btn) return;

  /* THE SAME TEST THE PARSER MAKES, so the button is never enabled
     over text that would then produce nothing. A line starting with
     a dash is an instruction; anything else is prose. */
  /* `[^\S\n]` and not `\s`, kept in step with buildable() in
     plan-ai/parse.js — \s matches a newline, so the loose version
     found a dash on one line and content on the next and called
     two empty dashes buildable. */
  const hasRows = /^-[^\S\n]+\S/m.test(current.body || "");

  btn.disabled = !hasRows || readOnly;
  btn.textContent = "Build plan";
  btn.title = hasRows
    ? "Read the plan's syntax and build the rows — no model, no limit"
    : "Nothing to build yet. Press Generate, or write lines beginning with a dash.";

  /* ---- Clear, and Generate's spent state ---------------------- */
  const clear = $("[data-clear]");
  if (clear) {
    /* ANYTHING SHE HAS NOT KEPT, which is what Start again
       removes — the assistant's untouched suggestions AND the ones
       she marked wrong.

       This counted only `proposed`, so after she had been down the
       list rejecting the bad rows the button greyed out with the
       whole table still full of them. It read as broken because
       from where she was sitting it was. */
    const going = items.filter(
      (i) => i.status === "proposed" || i.status === "rejected"
    ).length;
    clear.disabled = going === 0 || readOnly;
    clear.title = going
      ? `Throw away ${going} row${going === 1 ? "" : "s"} and start this reading again`
      : "Nothing to throw away — every row here is one you kept";
  }

  const why = $("[data-reading-why]");
  if (why && left === 0) {
    why.textContent =
      "The assistant has read this three times. Build still works — it reads the syntax " +
      "rather than the meaning, and costs nothing. If the rows are wrong, fix the wording " +
      "above and press Build again.";
  }
}

/* ============================================================
   BUILD — the syntax reviewer, and not a model
   ------------------------------------------------------------
   Reads the plan text as it stands and turns it into the rows in
   the table. Nothing generative, no charge against the three
   reads: the structure is already in the text and this is reading
   it rather than guessing at it.

   OFF UNTIL THERE IS STRUCTURE TO READ. On raw prose it would find
   nothing, so the button says so by being disabled rather than by
   failing when pressed. Generate is what puts the dashes in —
   which is why the order is Generate, review, Build.

   SHE CAN EDIT IN BETWEEN, and that is the point of two steps. The
   generated text is hers to correct before any row exists, and
   because the syntax is strict her corrections parse exactly as
   the model's output did.
   ============================================================ */
async function buildPlan() {
  const btn = $("[data-read]");
  btn.disabled = true;
  btn.textContent = "Building…";
  try {
    /* The plan is read from the database, not from this page, so
       whatever is in the pad has to be there first. See flush(). */
    await flush();
    const out = await api.buildPlan(current.id);
    items = out.items || [];
    hideRewrite();
    paintItems();
    saySwept(out.changed);
    sayProblems(out.problems);
  } catch (err) {
    $("[data-rows]").innerHTML =
      `<p class="empty is-bad">${esc(err.message || "Could not build the rows")}</p>`;
  } finally {
    paintButtons();
  }
}

/** WHAT IT COULD NOT READ, listed rather than swallowed.

    A line silently dropped is how a client loses an instruction
    while she is looking at a table that seems complete. Prose is
    never reported — a sentence with no dash was not trying to be a
    row, and complaining about it would train her to stop reading
    this list. */
function sayProblems(problems) {
  const host = $("[data-problems]");
  if (!host) return;

  if (!problems?.length) { host.hidden = true; host.replaceChildren(); return; }

  host.hidden = false;
  host.innerHTML =
    `<p class="probs-l">${problems.length} line${problems.length === 1 ? "" : "s"} ` +
    `looked like an instruction and could not be read</p>` +
    problems
      .map(
        (p) => `
        <div class="prob">
          <p class="prob-why">${esc(p.why)}</p>
          <p class="prob-text">${esc(p.text)}</p>
        </div>`
      )
      .join("");
}

/* ============================================================
   FETCH AND CREATE — the first draft, out of the finalised record
   ------------------------------------------------------------
   The other direction from Generate. Generate reads what she has
   written; this writes what she has not, from the nutrition
   assessment she has already finalised.

   IT IS THE ONLY PLACE IN THIS SYSTEM WHERE THE ASSISTANT WRITES
   CLINICAL ADVICE, so the sequence around it is deliberately slow:

     press          the assistant writes rows from the assessment
     read           they appear as TEXT beside what is in the pad,
                    with anything that collides with a recorded
                    allergy flagged above them
     Use this       the text lands in the editor, hers to change
     Build          the syntax reviewer turns it into rows and says
                    what it could not read
     Issue          only now does a client see any of it

   Four decisions of hers between the model and somebody's food.
   Nothing here shortens that, and nothing should.
   ============================================================ */

/** The latest finalised assessment for this client, or null. Read
    when a plan opens, because the button's state depends on it and
    a button that offers itself and then refuses teaches her not to
    trust the page. */
let finalAssessment = null;

async function loadAssessment(personId) {
  finalAssessment = null;
  if (!personId) return paintButtons();
  try {
    const out = await api.assessments(personId);
    const done = (out.assessments || []).filter((a) => a.status === "final");
    done.sort((a, b) => (b.visit - a.visit) || (b.amendment - a.amendment));
    finalAssessment = done[0] || null;
  } catch {
    /* Not knowing is not the same as knowing there is none. The
       button stays off and says why — the server would refuse it
       anyway, and guessing "yes" here would spend one of three
       drafts finding that out. */
    finalAssessment = null;
  }
  paintButtons();
}

/* Put back the shape she used last time, once, on load. */
function restoreShape() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("myf.plan.shape") || "null");
  } catch {
    saved = null;
  }
  if (!saved) return;
  const mealsEl = $("[data-shape-meals]");
  const fillersEl = $("[data-shape-fillers]");
  if (mealsEl && saved.meals) mealsEl.value = String(saved.meals);
  if (fillersEl && typeof saved.fillers === "boolean") fillersEl.checked = saved.fillers;
}

async function fetchAndCreate() {
  const btn = $("[data-draft]");
  btn.disabled = true;
  btn.textContent = "Writing…";
  try {
    /* WHAT SHE ASKED FOR, and it is remembered. She writes plans
       of a shape — this practice is mostly four meals — and making
       her set it again on every client is the kind of small
       repetition that adds up to feeling like data entry. */
    const mealsEl = $("[data-shape-meals]");
    const fillersEl = $("[data-shape-fillers]");
    const shape = {
      meals: Number(mealsEl && mealsEl.value) || 4,
      fillers: fillersEl ? fillersEl.checked : true,
    };
    try {
      localStorage.setItem("myf.plan.shape", JSON.stringify(shape));
    } catch {
      /* Private browsing, or storage full. The shape still applies
         to this press; it simply is not remembered for the next. */
    }

    const out = await api.draftFromAssessment(current.id, shape);
    current.drafts = (current.drafts || 0) + 1;

    const from = out.from?.ref ? ` ${out.from.ref}` : "";
    showRewrite(out.items || [], {
      title: `Written from the assessment${from}`,
      /* A whole plan, not an edit of one — see showRewrite. */
      replace: true,
      warnings: out.warnings || [],
    });
  } catch (err) {
    /* Said on the page rather than in the rows table: the rows
       table describes the plan, and this failed before there was
       anything to describe. */
    markFailed(err.message || "The assistant did not answer");
  } finally {
    paintButtons();
  }
}

async function generatePlan() {
  const btn = $("[data-generate]");
  btn.disabled = true;
  btn.textContent = "Reading…";
  try {
    const out = await api.generatePlan(current.id);
    /* Counted here as well as on the server, so the button is right
       without a second fetch. The next paint reads the real number. */
    current.reads = (current.reads || 0) + 1;
    showRewrite(out.items || []);
  } catch (err) {
    $("[data-rows]").innerHTML =
      `<p class="empty is-bad">${esc(err.message || "The assistant did not answer")}. ` +
      `The plan itself is unaffected — you can issue it without this.</p>`;
  } finally {
    // Back to whatever the count now allows, not to a fixed label.
    paintButtons();
  }
}

/** The panel only exists for a draft. Once the plan is issued its
    rows are settled, and re-reading would rewrite the structure
    under a document somebody is already following. */
async function paintReading(p) {
  const box = $("[data-reading]");
  box.hidden = p.status !== "draft";
  if (box.hidden) { items = []; return; }

  try {
    const out = await api.planItems(p.id);
    items = out.items || [];
  } catch {
    items = [];
  }
  paintItems();
  paintButtons();
}

/** The link she hands over. Only for an issued plan — a draft has no
 *  door, and Go refuses to mint one.
 *
 *  ITS FAILURE IS NOT THE PLAN'S FAILURE. If minting is refused the
 *  panel says so and everything else on the page carries on; she can
 *  still print the plan and give it to them on paper. */
async function paintHandover(p) {
  const box = $("[data-handover]");
  const out = $("[data-plan-url]");
  const wa = $("[data-wa]");

  if (p.status !== "issued") { box.hidden = true; return; }

  box.hidden = false;
  out.textContent = "making the link…";
  out.removeAttribute("href");
  wa.hidden = true;

  try {
    const { url } = await api.planLink(p.id);
    out.textContent = url;
    out.href = url;

    /* The message she sends, already written. wa.me opens WhatsApp
       with the text filled in and she presses send — the same
       manual path the booking confirmation uses, so nothing here
       needs a Meta template or an approval. */
    const first = String(p.personName || "").trim().split(/\s+/)[0] || "there";
    const text = [
      `Hi ${first}, here is your plan from today's consultation.`,
      ``,
      url,
      ``,
      `It will always show the current version.`,
      `— Khadija, Mind Your Food`,
    ].join("\n");
    wa.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    wa.hidden = false;
  } catch (err) {
    out.textContent = err.message || "could not make a link";
  }
}

function paint(p) {
  current = p;
  $("[data-blank]").hidden = true;
  $("[data-sheet]").hidden = false;
  $("[data-acts]").hidden = false;

  $("[data-ref]").textContent = p.ref + (p.amendsRef ? ` · amends ${p.amendsRef}` : "");
  $("[data-meta]").textContent =
    (p.status === "issued" ? "Issued" : "Draft") +
    " · started " +
    new Date(p.startedAt).toLocaleString("en-GB", {
      weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    });

  $("[data-bar-who]").textContent = `${p.personName} · ${p.ref}`;
  $("[data-body]").value = p.body || "";
  $("[data-note]").value = p.privateNote || "";

  const foot = $("[data-issued]");
  foot.hidden = !p.issuedAt;
  if (p.issuedAt) {
    foot.textContent =
      "Given to " + p.personName + " on " +
      new Date(p.issuedAt).toLocaleString("en-GB", {
        weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
      }) + ".";
  }

  paintTargets(p);
  paintVersions(p);
  /* Whether Fetch and create has anything to work from. Deliberately
     not awaited: the pad has to open now, and the button repaints
     itself when the answer arrives a moment later. */
  loadAssessment(p.personId);
  paintHandover(p);
  paintReading(p);
  // A preview of a different plan's rows is worse than none.
  hideRewrite();
  markSaved();
}

/* ---- saving ---------------------------------------------------- */

/** Save NOW, and wait for it.

    `touch` is the right thing while she is typing — a request per
    keystroke is a request per keystroke. It is the wrong thing
    immediately before an action that reads the plan back off the
    database, because the debounce means the read can overtake the
    write and act on the previous version. Build does exactly that,
    so Build flushes first. */
async function flush() {
  if (!current || document.body.dataset.readonly === "true") return;
  clearTimeout(saveTimer);
  markSaving();
  try {
    await api.savePlan(current.id, {
      body: current.body,
      privateNote: current.privateNote,
    });
    markSaved();
  } catch (err) {
    markFailed("Not saved — " + (err.message || "try again"));
    throw err;
  }
}

function touch() {
  if (document.body.dataset.readonly === "true") return;
  markSaving();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api.savePlan(current.id, {
        body: current.body,
        privateNote: current.privateNote,
      });
      markSaved();
    } catch (err) {
      /* Said plainly rather than swallowed. A plan that silently
         failed to save is a consultation she will have to run
         again from memory. */
      markFailed("Not saved — " + (err.message || "try again"));
    }
  }, 400);
}

/* ---- the client list ------------------------------------------- */

function renderList() {
  const q = ($("[data-find]").value || "").trim().toLowerCase();
  const shown = people.filter((p) => !q || (p.name + " " + p.email).toLowerCase().includes(q));

  $("[data-list]").innerHTML = shown.length
    ? shown
        .map(
          (p) => `
        <button class="row" type="button" data-person="${esc(p.id)}"
                aria-current="${current?.personId === p.id}">
          <span class="who">${esc(p.name)}</span>
          <span class="sub">${esc(p.email)}</span>
        </button>`
        )
        .join("")
    : `<p class="empty">Nobody matches that.</p>`;
}

/* ============================================================
   CHOOSING A CLIENT SHOWS WHAT IS THERE. IT CREATES NOTHING.
   ------------------------------------------------------------
   This used to call openPlan, which is mint-or-start-NEXT: no
   open draft means Go writes the next plan number. So clicking a
   client whose plan had been issued did two bad things at once.

   It started an empty plan she had not asked for — every glance
   at somebody's record left another abandoned draft behind, and
   the plan numbers climbed.

   And it made the issued plan DISAPPEAR. The new draft became the
   current one, and the version bar only ever listed amendments of
   the same plan number, so the plan the client is actually
   following was on screen nowhere at all. "Once plans are issued
   they are not visible on the system" was exactly this.

   Now: read first, paint the most useful thing, and put starting
   a new plan behind a button that says so.
   ============================================================ */
async function openFor(personId, consultationId) {
  markSaving();
  try {
    const all = await api.plans(personId);
    chain = all.plans || [];
    pendingConsultation = consultationId || null;

    if (!chain.length) {
      /* Nobody has ever written one. Opening the pad here is what
         she came to do, so this is the one case that still creates
         — and it is a first plan rather than an extra one. */
      const opened = await api.openPlan({ personId, consultationId: consultationId || null });
      chain = [opened.plan];
      paint(opened.plan);
      renderList();
      return;
    }

    /* An open draft is where she left off. Otherwise the newest
       plan, read-only — which is the thing she is most often here
       to look at, and the thing that used to vanish. */
    const draft = chain.find((p) => p.status === "draft");
    const newest = [...chain].sort(
      (a, b) => a.planNo - b.planNo || a.amendment - b.amendment
    ).pop();

    paint(draft || newest);
    renderList();
  } catch (err) {
    markFailed(err.message || "Could not open that");
  }
}

/* Carried from the room, so a plan started from a consultation is
   still tied to it — the link openFor used to pass straight into
   openPlan and now has to survive until she presses New plan. */
let pendingConsultation = null;

/** Start the next plan for this person. The only place a new one is
    created from now, and it says what it does. */
async function newPlan() {
  if (!current) return;
  const btn = $("[data-new-plan]");
  if (btn) btn.disabled = true;
  try {
    const opened = await api.openPlan({
      personId: current.personId,
      consultationId: pendingConsultation,
    });
    const all = await api.plans(current.personId);
    chain = all.plans || [];
    paint(chain.find((p) => p.id === opened.plan.id) || opened.plan);
  } catch (err) {
    markFailed(err.message || "Could not start a plan");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---- wiring ---------------------------------------------------- */

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-find]")) return renderList();
  if (!current || document.body.dataset.readonly === "true") return;

  if (e.target.matches("[data-body]")) {
    /* CLEANED BEFORE IT IS KEPT. The pad is the only box in the CRM
       whose text leaves the building — the client's page, the
       assistant's reading and the printer all get this string — so
       the marks that survive all three are the ones allowed in it.
       Substitutions are silent; anything genuinely dropped is named
       under the pad for a moment. See plan-punctuation.js.

       Her private note below is deliberately NOT cleaned: nobody
       else ever reads it, and telling her how to punctuate her own
       notes would be a rule with no purpose behind it. */
    sayPunctuation(punctuation.cleanField(e.target));
    current.body = e.target.value;
    /* A preview beside a pad she has since edited is showing her a
       comparison with text that no longer exists. It goes the moment
       she types. */
    hideRewrite();

    /* BUILD FOLLOWS THE TEXT, not the buttons that produced it.
       Its enabled state is derived from whether the body has any
       instruction lines in it, so typing a dashed line by hand has
       to switch it on exactly as accepting a generated plan does —
       and deleting the last one has to switch it off again.

       Generate moves too: it needs something to read, so an empty
       pad disables it. */
    paintButtons();
    return touch();
  }
  if (e.target.matches("[data-note]")) {
    current.privateNote = e.target.value;
    return touch();
  }
});

/* WHITESPACE IS TIDIED WHEN SHE LEAVES THE PAD, never as she types.

   Runs of spaces and stacks of blank lines cost the assistant
   clarity, but collapsing them per keystroke means the second space
   she presses vanishes under her finger — a dropped key with no
   explanation, which is the exact thing the strip exists to avoid.
   On blur the thought is finished and nothing is taken out from
   under her.

   `focusout` rather than `blur`: blur does not bubble, so a single
   listener on the document would never hear it. */
document.addEventListener("focusout", (e) => {
  if (!e.target.matches("[data-body]")) return;
  if (!current || document.body.dataset.readonly === "true") return;
  if (!punctuation.tidyField(e.target)) return;
  current.body = e.target.value;
  touch();
});

/* The client list as a panel on a narrow screen — the same
   behaviour as the assessment page, because it is the same
   control and she should not have to learn it twice. */
function wireClients() {
  const btn = $("[data-aside-btn]");
  const panel = $("[data-aside]");
  const veil = $("[data-aside-veil]");
  if (!btn || !panel || !veil) return;

  const shut = () => {
    panel.dataset.open = "false";
    veil.dataset.open = "false";
    btn.setAttribute("aria-expanded", "false");
    setTimeout(() => { if (panel.dataset.open !== "true") veil.hidden = true; }, 320);
  };

  btn.addEventListener("click", () => {
    const open = panel.dataset.open !== "true";
    if (open) {
      veil.hidden = false;
      requestAnimationFrame(() => {
        panel.dataset.open = "true";
        veil.dataset.open = "true";
      });
      btn.setAttribute("aria-expanded", "true");
    } else shut();
  });

  veil.addEventListener("click", shut);
  addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });
  panel.addEventListener("click", (e) => { if (e.target.closest("[data-person]")) shut(); });
}

document.addEventListener("click", async (e) => {
  const version = e.target.closest("[data-version]");
  if (version) {
    const want = chain.find((p) => p.id === version.dataset.version);
    if (want) return paint(want);
  }

  const person = e.target.closest("[data-person]");
  if (person) return openFor(person.dataset.person);

  if (e.target.closest("[data-print]")) return print();

  if (e.target.closest("[data-read]") && current) return buildPlan();

  if (e.target.closest("[data-new-plan]") && current) return newPlan();
  if (e.target.closest("[data-generate]") && current) return generatePlan();
  if (e.target.closest("[data-draft]") && current) return fetchAndCreate();
  if (e.target.closest("[data-clear]") && current) return clearRows();
  if (e.target.closest("[data-rewrite-keep]")) return hideRewrite();
  if (e.target.closest("[data-rewrite-use]")) return useRewrite();

  const verdict = e.target.closest("[data-verdict]");
  if (verdict) {
    const box = verdict.closest("[data-item]");
    if (box) return rule(box.dataset.item, verdict.dataset.verdict);
  }

  /* NO CONFIRMATION DIALOGUE. It removes an unjudged proposal — a
     machine's guess she has not agreed with — and pressing Read
     again brings it back if it was still in the text. Asking "are
     you sure" about something that costs nothing to undo is how a
     dialogue becomes noise she clicks through. */
  const drop = e.target.closest("[data-drop]");
  if (drop) {
    const box = drop.closest("[data-item]");
    if (box) return dropRow(box.dataset.item);
  }

  const startProg = e.target.closest("[data-start-programme]");
  if (startProg && current) {
    startProg.disabled = true;
    try {
      const days = Number($("[data-prog-days]")?.value) || 30;
      const out = await api.startProgramme(current.id, days);
      const box = $("[data-prog]");
      box.hidden = false;
      $("[data-prog-url]").textContent = out.url;
      $("[data-prog-url]").href = out.url;

      /* The length that was ACTUALLY set, not the one in the box.
         Starting is mint-or-return: if a programme was already
         running, the number she just picked was ignored, and telling
         her otherwise would be a lie she only discovers when the
         client's app ends on the wrong day. */
      const ran = out.programme?.lengthDays;
      const l = $("[data-prog-l]");
      if (l && ran) {
        l.textContent = ran === days
          ? `Their daily app — ${ran} days, copy this now, it is not shown again`
          : `Their daily app — already running, ${ran} days. Copy this now, it is not shown again`;
      }
    } catch (err) {
      markFailed(err.message || "Could not start that");
    } finally {
      startProg.disabled = false;
    }
    return;
  }

  const copyProg = e.target.closest("[data-copy-prog]");
  if (copyProg) {
    const url = $("[data-prog-url]").textContent.trim();
    if (!url.startsWith("http")) return;
    navigator.clipboard.writeText(url).then(
      () => { copyProg.textContent = "Copied"; setTimeout(() => (copyProg.textContent = "Copy"), 1800); },
      () => { copyProg.textContent = "Select it"; setTimeout(() => (copyProg.textContent = "Copy"), 1800); }
    );
    return;
  }

  const copy = e.target.closest("[data-copy-plan]");
  if (copy) {
    const url = $("[data-plan-url]").textContent.trim();
    if (!url.startsWith("http")) return;
    navigator.clipboard.writeText(url).then(
      () => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1800); },
      () => { copy.textContent = "Select it"; setTimeout(() => (copy.textContent = "Copy"), 1800); }
    );
    return;
  }

  const act = e.target.closest("[data-issue]");
  if (act && current) {
    act.disabled = true;
    try {
      if (current.status === "issued") {
        /* NOT A REOPEN. The issued version stays exactly as the
           client received it; this opens its successor. */
        const out = await api.amendPlan(current.id);
        const all = await api.plans(current.personId);
        chain = all.plans || [];
        return paint(chain.find((p) => p.id === out.plan.id) || out.plan);
      }
      await api.issuePlan(current.id);
      const all = await api.plans(current.personId);
      chain = all.plans || [];
      return paint(chain.find((p) => p.id === current.id) || current);
    } catch (err) {
      markFailed(err.message || "That did not work");
      act.disabled = false;
    }
  }
});

/* ---- boot ------------------------------------------------------ */
start("plan", api.people, (data) => {
  people = data.people || [];
  renderList();
  wireClients();

  // The strip's resting state and the guide behind it, both written
  // from the rule rather than typed into the HTML — one place to
  // change if the marks ever change.
  sayPunctuation([]);
  paintPunctGuide();
  restoreShape();

  /* The sheet's head sticks beneath the bar, so it needs the bar's
     real height rather than a number in the stylesheet that is
     wrong the moment the masthead wraps. */
  const bar = document.querySelector(".work-bar");
  if (bar) {
    const set = () =>
      document.documentElement.style.setProperty("--work-bar-h", `${bar.offsetHeight}px`);
    set();
    if ("ResizeObserver" in window) new ResizeObserver(set).observe(bar);
    else addEventListener("resize", set);
  }

  /* Deep links: from a person's row, or straight out of the room
     with the consultation attached. */
  const q = new URLSearchParams(location.search);
  const who = q.get("person");
  if (who && people.some((p) => p.id === who)) openFor(who, q.get("booking"));
});
