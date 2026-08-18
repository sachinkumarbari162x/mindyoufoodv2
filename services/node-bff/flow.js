/* ============================================================
   FLOW — the receptionist's state machine

     greeting → collecting → review → confirmed
                    ↑          │
                    └──edit────┘
     any state → halted   (safety stop; no booking is possible)
     any state → closed   (discarded, or the visitor walked away)

   The ordering rule that everything else follows from:

       RULES DECIDE, THE MODEL SPEAKS.

   Every turn, the model may propose field values and propose
   wording. Neither is trusted. Proposed values go through the
   validators in rules/ and are only merged if they pass; proposed
   wording is screened and is replaced outright if a deterministic
   fact needs stating (a rejected slot, a bad email, a completed
   draft). The model can make the desk pleasant. It cannot make it
   book something it should not.

   The whole flow also runs with the AI service switched off — the
   scripted branch asks the same questions in the same order.
   ============================================================ */
"use strict";

const { config } = require("./config");
const session = require("./session");
const ai = require("./ai-client");
const booking = require("./booking");
const checkout = require("./payments/checkout");
const safety = require("./rules/safety");
const v = require("./rules/validate");
const hours = require("./rules/hours");
const nlu = require("./rules/nlu");
const bookingForm = require("./form");
const orchestrator = require("./orchestrator");
const scope = require("./corpus/scope");
const countries = require("./rules/countries");
const knowledge = require("./rules/knowledge");
const status = require("./rules/status");
const slots = require("./rules/slots");
const limits = require("./rules/limits");
const data = require("./data-client");
const mail = require("./mail");

const P = config.practice;

/* ---- the questions, in order --------------------------------
   Each gap knows how to ask for itself and what to offer as quick
   replies. The scripted path and the AI path share this table, so
   the two never ask for different things. */
const ASK = {
  name: {
    prompt: () => "Lovely — what should I call you?",
    chips: () => [],
  },
  focusArea: {
    prompt: (s) => `Thanks, ${s.draft.name.split(" ")[0]}. What would you like to work on?`,
    chips: () => v.FOCUS_AREAS.slice(0, 4).map((f) => f.label),
  },
  email: {
    prompt: () => "Which email address should she reply to?",
    chips: () => [],
  },
  dob: {
    prompt: () =>
      "And your date of birth? She uses it to set your nutritional requirements — " +
      "they differ quite a bit by age.",
    chips: () => [],
  },
  country: {
    prompt: () => "Which country are you in? It tells her your timezone and what food is around you.",
    /* From crm.countries, in her priority order, rather than three
       names written here. A fourth copy of the country list was
       exactly how the first one drifted — and if she adds a country
       tomorrow, this offers it without an edit.

       Falls back to the old trio only when go-data has not answered
       yet, so a cold cache costs nobody their suggestions. */
    chips: () => {
      const pinned = countries.list().filter((c) => c.pinned).map((c) => c.name);
      return pinned.length ? pinned.slice(0, 4) : ["India", "United Arab Emirates", "United Kingdom"];
    },
  },
  slots: {
    /* Two different questions, depending on whether we know what she
       is actually free for. With real availability the desk can offer
       times rather than invite guesses — and a visitor who picks one
       is choosing a slot that exists, not proposing one that might. */
    prompt: (s) =>
      s.offered?.length
        ? `Here's when she's free. Pick whichever suits you, or say another time and I'll check.`
        : `And when suits you? Give me one to ${P.maxSlots} options and she'll pick from them.\n\n` +
          `Consultation hours are ${P.hoursText}.`,
    chips: (s) =>
      s.offered?.length
        ? s.offered.slice(0, 3).map((o) => o.label)
        : slots.suggest(3).map((x) => x.label),
  },
};

const OPTIONAL_ORDER = ["mode", "phone"];

const OPTIONAL = {
  mode: {
    // Three ways, not two. She rings some visitors rather than video
    // calling them, and a question that only offers video and in-person
    // makes the phone look like it is not on the table — so nobody asks
    // for it, and the mode that needs no link and no camera goes unused.
    prompt: () => "How would you like to meet — video call, phone, or in person?",
    chips: () => ["Video call", "Phone call", "In person", "Either is fine"],
  },
  phone: {
    prompt: () =>
      "Last thing, and it's optional: a phone number, in case she needs to reach you quickly?",
    chips: () => ["Skip that"],
  },
};

const say = (text, tone) => ({ from: "bot", text, tone });
const note = (text, tone) => ({ from: "system", text, tone: tone || "warn" });

/* ---- turn envelope ------------------------------------------- */
/* ---- real availability ---------------------------------------
   Fetched once per session, the first time the desk needs to talk
   about times. Cached on the session because it is asked for on
   every turn while the visitor decides, and re-fetching would put a
   database round trip inside a keystroke.

   Best effort, deliberately. If the data service is unreachable the
   desk falls back to the scripted suggestions and takes proposals
   the old way — the practitioner then picks by hand, exactly as she
   did before any of this existed. Losing the offer must never lose
   the booking. */
async function loadOffer(s) {
  if (s.offered || s.offerFailed) return;
  const out = await data.crm.slots({ days: 14, limit: 40 });
  if (out?.ok && Array.isArray(out.slots) && out.slots.length) {
    s.offered = out.slots;
  } else {
    // Marked so a dead service is not re-tried on every keystroke.
    s.offerFailed = true;
  }
}

/* Match what the visitor said against what was actually offered.
   Returns the concrete slot — with the exact instants the booking
   needs — or null if they named a time that is not free.

   Compared in minutes, so "4pm", "16:00" and "4.00pm" all resolve to
   the same offered slot rather than three near-misses. */
function resolveOffer(s, proposed) {
  if (!s.offered?.length || !proposed?.length) return null;

  for (const p of proposed) {
    if (!p.date) continue;
    const want = hours.parseTime(p.time);
    for (const o of s.offered) {
      if (o.date !== p.date) continue;
      // No time given, but only one slot that day — they clearly mean
      // that one, and asking again would be pedantry.
      if (!want) {
        const sameDay = s.offered.filter((x) => x.date === p.date);
        if (sameDay.length === 1) return sameDay[0];
        continue;
      }
      const have = hours.parseTime(o.time);
      if (have && want.minutes === have.minutes) return o;
    }
  }
  return null;
}

function envelope(s, messages, extra) {
  const presence = hours.presence();
  return {
    sessionId: s.id,
    state: s.state,
    messages: messages.filter(Boolean),
    chips: extra?.chips || [],
    review: extra?.review || null,
    /* The booking form, when one is open. Null the rest of the time
       — the desk is a conversation that can produce a form, not a
       form with a conversation stuck to the front of it. */
    form: extra?.form || null,
    booking: extra?.booking || null,
    /* THE TILL, WHEN THERE IS ONE.

       The envelope is a fixed shape on purpose — a reply that
       could carry anything is a reply nothing can be written
       against. The cost is that a new field has to be declared
       here or it is silently dropped, which is what happened:
       flow.js set checkoutUrl, the desk looked for it, and the
       envelope between them threw it away without a word. */
    checkoutUrl: extra?.checkoutUrl || null,
    office: { open: presence.open, label: presence.label, hoursText: P.hoursText },
    // What the desk says about its own state — closed, shut for a
    // holiday, or having a slow moment. Null when there is nothing to
    // add, which is most of the time. See rules/status.js.
    notice: status.notice({ degraded: extra?.degraded }),
    inputEnabled: extra?.inputEnabled !== undefined
      ? extra.inputEnabled
      : s.state !== "review" && s.state !== "confirmed" && s.state !== "halted",
    meta: { turn: s.turns, model: extra?.model || null, latencyMs: extra?.latencyMs || 0 },
  };
}

/** The draft as the review card and the practitioner will see it. */
function draftView(d) {
  return {
    name: d.name,
    email: d.email,
    phone: d.phone,
    focusArea: d.focusArea,
    mode: d.mode,
    modeLabel: d.modeLabel,
    dob: d.dob,
    country: d.country,
    notes: d.notes,
    /* When the visitor picked a real free slot, the review card shows
       THAT and nothing else — it is the appointment, not a wish. The
       proposals only appear when no offer could be matched, which is
       the old behaviour: she reads them and schedules by hand.

       Showing both would be the worst version: three lines of times
       where one of them is the booking and the reader cannot tell
       which. */
    suggestedSlots: d.chosenSlot
      ? [{ date: d.chosenSlot.date, time: d.chosenSlot.time, label: d.chosenSlot.label }]
      : d.suggestedSlots,
    // Present only when a real slot was taken, so the client can say
    // "booked" rather than "requested".
    scheduledAt: d.chosenSlot?.startAt || null,
  };
}

/** Reconnecting to a session that is still alive.
 *
 *  The window must NEVER come back empty. Returning an envelope with
 *  no messages and no chips is what it did, and if the browser had no
 *  transcript of its own — cleared, private mode, a different device,
 *  or simply a session id that outlived the log — the visitor opened
 *  the desk and got a blank box.
 *
 *  The client draws this only when it has nothing restored, so a
 *  visitor with their conversation still in front of them does not
 *  get greeted a second time underneath it.
 */
function resume(s) {
  const presence = hours.presence();

  /* Mid-booking is a different sentence. Somebody who left a form
     half-filled wants to know it is still there, not to be welcomed
     back as though they had just arrived. */
  const midway = s.state === "form" || (s.draft && (s.draft.name || s.draft.email));

  const line = midway
    ? "You are back — and so is what you had started. Say “book” to pick the form up again."
    : presence.open
    ? "Welcome back. What can I do?"
    : `Welcome back. She's not at her desk right now, but I can take everything down and she'll ${presence.label.replace(/^Closed · replies /, "reply ")}.`;

  return envelope(s, [say(line)], {
    chips: ["Book a consultation", "What do you help with?", "How does it work?"],
  });
}

/* ---- greeting ------------------------------------------------- */
function greet(s) {
  const presence = hours.presence();
  const opening = presence.open
    ? "Hello — front desk at Mind Your Food."
    : `Hello — front desk at Mind Your Food. She's not at her desk right now, but ` +
      `I can take everything down and she'll ${presence.label.replace(/^Closed · replies /, "reply ")}.`;

  s.state = "collecting";
  /* NOT awaiting a name.

     The desk used to open by asking for one and then work down a
     list — name, focus, email, date of birth. The form does that
     now, all at once, and leaving the old questions running meant
     every turn ended with one whether it made sense or not: ask
     "who are you?" and the desk answered, then asked for your email.
     Two replies to one question, which is what reads as two bots
     talking over each other.

     It also took "hello" as a name, because something had to be the
     answer to a question nobody had asked for. */
  s.awaiting = null;
  session.remember(s, "assistant", opening);

  return envelope(
    s,
    [
      say(opening),
      say(
        "I can book you a consultation, tell you what she works with, or answer questions about how " +
          "the sessions run. What brings you in?"
      ),
    ],
    { chips: ["Book a consultation", "What do you help with?", "How does it work?"] }
  );
}

/* ---- merging proposed fields --------------------------------
   The single place a draft is allowed to change. Everything —
   model output, scripted extraction, a chip click — goes through
   here, so there is exactly one implementation of "is this
   value acceptable" to audit. */
function merge(s, fields, now) {
  const complaints = [];
  const d = s.draft;

  if (fields.name && !d.name) {
    const r = v.name(fields.name);
    r.ok ? (d.name = r.value) : complaints.push(r.message);
  }

  if (fields.email) {
    const r = v.email(fields.email);
    if (r.ok) d.email = r.value;
    else complaints.push(r.message);
  }

  if (fields.phone) {
    const r = v.phone(fields.phone);
    if (r.ok) d.phone = r.value || "";
    else complaints.push(r.message);
  }

  if (fields.focusArea && !d.focusArea) {
    const r = v.focusArea(fields.focusArea);
    if (r.ok) {
      d.focusArea = r.value;
      d.focusId = r.id;
    } else complaints.push(r.message);
  }

  if (fields.mode) {
    const r = v.mode(fields.mode);
    d.mode = r.value;
    d.modeLabel = r.label;
  }

  if (fields.dob && !d.dob) {
    const r = v.dob(fields.dob, now);
    if (r.ok) {
      d.dob = r.value;
      d.age = r.age;
    } else {
      // An under-16 is a safeguarding stop, not a validation nag: the
      // flow halts on it rather than asking again.
      if (r.minor) s.flags.minor = true;
      complaints.push(r.message);
    }
  }

  if (fields.country && !d.country) {
    const r = v.country(fields.country);
    if (r.ok) d.country = r.value;
    else complaints.push(r.message);
  }
  if (fields.timezone) d.timezone = v.clean(fields.timezone).slice(0, 60);

  if (fields.notes) {
    const r = v.notes([d.notes, fields.notes].filter(Boolean).join(" "));
    d.notes = r.value;
  }

  if (fields.suggestedSlots && fields.suggestedSlots.length) {
    const room = P.maxSlots - d.suggestedSlots.length;
    if (room > 0) {
      const { accepted, rejected } = slots.screen(
        fields.suggestedSlots.map((sl) => ({ slot: sl })),
        now
      );
      for (const a of accepted.slice(0, room)) {
        const dup = d.suggestedSlots.some((x) => x.date === a.date && x.time === a.time);
        if (!dup) d.suggestedSlots.push(a);
      }
      // Only the first rejection is reported. Three "that doesn't
      // work either" lines in one breath reads as a telling-off.
      if (rejected.length) {
        s.flags.invalidSlots++;
        complaints.push(rejected[0].message);
      }
    }
  }

  return complaints;
}

/* ---- scripted extraction -------------------------------------
   The no-AI path. Attributes the message to whatever the desk
   last asked for, plus anything unmistakable (an email address, a
   date) found anywhere in the text. */
/* Common lead-ins people put in front of their own name. Stripped
   before the name is tested and before it is stored, so the draft
   holds "Aisha Rahman" rather than "hi, my name is Aisha Rahman". */
const NAME_LEADIN =
  /^(hi|hello|hey)?[,\s]*(i'?m|i am|my name'?s?( is)?|this is|it'?s|call me|name'?s)\s+/i;

/* Is this message plausibly somebody's name, or is it a sentence?
   The scripted path has no model to ask, and the failure it must
   avoid is storing "I'd like to book a consultation" as a name and
   then greeting them as "I'd" for the rest of the conversation.

   Deliberately strict. A rejected name costs one re-ask; an
   accepted sentence poisons the draft and the practitioner's
   email. */
const INTENT_WORDS =
  /\b(book|booking|appoint|consult|schedule|help|want|need|would|like|please|about|question|know|tell|can|could|how|what|when|where|why|price|cost|fee|available|time|slot)\b/i;

function looksLikeName(raw) {
  const t = raw.replace(NAME_LEADIN, "").trim().replace(/[.!?]+$/, "");
  if (t.length < 2 || t.length > 60) return null;
  if (/\d|@|https?:/.test(t)) return null;
  if (/[?!]/.test(raw)) return null;
  // Names are one to four words of letters, hyphens, apostrophes, dots.
  const words = t.split(/\s+/);
  if (words.length > 4) return null;
  if (!/^[\p{L}][\p{L}\s'’.\-]*$/u.test(t)) return null;
  // A single intent word anywhere means this is a sentence, unless the
  // visitor explicitly announced it ("my name is Grace") — in which
  // case they have already told us it is a name.
  if (INTENT_WORDS.test(t) && !NAME_LEADIN.test(raw)) return null;
  return t;
}

/* Intents that mean "I am asking you something", not "here is my
   answer". A message reading as one of these must never be consumed
   as a free-text field.

   The word list in looksLikeName cannot do this on its own: it has no
   entry for "do", "you" or "treat", so "do you treat PCOS" passed
   every check and was filed as somebody's NAME — the practitioner
   would have received an email addressed to "do". Intent recognition
   is exactly the right tool for the distinction, and it costs
   microseconds. */
const QUESTION_INTENTS = new Set([
  "hours", "fees", "services", "process", "location",
  "mode", "duration", "about", "human", "ambiguous",
]);

function scriptedFields(s, text, now) {
  const fields = {};
  const t = text.trim();

  /* Asked, not answered. Structured fields are still read below —
     an email address or a date identifies itself and cannot be
     mistaken for a question — but the free-text ones are left alone
     so a question never becomes a name, a focus area or a country. */
  const asking = QUESTION_INTENTS.has(nlu.classify(text).intent);

  /* Sniff loosely, validate strictly — the split has to fall that way
     round. The well-formed pattern requires a dot after the @, so a
     near-miss like "priya@nope" volunteered while the desk was asking
     for a name never reached the validator at all: it was dropped in
     silence and the visitor was left believing they had given it.

     So a second, looser pass runs when the message ANNOUNCES an
     address ("my email is …") or when an address is what was asked
     for. The announcement test is what keeps "free tues@2pm" from
     being read as an email — the loose pattern alone would match it. */
  const emailHit = /[^\s@]+@[^\s@.]+\.[^\s@]+/.exec(t);
  const emailish = /[^\s@]+@[^\s@]+/.exec(t);
  const declaresEmail = /\b(e-?mails?|mail me|reach me|contact me)\b/i.test(t);

  if (emailHit) fields.email = emailHit[0];
  else if (emailish && (declaresEmail || s.awaiting === "email")) fields.email = emailish[0];

  /* A date of birth is a date, and the slot parser will happily read
     "14/03/1992" as a proposed appointment — the visitor then gets
     "1992-03-14 has already passed" in reply to being asked when they
     were born. While the desk is waiting on a birth date, nothing in
     the message is a booking time. */
  const parsed = s.awaiting === "dob" ? [] : slots.parseSlots(t, now);
  if (parsed.length) fields.suggestedSlots = parsed.map((p) => p.slot);

  switch (s.awaiting) {
    case "name": {
      // "I'd like to book a consultation" is an intent, not a name.
      // Storing it would greet them as "I'd" for the rest of the
      // conversation and put it on the practitioner's email.
      const candidate = fields.email || asking ? null : looksLikeName(t);
      if (candidate) fields.name = candidate;
      break;
    }
    case "focusArea":
      // ...but not if the message is plainly about scheduling. A reply
      // of "thursday at 4pm or friday morning" arriving while the desk
      // still wants a focus area was being filed as the focus area,
      // and went to the practitioner as the thing they wanted help
      // with. Slots parsed out of it means it is a time, not a topic.
      if (!fields.email && !parsed.length && !asking) fields.focusArea = t;
      break;
    case "email":
      // Whole message only if nothing address-shaped was found — otherwise
      // the sniffed address above is the better thing to validate.
      if (!fields.email) fields.email = t;
      break;
    case "phone":
      if (/^(skip|no|none|nope|later|rather not)/i.test(t)) fields.phone = "";
      else fields.phone = t;
      break;
    case "mode":
      fields.mode = t;
      break;
    case "dob":
      if (!emailHit) fields.dob = t;
      break;
    case "country":
      if (!emailHit && !parsed.length && !asking) fields.country = t;
      break;
    case "slots":
      if (!parsed.length) fields.suggestedSlots = [{ label: t.slice(0, 80) }];
      break;
    default:
      break;
  }

  return fields;
}

/* ---- scripted answers ---------------------------------------
   The desk offers "What do you help with?" as a quick reply, so it
   has to be able to answer it with the model switched off — an
   offered question that leads nowhere is worse than not offering
   it. These are the handful the practice is actually asked, in the
   same voice the model is instructed to use. Anything not here
   falls through to the next booking question. */
const FAQ = [
  {
    match: /\b(what|which).{0,20}\b(help|work|treat|specialis|specializ|deal|focus|areas?)\b|^services?$/i,
    answer: () =>
      `She works with ${v.FOCUS_AREAS.map((f) => f.label.toLowerCase()).slice(0, -1).join(", ")}, ` +
      `and ${v.FOCUS_AREAS[v.FOCUS_AREAS.length - 1].label.toLowerCase()}.\n\n` +
      "It's medical nutrition therapy, built around your labs, your routine and the food you actually eat.",
  },
  {
    match: /\bhow (does|do) (it|this|things|the sessions?) work\b|\bwhat happens\b|\bwhat'?s the process\b/i,
    answer: () =>
      "You send a request here with a few times that suit you. She replies personally — usually within " +
      `${P.replyWindow} — confirms one of them, and takes it from there.\n\n` +
      "The first session is the long one: history, labs, lifestyle and goals, before any plan exists.",
  },
  {
    match: /\b(when|what) (are|is) (you|she|the practice|your) (open|hours|available)\b|\bopening hours\b|\bwhat time\b/i,
    answer: () => `Consultation hours are ${P.hoursText}. ${hours.presence().label}.`,
  },
  {
    match: /\b(fee|fees|cost|costs|price|prices|pricing|charge|charges|how much|payment|rate)\b/i,
    answer: () =>
      "Fees depend on which programme suits you, so she sets them out herself rather than my quoting a " +
      "number that turns out to be wrong. Send a request and she'll cover it in her reply.",
  },
  {
    match: /\b(online|video|remote|in.?person|clinic|where|location|address|visit)\b/i,
    answer: () =>
      "Both — video call or in person. Most people outside the city choose video, and it works just as " +
      "well. You can tell me which you'd prefer when I take your details.",
  },
  {
    match: /\bhow long\b|\bduration\b|\blength of\b/i,
    answer: () =>
      "The first consultation runs longest, because it covers your history and labs properly. " +
      "Follow-ups are shorter. She'll confirm the timing when she replies.",
  },
  {
    match: /\b(who|what) (is|are) (khadija|she|you)\b|\babout (khadija|her)\b|\bqualif|\bcertif|\bcredential/i,
    answer: () =>
      "Khadija is a clinical dietitian and sports nutritionist. She takes on a limited number of " +
      "clients so each one gets real attention — which is why this is by appointment.",
  },
  {
    // Answered plainly. Someone asking whether they are talking to a
    // machine has already decided it matters to them, and a coy
    // non-answer is the one reply guaranteed to annoy. Saying so also
    // costs nothing: everything this desk does is take details and
    // book a time, which is not work that needs a person.
    match: /\b(speak|talk) to (a )?(human|person)\b|\bare you (a )?(bot|robot|real)\b/i,
    answer: () =>
      "I'm the front desk — software, not Khadija. I take your details and find a time; she reads " +
      "every request herself and replies personally.\n\n" +
      `If you'd rather skip me entirely, email ${P.contactEmail} and she'll pick it up directly.`,
  },
];

/* Which FAQ entry answers which intent. The regexes above stay as a
   fallback for phrasings the NLU has not learned yet, but the intent
   is consulted FIRST — it scores every intent instead of taking the
   earliest regex that happens to match, which is how "how much is a
   video consultation" used to be answered with the sentence about
   cameras rather than the one about money.

   `location` and `mode` share an answer because the honest reply to
   both is the same: video, phone, or come in. */
const ANSWER_FOR_INTENT = {
  services: 0,
  process: 1,
  hours: 2,
  fees: 3,
  location: 4,
  mode: 4,
  duration: 5,
  about: 6,
  human: 7,
};

/** The reply the desk can give without asking a model anything.
 *
 *  Returns null when nothing in the knowledge base covers it, which
 *  is a real answer: the caller then falls through to the model, or
 *  to the scripted question it was already asking.
 */
function scriptedAnswer(text) {
  const read = nlu.classify(text, knowledge.allPhrasings());

  /* The database first, the built-in answers as a floor. She edits
     the wording in the CRM; the copies in FAQ below exist so a fresh
     clone with an empty database still has a working desk, and so an
     unreachable data service cannot make the desk mute. */
  const stored = knowledge.answerFor(read.intent);
  if (stored) return stored;

  const idx = ANSWER_FOR_INTENT[read.intent];
  if (idx !== undefined) return FAQ[idx].answer();

  /* Two intents too close to separate. Answering either would be a
     coin toss, and a confident wrong answer costs more than one turn
     spent asking. */
  if (read.intent === "ambiguous") {
    const both = [read.top, read.runnerUp].filter((i) => ANSWER_FOR_INTENT[i] !== undefined);
    if (both.length === 2) {
      const name = (i) => knowledge.labelFor(i) || TOPIC_WORDS[i];
      return `I can answer either — did you mean ${name(both[0])} or ${name(both[1])}?`;
    }
  }

  // Nothing recognised: fall back to the original regexes, which
  // still catch phrasings the intent table has not been taught.
  const hit = FAQ.find((f) => f.match.test(text));
  return hit ? hit.answer() : null;
}

/** How to name a topic back to a visitor.
    NB: not INTENT_WORDS — that name is already taken above by the
    regex that stops a question being mistaken for somebody's name. */
const TOPIC_WORDS = {
  services: "what she works with",
  process: "how the sessions run",
  hours: "opening hours",
  fees: "the fee",
  location: "where she is",
  mode: "video or in person",
  duration: "how long a session takes",
  about: "about Khadija",
};


/* Which field a reply is asking about, or null.

   The model is TOLD which single field to request, and mostly obeys —
   but not always, and the failure is visible to the visitor: after a
   BMI handoff it would ask "what would you like to work on?" about a
   focus area the calculator had already supplied. More prompt did not
   fix it; two rounds of increasingly explicit instruction were still
   ignored.

   So the rules check the model's work. This is the same principle
   already applied to rejected slots and tripped guardrails: the model
   chooses the words, it does not choose what happens. */
const ASKING_ABOUT = {
  name: /what should i call you|your name|may i (have|take) your name/i,
  focusArea: /what would you like to work on|what brings you|like help with|what are you looking for/i,
  email: /email address|your email/i,
  dob: /date of birth|when were you born/i,
  country: /which country|what country|where are you based/i,
  slots: /what times?|when suits|times? suit you|when would you like/i,
};

function questionTarget(text) {
  for (const [field, re] of Object.entries(ASKING_ABOUT)) {
    if (re.test(text)) return field;
  }
  return null;
}

/** True when the reply asks for something the draft already holds. */
function asksForHeldField(text, draft) {
  const target = questionTarget(text);
  if (!target) return false;
  if (target === "slots") return (draft.suggestedSlots || []).length > 0;
  return Boolean(draft[target]);
}

/* ---- what to ask next ---------------------------------------- */
/* The next optional field worth offering, or null. Peeks without
   marking it asked — the caller marks it once it actually asks, so
   a turn that never gets around to the question does not burn it. */
function nextOptional(s) {
  for (const key of OPTIONAL_ORDER) {
    if (s.flags[`asked_${key}`]) continue;
    const empty = key === "phone" ? !s.draft.phone : s.draft.mode === "undecided";
    if (empty) return key;
  }
  return null;
}

function nextQuestion(s) {
  const gaps = v.missing(s.draft);
  if (gaps.length) {
    const key = gaps[0];
    s.awaiting = key;
    return { text: ASK[key].prompt(s), chips: ASK[key].chips(s) };
  }

  // Required fields are in. Offer the optional ones once each,
  // then go to review — the desk asks, it does not interrogate.
  for (const key of OPTIONAL_ORDER) {
    const asked = s.flags[`asked_${key}`];
    const empty = key === "phone" ? !s.draft.phone : s.draft.mode === "undecided";
    if (!asked && empty) {
      s.flags[`asked_${key}`] = true;
      s.awaiting = key;
      return { text: OPTIONAL[key].prompt(s), chips: OPTIONAL[key].chips(s) };
    }
  }

  s.awaiting = null;
  return null;
}

function toReview(s) {
  s.state = "review";
  s.awaiting = null;
  return envelope(
    s,
    [say("That's everything I need. Here it is as she'll see it — have a read before I send it.")],
    { review: draftView(s.draft), inputEnabled: false }
  );
}

/* ============================================================
   PUBLIC ENTRY POINTS
   ============================================================ */

function start(ipHash, meta) {
  const s = session.create(ipHash, meta);
  if (meta?.snapshot) return greetWithBmi(s, meta.snapshot);
  return greet(s);
}

/* ---- warm start from the BMI calculator ----------------------
   The visitor has already told us something real about why they
   are here, so opening with "what brings you in?" would be asking
   them to repeat themselves. The desk acknowledges the number,
   states plainly that it is not a diagnosis, and goes straight to
   the first thing it actually needs.

   What the snapshot fills in is deliberately narrow: the goal, if
   they typed one, and a note for the practitioner. It does NOT
   invent a focus area from the BMI band — "obese I" is not a
   thing somebody asked for help with, and guessing would put words
   in their mouth on the practitioner's email. */
function greetWithBmi(s, snap) {
  const bmi = Number(snap.bmi);
  const band = String(snap.category || "").trim();

  s.state = "collecting";
  s.draft.notes = [
    `BMI ${bmi} (${band}, ${snap.categoryBasis === "asian" ? "South Asian" : "WHO"} range),`,
    `height ${snap.heightCm}cm, weight ${snap.weightKg}kg — from the site's calculator.`,
  ].join(" ");
  s.bmiSnapshotId = snap.id || null;

  // A typed goal is the visitor's own words, so it can stand as the
  // focus area. An empty box cannot.
  if (snap.goal) {
    const r = v.focusArea(snap.goal);
    if (r.ok) {
      s.draft.focusArea = r.value;
      s.draft.focusId = r.id;
    }
  }

  const gaps = v.missing(s.draft);
  s.awaiting = gaps[0] || null;
  const q = gaps.length ? ASK[gaps[0]].prompt(s) : null;

  const opening =
    `I have your figures from the calculator — BMI ${bmi}, in the ${band} range. ` +
    "That is a starting point and nothing more; what it means for you is exactly the kind of " +
    "thing she works out in a consultation.";

  session.remember(s, "assistant", opening);

  return envelope(
    s,
    [
      say(opening),
      say(
        s.draft.focusArea
          ? `I have you down for ${s.draft.focusArea.toLowerCase()}. ${q || ""}`.trim()
          : q || "Shall I take your details?"
      ),
    ],
    { chips: gaps.length && ASK[gaps[0]] ? ASK[gaps[0]].chips(s) : [] }
  );
}

async function message(s, text, ipHash) {
  const now = new Date();
  s.turns++;

  /* 0 · terminal states are terminal.
     `halted` in particular: the desk stopped because somebody
     described an emergency, and it must not be talked back into
     taking a booking on the next message. Restarting is a
     deliberate act (the restart button drops the session), not
     something that happens by carrying on typing. */
  if (s.state === "halted") {
    // Why it halted changes what should be said. Telling someone who
    // turned out to be 15 to "contact emergency services" is alarming
    // and wrong; telling someone in crisis to ask a guardian to email
    // is worse. One state, two reasons, two messages.
    const again = s.flags.minor
      ? `I still can't take this one myself — please ask a parent or guardian to email ` +
        `${P.contactEmail} and she'll pick it up from there.`
      : "I'm still not able to help with this one — please contact emergency services or your " +
        "doctor. If you came here for something else entirely, close this and start again.";
    return envelope(s, [say(again, "warn")], { inputEnabled: false });
  }

  /* A CONFIRMED BOOKING IS NOT THE END OF THE CONVERSATION.

     This used to answer every later message with "that request is
     already with her" and switch the composer off, which made a
     booking a dead end for the whole browser. It was the wrong
     axis to enforce on: it locked a SESSION, and the thing that
     identifies a client is their EMAIL ADDRESS.

     One tab is one person only by assumption. A mother books for
     herself and then for her daughter; a husband books after his
     wife on the same laptop; somebody realises they picked the
     wrong focus area and starts again. Every one of those is a
     legitimate second booking with a different address, and every
     one of them was met with a switched-off input box.

     Duplicate control lives where identity lives — the email check
     at form.submit, and the unique index under it. So this resets
     to a fresh draft and carries on, keeping the reference so the
     desk can still answer "did you get it?" about the last one. */
  if (s.state === "confirmed") {
    s.lastBooking = s.booking;
    s.booking = null;
    s.draft = session.emptyDraft();
    s.state = "collecting";

    /* AND THE FORM MAY OPEN AGAIN.

       `formOpened` is a once-only guard so that saying "book" while
       already typing into the form does not wipe the panel. Right
       within one booking — and it was never cleared, so it outlived
       the booking it was guarding.

       The effect: after paying, the visitor came back to the desk
       in the same tab (sessionStorage survives the trip to the
       checkout), pressed "Book a consultation", and got the generic
       "I can book you a consultation…" answer instead of a form.
       Forever, on that device, until they cleared their storage —
       which is exactly what it took to make it work again.

       A second consultation is the whole point of taking payment.
       The guard belongs to a booking, so it is dropped with one. */
    s.flags.formOpened = false;
    // and falls through to the ordinary handling of this message
  }

  if (s.state === "closed") {
    return envelope(s, [
      say("This conversation is closed. Start a fresh one whenever you're ready."),
    ], { inputEnabled: false });
  }

  if (s.turns > config.session.maxTurns) {
    s.state = "closed";
    return envelope(s, [
      say(
        "We've gone back and forth a fair bit — I don't want to keep you here. Email " +
          `${P.contactEmail} with your name, what you'd like help with and two times that suit ` +
          "you, and she'll take it from there."
      ),
    ], { inputEnabled: false });
  }

  /* 1 · safety, before anything else sees the text */
  const screen = safety.screenInbound(text);
  if (screen.action !== "pass") {
    if (screen.halt) {
      s.state = "halted";
      s.flags.emergency = true;
      // The draft is abandoned deliberately: no booking should come
      // out of this exchange, so there is nothing left to hold.
      s.draft = session.emptyDraft();
      return envelope(s, [say(screen.reply, "warn")], { inputEnabled: false });
    }
    s.flags.deflections++;
    session.remember(s, "user", text);
    session.remember(s, "assistant", screen.reply);
    const q = s.state === "collecting" ? nextQuestion(s) : null;
    return envelope(s, [say(screen.reply), q && say(q.text)], { chips: q?.chips || [] });
  }

  session.remember(s, "user", text);

  /* 2 · read what THIS message just answered, before asking the
         model anything.

         Ordering matters and getting it wrong is visible: run the
         model first and its prompt describes the draft as it was a
         turn ago, so it re-asks for something already given, or —
         as happened — accepts the focus area and jumps straight to
         email without ever learning a name. The scripted extractor
         is deterministic and costs nothing, so it goes first and the
         model is briefed on the CURRENT state. */
  /* 1c · somebody asking to book gets the FORM, not eight questions.
         Once only: reopening it on every mention of "book" would
         wipe the panel they are in the middle of typing into.

         Deliberately after the safety checks above and before any
         field extraction, so "I'd like to book" opens the form
         rather than being mined for a name. */
  if (s.state === "collecting" && !s.flags.formOpened) {
    const read = nlu.classify(text, knowledge.allPhrasings());
    /* A CLEAR request, not a hint. The book intent scores on words
       like "start" and "session", so "I want to start eating better"
       was opening a booking form at somebody who had asked a
       question. A form that appears uninvited is worse than one that
       has to be asked for twice — a score of 3 needs a whole strong
       phrase rather than three stray hints. */
    if (read.intent === "book" && read.score >= 3) {
      s.flags.formOpened = true;
      return action(s, "form.open", ipHash);
    }
  }

  const wasAwaiting = s.awaiting; // askFor overwrites this a few lines down
  const scripted = scriptedFields(s, text, now);
  const preComplaints = merge(s, scripted, now);

  /* Which single field the desk still needs. Computed here, in code,
     and handed to the model as an instruction — the model words the
     question, it does not get to choose which question. */
  const askFor = v.missing(s.draft)[0] || nextOptional(s) || null;

  /* ---- 2a · answer it here, and do not ask a model at all -------

     A visitor asking the opening hours is not a language problem. The
     question is one of a closed set, the answer is a fact the desk
     already holds, and the model was only ever rewording it — at
     roughly 700ms, a per-message cost, and with a chance of saying
     something slightly different each time. The knowledge base
     answers in microseconds and says the same thing twice.

     Three conditions, all necessary:

       · nothing was extracted this turn, so they are asking rather
         than answering — "my email is x@y.com, and how much is it"
         must still reach the model, which is better at both-at-once;
       · the knowledge base actually covers it;
       · they are not mid-review, where the only useful reply is the
         card in front of them.

     The pending question is re-asked underneath the answer, so an
     interruption costs the visitor nothing and the desk does not lose
     its place. */
  const answeredSomething = Object.keys(scripted).length > 0;
  if (!answeredSomething && s.state === "collecting") {
    const known = scriptedAnswer(text);

    /* Nothing extracted and nothing recognised: the visitor asked
       something this desk does not know. Recorded — the text only,
       never who sent it — so she can see what people actually ask
       and teach it an answer. That queue is the whole mechanism by
       which this gets better without anyone retraining anything.

       Fire and forget: a note for later must never affect the
       conversation that produced it. */
    /* ---- the deskOfficer's boundary (item 10) -------------
       Before anything else looks at this: is it a question only
       Khadija may answer? If so it is refused here, in code, and
       never reaches a model at all. The safest possible place for
       that check is the earliest one.

       Deliberately BEFORE the corpus, because retrieval would
       otherwise deflect it by accident — "what should I eat for
       PCOS" matches the entry about what a consultation covers,
       which is the right outcome for the wrong reason and will
       not hold as the corpus grows. */
    if (!known && scope.isClinical(text)) {
      session.remember(s, "assistant", scope.REFUSAL);
      s.turns++;
      orchestrator.record({
        bot: "desk-officer",
        lane: "deterministic",
        sessionRef: s.id,
        input: text,
        output: scope.REFUSAL,
        reason: "clinical-boundary",
        latencyMs: 0,
      });
      return envelope(s, [say(scope.REFUSAL)], {
        chips: ["Book a consultation"],
        inputEnabled: true,
      });
    }

    /* The scope corpus is no longer consulted.

       It was a second place answers could come from, and the desk
       already has one she edits herself — crm.knowledge, from the
       Knowledge page, with the learning loop attached. Two sources
       means two places to look when the desk says something odd,
       and only one of them was hers.

       corpus/scope.js stays on disk and keeps its tests: the
       CLINICAL BOUNDARY above still uses it, and that is the part
       that matters. Losing the scope answers costs a few sentences
       she can write herself; losing the refusal would cost rather
       more. */

    /* Only what the desk genuinely could not place. A greeting is
       answered, a chip opens a form — neither is a question waiting
       for her to write an answer, and a teach queue full of things
       that already work is one she stops opening.

       This is the SECOND of two places that recorded misses. Fixing
       only the other one left "hello" still arriving. */
    if (!known) {
      const placed = nlu.classify(text, knowledge.allPhrasings()).intent;
      if (placed === "unknown" || placed === "ambiguous") knowledge.missed(text);
    }

    if (known) {
      session.remember(s, "assistant", known);
      s.turns++;

      /* The deterministic lane is counted too, and this is the half
         that matters most. Recording only the model turns would make
         the table say the desk answers everything with a provider —
         the exact opposite of what it does, and the exact question
         item 13 exists to settle. */
      orchestrator.record({
        bot: "front-desk",
        lane: "deterministic",
        sessionRef: s.id,
        input: text,
        output: known,
        reason: "knowledge",
        latencyMs: 0,
      });

      /* The answer, and nothing else.

         This used to append the next collection question underneath —
         "Consultation hours are Mon-Fri 10:00-19:00" followed by
         "Lovely, what should I call you?" — which is a non sequitur
         and the second half of what read as two bots replying at
         once. The form collects; a question deserves an answer and
         then silence. */
      return envelope(s, [say(known)], {
        chips: ["Book a consultation"],
        // No model was consulted, so no model is reported. `meta.model`
        // staying null is how the CRM and the logs can tell which
        // turns cost anything.
      });
    }
  }

  /* If times are about to come up — either because the desk is about
     to ask, or because the visitor has just answered that question —
     make sure we know what she is genuinely free for. Awaited rather
     than fired-and-forgotten: the chips in this very reply are built
     from it. */
  if (askFor === "slots" || wasAwaiting === "slots") await loadOffer(s);

  /* Turn what they said into a slot that actually exists. Everything
     downstream — the review card, the hold, the time she sees — comes
     from this, so it is resolved once, here, against the offer rather
     than re-derived from free text later. */
  if (s.draft.suggestedSlots?.length && !s.draft.chosenSlot) {
    const picked = resolveOffer(s, s.draft.suggestedSlots);
    if (picked) s.draft.chosenSlot = picked;
  }

  // Record it as the pending question so next turn's scripted
  // extractor attributes a bare answer ("tuesday", "skip") correctly,
  // and mark an optional as spent so it is offered once, not nagged.
  if (askFor) s.awaiting = askFor;
  // NB: an optional field is marked "asked" only once the turn has
  // actually delivered the question — see below. Marking it here
  // burned the question whenever the model then failed and the
  // scripted path took over: it skipped straight past `mode` to
  // `phone`, so "video call" arrived while the desk was waiting for a
  // phone number and was rejected as a malformed one.

  /* 3 · NO MODEL. The front desk is deterministic.

         It used to ask a model to word the next question and to pick
         up any field the regexes missed. That is gone, and the desk
         is better for it:

           two voices answered at once — the scripted answer and then
           the model's, which reads as two people talking over each
           other;

           the model occasionally decided the conversation had moved
           on and asked for something already given;

           and it cost about 600ms a turn to reword a question that
           was already written down.

         What replaces it is what was always underneath: the
         knowledge base she writes, the scripted prompts, the scope
         corpus, and the form. Instant, identical every time, and
         still working with every provider on earth down.

         The agentic lane still exists — it is the deskOfficer, and
         the orchestrator still routes to it. It is simply no longer
         wired into the desk's own turn.

         `result` is a null constant rather than the branch below
         being deleted. That branch is the only written account of
         how the model USED to be constrained, and it costs nothing
         to leave unreachable. */
  const result = null;

  orchestrator.record({
    bot: "front-desk",
    lane: "deterministic",
    sessionRef: s.id,
    input: text,
    intent: wasAwaiting || askFor || null,
    reason: "scripted",
    latencyMs: 0,
  });

  /* 4 · merge anything the model found that the scripted pass did
         not. Both go through the same validators. */
  const modelFields = { ...(result?.fields || {}) };

  /* Except dates. The scripted parser is deterministic and grounded in
     the visitor's actual words; the model is neither, and it will
     helpfully "resolve" an impossible request into a workable one. Told
     "sunday at 11am" it proposed the coming Wednesday — a date nobody
     had offered, which passed validation and would have reached the
     practitioner as the visitor's own suggestion.

     So when the regex pass found dates in this message, those are the
     dates. The model may still contribute times and labels, and it
     remains the only source when the regex pass finds nothing — which
     is where it earns its place. */
  if (modelFields.suggestedSlots) {
    const before = modelFields.suggestedSlots.length;

    // A message with no temporal language cannot be proposing a time.
    // Without this the model could add slots on turns like "video call"
    // — it emitted a Friday labelled "Sunday" that way, and with no
    // scripted dates to compare against, nothing caught it.
    const TEMPORAL =
      /\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|yesterday|morning|afternoon|evening|noon|night|week|month|am|pm|o'?clock|\d{1,2}[:.]\d{2}|\d{4}-\d{2}-\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|anytime|whenever|flexible)\b/i;

    if (wasAwaiting === "dob" || !TEMPORAL.test(text)) {
      modelFields.suggestedSlots = [];
    } else if (scripted.suggestedSlots?.length) {
      const grounded = new Set(scripted.suggestedSlots.map((sl) => sl.date).filter(Boolean));
      if (grounded.size) {
        modelFields.suggestedSlots = modelFields.suggestedSlots.filter(
          (sl) => !sl.date || grounded.has(sl.date)
        );
      }
    }

    const dropped = before - modelFields.suggestedSlots.length;
    if (dropped) console.warn(`[bff] dropped ${dropped} ungrounded model slot(s)`);
  }

  /* The visitor's own words outrank the model's reading of them.
     `mode` is merged unconditionally — every other field is guarded
     with `!d.field`, so only this one can be overwritten — and the
     model's fields land AFTER the scripted pass. The result: somebody
     answered "phone call", the scripted extractor correctly read
     `audio`, and the model's `in_person` replaced it a few lines
     later. She would have expected them at the clinic while they
     waited by the phone.

     So when the scripted pass has already read this field out of a
     direct answer, the model does not get to restate it. Rules decide,
     the model speaks — and here the visitor decided. */
  if (scripted.mode !== undefined && modelFields.mode !== undefined) {
    delete modelFields.mode;
  }

  const complaints = preComplaints.concat(merge(s, modelFields, now));

  /* An under-16 disclosed their age. The desk stops: it does not take
     the booking, and it does not keep the date of birth it was just
     given. A guardian has to make contact instead. Same shape as the
     emergency halt — a stop, not a validation loop. */
  if (s.flags.minor) {
    s.state = "halted";
    const msg = complaints[0];
    s.draft = session.emptyDraft();
    return envelope(s, [say(msg, "warn")], { inputEnabled: false });
  }

  /* 4 · decide the reply.
         A complaint is a deterministic fact about the booking, so it
         outranks whatever the model wrote — the model does not know
         the slot was rejected. */
  const messages = [];
  let chips = [];

  if (complaints.length) {
    messages.push(say(complaints[0], "warn"));
    const q = nextQuestion(s);
    if (q) {
      messages.push(say(q.text));
      chips = q.chips;
    }
  } else if (result?.reply) {
    const out = safety.screenOutbound(result.reply);

    /* The model asked for something already recorded. Its wording is
       discarded and the desk asks its own question instead — a visitor
       who has just given a detail should not be asked for it again. */
    const redundant = out.ok && askFor && asksForHeldField(result.reply, s.draft);
    if (redundant) {
      const own = (ASK[askFor] || OPTIONAL[askFor])?.prompt(s);
      console.warn(`[bff] model re-asked a held field; substituted "${askFor}"`);
      messages.push(say(own || result.reply));
    } else {
      messages.push(say(out.ok ? result.reply : out.replacement));
    }
    session.remember(s, "assistant", messages[0].text);
    chips = result.chips || [];

    // A replaced reply has lost whatever question the model had put in
    // it. Without re-asking, the turn ends on a deflection and the
    // booking stalls — which is exactly what happened: the desk
    // deflected twice and never did collect a focus area. The
    // deflection is kept (it is the safe text) and the pending
    // question is put back after it.
    if ((!out.ok || result.guardrail) && askFor) {
      const q = (ASK[askFor] || OPTIONAL[askFor])?.prompt(s);
      if (q) messages.push(say(q));
    }

    // The model was TOLD which field to ask for, so the desk does not
    // also ask. Appending the scripted question here produced turns
    // that asked the same thing twice in two different voices —
    // "What times suit you?" followed by "And when suits you?".
    //
    // What the rules still decide is when collecting is over: the
    // model does not get to declare the draft complete.
    if (v.isComplete(s.draft) && s.state === "collecting" && !askFor) {
      return toReview(s);
    }

    /* Chips are useful even when the model wrote its own question, so
       offer the ones belonging to the field it was asked to request.

       TIMES ARE NOT NEGOTIABLE, though. When the question is which
       slot, the real availability REPLACES whatever the model offered
       rather than filling in behind it — the model may word the
       question, it does not get to decide which hours she is free.
       Left as a fallback, a turn where the model supplied its own
       chips silently hid the genuine ones, and the visitor was shown
       invented times or none at all. Same rule as everywhere else
       here: rules decide, the model speaks. */
    const ownChips = (ASK[askFor] || OPTIONAL[askFor])?.chips(s) || [];
    if (askFor === "slots" && s.offered?.length) {
      chips = ownChips;
    } else if (!chips.length && askFor) {
      chips = ownChips;
    }

    // The model delivered the question, so the optional is now spent.
    if (OPTIONAL_ORDER.includes(askFor)) s.flags[`asked_${askFor}`] = true;
  } else {
    /* The deterministic turn, and the whole of it.

       ANSWER what it knows, or OFFER what it can do. It does not ask
       for a name, an email or a date of birth — the form collects
       those, in one pass, where the visitor can see all of them.

       One reply per message. The desk that answered a question and
       then asked an unrelated one in the same turn is what read as
       two bots. */
    const faq = scriptedAnswer(text);

    if (faq) {
      messages.push(say(faq));
      session.remember(s, "assistant", faq);
      chips = ["Book a consultation"];
    } else {
      /* Recorded so she can teach it — but only when the desk
         genuinely could not place it.

         It used to record everything that reached this branch, so
         the queue filled with "Book a consultation" (a chip, which
         opens the form) and "hello" (a greeting, which is answered).
         Neither is a question needing an answer written for it, and
         a teach queue full of things that already work is a queue
         she stops opening. */
      const read = nlu.classify(text, knowledge.allPhrasings());
      if (read.intent === "unknown" || read.intent === "ambiguous") knowledge.missed(text);
      /* HER sentence, not one written into this file.

         This is the most-said line on the whole site — the reply to
         everything nobody has taught the desk yet — and it was the
         one sentence she could not change without a deploy. It lives
         in crm.knowledge under 'fallback' now, so it is edited on
         the Knowledge page like any other answer, and placeholders
         resolve in it exactly the same way.

         The string below is the floor, for a fresh clone with an
         empty database or a data service that is not answering. A
         desk that goes silent because it could not read its own
         fallback would be worse than a slightly stale one. */
      const offer =
        knowledge.answerFor("fallback") ||
        "I can book you a consultation, tell you what she works with, or answer questions " +
          "about how the sessions run.";
      messages.push(say(offer));
      session.remember(s, "assistant", offer);
      chips = ["Book a consultation", "What do you help with?", "How does it work?"];
    }
  }

  return envelope(s, messages, {
    chips,
    model: result?.model,
    latencyMs: result?.latencyMs,
    // A null result means the AI service timed out, errored, or the
    // circuit is open — the scripted path answered instead. Deliberately
    // switching it off with AI_ENABLED is not degradation, it is a
    // choice, so it says nothing.
    degraded: config.ai.enabled && !result,
  });
}

async function action(s, act, ipHash, payload) {
  /* ---- the booking form (item 3) ----------------------------
     Opened when somebody says they want to book, rather than the
     desk asking for eight things one at a time. */
  if (act === "form.open") {
    await loadOffer(s);
    s.state = "form";
    s.awaiting = null;
    return envelope(s, [], {
      form: bookingForm.spec(s, s.offered || []),
      inputEnabled: false,
    });
  }

  if (act === "form.close") {
    /* Keeping is the default and the caller has to ask for the
       other thing explicitly. Somebody who closes a half-filled
       form has not said "throw it away", and treating those as the
       same is how people lose ten minutes of typing. */
    if (payload?.discard) {
      s.draft = session.emptyDraft();
      s.state = "collecting";
      s.awaiting = null;
      /* Cleared means cleared, including the guard — otherwise
         "start again whenever you like" is not something they can
         actually do. */
      s.flags.formOpened = false;
      return envelope(s, [
        say("Cleared — nothing was kept. Start again whenever you like."),
      ], { inputEnabled: true });
    }
    s.state = "collecting";
    /* This sentence promises the form comes back. Without clearing
       the guard it did not, and the chip below did nothing. */
    s.flags.formOpened = false;
    return envelope(s, [
      say("Saved where it was. Say \u201cbook\u201d whenever you want to pick it back up."),
    ], { chips: ["Book a consultation"], inputEnabled: true });
  }

  if (act === "form.submit") {
    const { ok, errors, values } = bookingForm.check(payload?.values);

    if (!ok) {
      /* Every problem at once. Revealing one per submit is the
         same interrogation the form replaced, with worse manners. */
      const spec = bookingForm.spec(s, s.offered || []);
      spec.errors = errors;
      // Their own answers go back in, so nothing has to be retyped.
      for (const f of spec.fields) {
        if (payload?.values?.[f.id] !== undefined) f.value = payload.values[f.id];
      }
      return envelope(s, [], { form: spec, inputEnabled: false });
    }

    /* ONE BOOKING PER ADDRESS, and a returning client is asked to
       write to her instead.

       Checked AFTER validation and BEFORE anything is written, so a
       visitor is never told "already on file" about an address they
       also mistyped — they would fix the typo and be told the same
       thing again about a different address.

       Failing OPEN. If the data service cannot answer, the booking
       goes through: turning somebody away because a lookup timed out
       is a lost client, while a duplicate row is an afternoon's
       tidying. The check is a convenience for her, not a guard on
       anything that matters.

       This does reveal whether an address is on file, to anybody who
       can submit the form. It is the unavoidable cost of the rule —
       the desk cannot say "you are already with us" without saying
       it to whoever typed the address. The rate limiter above is
       what stops it being swept. */
    if (values.email) {
      const known = await data.crm.personExists(values.email).catch(() => null);
      if (known?.ok && known.exists) {
        const spec = bookingForm.spec(s, s.offered || []);
        spec.errors = {
          email:
            `We already have you on file under that address. If you are booking ` +
            `again, email her directly at ${config.practice.contactEmail} and she ` +
            `will arrange it — or use a different address here.`,
        };
        for (const f of spec.fields) {
          if (payload?.values?.[f.id] !== undefined) f.value = payload.values[f.id];
        }
        return envelope(s, [], { form: spec, inputEnabled: false });
      }
    }

    Object.assign(s.draft, values);

    // The time is picked from what was offered, so the form cannot
    // produce a booking for an hour the desk would refuse.
    const slot = (s.offered || []).find((o) => o.startAt === payload?.slotId);
    if (slot) {
      s.draft.chosenSlot = slot;
      s.draft.suggestedSlots = [{ date: slot.date, time: slot.time, label: slot.label }];
    }

    const gaps = v.missing(s.draft);
    if (gaps.length) {
      const spec = bookingForm.spec(s, s.offered || []);
      spec.errors = gaps.includes("slots")
        ? { slots: "Pick a time that suits you." }
        : Object.fromEntries(gaps.map((g) => [g, "This one is needed."]));
      return envelope(s, [], { form: spec, inputEnabled: false });
    }

    /* "Check it over" validates and stops. It is for the visitor who
       wants to know where they stand before committing to anything,
       and it must not quietly become a submission — a button that
       does more than it says is the worst kind. */
    if (payload?.checkOnly) {
      const spec = bookingForm.spec(s, s.offered || []);
      spec.allGood = true;
      return envelope(s, [], { form: spec, inputEnabled: false });
    }

    /* Submitting the form IS the confirmation.

       There used to be a review card here — the desk showed the
       details back and asked for a second click. That made sense when
       the desk had collected the answers one at a time and might have
       misheard one. It makes no sense after a form: the visitor typed
       every field, can see all of them, and pressed Submit.

       It was also losing every booking. The form stopped at the review
       card and only the confirm click wrote to the database, so
       anybody who filled the form and considered themselves finished
       was never booked. Nothing had reached crm.consultations since
       the form shipped.

       confirm is REUSED rather than copied: one write path, one set
       of rules about rate limits, consent and the slot hold. */
    s.state = "review";
    return action(s, "confirm", ipHash, payload);
  }

  if (act === "edit") {
    s.state = "collecting";
    s.awaiting = null;
    return envelope(s, [
      say("Of course — what would you like to change? Just tell me the corrected detail."),
    ], { chips: ["My email", "The times", "What I want help with"], inputEnabled: true });
  }

  if (act === "cancel") {
    s.state = "closed";
    s.draft = session.emptyDraft();
    return envelope(s, [
      say(
        "Discarded — nothing was sent and I've cleared what you gave me. If you change your mind, " +
          "just start again whenever you like."
      ),
    ], { inputEnabled: false });
  }

  if (act !== "confirm") {
    return envelope(s, [note("I didn't follow that.")]);
  }

  /* ---- confirm ---- */
  if (s.state !== "review") {
    return envelope(s, [note("There's nothing waiting to be sent.")]);
  }
  if (!v.isComplete(s.draft)) {
    // Should be unreachable; if it fires, something bypassed the flow.
    s.state = "collecting";
    const q = nextQuestion(s);
    return envelope(s, [note("I'm still missing something."), q && say(q.text)], {
      chips: q?.chips || [],
    });
  }

  const rl = limits.perIpBooking(ipHash);
  if (!rl.ok) {
    return envelope(s, [
      note(
        `That's ${config.limits.bookingsPerIpPerHour} requests from this connection in an hour — ` +
          "I'll pause there. Try again shortly, or email her directly.",
        "warn"
      ),
    ], { review: draftView(s.draft), inputEnabled: false });
  }

  // The click IS the consent event. Recorded with the policy version
  // in force at the moment it was given.
  s.draft.consent = true;

  /* DECLARED OUT HERE, WITH THE REPLY THAT READS THEM.

     They were inside the `if (res.ok)` block below, which is
     where they are WRITTEN — but the envelope at the end of this
     function is outside it, so every successful form submission
     threw `checkoutToken is not defined` after the booking and
     the checkout had both already been created. A 500 to the
     visitor, an hour held in the database, and nothing on screen. */
  const chosenSlot = s.draft.chosenSlot || null;
  let checkoutToken = null;
  let slotTaken = false;

  const res = await booking.submit(s.draft, s);

  // Mirror into the trial database. Best effort and deliberately
  // after the real submit: the trial store must never be able to
  // fail a booking that the production endpoint already accepted.
  if (res.ok) {
    data
      .saveAppointment({
        reference: res.reference,
        name: s.draft.name,
        email: s.draft.email,
        phone: s.draft.phone || null,
        focusArea: s.draft.focusArea,
        dob: s.draft.dob || null,
        country: s.draft.country || null,
        mode: s.draft.mode,
        notes: s.draft.notes || null,
        suggestedSlots: s.draft.suggestedSlots || [],
        snapshotId: s.bmiSnapshotId || null,
        source: s.bmiSnapshotId ? "trial-bmi" : "trial-chat",
        policyVersion: config.privacy.policyVersion,
      })
      .catch(() => {});

    /* Register the visitor in the CRM schema, over the service
       token. Email is the identity there, so somebody booking a
       second time updates their record rather than appearing twice —
       which is what makes the People list worth reading.

       Same best-effort rule as the mirror above: this runs AFTER the
       real submit and its failure can never fail a booking the
       upstream endpoint has already accepted. She would rather have
       the appointment and a missing CRM row than the reverse. */
    /* TAKEN NOW, USED LATER. Everything the confirmation email needs,
       copied before the write goes out — because the draft is wiped a
       few lines below, synchronously, while this request is still in
       flight. Reading s.draft inside the callback would have found an
       empty one and posted an email addressed to nobody about
       nothing. */
    const forEmail = {
      name: s.draft.name,
      email: s.draft.email,
      focusArea: s.draft.focusArea,
      mode: s.draft.mode || "undecided",
      startAt: s.draft.chosenSlot?.startAt || null,
    };

    /* AWAITED, WHERE IT USED TO BE FIRE-AND-FORGET.

       The reason it was not is written above: this ran after an
       upstream endpoint had already accepted the booking, so its
       failure had to be survivable. That upstream is unset now and
       this row IS the booking — the comment below already said a
       silent failure here is a lost client rather than a lost
       mirror.

       And there is a second reason now. A visitor who chose an
       hour has to be handed a till, and a till needs the id of the
       row this call creates. Fire-and-forget cannot hand anybody
       anything: the reply has already gone. */
    const booked = await data.crm
      .book({
        name: s.draft.name,
        email: s.draft.email,
        phone: s.draft.phone || null,
        dob: s.draft.dob || null,
        // Sent as the visitor said it — "United Kingdom", "UK", "india".
        // Go resolves it against crm.countries, because that is where
        // the list lives; a mapping table up here would be a second
        // copy to update the day a country is added.
        country: s.draft.country || null,
        focusArea: s.draft.focusArea,
        mode: s.draft.mode || "undecided",
        timezone: s.timezone || null,
        notes: s.draft.notes || null,
        source: s.bmiSnapshotId ? "chatbot-bmi" : "chatbot",

        /* The actual appointment. Null when the visitor described a
           time in prose that matched nothing on offer, or when the
           data service was down while they were choosing — the row
           is then a request for her to schedule by hand, which is
           what every booking was before the engine existed.

           holdExpiresAt is why this is a hold and not a reservation:
           an unanswered one stops blocking the slot at the notice
           period, so a visitor who never hears back does not keep
           an hour of her week forever. When they are going to the
           till, crmCheckoutMint shortens this to the checkout
           window — fifteen minutes, not the full notice period. */
        startAt: chosenSlot?.startAt || null,
        endAt: chosenSlot?.endAt || null,
        holdExpiresAt: chosenSlot
          ? new Date(
              Date.parse(chosenSlot.startAt) - P.minLeadHours * 3600e3
            ).toISOString()
          : null,
      })
      .catch((err) => {
        console.warn(`[bff] booking write threw: ${err.message}`);
        return null;
      });

    /* 409 means somebody took that slot between it being offered
       and this write — the database refusing a double booking,
       which is the guard working rather than a fault. */
    if (booked && !booked.ok && booked.error === "slot_taken") {
      console.warn(
        `[bff] slot taken between offer and confirm — ${res.reference} needs scheduling by hand`
      );
      slotTaken = true;
    } else if (!booked || !booked.ok) {
      /* ANY OTHER REFUSAL, AND THIS IS THE IMPORTANT ONE.

         Every way this write can fail other than slot_taken — a
         constraint, a bad country, the data service dying
         mid-request — used to fall through to nothing: no log, no
         row, no email, and a visitor who had just been told "we
         have your request". The booking would exist nowhere.

         Shouted at the log with the reference, so there is
         something to search for when somebody writes in asking why
         they never heard back. */
      console.error(
        `[bff] BOOKING NOT RECORDED — ${res.reference} for ${forEmail.email}: ` +
          `${booked?.error || "the data service did not answer"}. ` +
          `Nothing is in crm.consultations.`
      );
    } else if (chosenSlot) {
      /* THEY PICKED AN HOUR, SO THEY GO TO THE TILL.

         The hour is held from this moment and released by the
         sweeper if they wander off, so nothing is promised to them
         that is not also being kept for them. */
      const till = await checkout.start(booked.consultationId).catch(() => null);
      if (till?.ok) {
        checkoutToken = till.token;
      } else {
        console.error(
          `[bff] could not open a checkout for ${res.reference} ` +
            `(consultation ${booked.consultationId}) — they were sent no payment link.`
        );
      }
    }

    /* "WE HAVE YOUR REQUEST." Only for the visitors it is true of.

       It needs the CRM row's id — that is what ties the message to
       the booking and lets the unique index stop a second copy
       going out. It promises nothing except that the form arrived.

       DELIBERATELY NOT SENT to somebody on their way to the till.
       For them it would be false in both directions: they do not
       have a request pending her review, they have an hour held
       for fifteen minutes; and telling them she will "reply
       personally with a time" invites them to close the tab and
       wait for an email that is not coming. Their letter is the
       confirmation that follows the payment. */
    if (booked?.ok && booked.consultationId && !chosenSlot) {
      mail
        .bookingReceived({
          id: booked.consultationId,
          personId: booked.personId || null,
          ...forEmail,
        })
        .catch((err) => {
          console.warn(`[bff] booking-received email failed: ${err.message}`);
        });
    }
  }

  if (!res.ok) {
    s.state = "review"; // stay put; the card is still live
    return envelope(s, [say(res.message, "warn")], {
      review: draftView(s.draft),
      inputEnabled: false,
    });
  }

  s.state = "confirmed";
  s.booking = { reference: res.reference, id: res.id };
  const firstName = (s.draft.name || "").split(" ")[0];

  // The booking is upstream now. Everything sensitive in the session
  // has served its purpose, so it goes — the reference is all the
  // desk needs to keep talking about it.
  const view = { reference: res.reference, id: res.id };
  s.draft = session.emptyDraft();
  s.history.length = 0;

  /* ---- TWO ENDINGS, AND THEY ARE NOT THE SAME PROMISE --------

     PICKED AN HOUR  → it is held, and held is not booked. They are
                       sent to pay, and told plainly how long they
                       have. Nothing here says "confirmed", because
                       nothing is until the money verifies.

     NO HOUR YET     → unchanged, and this is what the Requests page
                       is for: somebody who wants a session and has
                       no time on the diary, waiting for her to
                       offer one. She offers; they then pay for it
                       the same way. */
  if (checkoutToken) {
    return envelope(
      s,
      [
        say(
          `${firstName ? `${firstName}, that` : "That"} time is held for you for the next ` +
            `15 minutes. Confirm it by paying below — you'll get the receipt and ` +
            `the confirmation straight away.`
        ),
      ],
      {
        booking: view,
        /* The page the button opens. Same origin, and the token is
           the only thing in it. */
        checkoutUrl: `/checkout.html?t=${encodeURIComponent(checkoutToken)}`,
        inputEnabled: true,
        chips: [],
      }
    );
  }

  if (slotTaken) {
    /* Said out loud rather than swallowed. It used to be logged and
       hidden, on the reasoning that "actually, no" is worse than a
       gap — true when the visitor had been told they were booked.
       They have not been told that here, and sending somebody to
       pay for an hour that is gone would be very much worse. */
    return envelope(
      s,
      [
        say(
          `Sorry${firstName ? `, ${firstName}` : ""} — somebody took that time while ` +
            `we were talking. Nothing has been charged. Shall I show you what else is free?`,
          "warn"
        ),
      ],
      { inputEnabled: true, chips: ["Show me other times", "Leave it with her"] }
    );
  }

  return envelope(
    s,
    [
      say(
        `Done${firstName ? `, ${firstName}` : ""} — that's with her now. She replies personally, ` +
          /* The visitor used to be told "(Dry run: no live booking
             was created.)" here — while their request sat in the CRM
             waiting for her. True when v1's endpoint was the only
             destination and nothing was stored; false since bookings
             started landing in crm.consultations, and it was the
             LAST line of the confirmation. Nothing is appended now,
             because the sentence above is already correct. */
          `usually within ${P.replyWindow}, and she'll confirm one of your times by email.`
      ),
    ],
    {
      booking: view,
      /* LEFT ON. The composer used to be switched off here, which
         read as "we are done with you" — and meant a visitor who
         needed to book for somebody else, or had one more question,
         had nowhere to put it. They booked; they did not stop being
         a person with a keyboard. */
      inputEnabled: true,
      chips: ["Book for someone else", "That's everything"],
    }
  );
}

module.exports = { start, message, action, greet, resume, envelope, draftView };
