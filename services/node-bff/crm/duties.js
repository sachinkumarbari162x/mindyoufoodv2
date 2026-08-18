/* ============================================================
   THE JOB DESCRIPTION
   ------------------------------------------------------------
   Item 1. This is the document the CRM assistant is built around,
   written as data rather than prose so the bot can actually act
   on it — and kept in one file so it reads as a job description
   and can be argued with.

       DRAFTED BY THE BUILDER, FOR KHADIJA TO CORRECT.
       Nothing here is settled. Every line is a claim about how
       she works, and she is the authority on all of them.

   THE POST

     Title      Front desk assistant
     Reports to Khadija
     Hours      Whenever she has the CRM open
     Nature     NOT AN AI. No model is called anywhere in this
                bot. It reads the practice and tells her what
                needs her, which is arithmetic, not language.

   WHY NOT A MODEL: it would be wrong occasionally and she would
   have to check it every time, which is the work it exists to
   save. A duty below is either satisfied or it is not, and the
   answer is the same every time anybody asks.

   THE PRINCIPLE THAT SHAPES EVERYTHING BELOW

     TASKS ARE DERIVED, NEVER STORED.

   There is no to-do table. Every duty is a question asked of the
   live practice at the moment she looks. A stored list goes stale
   the instant reality moves — a request accepted on her phone
   leaves a task behind on her laptop, and after the third one she
   stops believing the list. A derived list cannot be wrong: the
   task exists exactly as long as the thing it describes does.

   The cost is that a task cannot be ticked off, only resolved.
   That is the right trade: "accept the request" is done when the
   request is accepted, and nowhere else.
   ============================================================ */
"use strict";

/* Urgency, and it means something specific.

     now      a client is waiting on her today, or money/time is
              about to be lost
     soon     wants doing this week
     watch    worth knowing, nothing breaks if ignored

   Deliberately three. Five levels means nobody can tell four from
   five, and everything drifts to the top. */
const NOW = "now";
const SOON = "soon";
const WATCH = "watch";

/* ============================================================
   THE DUTIES
   ------------------------------------------------------------
   Each one: what it is, how to tell whether it needs doing, and
   what she would actually click. `check` is handed the state
   gathered in officer.js and returns a task or null.
   ============================================================ */
const DUTIES = [
  /* ---- 1 · answer the people who are waiting ----------------
     The core of the job. Somebody asked for a consultation and is
     waiting to hear back; everything else in this practice is
     downstream of that happening promptly. */
  {
    id: "requests-waiting",
    title: "Requests waiting",
    check: (s) =>
      s.waiting.length
        ? {
            urgency: NOW,
            what: `${s.waiting.length} ${s.waiting.length === 1 ? "person is" : "people are"} waiting to hear back`,
            detail: s.waiting.slice(0, 3).map((w) => w.name).join(", "),
            go: "./requests.html",
            action: "Open Requests",
          }
        : null,
  },

  /* ---- 2 · holds that are about to lapse --------------------
     A held slot is a promise with a clock on it. When it expires
     the visitor is not told — they simply never hear back, which
     is the worst outcome this system can produce. */
  {
    id: "holds-expiring",
    title: "Holds expiring",
    check: (s) =>
      s.expiringSoon.length
        ? {
            urgency: NOW,
            what: `${s.expiringSoon.length} hold${s.expiringSoon.length === 1 ? "" : "s"} expiring within 12 hours`,
            detail: s.expiringSoon.map((w) => w.name).join(", "),
            go: "./requests.html",
            action: "Answer them",
          }
        : null,
  },

  /* ---- 3 · today's sessions ---------------------------------
     Not a warning, a briefing. She wants to know what today looks
     like before it starts. */
  {
    id: "today",
    title: "Today",
    check: (s) =>
      s.today.length
        ? {
            urgency: SOON,
            what: `${s.today.length} session${s.today.length === 1 ? "" : "s"} today`,
            detail: s.today.map((t) => `${t.name} ${t.at || ""}`.trim()).join(" · "),
            go: "./today.html",
            action: "Open Today",
          }
        : null,
  },

  /* ---- 3b · sessions nobody has said anything about ----------
     THE DUTY THAT MAKES THE OTHERS MEASURABLE.

     Recording what became of a session is one tap, and one tap she
     is never reminded to make is one that gets skipped on a busy
     day. Skip it often enough and the History page is half-filled —
     at which point "how many people did not turn up last quarter"
     has no answer, and neither does any other question she might
     want to run her practice on.

     So the gap chases her. Not urgent on the day itself — she is
     seeing clients — but a session from yesterday with nothing
     against it is a hole in her own record, and it only gets harder
     to fill from memory. */
  {
    id: "outcomes-unrecorded",
    title: "Sessions to close off",
    check: (s) => {
      const n = s.unrecorded.length;
      if (!n) return null;
      const names = s.unrecorded.slice(0, 3).map((u) => u.name).join(", ");
      return {
        // Yesterday's is a chore; a week of them is a broken record.
        urgency: n > 3 ? NOW : SOON,
        what: `${n} session${n === 1 ? "" : "s"} with nothing recorded`,
        detail: `${names}${n > 3 ? ` and ${n - 3} more` : ""} — say how they went while you remember`,
        go: "./today.html",
        action: "Open Today",
      };
    },
  },

  /* ---- 4 · questions the desk could not place ----------------
     The learning loop. Each one is a visitor who asked something
     and got a shrug. Teaching it an answer costs a minute and
     fixes it for everybody who asks afterwards. */
  {
    id: "unrecognised",
    title: "Questions to teach",
    check: (s) =>
      s.missed > 0
        ? {
            urgency: SOON,
            what: `${s.missed} question${s.missed === 1 ? "" : "s"} the desk could not answer`,
            detail: "Teaching it a phrasing fixes it for everyone who asks next",
            go: "./knowledge.html",
            action: "Open Knowledge",
          }
        : null,
  },

  /* ---- 5 · is there anything left to book? ------------------
     The failure nobody notices: the desk politely tells every
     visitor there is nothing free, and she never finds out because
     no requests arrive to tell her. */
  {
    id: "no-availability",
    title: "Nothing bookable",
    check: (s) =>
      s.freeSlots === 0
        ? {
            urgency: NOW,
            what: "No free times published",
            detail: "Visitors are being told there is nothing available",
            go: "./hours.html",
            action: "Open Hours",
          }
        : s.freeSlots < 3
        ? {
            urgency: SOON,
            what: `Only ${s.freeSlots} free time${s.freeSlots === 1 ? "" : "s"} left`,
            detail: "Worth opening more before they go",
            go: "./hours.html",
            action: "Open Hours",
          }
        : null,
  },

  /* ---- 6 · bands that do nothing ----------------------------
     Item 4's discovery: a narrow band inside a wider one is legal
     and has no effect, so she can believe she has changed her week
     when she has not. */
  {
    id: "hours-no-effect",
    title: "Hours that change nothing",
    check: (s) =>
      s.overlappingBands > 0
        ? {
            urgency: WATCH,
            what: `${s.overlappingBands} band${s.overlappingBands === 1 ? "" : "s"} sitting inside a wider one`,
            detail: "They are saved but change nothing a visitor is offered",
            go: "./hours.html",
            action: "Review Hours",
          }
        : null,
  },

  /* ---- 7 · the second factor --------------------------------
     Security work she will otherwise never get round to, phrased
     as what it costs rather than as a scolding. */
  {
    id: "totp-missing",
    title: "Second factor",
    check: (s) =>
      s.totpEnrolled === false
        ? {
            urgency: SOON,
            what: "No authenticator app attached",
            detail: "Your password is currently the only thing in the way",
            go: "./settings.html",
            action: "Set it up",
          }
        : null,
  },

  /* ---- 8 · the model is unavailable -------------------------
     Not a task so much as an explanation, so that when the desk
     sounds terser than usual she knows why rather than wondering
     whether something is broken. */
  {
    id: "breaker-open",
    title: "Longer answers unavailable",
    check: (s) =>
      s.breakerOpen
        ? {
            urgency: WATCH,
            what: "The model is not answering",
            detail: "Bookings and the usual questions are unaffected",
            go: "./bots.html",
            action: "See Bots",
          }
        : null,
  },
];

/* What it says when every duty is satisfied. Not "no tasks" — the
   point of looking is reassurance, and reassurance needs a sentence. */
const ALL_CLEAR = {
  what: "Nothing is waiting on you",
  detail: "Requests answered, times published, nothing expiring.",
};

const ORDER = { [NOW]: 0, [SOON]: 1, [WATCH]: 2 };

module.exports = { DUTIES, ALL_CLEAR, ORDER, NOW, SOON, WATCH };
