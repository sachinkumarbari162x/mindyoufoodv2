/* ============================================================
   NLU — working out what somebody meant, deterministically

   Same answer every time, in about a tenth of a millisecond, with
   no network call and nothing to go down. This is the layer that
   lets the desk run without a model at all.

   IT CLASSIFIES. IT NEVER COMPOSES.
   The wording of every reply lives in flow.js and rules/status.js.
   This file only says which of a closed set of things was meant,
   and how sure it is. Keeping those apart is what makes both
   testable: intent recognition against a list of phrasings, and
   copy against nothing at all.

   WHY SCORING RATHER THAN FIRST-MATCH.
   The FAQ it replaces was seven regexes checked in order, so
   "how much is a video call" hit the mode rule before the fee
   rule and answered the wrong question — a visitor asking about
   money was told about cameras. Every intent now scores, the
   highest wins, and a close-run pair is treated as unclear
   instead of quietly picking the earlier one.

   BELOW THE FLOOR, ASK.
   `unknown` is a real outcome, not a failure. A desk that guesses
   at a half-understood sentence is worse than one that says "do
   you mean X or Y" — the guess is confidently wrong and the
   question costs one turn.
   ============================================================ */
"use strict";

/* ---- 1 · normalise -------------------------------------------
   Before matching, get the sentence into one shape. Everything
   here is reversible in meaning: nothing is dropped that changes
   what was said. */

const CONTRACTIONS = [
  [/\bwhat'?s\b/g, "what is"],
  [/\bwhen'?s\b/g, "when is"],
  [/\bwhere'?s\b/g, "where is"],
  [/\bhow'?s\b/g, "how is"],
  [/\bi'?m\b/g, "i am"],
  [/\bi'?d\b/g, "i would"],
  [/\bi'?ve\b/g, "i have"],
  [/\bi'?ll\b/g, "i will"],
  [/\bcan'?t\b/g, "cannot"],
  [/\bwon'?t\b/g, "will not"],
  [/\bdon'?t\b/g, "do not"],
  [/\bdoesn'?t\b/g, "does not"],
  [/\bdidn'?t\b/g, "did not"],
  [/\bisn'?t\b/g, "is not"],
  [/\bwouldn'?t\b/g, "would not"],
  [/\byou'?re\b/g, "you are"],
  [/\bthey'?re\b/g, "they are"],
  [/\bthat'?s\b/g, "that is"],
  [/\blet'?s\b/g, "let us"],
];

/* Misspellings worth knowing by name. A general fuzzy matcher would
   catch more and also match things nobody wrote — "cancel" and
   "council" are one edit apart. These are the words this desk
   actually receives, spelled the ways people actually get them
   wrong. */
const TYPOS = [
  [/\bappoint?ment?s?\b|\bappointmnts?\b|\bapointments?\b|\bappoinments?\b/g, "appointment"],
  [/\bconsulta?tions?\b|\bconsultaions?\b|\bconsulation\b/g, "consultation"],
  [/\bschedual\w*\b|\bschedu?le\b/g, "schedule"],
  [/\bavailabl?e?\b|\bavailible\b|\bavailabile\b/g, "available"],
  [/\bcancle\b|\bcancell?\b|\bcancle?ation\b|\bcancellation\b/g, "cancel"],
  [/\brescheduel\b|\breschedual\b/g, "reschedule"],
  [/\bdietici?an\b|\bdietitian\b|\bdeititian\b/g, "dietitian"],
  [/\bnutritionest\b|\bnutrionist\b/g, "nutritionist"],
  [/\bdiabete?s?\b|\bdiabetis\b|\bdaibetes\b/g, "diabetes"],
  [/\bweigh?t\b|\bwieght\b/g, "weight"],
  [/\bprgnant\b|\bpregnent\b/g, "pregnant"],
];

/** Get a message into the one shape every pattern below expects. */
function normalise(raw) {
  let t = String(raw || "").toLowerCase().trim();
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  for (const [re, to] of TYPOS) t = t.replace(re, to);
  // Punctuation goes, but the words keep their boundaries — "hours?"
  // and "hours" must score identically.
  t = t.replace(/[^\p{L}\p{N}\s:./-]+/gu, " ").replace(/\s+/g, " ").trim();
  return t;
}

/* ---- 2 · the intents -----------------------------------------
   `strong` is a phrase that on its own settles it. `hint` is a word
   that leans without deciding. A sentence carrying two hints for
   one intent and one for another goes the right way; a sentence
   carrying one of each does not go anywhere, which is correct.

   Deliberately a closed set. A front desk has a small domain, and
   pretending otherwise is how a rules engine turns into a machine
   that answers questions it has no business answering. */
const INTENTS = [
  {
    id: "book",
    strong: [/\b(book|schedule|make|set up|arrange|get)\b.{0,20}\b(appointment|consultation|session|slot|time)\b/,
             /\bi (want|would like|need)\b.{0,15}\b(appointment|consultation|session|book)\b/,
             /\bcan i (book|come in|see her|get seen)\b/],
    hint: [/\bbook\b/, /\bappointment\b/, /\bconsultation\b/, /\bsession\b/, /\bsign up\b/, /\bstart\b/],
  },
  {
    id: "reschedule",
    strong: [/\breschedule\b/, /\b(move|change|shift|push)\b.{0,20}\b(appointment|booking|session|time|slot)\b/,
             /\bdifferent (time|day|slot)\b/, /\bcan we (move|change)\b/],
    hint: [/\bmove\b/, /\bchange\b/, /\banother time\b/],
  },
  {
    id: "cancel",
    strong: [/\bcancel\b/, /\bcall (it )?off\b/, /\bcannot make it\b/, /\bnot (able to )?come\b/,
             /\bwithdraw\b/],
    hint: [/\bcancel\b/, /\bno longer\b/],
  },
  {
    id: "hours",
    strong: [/\b(what|when) (are|is)\b.{0,20}\b(hours|open|opening|timings?)\b/,
             /\bopening hours\b/, /\bare you open\b/, /\bwhat time.{0,15}\b(open|close|start|finish)\b/],
    hint: [/\bhours\b/, /\bopen\b/, /\btiming\b/, /\bclosed\b/, /\bweekend\b/],
  },
  {
    id: "fees",
    strong: [/\bhow much\b/, /\bwhat (do|does) (it|this|a session) cost\b/, /\byour (fees?|rates?|charges?)\b/,
             /\bprice list\b/,
             // Unmistakably about money and contested by nothing else
             // in this set, so they settle it on their own. As hints
             // they scored 1 against a floor of 2, and "is it
             // expensive" — a question with exactly one possible
             // meaning — came back unknown.
             /\bexpensive\b/, /\bafford\b/, /\bcheap\b/],
    hint: [/\bfees?\b/, /\bcosts?\b/, /\bprices?\b/, /\bcharges?\b/, /\brates?\b/, /\bpayment\b/],
  },
  {
    id: "services",
    strong: [/\b(what|which)\b.{0,25}\b(help|work|treat|specialis|specializ|deal|focus|areas?)\b/,
             /\bdo you (treat|handle|deal with|help with)\b/, /\bcan (you|she) help\b/],
    hint: [/\bpcos\b/, /\bdiabetes\b/, /\bgut\b/, /\bthyroid\b/, /\bweight\b/, /\bcholesterol\b/,
           /\bpregnant\b/, /\bsports\b/, /\bservices?\b/],
  },
  {
    id: "process",
    strong: [/\bhow (does|do) (it|this|things|the sessions?) work\b/, /\bwhat happens\b/,
             /\bwhat is the process\b/, /\bwhat should i expect\b/],
    hint: [/\bprocess\b/, /\bexpect\b/, /\bfirst session\b/],
  },
  {
    id: "location",
    strong: [/\bwhere (are|is)\b/, /\byour (address|clinic|location)\b/, /\bhow do i get there\b/],
    hint: [/\baddress\b/, /\bclinic\b/, /\blocation\b/, /\bdirections\b/, /\bparking\b/],
  },
  {
    id: "mode",
    strong: [/\b(is it|are they|do you do)\b.{0,15}\b(online|video|remote|virtual|phone)\b/,
             /\bin person or\b/, /\bover the phone\b/, /\bvideo call\b/],
    hint: [/\bonline\b/, /\bvideo\b/, /\bremote\b/, /\bvirtual\b/, /\bin person\b/, /\bphone\b/, /\bzoom\b/],
  },
  {
    id: "duration",
    strong: [/\bhow long\b/, /\blength of (the|a) (session|consultation|appointment)\b/],
    hint: [/\bduration\b/, /\bhow long\b/, /\bminutes\b/],
  },
  {
    id: "about",
    strong: [/\b(who|what) (is|are) (khadija|she|you)\b/, /\babout (khadija|her)\b/,
             /\b(is she|are you) (qualified|certified|registered)\b/],
    hint: [/\bqualif/, /\bcertif/, /\bcredential/, /\bexperience\b/, /\bdietitian\b/, /\bnutritionist\b/],
  },
  {
    id: "human",
    strong: [/\b(speak|talk|chat) (to|with) (a )?(human|person|someone|khadija|her)\b/,
             /\bare you (a )?(bot|robot|ai|human|real)\b/, /\breal person\b/],
    hint: [/\bhuman\b/, /\bbot\b/, /\bemail her\b/, /\bphone number\b/],
  },
  {
    id: "greeting",
    strong: [/^(hi|hello|hey|good (morning|afternoon|evening)|salam|assalam\w*|namaste)\b/],
    hint: [],
  },
  {
    id: "farewell",
    strong: [/^(thanks?|thank you|cheers|bye|goodbye|see you|that is all|nothing else)\b/],
    hint: [/\bthanks?\b/, /\bthank you\b/],
  },
  {
    id: "affirm",
    strong: [/^(yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|correct|right|that is right|sounds good)\b/],
    hint: [],
  },
  {
    id: "deny",
    strong: [/^(no|nope|nah|not really|do not|rather not|skip|later)\b/],
    hint: [],
  },
  {
    id: "correction",
    strong: [/\b(actually|sorry|i meant|my mistake|instead|correction|change that|scratch that)\b/],
    hint: [/\bwrong\b/, /\bnot that\b/],
  },
];

const STRONG_SCORE = 3;
const HINT_SCORE = 1;

/* Below this, the desk asks rather than assumes. One strong signal,
   or two hints, is enough to act on; a single hint is not — "weight"
   on its own could be a focus area, a question about services, or
   part of a sentence about something else entirely. */
const FLOOR = 2;

/* And if the top two are this close, it is genuinely ambiguous even
   though something scored well. "How much is a video consultation"
   carries fees and mode; answering either alone is a coin toss. */
const MARGIN = 1;

/**
 * Classify a message.
 *
 * @returns {{intent:string, confidence:number, score:number,
 *            runnerUp:string|null, scores:object, text:string}}
 *   `intent` is "unknown" when nothing cleared the floor, and
 *   "ambiguous" when two intents were too close to separate.
 */
function classify(raw, learned) {
  const text = normalise(raw);
  if (!text) {
    return { intent: "unknown", confidence: 0, score: 0, runnerUp: null, scores: {}, text };
  }

  const scores = {};
  for (const intent of INTENTS) {
    let score = 0;
    for (const re of intent.strong) if (re.test(text)) score += STRONG_SCORE;
    for (const re of intent.hint) if (re.test(text)) score += HINT_SCORE;
    if (score) scores[intent.id] = score;
  }

  /* Phrasings she has taught it, from crm.phrasings. ADDITIVE ONLY —
     they can make the desk recognise something it otherwise would
     not, and can never stop it recognising what it already does. That
     asymmetry matters because this list is edited from a web form: a
     bad row should be able to do nothing worse than nothing.

     Substring rather than regex, and for the same reason — one stray
     bracket typed into a form would otherwise throw on every message
     the desk received. */
  if (learned && learned.length) {
    for (const { intent, phrase } of learned) {
      if (!phrase || phrase.length < 3) continue;
      if (text.includes(phrase)) {
        // Scored as strong: she wrote it down deliberately, having
        // seen a real visitor be misunderstood.
        scores[intent] = (scores[intent] || 0) + STRONG_SCORE;
      }
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < FLOOR) {
    return {
      intent: "unknown",
      confidence: 0,
      score: ranked.length ? ranked[0][1] : 0,
      runnerUp: null,
      scores,
      text,
    };
  }

  const [topId, topScore] = ranked[0];
  const [runnerId, runnerScore] = ranked[1] || [null, 0];

  // Confidence as a share of the evidence, so a clear winner over a
  // weak field reads as confident and a photo-finish does not.
  const confidence = topScore / (topScore + runnerScore);

  if (runnerId && topScore - runnerScore < MARGIN) {
    return { intent: "ambiguous", confidence, score: topScore, runnerUp: runnerId, scores, text, top: topId };
  }

  return { intent: topId, confidence, score: topScore, runnerUp: runnerId, scores, text };
}

/** Every intent this desk knows, for tests and for the CRM to list. */
const INTENT_IDS = INTENTS.map((i) => i.id);

module.exports = { classify, normalise, INTENT_IDS, FLOOR, MARGIN };
