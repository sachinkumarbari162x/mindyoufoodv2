"""Second-line guardrails on the model's output.

The Node BFF screens both directions too (services/node-bff/rules/
safety.js) and its verdict is the one that reaches the visitor.
This layer exists because it is closer to the model: it sees the
raw completion before any of it is shaped into a turn, so it can
drop a bad reply rather than pass it along to be caught later, and
it keeps this service honest if it is ever called by something
other than the BFF.

Two independent checks, not one shared module, is the point. A
single regex list with a bug is a single point of failure; two
lists written against the same rules from different sides is a
cheap approximation of defence in depth.
"""

from __future__ import annotations

import re

# Clinical overreach — the model asserting something only the
# practitioner may, with the patient's history in front of her.
CLINICAL = [
    re.compile(r"\byou (probably |likely |may |might |could )?have\b.{0,40}"
               r"\b(pcos|diabetes|ibs|thyroid|deficiency|insulin resistance|celiac)\b", re.I),
    re.compile(r"\b(i(t)? (would|'d) )?(recommend|suggest) (you )?(take|start|stop)\b.{0,30}"
               r"\b(supplement|medication|metformin|insulin|vitamin|tablet)", re.I),
    re.compile(r"\btake \d+\s?(mg|mcg|g|iu|ml)\b", re.I),
    re.compile(r"\byour (results?|labs?|reports?) (show|indicate|suggest|mean)\b", re.I),
    re.compile(r"\b(eat|consume|aim for) \d{3,4}\s?(kcal|calories)\b", re.I),
    re.compile(r"\b\d{2,3}\s?g (of )?(protein|carbs?|fat) (a|per) day\b", re.I),
]

# Commitments the desk cannot make on the practitioner's behalf.
OVERPROMISE = [
    re.compile(r"\b(your|the) (appointment|consultation|slot|booking) is (now )?(confirmed|booked|scheduled)\b", re.I),
    re.compile(r"\bi('ve| have) (booked|scheduled|confirmed)\b", re.I),
    re.compile(r"\b(guarantee|guaranteed|promise)\b.{0,30}\b(results?|weight|loss|cure)", re.I),
    re.compile(r"\byou (will|'ll) lose \d+", re.I),
    re.compile(r"\bcure[sd]?\b.{0,20}\b(pcos|diabetes|ibs)\b", re.I),
]

# Any concrete money figure. Fees are hers to quote.
PRICE = re.compile(r"(₹|rs\.?|inr|\$|usd|aed|£|€)\s?\d{2,}|\b\d{3,5}\s?(rupees|per session)\b", re.I)

# The model leaking its own scaffolding into the conversation.
LEAKAGE = [
    re.compile(r"\b(system prompt|my instructions|as an ai|language model|i am an ai)\b", re.I),
    re.compile(r"\b(tool call|function call|json|schema|api)\b.{0,20}\b(respond|field)", re.I),
    re.compile(r"^\s*[\{\[]"),  # a reply that is actually raw JSON
]

FALLBACK = (
    "That one needs the practitioner rather than me — she'll have your history in front of her. "
    "Shall I take your details and get you in front of her?"
)

PRICE_FALLBACK = (
    "Fees depend on which programme suits you, so she sets them out herself rather than my quoting "
    "a number that turns out to be wrong. Shall I take your details so she can?"
)

BOOKING_FALLBACK = (
    "To be exact about it: I'm taking a request, not confirming a slot. She picks one of your times "
    "and confirms it with you by email herself."
)


# Framing that marks a sentence as REPEATING the visitor rather than
# asserting anything. "You have PCOS" from the desk is a diagnosis;
# "you'd like to work on PCOS" is a receptionist listening. Without
# this distinction the clinical rule fired on ordinary acknowledgement
# and replaced the reply mid-booking, which stalled the conversation
# and lost the field the desk had just collected.
ACKNOWLEDGEMENT = re.compile(
    r"\b(you (mentioned|said|told me|noted)|you'?d like to|you are looking to|"
    r"you'?re looking to|you want(ed)? to|to work on|you'?ve asked)\b",
    re.I,
)


# Conditions the "you have X" rule guards, named separately so the
# echo test can ask a precise question: did the VISITOR raise this
# condition themselves?
CONDITIONS = re.compile(
    r"\b(pcos|diabetes|ibs|thyroid|deficiency|insulin resistance|celiac)\b", re.I
)


# Words that turn "you have <condition>" from a note about her diary
# into advice. "You have one waiting for diabetes care" is
# scheduling; "you have diabetes and should start metformin" is not,
# and the difference is these.
ADVICE = re.compile(
    r"\b(should|must|need to|ought to|start|stop|begin|increase|reduce|"
    r"switch to|put (her|him|them) on|prescrib\w*)\b",
    re.I,
)


def _is_echo(reply: str, user_said: str) -> bool:
    """True when the reply only names conditions the visitor named first.

    "You have PCOS" asserted by the desk is a diagnosis. The same words
    right after the visitor writes "I have PCOS" are a receptionist
    repeating what she was told — and blocking that broke real
    bookings: the deflection replaced the reply, the extracted fields
    were discarded with it, and the desk never collected a focus area.

    Only the "you have <condition>" pattern is eligible. Dosage, lab
    interpretation and calorie targets stay forbidden no matter how the
    conversation arrived at them.
    """
    if not user_said:
        return False
    theirs = {m.group(0).lower() for m in CONDITIONS.finditer(user_said)}
    ours = {m.group(0).lower() for m in CONDITIONS.finditer(reply)}
    return bool(ours) and ours.issubset(theirs)


def check_reply(text: str, user_said: str = "", audience: str = "visitor") -> tuple[bool, str, str]:
    """Screen an outbound reply.

    Returns (ok, replacement, reason). When ok is False the caller
    must send `replacement` INSTEAD of the model's text — never a
    merge of the two, because a half-redacted clinical claim reads
    as a confirmed one.

    `user_said` is the visitor's message this turn, used only to tell
    an echo from an assertion. It relaxes nothing else.

    `audience` is who the text is going to.

      "visitor"      a stranger at the front desk. Everything below
                     applies. This is the default, so a caller that
                     forgets to say gets the strict reading.

      "practitioner" Khadija, reading her own practice software.

    The one rule that changes is "you have <condition>". At the front
    desk that sentence is a diagnosis handed to somebody who did not
    ask for one. In her assistant it is the ordinary way to say what
    is in her diary — "you have one waiting for diabetes care" — and
    the rule fired on it, blanking her morning briefing three times
    in five because a client's focus area happened to be Diabetes.

    Nothing else is relaxed. Dosages, lab readings, calorie targets
    and macro targets stay forbidden for both, because a model
    inventing those is a model malfunctioning whoever is reading.
    """
    t = (text or "").strip()

    if not t:
        return False, FALLBACK, "empty"

    if any(p.search(t) for p in LEAKAGE):
        return False, FALLBACK, "leakage"

    hit = next((i for i, p in enumerate(CLINICAL) if p.search(t)), None)
    if hit is not None:
        # CLINICAL[0] is "you have <condition>" — the only one of these
        # that can legitimately be an echo of the visitor, and the only
        # one that means something harmless when she is the reader.
        # For her, "you have <condition>" is how her own diary reads —
        # unless the sentence also tells somebody to DO something
        # about it, at which point it is advice again and blocked.
        # Relaxing this without that test let "You have diabetes and
        # should start metformin" through, which is not a sentence
        # this software may produce for anybody.
        her_diary = audience == "practitioner" and not ADVICE.search(t)

        echoed = hit == 0 and (
            ACKNOWLEDGEMENT.search(t)
            or _is_echo(t, user_said)
            or her_diary
        )
        if not echoed:
            return False, FALLBACK, "clinical"

    if any(p.search(t) for p in OVERPROMISE):
        return False, BOOKING_FALLBACK, "overpromise"

    if PRICE.search(t):
        return False, PRICE_FALLBACK, "price"

    return True, t, "ok"


# Length. A receptionist who writes six paragraphs is not a
# receptionist. Trimmed at a sentence boundary so it never ends
# mid-word.
MAX_CHARS = 700


def trim(text: str) -> str:
    if len(text) <= MAX_CHARS:
        return text
    cut = text[:MAX_CHARS]
    stop = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("\n"))
    return (cut[: stop + 1] if stop > 200 else cut).strip()


def clean_chips(chips, limit: int = 3) -> list[str]:
    """Quick replies must be short, distinct, and free of punctuation
    that makes them read as sentences rather than buttons."""
    out: list[str] = []
    for chip in chips or []:
        if not isinstance(chip, str):
            continue
        c = re.sub(r"\s+", " ", chip).strip().strip(".!")
        if not c or len(c) > 42:
            continue
        if c.lower() in {o.lower() for o in out}:
            continue
        out.append(c)
        if len(out) >= limit:
            break
    return out
