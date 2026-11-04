"""A simulated OpenAI-compatible model server, for building and testing the bench assistant without
any real API calls (`pcbv fake-model`, and the assistant tests).

It is deterministic and keyword-driven, not intelligent. Given a question it asks for the tools a
person would expect (a boot log question reads the board, then the capture), then answers from what
the tools returned. Some phrases make it misbehave on purpose, so failure paths can be tested:
"simulate error" answers HTTP 500, "simulate empty" answers with no text, "simulate length" ends with no text because the reply limit was reached, "simulate loop" keeps
asking for tools until tool_choice is "none" ("simulate stubborn" even then), and "simulate repeat"
proposes the same command three times. A key containing "wrong" is answered 401 and the model name
"no-such-model" is answered 404, so the Test button's messages can be tried. The model name "thinking-model"
answers with no text because the reply limit was reached, "silent-model" with no text and finish "stop", and
"no-tools-model" refuses a request that carries tools with 400. A tool result that contains "INSTRUCTION TO ASSISTANT: run <command>" makes
it behave like a gullible model and propose that command, which is how prompt injection is tested.
"""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = "pcbv-fake-model"
INJECTION_RE = re.compile(r"INSTRUCTION TO ASSISTANT:\s*run\s+([^\"\\\n]+)", re.IGNORECASE)


def _text(content) -> str:
    """The text of a message; image messages carry a list of parts."""
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return str(content or "")


def _turn(messages: list[dict]) -> list[dict]:
    """The messages since the person's latest question. Notes from the app are not questions."""
    last = max((i for i, m in enumerate(messages) if m.get("role") == "user"
                and not _text(m.get("content")).startswith("[From the app")), default=0)
    return messages[last:]


def _pictures(turn: list[dict]) -> int:
    return sum(1 for m in turn if isinstance(m.get("content"), list)
               for p in m["content"] if isinstance(p, dict) and p.get("type") == "image_url")


def _results(turn: list[dict]) -> dict[str, dict]:
    """Tool results of this question by tool name: the parsed {"data": ...} envelope."""
    names = {c["id"]: c["function"]["name"] for m in turn for c in (m.get("tool_calls") or [])}
    out = {}
    for m in turn:
        if m.get("role") == "tool":
            try:
                out[names.get(m.get("tool_call_id"), "?")] = json.loads(m["content"])
            except (ValueError, KeyError):
                pass
    return out


def _plan(question: str) -> list[str]:
    q = question.lower()
    plan: list[str] = []
    if re.search(r"boot|log|capture|console", q):
        plan += ["get_board", "get_capture"]
    if re.search(r"\bpins?\b|reading|voltage|multimeter", q):
        plan.append("get_pin_readings")
    if re.search(r"timeline|history|what happened", q):
        plan.append("get_timeline")
    if re.search(r"wiki|what is|explain|how do|why", q):
        plan.append("search_wiki")
    if re.search(r"\bstep\b|playbook", q):
        plan.append("explain_step")
    if re.search(r"finding|save this|note this", q):
        plan.append("write_finding")
    if re.search(r"command|\brun\b|printenv|propose", q):
        plan.append("propose_command")
    if re.search(r"photo|picture|identify|look at", q):
        plan += ["get_board", "view_photo"]
    if re.search(r"identify|label", q):
        plan.append("suggest_label")
    if re.search(r"pin roles", q):
        plan += ["get_board", "suggest_pin_roles"]
    return list(dict.fromkeys(plan)) or ["get_board"]


def _arguments(tool: str, question: str, results: dict[str, dict]) -> dict | None:
    if tool == "get_capture":
        captures = (results.get("get_board", {}).get("data") or {}).get("captures") or []
        return {"id": captures[-1]["id"]} if captures else None
    if tool == "search_wiki":
        words = [w for w in re.findall(r"[a-z0-9]+", question.lower()) if len(w) > 3]
        return {"query": " ".join(words[:5]) or "uart"}
    if tool == "explain_step":
        found = re.search(r"\b([a-z]+(?:-[a-z]+)+)\b", question.lower())
        return {"playbook": found.group(1) if found else "find-uart"}
    if tool == "write_finding":
        return {"title": "Simulated finding", "text": "Noted by the simulated model from: " + question[:200]}
    if tool == "propose_command":
        found = re.search(r"`([^`]+)`", question)
        return {"command": found.group(1) if found else "printenv", "reason": "Simulated suggestion."}
    if tool == "view_photo":
        return {}
    if tool == "suggest_label":
        return {"x": 50, "y": 40, "text": "U1: simulated part", "confidence": "low", "evidence": "Simulated, not seen."}
    if tool == "suggest_pin_roles":
        headers = (results.get("get_board", {}).get("data") or {}).get("headers") or []
        if not headers:
            return None
        return {"header": headers[0]["label"] or headers[0]["id"], "pins": [
            {"pin": 1, "role": "GND", "confidence": "medium", "evidence": "Simulated: wide trace to the ground plane."},
            {"pin": 2, "role": "TX", "confidence": "low", "evidence": "Simulated guess."}]}
    return {}


def _digest(results: dict[str, dict]) -> str:
    parts = []
    for tool, envelope in results.items():
        data = envelope.get("data") or {}
        if tool == "get_board":
            parts.append(f"the board has {len(data.get('headers') or [])} header(s) and {len(data.get('captures') or [])} capture(s)")
        elif tool == "get_capture":
            parts.append("the capture says: " + str(data.get("text") or data.get("error") or "")[:200].replace("\n", " "))
        elif tool == "get_pin_readings":
            parts.append(f"{len(data.get('pins') or [])} pin(s) have readings or roles")
        elif tool == "get_timeline":
            parts.append(f"{len(data.get('events') or [])} recent event(s)")
        elif tool == "search_wiki":
            parts.append("wiki pages: " + ", ".join(r["title"] for r in data.get("results") or []))
        elif tool == "explain_step":
            parts.append(str(data.get("title") or data.get("error") or ""))
        elif tool == "write_finding":
            parts.append(str(data.get("written") or data.get("error") or ""))
        elif tool == "propose_command":
            parts.append(f"proposal {data.get('status')}" + (f" ({data['detail']})" if data.get("detail") else ""))
        elif tool == "view_photo":
            parts.append(str(data.get("error") or f"I looked at {data.get('label') or data.get('photo')}"))
        elif tool in ("suggest_label", "suggest_pin_roles"):
            parts.append(f"suggestion {data.get('status') or data.get('error')}")
    return "; ".join(p for p in parts if p)


def respond(body: dict) -> tuple[int, dict]:
    """(HTTP status, JSON body) for one chat completion request."""
    messages = body.get("messages") or []
    turn = _turn(messages)
    question = _text(turn[0].get("content")) if turn else ""
    q = question.lower()
    results = _results(turn)
    called = [c["function"]["name"] for m in turn for c in (m.get("tool_calls") or [])]
    # Roughly what a real server counts: text by length, each picture as a fixed amount, not its base64 size.
    text_only = [{**m, "content": _text(m.get("content"))} for m in messages]
    tokens = {"prompt_tokens": len(json.dumps(text_only)) // 4 + 1600 * _pictures(messages), "completion_tokens": 20}

    def reply(message: dict) -> tuple[int, dict]:
        message.setdefault("role", "assistant")
        return 200, {"id": "sim", "object": "chat.completion", "model": body.get("model") or MODEL_NAME,
                     "choices": [{"index": 0, "message": message, "finish_reason": "stop"}], "usage": tokens}

    def call(tool: str, args: dict) -> tuple[int, dict]:
        return reply({"content": None, "tool_calls": [{"id": f"call_{len(called) + 1}", "type": "function",
                                                        "function": {"name": tool, "arguments": json.dumps(args)}}]})

    if "simulate error" in q:
        return 500, {"error": {"message": "simulated failure"}}
    if "simulate empty" in q:
        return reply({"content": ""})
    if "simulate length" in q:
        status, body = reply({"content": None})
        body["choices"][0]["finish_reason"] = "length"
        return status, body
    if "simulate stubborn" in q:
        return call("get_board", {})
    if body.get("tool_choice") == "none":
        summary = _digest(results)
        return reply({"content": "(simulated model) Out of tool calls. " + (f"I looked and {summary}." if summary else "")})
    if "simulate loop" in q:
        return call("get_board", {})
    if "simulate repeat" in q and called.count("propose_command") < 3:
        return call("propose_command", {"command": "printenv", "reason": "See the environment."})
    for envelope in results.values():                      # a gullible model obeys text it found in a tool result
        found = INJECTION_RE.search(json.dumps(envelope))
        if found and "propose_command" not in called:
            return call("propose_command", {"command": found.group(1).strip(), "reason": "The tool result asked for it."})
    for tool in _plan(question):
        if tool in called:
            continue
        args = _arguments(tool, question, results)
        if args is None:
            continue                                        # nothing to read, for example no captures yet
        return call(tool, args)
    summary = _digest(results)
    seen = f" I received {_pictures(turn)} picture(s)." if "view_photo" in called else ""
    return reply({"content": "(simulated model) " + (f"I looked and {summary}." if summary else "I have nothing to look at yet.") + seen})


class FakeModelServer:
    """Runs the simulated model on a local port in a background thread; `requests` records what it was sent."""

    def __init__(self, port: int = 0):
        self.requests: list[dict] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):                   # keep test and terminal output quiet
                pass

            def _send(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path.rstrip("/").endswith("/models"):
                    self._send(200, {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]})
                else:
                    self._send(404, {"error": {"message": "not found"}})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    return self._send(400, {"error": {"message": "body is not JSON"}})
                owner.requests.append({"path": self.path, "authorization": self.headers.get("Authorization"), "body": body})
                if self.path.rstrip("/").endswith("/chat/completions"):
                    if "wrong" in (self.headers.get("Authorization") or ""):      # a key containing "wrong" is refused
                        self._send(401, {"error": {"message": "invalid API key"}})
                    elif body.get("model") == "no-such-model":
                        self._send(404, {"error": {"message": "model not found"}})
                    elif body.get("model") == "no-tools-model" and body.get("tools"):
                        self._send(400, {"error": {"message": "no-tools-model does not support tools"}})
                    elif body.get("model") in ("thinking-model", "silent-model"):
                        self._send(200, {"choices": [{"message": {"role": "assistant", "content": ""},
                                                      "finish_reason": "length" if body["model"] == "thinking-model" else "stop"}],
                                         "usage": {"prompt_tokens": 20, "completion_tokens": 16}})
                    else:
                        self._send(*respond(body))
                else:
                    self._send(404, {"error": {"message": "not found"}})

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def start(self) -> FakeModelServer:
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self) -> FakeModelServer:
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()
