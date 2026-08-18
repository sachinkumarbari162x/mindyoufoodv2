"""HER ASSISTANT — the model, moved to the side where it is safe.

The desk's model faces strangers, which is why it is wrapped in
guardrails on both sides and trusted with nothing. This one faces
only her. It cannot be prompt-injected by a visitor, it cannot say
the wrong thing to a client, and it never touches the booking path.

    POST /assist  {task, brief}  ->  {text, model}

THE ONE RULE THIS FILE EXISTS TO ENFORCE:

    RULES GATHER THE FACTS. THE MODEL ONLY WORDS THEM.

`brief` is assembled by the BFF from the database and passed in
whole. The model is given no tools, no database, and no way to ask
for more. It cannot look anything up, so it cannot get anything
wrong that was not already wrong in the brief — and if it invents a
number, the number is not in the brief and she can see that.

An assistant that queried her practice itself would be quicker to
write and impossible to trust: every answer would need checking
against the database, which is the work it was supposed to save.
"""

from __future__ import annotations

import groq_client
import guardrails

# Deliberately short. She is glancing at this between consultations,
# not reading a report, and a model given room will fill it.
MAX_WORDS = 90

SYSTEM = """You are the assistant to Khadija, a clinical dietitian, inside her own \
practice software. You are speaking TO HER, never to a client.

You will be given FACTS about her practice as JSON. Everything you say must come \
from those facts.

Rules:
- Never invent a number, a name, a date or a time. If the facts do not contain \
something, say you do not have it.
- Never guess at clinical matters. You schedule and summarise; you do not advise.
- Be brief. Two or three sentences. She is reading this between appointments.
- Plain sentences, no headings, no bullet points, no preamble like "Here is".
- Refer to clients by first name only.
- If there is nothing to report, say so in one short sentence rather than \
padding it out."""


def _facts_message(brief: dict) -> str:
    import json

    return "FACTS:\n" + json.dumps(brief, ensure_ascii=False, indent=1)


TASKS = {
    # What she wants at 9am: what is waiting, what is today, anything
    # slipping. The brief already holds the numbers; this only decides
    # which of them are worth saying out loud.
    "brief": (
        "Summarise her day from the facts. Lead with anything waiting on her, "
        "then today's sessions. Mention anything that looks like it is slipping. "
        "If nothing needs her, say the day is clear."
    ),
    # A message she will read before it goes anywhere. Drafted in HER
    # voice, warm and short, because she will send it as herself.
    "draft": (
        "Draft a short message to the client in the facts, in her voice: warm, "
        "direct, no filler. Do not sign it. Do not invent an appointment time — "
        "use only what is in the facts."
    ),
    # Answering a question about her own practice, from the brief only.
    "ask": (
        "Answer her question using only the facts. If the facts do not contain "
        "the answer, say exactly that and suggest where in the CRM she would find it."
    ),
}


def assist(payload: dict) -> dict:
    task = str(payload.get("task") or "brief")
    brief = payload.get("brief") or {}
    question = str(payload.get("question") or "").strip()

    if task not in TASKS:
        return {"text": "", "model": "none", "error": "unknown_task"}

    if not groq_client.configured():
        # Not an error state. The CRM shows her own numbers regardless;
        # only the sentence about them is missing.
        return {
            "text": "",
            "model": "none",
            "note": "assistant not configured",
        }

    instruction = TASKS[task]
    if task == "ask" and question:
        instruction += f"\n\nHer question: {question}"

    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"{instruction}\n\n{_facts_message(brief)}"},
    ]

    try:
        result = groq_client.complete(messages)
    except Exception as err:  # noqa: BLE001 — must never take the CRM down
        print(f"[ai] assist failed: {err}", flush=True)
        return {"text": "", "model": "none", "note": "unavailable"}

    if not result:
        return {"text": "", "model": "none", "note": "unavailable"}

    text = ((result.get("message") or {}).get("content") or "").strip()

    # Screened on the way out, like everything else the model writes.
    # She is not a stranger, but a draft she might FORWARD to a client
    # is a message to a stranger — and a clinical claim or a quoted fee
    # is exactly as wrong in her outbox as in the chat window.
    # SHE IS NOT A STRANGER, and for two of these three tasks nothing
    # she reads ever leaves her screen. A "draft" does — it is written
    # to be forwarded to a client — so that one keeps the full front
    # desk screening, including the rule about naming a condition.
    audience = "visitor" if task == "draft" else "practitioner"
    ok, replacement, reason = guardrails.check_reply(text, audience=audience)
    if not ok:
        print(f"[ai] assist reply replaced: {reason}", flush=True)
        return {"text": "", "model": result.get("model", "none"), "note": reason}

    return {
        "text": _trim(text),
        "model": result.get("model", "none"),
    }


def _trim(text: str) -> str:
    """Cut at a sentence boundary if the model ran long."""
    words = text.split()
    if len(words) <= MAX_WORDS:
        return text
    cut = " ".join(words[:MAX_WORDS])
    stop = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return cut[: stop + 1].strip() if stop > 40 else cut.strip()
