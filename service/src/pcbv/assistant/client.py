"""The HTTP side of the assistant: one POST to an OpenAI-compatible model server and the parsing of its answer."""
from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.parse
import urllib.request

from ..net import is_loopback
from .errors import UpstreamError

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
CONNECT_TIMEOUT_S = 10
READ_TIMEOUT_S = 60            # for each wait on the socket, not for the whole answer


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect could carry the key to another host, so none is followed."""

    def redirect_request(self, *args, **kwargs):
        return None


class _ReadDeadline:
    """urllib has one timeout for connecting and reading; the connection waits CONNECT_TIMEOUT_S to
    connect (and finish TLS), then READ_TIMEOUT_S on each read."""

    def connect(self):
        super().connect()
        self.sock.settimeout(READ_TIMEOUT_S)


class _Connection(_ReadDeadline, http.client.HTTPConnection):
    pass


class _SecureConnection(_ReadDeadline, http.client.HTTPSConnection):
    pass


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_Connection, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_SecureConnection, req, context=self._context)


def chat_request(base_url: str, key: str | None, payload: dict) -> dict:
    """POST {base_url}/chat/completions and return the parsed JSON body."""
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    handlers: list = [_NoRedirect, _HTTPHandler, _HTTPSHandler]
    if is_loopback(urllib.parse.urlparse(url).hostname):
        handlers.append(urllib.request.ProxyHandler({}))   # a local model server is never behind the proxy
    opener = urllib.request.build_opener(*handlers)

    def mask(text: str) -> str:
        return text.replace(key, "***") if key else text

    try:
        request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")  # noqa: S310 - scheme checked when the profile is saved
        with opener.open(request, timeout=CONNECT_TIMEOUT_S) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        detail = exc.read(1000).decode("utf-8", errors="replace").strip()
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        raise UpstreamError(mask(f"the model server answered {exc.code}: {str(detail)[:300]}"),
                            status=exc.code, detail=mask(str(detail)[:300])) from None
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        kind = "timeout" if isinstance(exc, TimeoutError) or isinstance(reason, TimeoutError) else "unreachable"
        raise UpstreamError(mask(f"could not reach the model server at {base_url}: {reason}"), kind=kind) from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise UpstreamError("the model server's answer was too large")
    try:
        body = json.loads(raw)
    except ValueError:
        raise UpstreamError("the model server did not answer with JSON; check the base URL ends in /v1") from None
    if not isinstance(body, dict):
        raise UpstreamError("the model server's answer was not an object")
    return body


def parse_completion(body: dict) -> dict:
    """{content, tool_calls: [{id, name, arguments}], prompt_tokens, completion_tokens} from a chat answer."""
    try:
        message = body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise UpstreamError("the model server's answer had no message") from None
    if not isinstance(message, dict):
        raise UpstreamError("the model server's answer had no message")
    calls = []
    for n, call in enumerate(message.get("tool_calls") or []):
        function = (call or {}).get("function") or {}
        calls.append({"id": str((call or {}).get("id") or f"call_{n}"), "name": str(function.get("name") or ""),
                      "arguments": function.get("arguments")})
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}

    def count(name: str) -> int:
        value = usage.get(name)
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 0

    content = message.get("content")
    finish = body["choices"][0].get("finish_reason") if isinstance(body["choices"][0], dict) else None
    return {"content": content if isinstance(content, str) else "", "tool_calls": calls, "finish": str(finish or ""),
            "prompt_tokens": count("prompt_tokens"), "completion_tokens": count("completion_tokens")}
