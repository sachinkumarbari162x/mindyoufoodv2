"""Groq chat-completions client.

Talks to the REST API with urllib rather than the `groq` SDK, for
the same reason server.js has no dependencies: this ships to a
512 MB Lightsail box that already runs Postgres, a Node API and
Caddy, and one HTTPS POST does not justify a dependency tree.
Swapping in the SDK later is a change to this file alone.

GROQ IS A TESTING-STAGE CHOICE. It is here because it is fast and
cheap enough to iterate against. Nothing above this module knows
which provider is behind it — `complete()` is the whole surface —
so moving to another provider is a change to this file alone too.

No key configured is a supported state, not an error: `complete()`
returns None and the Node BFF falls through to its scripted flow.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

API_URL = os.environ.get("GROQ_API_URL", "https://api.groq.com/openai/v1/chat/completions")
API_KEY = os.environ.get("GROQ_API_KEY", "").strip()

# Instruction-following and tool-calling matter more here than raw
# reasoning: the model's job is to sound human and fill a form.
#
# THE DEFAULT IS A MODEL THAT STILL EXISTS. It was
# llama-3.3-70b-versatile, which Groq decommissioned — and a default
# is exactly the wrong place for a dead model id, because it is what
# a fresh clone gets and what this falls back to the day somebody
# clears GROQ_MODEL. The desk would then answer every visitor from
# its scripted floor while the log filled with model_not_found.
#
# openai/gpt-oss-20b is the replacement, and plan-ai/index.js has
# been reading well on it for a while — same family, already proven
# in this project on the more mechanical job.
MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")

TIMEOUT = float(os.environ.get("GROQ_TIMEOUT", "10"))
MAX_TOKENS = int(os.environ.get("GROQ_MAX_TOKENS", "900"))

# HOW HARD THE MODEL IS ALLOWED TO THINK.
#
# gpt-oss is a REASONING model, and max_tokens counts its reasoning
# and its answer together. llama-3.3 did not reason, so 600 was
# ample for the two or three sentences this service writes. On
# gpt-oss the model spent 598 of those 600 tokens thinking and was
# cut off before writing a word — measured: the CRM briefing came
# back empty four times in five, with finish_reason "length".
#
# "low" is not a downgrade for this work. Nothing here is a puzzle:
# the service words facts it has been handed and is forbidden from
# reasoning about clinical matters at all. Measured on the real
# briefing prompt: 3/3 answered on 62 reasoning tokens, against
# 0/3 on 598.
#
# Set GROQ_REASONING_EFFORT empty to stop sending it — which is
# what a model that does not accept the parameter needs.
REASONING_EFFORT = os.environ.get("GROQ_REASONING_EFFORT", "low").strip()
# Low, not zero. Zero makes a receptionist that greets forty people
# with the same sentence; high makes one that invents policy.
TEMPERATURE = float(os.environ.get("GROQ_TEMPERATURE", "0.25"))

RETRYABLE = {429, 500, 502, 503, 504}

# urllib identifies itself as "Python-urllib/3.x" by default, and the
# Cloudflare edge in front of api.groq.com rejects that signature
# outright — HTTP 403 with body "error code: 1010", which is a browser
# ban, not an auth failure. A named client string is all it wants.
# Without this the service starts healthy, reports `configured: true`,
# and then silently falls back to the scripted flow on every turn.
USER_AGENT = os.environ.get("GROQ_USER_AGENT", "mind-your-food-frontdesk/1.0")


class GroqError(RuntimeError):
    pass


def configured() -> bool:
    return bool(API_KEY)


def complete(messages: list[dict[str, Any]], tools: list[dict] | None = None,
             tool_choice: Any = None, attempts: int = 2) -> dict[str, Any] | None:
    """One chat completion. Returns the raw first choice, or None.

    None means "no usable answer" for any reason — unconfigured,
    timed out, rate limited, malformed. The caller must always have
    a path that does not need this to succeed.
    """
    if not API_KEY:
        return None

    payload: dict[str, Any] = {
        "model": MODEL,
        "messages": messages,
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
    }
    if REASONING_EFFORT:
        payload["reasoning_effort"] = REASONING_EFFORT
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"

    body = json.dumps(payload).encode("utf-8")

    # Set when a model turns out not to accept reasoning_effort, so the
    # retry below goes without it rather than failing the same way twice.
    dropped_effort = False

    for attempt in range(attempts):
        req = urllib.request.Request(
            API_URL,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                data = json.loads(res.read().decode("utf-8"))
            choices = data.get("choices") or []
            if not choices:
                return None
            return {
                "message": choices[0].get("message", {}),
                "finish_reason": choices[0].get("finish_reason"),
                "model": data.get("model", MODEL),
                "usage": data.get("usage", {}),
            }

        except urllib.error.HTTPError as err:
            # A MODEL THAT DOES NOT REASON. reasoning_effort is only
            # meaningful to some models and is rejected outright by the
            # rest, so a 400 naming it is not a fault to retry — it is
            # this client asking for something this model does not do.
            # Drop it and go again, once, so switching GROQ_MODEL back
            # to a plain model does not silently take the assistant down.
            if err.code == 400 and not dropped_effort and "reasoning_effort" in payload:
                detail = ""
                try:
                    detail = err.read().decode("utf-8")[:300]
                except Exception:
                    pass
                if "reasoning_effort" in detail:
                    print("[ai] model does not accept reasoning_effort — retrying without it",
                          flush=True)
                    payload.pop("reasoning_effort", None)
                    body = json.dumps(payload).encode("utf-8")
                    dropped_effort = True
                    continue

            if err.code in RETRYABLE and attempt + 1 < attempts:
                # Honour Retry-After when the API sends one, but never
                # sit on it — a visitor is waiting on this request.
                wait = min(float(err.headers.get("Retry-After") or 0.6), 2.0)
                time.sleep(wait)
                continue
            detail = ""
            try:
                detail = err.read().decode("utf-8")[:300]
            except Exception:
                pass
            print(f"[ai] groq HTTP {err.code}: {detail}", flush=True)
            return None

        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            if attempt + 1 < attempts:
                time.sleep(0.4)
                continue
            print(f"[ai] groq unreachable: {err}", flush=True)
            return None

    return None


def extract_tool_call(message: dict[str, Any], name: str) -> dict[str, Any] | None:
    """Pull the arguments of a named tool call out of a message."""
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        if fn.get("name") != name:
            continue
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            # A truncated tool call is the usual cause. Treat it as no
            # call rather than trying to repair half a JSON object.
            return None
        return args if isinstance(args, dict) else None
    return None
