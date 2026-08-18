/* ============================================================
   BUSINESS RULES · WHAT THE DESK SAYS ABOUT ITSELF

   A real front desk tells you the state of the place without being
   asked — that it is about to close, that it is shut for a holiday,
   that the computer is being slow today. This module is the single
   place those lines are written.

   Two rules govern everything here:

     1. DETERMINISTIC. One situation, one sentence, every time. No
        variation, no phrasing picked at random, and never the model:
        this is the copy shown precisely when the model may be the
        thing that is broken.

     2. NEVER NAME THE MACHINERY. A receptionist covering a slow
        computer says "bear with me a moment" — not "the AI service
        is unavailable". The second one tells a stranger about our
        architecture and reads like a stack trace. The visitor should
        not be able to tell from the wording whether the model is up.

   `notice()` returns at most one line, because two status messages
   stacked on a chat window is noise rather than information. The
   header already carries the open/closed label, so a notice is only
   produced when there is something the label does not already say.
   ============================================================ */
"use strict";

const { config } = require("../config");
const hours = require("./hours");

const P = config.practice;

/* ---- the lines ------------------------------------------------
   Written out in full rather than assembled from fragments. Copy
   that is glued together at runtime is copy nobody can read in one
   place, and this is exactly the text that has to be right. */
const LINES = {
  /* Transient — something is wrong behind the desk. Ordinary human
     friction, no mention of what is actually slow. */
  degraded: () =>
    "Bear with me — things are running slowly at my end just now. " +
    "I can still take all your details down.",

  /* A named closure. The most specific true thing we can say, and
     the reason config accepts `YYYY-MM-DD:Reason` at all. */
  holiday: (p) =>
    `We're closed today for ${p.holiday}. ` +
    `I can still take everything down and she'll reply ${p.nextPhrase || "when we're back"}.`,

  /* An unnamed closed date — she has booked the day out, we just do
     not know what for. */
  closed_today: (p) =>
    "We're closed today. " +
    `I can still take everything down and she'll reply ${p.nextPhrase || "when we're back"}.`,

  /* Ordinary out-of-hours: an evening, or a Sunday. */
  closed: (p) =>
    `We're closed just now, but I can take everything down and she'll reply ${
      p.nextPhrase || "personally"
    }.`,

  /* Open, but not for much longer. Said once the window is inside
     the closing-soon threshold, so it stays true rather than being
     said all afternoon. */
  closing_soon: (p) => `We close at ${p.closesAt} IST, but there's time for this.`,
};

/**
 * The one line the desk shows about its own state, or null when there
 * is nothing to add.
 *
 * Priority is deliberate: trouble behind the desk outranks the opening
 * hours, because it changes what happens in the next ten seconds,
 * whereas the header already says whether we are open.
 *
 * @param {{degraded?: boolean, at?: Date}} ctx
 * @returns {{kind: string, text: string} | null}
 */
function notice(ctx) {
  const presence = hours.presence(ctx?.at);

  if (ctx?.degraded) {
    return { kind: "degraded", text: LINES.degraded(presence) };
  }

  const line = LINES[presence.kind];
  // `open` has no entry, and that is the point — an open desk during
  // ordinary hours has nothing to explain.
  return line ? { kind: presence.kind, text: line(presence) } : null;
}

module.exports = { notice, LINES };
