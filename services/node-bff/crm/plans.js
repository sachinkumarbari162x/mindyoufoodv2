/* ============================================================
   PLANS — the CRM's half of the care plan
   ------------------------------------------------------------
   Thin, like assessments.js. Go owns the versioning, the
   amend-forward rule and the refusal to edit an issued plan; this
   moves strings and attaches the name of whoever is signed in.

   ONE THING IT DOES DECIDE, and it is the reason this file exists
   rather than the routes calling data-client directly: WHO WROTE
   IT comes from the session, never from the request body. The
   browser does not get to assert authorship of a clinical
   document, and a route that took `by` from JSON would let it.
   ============================================================ */
"use strict";

const data = require("../data-client");
const { publicBase } = require("../config");
const planAi = require("../plan-ai");
const parser = require("../plan-ai/parse");
/* The other job in that folder: writing a first draft out of the
   finalised assessment, rather than reading her prose back. */
const fromAssessment = require("../plan-ai/from-assessment");
/* For its `flatten`: the record the model reads has to be the same
   shape as the record she edits, measurements folded in and all. */
const assessments = require("./assessments");

/* Kept in step with planReadCap in services/go-data/plan_items.go.
   Two constants for one rule is a smell, and the alternative — the
   BFF asking Go what the limit is before deciding whether to call
   the model — is a round trip to save a duplicated integer. Go holds
   the authoritative one; this is the copy that avoids paying for a
   call that is about to be refused. */
const READ_CAP = 3;

/* A SEPARATE THREE, not a share of the reads. Migration 0029 sets
   out why: one press of the expensive button must not disable the
   cheap one she needs afterwards. */
const DRAFT_CAP = 3;

const ok = (body) => ({ status: 200, body });

const unavailable = {
  status: 503,
  body: { error: "data_unavailable", message: "The data service is not answering." },
};

const pass = (out) =>
  out
    ? out.ok
      ? null
      : { status: out.status || 400, body: { error: out.error, message: out.message } }
    : unavailable;

async function list(personId) {
  const out = await data.crm.plans({ personId });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ plans: out.plans || [] });
}

async function one(id) {
  const out = await data.crm.plan(id);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ plan: out.plan });
}

/** Open her current draft for this person, or start the next plan.
    Idempotent in Go, so a double click is harmless. */
async function open(body, who) {
  const out = await data.crm.planOpen({
    personId: body?.personId,
    consultationId: body?.consultationId || null,
    /* The figures as they stood when she opened it — energy target,
       protein, the activity factor. Copied in rather than looked up
       later, so a plan issued in March still reads March when the
       April weight lands. */
    targets: body?.targets && typeof body.targets === "object" ? body.targets : {},
    by: who || "unknown",
  });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ plan: out.plan, opened: out.opened });
}

/** Save a draft. Go refuses this outright once the plan is issued —
    the WHERE clause carries the rule, not an if in this file. */
async function save(id, body) {
  const out = await data.crm.planSave(id, {
    body: typeof body?.body === "string" ? body.body : undefined,
    privateNote: typeof body?.privateNote === "string" ? body.privateNote : undefined,
    targets: body?.targets && typeof body.targets === "object" ? body.targets : undefined,
  });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

/** Hand it over. Freezes the row; from here the only change is an
    amendment, which writes the next version. */
async function issue(id) {
  const out = await data.crm.planIssue(id);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

/** The only way to change an issued plan: write its successor, and
    leave the copy the client is holding exactly as it was. */
async function amend(id, who) {
  const out = await data.crm.planAmend(id, { by: who || "unknown" });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ plan: out.plan });
}

/** The client's way in. Only an issued plan has one — Go refuses a
    draft, so a half-written plan can never be handed over.

    The URL is built here rather than in the browser: the public
    origin is a deployment fact, and a CRM open on a laptop would
    guess localhost and then mail it to somebody. */
async function link(id) {
  const out = await data.crm.planLinkMint(id);
  const bad = pass(out);
  if (bad) return bad;

  return ok({ url: `${publicBase()}/p/${out.token}`, expiresAt: out.expiresAt || null });
}

/* ---- what a model thinks the plan says -------------------------
   THE ORDER MATTERS. Read the plan from the database rather than
   from the request body: the browser could send anything, and the
   thing being structured must be the thing that was actually saved,
   or the rows and the text describe different documents. */
async function structure(planId) {
  const got = await data.crm.plan(planId);
  const bad1 = pass(got);
  if (bad1) return bad1;

  const plan = got.plan;
  if (plan.status !== "draft") {
    return {
      status: 409,
      body: { error: "not_draft", message: "That plan has been issued — amend it before re-reading it." },
    };
  }

  /* A cheap refusal before the expensive call. Go holds the real
     limit and claims it atomically below — this only avoids paying
     for a call that is about to be refused. */
  if ((plan.reads || 0) >= READ_CAP) return atLimit();

  const read = await planAi.propose(plan.body);
  if (!read.ok) {
    /* 503, not 500. The assistant being off or slow is a condition
       she can act on — write the plan and issue it anyway — and not
       a fault in the practice's own system. */
    return { status: 503, body: { error: "assistant_unavailable", message: read.why } };
  }

  /* CLAIMED AFTER IT ANSWERED, not before. A call that timed out or
     came back unreadable should not cost her one of three — she
     pressed a button and got nothing, and charging for that teaches
     her the button is unreliable in the worst way.

     Atomic in Go: the WHERE clause carries the limit, so two presses
     arriving together cannot both pass. */
  const claim = await data.crm.planReadClaim(planId);
  if (!claim?.ok) return atLimit();

  /* GENERATE WRITES NO ROWS. It hands back what the model read so
     the page can lay it out as text for her to review; rows are
     Build's job, from the text she accepts. Doing both here would
     mean rows existing for wording she never agreed to. */
  return ok({ items: read.items || [], model: read.model, left: claim.left ?? 0 });
}

/* ============================================================
   FETCH AND CREATE — the first draft, out of the finalised record
   ------------------------------------------------------------
   The one route in this system where the model WRITES clinical
   advice rather than reading hers back. See from-assessment.js
   for the whole argument; the guards that live HERE are:

     1. The plan must be a draft. An issued plan is a document
        somebody is following.
     2. There must be a FINALISED assessment. A draft assessment
        is a half-finished thought, and a plan written from one
        would be confidently wrong.
     3. The budget is claimed BEFORE the call, atomically in Go —
        this one is slow and expensive enough that a double tap
        must not send a client's history twice.
     4. Nothing is written. It returns a proposal for the preview.

   THE ASSESSMENT IS READ HERE, NOT SENT BY THE BROWSER. The page
   could claim any assessment id it liked; what gets read is the
   latest finalised one belonging to the person this plan is for.
   ============================================================ */
async function draftFromAssessment(planId, body) {
  const got = await data.crm.plan(planId);
  const bad1 = pass(got);
  if (bad1) return bad1;

  const plan = got.plan;
  if (plan.status !== "draft") {
    return {
      status: 409,
      body: { error: "not_draft", message: "That plan has been issued — amend it before rewriting it." },
    };
  }
  if ((plan.drafts || 0) >= DRAFT_CAP) return atDraftLimit();

  /* THE PERSON'S OWN RECORD, latest finalised version. Go returns
     every version newest-first; anything still in draft is skipped
     rather than used, which is the whole precondition of this
     feature. */
  /* THROUGH THE ASSESSMENTS MODULE, not straight to Go.

     It folds the measurements — weight, height, waist — back out of
     crm.measurements and into the flat shape the form edits. Going
     direct returned `answers` with none of them in it, and a plan
     written without a weight is a plan written for nobody in
     particular. Reusing the module also means the record the model
     reads is byte-for-byte the record she sees on screen. */
  const list = await assessments.list(plan.personId);
  if (list.status !== 200) return list;

  const finalised = (list.body.assessments || []).filter((a) => a.status === "final");
  if (!finalised.length) {
    return {
      status: 409,
      body: {
        error: "no_final_assessment",
        message: "There is no finalised assessment for this client yet. " +
                 "Finish the assessment and mark it final, then come back.",
      },
    };
  }

  /* Newest by visit, then by amendment — an amended assessment
     supersedes the one it amends, and the list is already in that
     order, but sorting here means this does not silently break if
     the order ever changes upstream. */
  finalised.sort((a, b) => (b.visit - a.visit) || (b.amendment - a.amendment));
  const assessment = finalised[0];

  /* HOW MANY MEALS IS HERS. Read off the body rather than left to
     the model, which was producing whatever the assessment
     happened to describe — sometimes one. */
  const shape = {
    meals: Number(body && body.meals),
    fillers: !body || body.fillers !== false,
  };

  /* CLAIMED BEFORE THE CALL. The comment in Go sets out why this
     one differs from a read: several seconds of work with a
     client's medical history in flight, and a second tap while it
     runs would send it again. */
  const claim = await data.crm.planDraftClaim(planId);
  if (!claim?.ok) return atDraftLimit();

  const written = await fromAssessment.draft(assessment, shape);
  if (!written.ok) {
    return { status: 503, body: { error: "assistant_unavailable", message: written.why } };
  }

  return ok({
    items: written.items || [],
    model: written.model,
    left: claim.left ?? 0,
    /* WHAT IT CAME FROM, ON THE SCREEN. She is about to read a plan
       she did not write; which record it was written from is the
       first thing she will want to know. */
    from: { ref: assessment.ref, visit: assessment.visit, finalisedAt: assessment.finalisedAt || null },
    /* AND WHAT THE CHECK FOUND. Never swallowed: a collision with a
       recorded allergy is the single most important thing this
       response can carry. */
    warnings: written.warnings || [],
  });
}

const atDraftLimit = () => ({
  status: 429,
  body: {
    error: "draft_limit",
    message: "The assistant has written three drafts from this assessment. " +
             "Edit what it gave you, or fill in more of the assessment and amend.",
  },
});

const atLimit = () => ({
  status: 429,
  body: {
    error: "read_limit",
    message:
      "The assistant has read this plan three times. If it is still wrong, the wording is " +
      "the thing to change — edit it and press Build, or issue it and amend for a fresh three.",
  },
});

/* ---- Build: the syntax reviewer, and not a model -----------------
   Reads the plan text as it stands and turns it into rows. No
   network beyond the database, nothing generative, and no charge
   against the three reads — the structure is already in the text
   and this is reading it rather than guessing at it.

   IT REPORTS WHAT IT COULD NOT READ. A line that looks like an
   instruction and is not one comes back with the reason, because
   silently dropping one is how a client loses an instruction while
   she is looking at a table that seems complete. */
async function build(planId) {
  const got = await data.crm.plan(planId);
  const bad1 = pass(got);
  if (bad1) return bad1;

  const plan = got.plan;
  if (plan.status !== "draft") {
    return {
      status: 409,
      body: { error: "not_draft", message: "That plan has been issued — amend it before rebuilding its rows." },
    };
  }

  const read = parser.parse(plan.body);
  if (!read.items.length) {
    return {
      status: 400,
      body: {
        error: "nothing_to_build",
        message:
          "No instructions found. Press Generate first — Build reads lines that start with a dash, " +
          "and it will not guess at prose.",
        problems: read.problems,
      },
    };
  }

  const out = await data.crm.planItemsRead({
    planId,
    /* Named for what produced these rows. It is not a model and must
       not be counted as one on the accuracy panel — "syntax" sitting
       beside a model name is the honest version of that. */
    model: "syntax",
    items: read.items,
  });
  const bad2 = pass(out);
  if (bad2) return bad2;

  return ok({
    items: out.items || [],
    changed: out.changed || {},
    problems: read.problems,
  });
}

/** Throw away a proposal. Refused by Go for anything she has ruled
    on, so this stays a pass-through with no rule of its own. */
async function drop(id) {
  const out = await data.crm.planItemDrop(id);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

async function items(planId) {
  const out = await data.crm.planItems(planId);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ items: out.items || [] });
}

/** Her verdict on one row. `by` comes from the session, never the
    body — who agreed to a clinical row is not the browser's to
    assert, and the database refuses a confirmed row without it. */
async function verdict(id, body, who) {
  const out = await data.crm.planItemVerdict(id, {
    status: body?.status,
    kind: typeof body?.kind === "string" ? body.kind : undefined,
    label: typeof body?.label === "string" ? body.label : undefined,
    quantity: typeof body?.quantity === "number" ? body.quantity : undefined,
    unit: typeof body?.unit === "string" ? body.unit : undefined,
    schedule: typeof body?.schedule === "string" ? body.schedule : undefined,
    by: who || "unknown",
  });
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true });
}

/** How often the assistant is right. The reason phase three exists. */
async function accuracy() {
  const out = await data.crm.planItemAccuracy();
  const bad = pass(out);
  if (bad) return bad;
  return ok({ accuracy: out.accuracy || [] });
}

/** Clear the reading and start again. Go refuses anything she has
    ruled on, so this stays a pass-through with no rule of its own. */
async function clear(planId) {
  const out = await data.crm.planItemsClear(planId);
  const bad = pass(out);
  if (bad) return bad;
  return ok({ ok: true, cleared: out.cleared || 0, kept: out.kept || 0 });
}

module.exports = {
  list, one, open, save, issue, amend, link,
  structure, draftFromAssessment, build,
  items, verdict, drop, clear, accuracy,
};
