/* ============================================================
   SAFETY — checking a written draft against the record it came from
   ------------------------------------------------------------
   THE ONE PLACE IN THIS SYSTEM WHERE THE MODEL WRITES CLINICAL
   ADVICE RATHER THAN READING IT BACK, and this file exists because
   of that.

   Everywhere else, plan-ai proposes rows from sentences Khadija
   already wrote — so the worst it can do is misread her. Writing a
   first draft from an assessment is different in kind: the words
   are the model's, and the failure that matters is not a clumsy
   sentence. It is a plan that puts peanuts in the mid-morning snack
   of somebody whose record says anaphylaxis.

   THE PROMPT IS TOLD ABOUT THE ALLERGIES. That is necessary and it
   is not sufficient — a prompt is a request, and this is a class of
   mistake that must not depend on one being honoured. So every
   generated row is checked here, deterministically, against what
   the record actually says, and anything that collides is FLAGGED
   RATHER THAN DELETED.

   WHY FLAGGED AND NOT DELETED. Silently dropping a row would leave
   her reading a plan with a hole in it and no idea there had been
   one. She is the clinician; the machine's job is to put the
   collision in front of her in words, on the row itself, before she
   has agreed to anything. A deleted row teaches her nothing. A
   flagged one teaches her that the assistant cannot be trusted with
   this client's allergies — which is the correct lesson.

   NOTHING HERE IS A SUBSTITUTE FOR HER READING IT. This catches the
   obvious collision between a named food and a named allergy. It
   does not know that ghee is dairy in every kitchen in the country,
   and it never will. It is a seatbelt, not a driver.
   ============================================================ */
"use strict";

/* THE ALLERGY FIELD IS A NARRATIVE, NOT A LIST, and that is what
   this file got wrong first time round.

   The form asks for the reaction as well as the name — "with the
   reaction, not just the name", says the hint — so a real entry
   reads:

     Cow's milk — bloating, cramps and loose stool within an hour.
     Not anaphylactic. Tolerates small amounts of curd.

   Treating every word of that as a food banned "small" and "hour",
   and then flagged the sleep row for containing the word hours. Five
   warnings on a ten-row plan, three of them nonsense. A check that
   cries wolf is worse than no check: she reads the first two, learns
   they are noise, and stops reading the one that matters.

   So the vocabulary below is everything a clinician writes AROUND
   the allergen — symptoms, severities, timings, hedges — and none of
   it is ever treated as a food. */
const NOISE = new Set([
  // nothing recorded
  "none", "nil", "no", "nothing", "n/a", "na", "unknown", "not known",
  "denies", "nkda", "none known", "no known", "-", "—", "not applicable",
  // the label of the field itself
  "allergy", "allergies", "intolerance", "intolerant", "intolerances",
  "food", "foods", "avoid", "avoids", "avoiding", "reaction", "reacts",
  // grammar
  "and", "or", "with", "the", "a", "an", "to", "of", "any", "all", "but",
  "some", "small", "large", "amount", "amounts", "trace", "traces", "only",
  "when", "after", "before", "since", "also", "very", "quite", "bit",
  // how bad
  "mild", "moderate", "severe", "slight", "occasional", "occasionally",
  "anaphylaxis", "anaphylactic", "epipen", "adrenaline",
  // what it does — the half that caused the false positives
  "bloating", "bloated", "cramps", "cramping", "pain", "stool", "stools",
  "loose", "diarrhoea", "diarrhea", "constipation", "nausea", "vomiting",
  "reflux", "wind", "gas", "rash", "rashes", "hives", "urticaria", "itch",
  "itching", "swelling", "wheeze", "wheezing", "headache", "migraine",
  "discomfort", "upset", "sick", "unwell", "flare",
  // when it does it
  "hour", "hours", "minute", "minutes", "day", "days", "week", "weeks",
  "immediately", "straight", "within", "later", "afterwards", "night",
  "morning", "evening",
  /* ADJECTIVES ARE NOT FOODS. "black" out of "uses black tea now"
     is five characters long and passed the length test, so every
     row mentioning black tea was flagged. None of these ever names
     the thing somebody is allergic to on its own. */
  "black", "white", "green", "brown", "red", "fresh", "plain", "raw",
  "cooked", "fried", "boiled", "roasted", "low", "high", "full", "half",
  "whole", "skimmed", "fat", "free", "added", "extra", "little", "more",
  "less", "much", "many", "good", "bad", "better", "worse", "same",
]);

/* Clauses that say the OPPOSITE of a ban. "Tolerates small amounts of
   curd" appearing in an allergy field is her telling us curd is
   allowed, and reading it as a ban is reading the record backwards.

   Split off before anything else, and whatever food they name is
   removed from the banned set rather than added to it. */
const ALLOWS = new RegExp(
  "\\b(" +
  /* Said outright. */
  "tolerat\\w*|can have|is fine with|are fine|ok with|okay with|fine with|" +
  "no (?:issue|problem|reaction)s? with|apart from|except|" +
  /* AND SAID BY NAMING THE SUBSTITUTE, which is how a dietitian
     actually writes it. Her avoiding field reads "Milk in tea since
     the bloating started. Uses black tea now." — the first sentence
     is the ban and the second is what she does instead. Reading the
     second as a ban banned the word "black", and the assistant was
     then told off for writing "limit black tea to 5-6 cups", which
     is the client's own current habit and Khadija's own advice. */
  "uses|using|switched|swapped|moved to|changed to|drinks|takes|has instead|instead of" +
  ")\\b", "i"
);

/* Sentence, semicolon, or a full stop — the units a clinician
   actually writes in. Kept separate from the comma-level split
   below, because "milk, eggs" is a list and "Not anaphylactic.
   Tolerates curd." is two statements. */
const CLAUSES = /(?:\.\s+|\.$|;|\n)/;

/* Anything shorter than this is a fragment rather than a food, and
   matching on it produces noise: "egg" is worth matching, "so" is
   not. Four also keeps "nut" out, which is deliberate — see below. */
const MIN = 4;

/* A handful of foods whose plural or family form is what actually
   appears in a plan. Kept short and obvious on purpose: this is a
   lookup for the commonest collisions, not an ontology, and a long
   invented one would be a false sense of coverage.

   Every entry is a term a dietitian would recognise, and each maps
   to the words that would show up in an Indian or British meal plan
   for this practice. */
/* ONE DAIRY LIST, USED TWICE. It was written out twice — once here
   and once in the vegan pattern rule — and the two had already
   drifted: malai and chaas were in one and not the other, so an
   allergy to milk missed a row that a vegan pattern would have
   caught. Two lists for one fact is one list that stops being
   maintained. */
const DAIRY = [
  "milk", "curd", "dahi", "yoghurt", "yogurt", "paneer", "cheese",
  "butter", "ghee", "cream", "malai", "khoya", "lassi", "buttermilk",
  "chaas", "dairy",
];

const FAMILIES = {
  milk: DAIRY,
  dairy: DAIRY,
  lactose: DAIRY,
  peanut: ["peanut", "peanuts", "groundnut", "groundnuts", "moongphali"],
  nuts: ["almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pistachio", "pistachios", "peanut", "peanuts", "groundnut", "hazelnut"],
  treenut: ["almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pistachio", "pistachios", "hazelnut"],
  gluten: ["wheat", "chapati", "chapatis", "roti", "rotis", "bread", "atta", "maida", "suji", "rava", "pasta", "noodles", "barley", "seitan", "paratha", "naan", "poori"],
  wheat: ["wheat", "chapati", "chapatis", "roti", "rotis", "bread", "atta", "maida", "suji", "rava", "paratha", "naan", "poori"],
  egg: ["egg", "eggs", "omelette", "omelet", "anda"],
  soy: ["soy", "soya", "tofu", "edamame", "soybean"],
  shellfish: ["prawn", "prawns", "shrimp", "crab", "lobster", "shellfish"],
  fish: ["fish", "salmon", "tuna", "mackerel", "sardine", "sardines"],
  sesame: ["sesame", "til", "tahini"],
  mustard: ["mustard", "sarson", "rai"],
};

/** Split what she typed into terms worth matching on.
 *
 *  EACH ONE REMEMBERS WHAT IT CAME FROM. The widening below turns
 *  "cow's milk" into buttermilk, paneer and ghee — which is the half
 *  that catches the real cases — but a warning reading "the record
 *  says buttermilk" about a record that says no such thing would send
 *  her hunting through the assessment for a word that is not in it.
 *  So a match reports the food it found AND the entry that banned it.
 *
 *  @returns {{term: string, from: string}[]}
 */
function terms(text) {
  const said = String(text || "").toLowerCase();
  if (!said.trim()) return [];

  /* STATEMENTS FIRST, LISTS SECOND. "Not anaphylactic. Tolerates
     curd." is two statements; "milk, eggs" is one list. Splitting
     them at the same level is what let a tolerance be read as a ban. */
  const bans = [];
  const allows = [];
  for (const clause of said.split(CLAUSES)) {
    if (!clause.trim()) continue;
    (ALLOWS.test(clause) ? allows : bans).push(clause);
  }

  /* term -> the recorded phrase it came from. A Map rather than a Set
     so the first entry to claim a term keeps it: "milk" recorded
     plainly should be reported as "milk", not as whatever family
     rule happened to reach it later. */
  const found = new Map();
  const add = (term, from) => { if (!found.has(term)) found.set(term, from); };

  /* Everything a person uses to separate a list, including mid-
     sentence. The em-dash matters: "Cow's milk — bloating" is the
     house style for allergen-then-reaction, and the reaction half is
     then dropped word by word against NOISE. */
  const listy = (s) => s.split(/[,/()·—–-]+|\band\b|\bor\b|\bplus\b|\bthen\b/);

  const collect = (clauses) => {
    const out = [];
    for (const clause of clauses) {
      for (const raw of listy(clause)) {
        const phrase = raw.trim().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
        if (!phrase || NOISE.has(phrase)) continue;

        /* The phrase itself, and each substantial word in it — "cow's
           milk protein" should match a plan that says milk. Words in
           NOISE are skipped at both levels, so a phrase that is
           entirely symptom vocabulary contributes nothing. */
        const words = phrase.split(/\s+/).filter((w) => w.length >= MIN && !NOISE.has(w));
        if (!words.length) continue;

        if (phrase.length >= MIN && !NOISE.has(phrase)) out.push([phrase, phrase]);
        for (const w of words) out.push([w, phrase]);
      }
    }
    return out;
  };

  /* Widen to the family — the half that catches the real cases. A
     record saying "lactose intolerant" and a plan saying "a glass of
     buttermilk at 4pm" share no word at all. */
  const widen = (pairs, sink) => {
    for (const [t, origin] of pairs) {
      sink(t, origin);
      for (const [family, foods] of Object.entries(FAMILIES)) {
        if (t === family || t.startsWith(family) || family.startsWith(t)) {
          for (const f of foods) sink(f, origin);
        }
      }
    }
  };

  widen(collect(bans), add);

  /* AND THEN WHAT SHE SAID IS FINE COMES BACK OUT. Only the exact
     foods named as tolerated, not their whole family: "tolerates
     small amounts of curd" permits curd and says nothing at all
     about paneer. */
  const allowed = collect(allows).map(([t]) => t);
  for (const t of allowed) found.delete(t);

  const out = [...found].map(([term, from]) => ({ term, from }));
  /* Carried on the list so the caller can apply it to the OTHER
     fields too. Without this, "tolerates curd" un-banned curd as an
     allergen and the dislikes check — widened from "milk in tea" to
     the whole dairy family — promptly banned it again. A tolerance
     recorded anywhere is a tolerance everywhere. */
  out.allowed = allowed;
  return out;
}

/** Whole-word, so "milk" does not match "milkweed" and — the one
    that actually bit — "oat" does not match "goat".

    SINGULAR AND PLURAL BOTH WAYS. The trailing `s` was optional on
    the text only, so a record saying "oats" missed a plan saying
    "oat porridge". The needle is stemmed of its own `s` and the
    optional one put back, which covers egg/eggs and oats/oat alike. */
const mentions = (haystack, needle) => {
  const stem = String(needle).replace(/s$/, "");
  if (stem.length < 3) return false;
  const safe = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${safe}s?(?![\\p{L}\\p{N}])`, "iu").test(haystack);
};

/* THE SUBSTITUTE IS NOT THE ALLERGEN, and flagging it is the fastest
   way to make this check worthless.

   A plan written for a milk allergy quite properly says "a protein
   shake with plant milk" or "porridge made with almond milk" — the
   word "milk" is right there, and it is there precisely BECAUSE the
   allergy was honoured. Warning her about it teaches her that milk
   warnings are noise, and the next one she waves through will be
   paneer.

   Only the qualified forms, and only for the dairy family: an
   allergy to almonds still catches almond milk, because that match
   comes from "almond" rather than from "milk". */
const NOT_DAIRY = /\b(plant|almond|soy|soya|oat|rice|coconut|cashew|hemp|non[\s-]?dairy|dairy[\s-]?free|lactose[\s-]?free|vegan)[\s-]+milks?\b/i;

const DAIRY_WORDS = new Set(["milk", "dairy", "lactose"]);

/** Is this hit only the word "milk" inside "almond milk"? */
const substituted = (text, term) => DAIRY_WORDS.has(term) && NOT_DAIRY.test(text);

/**
 * Check written rows against what the record says to avoid.
 *
 * Returns the same rows, with `warn` set on any that collide. The
 * caller decides what to do with them; nothing is removed here.
 *
 * @param {object[]} items    rows the model wrote
 * @param {object} avoid      { allergies, conditions, dislikes, pattern }
 * @returns {{items: object[], flagged: number, why: string[]}}
 */
function check(items, avoid = {}) {
  const bannedAll = terms(avoid.allergies);

  /* Dislikes and "currently avoiding" are checked too, and kept
     separate in the wording. Being given food you hate is not a
     safety incident — it is a plan you will not follow, which is a
     different failure and deserves a different sentence.

     Joined with a full stop, not a comma: these are two fields and
     a tolerance written in one must not be read as part of a list
     in the other. */
  const dislikedAll = terms([avoid.dislikes, avoid.avoiding].filter(Boolean).join(". "));

  /* A TOLERANCE RECORDED ANYWHERE IS A TOLERANCE EVERYWHERE. "Uses
     black tea now" in the avoiding field widened to the whole dairy
     family and re-banned the curd that the allergy field had
     explicitly permitted. */
  const permitted = new Set([...(bannedAll.allowed || []), ...(dislikedAll.allowed || [])]);
  const banned = bannedAll.filter((t) => !permitted.has(t.term));
  const disliked = dislikedAll.filter((t) => !permitted.has(t.term));

  /* A dietary pattern is a rule about the whole plan rather than a
     list of words, so it gets its own small table. */
  /* THE LOCAL NAME IS THE ONE THAT APPEARS IN THE PLAN. "Aloo
     paratha" contains no potato, and a Jain rule that only knows
     the English word passes it — which is how the first version of
     this table let a root vegetable through. Every list carries both
     the word a textbook uses and the word a kitchen uses. */
  const MEAT = [
    "chicken", "mutton", "lamb", "beef", "pork", "bacon", "ham", "meat",
    "keema", "kheema", "murgh", "gosht",
  ];
  const SEA = ["fish", "prawn", "prawns", "shrimp", "crab", "salmon", "tuna", "machli", "macher"];
  const EGG = ["egg", "eggs", "omelette", "omelet", "anda"];
  const ROOTS = [
    "onion", "onions", "pyaz", "pyaaz", "kanda",
    "garlic", "lehsun", "lasun",
    "potato", "potatoes", "aloo", "alu",
    "radish", "mooli", "carrot", "gajar", "beetroot", "beet",
    "ginger", "adrak", "turmeric root", "yam", "suran",
  ];

  const patternBans = {
    vegetarian: [...MEAT, ...SEA, ...EGG],
    vegan: [...MEAT, ...SEA, ...EGG, ...DAIRY, "honey", "shahad"],
    eggetarian: [...MEAT, ...SEA],
    jain: [...MEAT, ...SEA, ...EGG, ...ROOTS],
    pescatarian: [...MEAT],
  };
  const pattern = String(avoid.pattern || "").trim().toLowerCase();
  const byPattern = patternBans[pattern] || [];

  const why = [];
  let flagged = 0;

  /* "buttermilk (recorded as cow's milk)" when the two differ, and
     just "milk" when they do not — repeating the same word twice in
     one sentence reads as a bug. */
  const named = (hit) =>
    hit.term === hit.from ? hit.term : `${hit.term}, recorded as “${hit.from}”`;

  const out = items.map((it) => {
    const text = `${it.label || ""} ${it.unit || ""} ${it.schedule || ""}`;

    /* ALLERGIES FIRST, and only one warning per row. A row that
       breaks three rules is a row she is going to delete; ranking
       them by how much they matter puts the reason that would make
       her delete it fastest in front of her. */
    const hitAllergy = banned.find((t) => mentions(text, t.term) && !substituted(text, t.term));
    if (hitAllergy) {
      flagged++;
      why.push(`“${it.label}” — the record lists an allergy or intolerance to ${named(hitAllergy)}`);
      return { ...it, warn: `Allergy: the record says ${named(hitAllergy)}` };
    }

    const hitPattern = byPattern.find((t) => mentions(text, t));
    if (hitPattern) {
      flagged++;
      why.push(`“${it.label}” — ${hitPattern} in a ${pattern} plan`);
      return { ...it, warn: `${hitPattern} in a ${pattern} plan` };
    }

    const hitDislike = disliked.find((t) => mentions(text, t.term));
    if (hitDislike) {
      flagged++;
      why.push(`“${it.label}” — the record says they avoid or dislike ${named(hitDislike)}`);
      return { ...it, warn: `They avoid ${named(hitDislike)}` };
    }

    return it;
  });

  return { items: out, flagged, why };
}

module.exports = { check, terms, FAMILIES };
