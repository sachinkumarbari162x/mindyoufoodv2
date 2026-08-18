"""AI service — the receptionist's voice.

    POST /turn     one conversational turn
    GET  /health   liveness + whether a key is configured

Stdlib only, on purpose. The rest of this project runs dependency
-free (server.js, services/node-bff), it deploys to a small shared
box, and this service is two endpoints — FastAPI would be more
machinery than the thing it wraps. `handle_turn()` is a plain
function, so putting it behind FastAPI later is an import away.

Bound to 127.0.0.1: nothing but the Node BFF may reach it. It has
no rate limiting and no auth of its own because it is not supposed
to be reachable from outside the box.

    python app.py            # -> 127.0.0.1:5503
    AI_PORT=6000 python app.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import assistant
import groq_client
import guardrails
import prompts

PORT = int(os.environ.get("AI_PORT", "5503"))
MAX_BODY = 64 * 1024

# Field values the model may propose. Anything else is dropped here
# AND in the BFF's sanitiser — the BFF is the authority, this is the
# early filter that keeps junk out of the logs.
ALLOWED_FIELDS = {
    "name", "email", "phone", "focusArea",
    "country", "mode", "notes", "suggestedSlots",
}

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean_fields(raw) -> dict:
    """Shape and bound whatever the tool call proposed.

    Nothing here decides whether a value is *acceptable* — that is
    the BFF's validators. This only guarantees the BFF receives
    something of the right type and size to validate.
    """
    if not isinstance(raw, dict):
        return {}

    out: dict = {}
    for key, value in raw.items():
        if key not in ALLOWED_FIELDS or value in (None, "", [], {}):
            continue

        if key == "suggestedSlots":
            if not isinstance(value, list):
                continue
            slots = []
            for item in value[:3]:
                if not isinstance(item, dict):
                    continue
                slot = {}
                date = item.get("date")
                if isinstance(date, str) and ISO_DATE.match(date.strip()):
                    slot["date"] = date.strip()
                for field in ("time", "label"):
                    val = item.get(field)
                    if isinstance(val, str) and val.strip():
                        slot[field] = val.strip()[:80]
                if slot:
                    slots.append(slot)
            if slots:
                out[key] = slots
            continue

        if not isinstance(value, str):
            continue
        text = re.sub(r"\s+", " ", value).strip()
        if text:
            out[key] = text[:2000]

    return out


def _messages(payload: dict) -> list[dict]:
    system = prompts.build_system(
        context=payload.get("context") or {},
        draft=payload.get("draft") or {},
        missing=payload.get("missing") or [],
        awaiting=payload.get("awaiting"),
        ask_for=payload.get("askFor"),
    )

    msgs = [{"role": "system", "content": system}]
    for turn in (payload.get("history") or [])[-12:]:
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            msgs.append({"role": role, "content": content[:1200]})
    return msgs


def handle_turn(payload: dict) -> dict:
    """One turn. Never raises — a failure here must degrade to the
    BFF's scripted flow, not take the front desk down."""
    started = time.time()

    if not groq_client.configured():
        # Not an error state. The BFF reads an empty reply as "no
        # model available" and runs its own scripted questions.
        return {
            "reply": "",
            "fields": {},
            "intent": "unconfigured",
            "chips": [],
            "model": "none",
            "note": "GROQ_API_KEY not set",
        }

    try:
        result = groq_client.complete(
            _messages(payload),
            tools=[prompts.TURN_TOOL],
            tool_choice={"type": "function", "function": {"name": "respond"}},
        )
    except Exception as err:  # noqa: BLE001 — this must not propagate
        print(f"[ai] completion failed: {err}", flush=True)
        result = None

    if not result:
        return {"reply": "", "fields": {}, "intent": "unavailable", "chips": [], "model": "none"}

    message = result.get("message") or {}
    args = groq_client.extract_tool_call(message, "respond")

    # A model that answered in prose instead of calling the tool still
    # said something usable; take the content and extract nothing.
    if args is None:
        content = (message.get("content") or "").strip()
        args = {"reply": content, "intent": "other", "fields": {}, "chips": []}

    # The visitor's own last message, so the screen can tell an echo of
    # their words from an assertion of the desk's own.
    last_user = next(
        (m.get("content", "") for m in reversed(payload.get("history") or [])
         if m.get("role") == "user"),
        "",
    )

    ok, reply, reason = guardrails.check_reply(args.get("reply", ""), last_user)
    if not ok:
        print(f"[ai] guardrail tripped: {reason}", flush=True)

    # Fields survive a tripped guardrail. Only the WORDING was unsafe —
    # the email and the dates the model pulled out are unaffected, and
    # they still have to pass the BFF's validators regardless. Dropping
    # them meant one clumsy sentence silently erased a field the
    # visitor had already given, and the desk asked for it again.
    return {
        "reply": guardrails.trim(reply),
        "fields": _clean_fields(args.get("fields")),
        "intent": str(args.get("intent") or "other")[:40],
        "chips": guardrails.clean_chips(args.get("chips")) if ok else [],
        "model": result.get("model", groq_client.MODEL),
        "guardrail": None if ok else reason,
        "latencyMs": int((time.time() - started) * 1000),
        "usage": result.get("usage", {}),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "myf-ai/1.0"
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {
                "ok": True,
                "service": "py-ai",
                "configured": groq_client.configured(),
                "model": groq_client.MODEL if groq_client.configured() else None,
            })
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.rstrip("/")
        if route not in ("/turn", "/assist"):
            self._send(404, {"error": "not_found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._send(413, {"error": "payload_too_large"})
            return

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, ValueError):
            self._send(400, {"error": "malformed_json"})
            return

        if not isinstance(payload, dict):
            self._send(400, {"error": "expected_object"})
            return

        try:
            if route == "/assist":
                # Her assistant. Separate handler because it faces HER,
                # not a visitor: no field extraction, no chips, no
                # booking state — just facts in, a sentence out.
                self._send(200, assistant.assist(payload))
            else:
                self._send(200, handle_turn(payload))
        except Exception as err:  # noqa: BLE001
            print(f"[ai] unhandled: {err}", flush=True)
            if route == "/assist":
                # The CRM shows her own numbers regardless; only the
                # sentence about them is missing.
                self._send(200, {"text": "", "model": "none", "note": "error"})
            else:
                self._send(200, {"reply": "", "fields": {}, "intent": "error", "chips": []})

    def log_message(self, fmt: str, *args) -> None:
        # The default logger writes the request line to stderr, which
        # here would mean transcript fragments in the journal. Method
        # and status only.
        sys.stderr.write(f"[ai] {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    state = f"groq:{groq_client.MODEL}" if groq_client.configured() else "NO KEY (scripted fallback)"
    print(f"[ai] receptionist voice on http://127.0.0.1:{PORT} — {state}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[ai] stopped", flush=True)
        srv.server_close()


if __name__ == "__main__":
    main()
