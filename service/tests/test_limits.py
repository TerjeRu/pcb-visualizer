import json
import socket
import threading

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from pcbv import logic, server
from pcbv.logic import Capture, uart_waveform, write_sr
from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}
BINARY = {**AUTH, "Content-Type": "application/octet-stream"}


def service(tmp_path):
    root = tmp_path / "boards"
    root.mkdir(exist_ok=True)
    return create_app(root, TOKEN)


def sr(samples: int = 5000, fill: int = 0xFF) -> bytes:
    return write_sr(Capture(1_000_000, [f"D{i}" for i in range(8)], bytes([fill]) * samples))


def new_board(client, name="B"):
    return client.post("/api/boards", json={"name": name}, headers=AUTH).json()["slug"]


def import_capture(client, slug, data, name="x.sr", **params):
    return client.post(f"/api/boards/{slug}/logic", params={"name": name, **params}, content=data, headers=BINARY)


def chunks(data: bytes, size: int = 1000):
    for start in range(0, len(data), size):
        yield data[start:start + size]


def test_chunked_body_over_limit_413(tmp_path, monkeypatch):
    monkeypatch.setattr(server.body, "MAX_BODY_BYTES", 5000)
    with TestClient(service(tmp_path), base_url="http://localhost:8765") as client:
        body = json.dumps({"name": "x" * 20_000}).encode()
        response = client.post("/api/boards", content=chunks(body), headers={**AUTH, "Content-Type": "application/json"})
        assert "content-length" not in response.request.headers and response.request.headers["transfer-encoding"] == "chunked"
        assert response.status_code == 413 and response.json()["error"] == "too_large"
        ok = client.post("/api/boards", content=chunks(json.dumps({"name": "fine"}).encode()),
                         headers={**AUTH, "Content-Type": "application/json"})
        assert ok.status_code == 201


def test_deeply_nested_json_is_a_bad_body_not_a_crash(tmp_path):
    with TestClient(service(tmp_path), base_url="http://localhost:8765", raise_server_exceptions=False) as client:
        response = client.post("/api/boards", content=b"[" * 500_000, headers={**AUTH, "Content-Type": "application/json"})
        assert response.status_code == 422 and response.json()["error"] == "invalid_event"


def test_upload_budget_refuses_bodies_that_do_not_fit_and_releases_after_each_request(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "UPLOAD_BUDGET", 3000)
    with TestClient(service(tmp_path), base_url="http://localhost:8765") as client:
        too_much = client.post("/api/boards", content=chunks(b'{"name": "' + b"x" * 4000 + b'"}'),
                               headers={**AUTH, "Content-Type": "application/json"})
        assert too_much.status_code == 429 and too_much.json()["error"] == "work_busy"
        declared = client.post("/api/boards", content=b'{"name": "' + b"x" * 4000 + b'"}', headers=AUTH)
        assert declared.status_code == 429
        for n in range(5):                          # every earlier request gave its reservation back
            assert client.post("/api/boards", json={"name": f"b{n}"}, headers=AUTH).status_code == 201


def test_ws_unauthenticated_does_not_open_board(tmp_path):
    app = service(tmp_path)
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client)
        app.state.registry.close_all()
        before = (tmp_path / "boards" / slug / "project.pcb.json").read_bytes()
        for hello in ({"op": "auth", "protocol": 2, "token": "wrong"}, {"op": "ping"}):
            for path in (f"/api/boards/{slug}/ws", f"/api/boards/{slug}/terminal"):
                with client.websocket_connect(path, headers={"host": "localhost:8765"}) as ws:
                    ws.send_json(hello)
                    with pytest.raises(WebSocketDisconnect) as closed:
                        ws.receive_json()
                    assert closed.value.code == 4401
        assert slug not in app.state.registry.entries, "nothing was opened for an unauthenticated caller"
        assert (tmp_path / "boards" / slug / "project.pcb.json").read_bytes() == before


@pytest.mark.parametrize("actor", ["service", "external", "assistant", "agent", "WEB", 7])
def test_clients_cannot_claim_a_reserved_actor(tmp_path, actor):
    import helpers as h
    with TestClient(service(tmp_path), base_url="http://localhost:8765") as client:
        slug = new_board(client)
        response = client.post(f"/api/boards/{slug}/events", json={"event": h.add_asset(), "actor": actor}, headers=AUTH)
        assert response.status_code == 422 and response.json()["error"] == "invalid_event"
        with client.websocket_connect(f"/api/boards/{slug}/ws", headers={"host": "localhost:8765"}) as ws:
            ws.send_json({"op": "auth", "protocol": 2, "token": TOKEN, "actor": actor})
            assert ws.receive_json()["code"] == "invalid_event"
        assert client.get(f"/api/boards/{slug}", headers=AUTH).json()["seq"] == 1


def test_the_four_client_actors_are_accepted(tmp_path):
    import helpers as h
    with TestClient(service(tmp_path), base_url="http://localhost:8765") as client:
        slug = new_board(client)
        for n, actor in enumerate(("web", "cli", "http", "ws")):
            event = h.add_asset(id=f"img_{n}", path=f"assets/{n}.jpg")
            assert client.post(f"/api/boards/{slug}/events", json={"event": event, "actor": actor}, headers=AUTH).status_code == 201


@pytest.mark.parametrize("method, path, kwargs", [
    ("get", "/api/boards/{slug}/events?since=soon", {}),
    ("post", "/api/boards/{slug}/events", {"json": {"event": "nope", "actor": ["web"]}}),
    ("get", "/api/boards/{slug}/logic/cap_none/edges", {}),
    ("get", "/api/boards/nothing-here", {}),
    ("get", "/api/no-such-route", {}),
    ("post", "/api/boards/{slug}/assistant/chat", {"json": {"message": 5}}),
    ("post", "/api/boards/{slug}/assistant/chat", {"json": {"message": "hi", "conversation": ["a"], "profile": ["tutor"]}}),
    ("post", "/api/boards/{slug}/assistant/reset", {"json": {"conversation": ["x"]}}),
    ("get", "/api/boards/{slug}/assistant/conversation?conversation=A%20B", {}),
    ("post", "/api/assistant/keys/tutor", {"json": {"key": 12}}),
    ("post", "/api/assistant/settings", {"json": {"default": ["tutor"]}}),
    ("post", "/api/boards/{slug}/assistant/proposals/p1", {"json": {"action": ["approve"]}}),
    ("post", "/api/boards/{slug}/serial", {"json": {"baud": "fast"}}),
    ("post", "/api/boards/{slug}/export", {"json": {"formats": "all"}}),
])
def test_error_shape(tmp_path, method, path, kwargs):
    with TestClient(service(tmp_path), base_url="http://localhost:8765", raise_server_exceptions=False) as client:
        slug = new_board(client)
        client.post("/api/settings", json={"assistant": "on"}, headers=AUTH)   # off, the assistant rows would only see 409
        response = getattr(client, method)(path.format(slug=slug), headers=AUTH, **kwargs)
        assert 400 <= response.status_code < 500, (response.status_code, response.text)
        body = response.json()
        assert set(body) == {"error", "message"} and body["error"] and body["message"], body


def test_a_missing_capture_is_not_found_not_a_board_error(tmp_path):
    with TestClient(service(tmp_path), base_url="http://localhost:8765") as client:
        slug = new_board(client)
        response = client.get(f"/api/boards/{slug}/logic/cap_none/edges", headers=AUTH)
        assert response.status_code == 404 and response.json()["error"] == "not_found"


def test_imports_keep_the_cache_within_its_entries_and_bytes(tmp_path, monkeypatch):
    size = 5000
    monkeypatch.setattr(server, "LOGIC_CACHE_BYTES", int(size * 1.5))
    app = service(tmp_path)
    cache = app.state.logic_cache
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client)
        for n in range(4):
            assert import_capture(client, slug, sr(size, fill=0xFF - n)).status_code == 201
            assert len(cache) == 1 and cache.bytes <= size * 1.5
    monkeypatch.setattr(server, "LOGIC_CACHE_BYTES", size * 10)
    app = service(tmp_path)
    cache = app.state.logic_cache
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client, "C")
        for n in range(4):
            assert import_capture(client, slug, sr(size, fill=0xF0 + n)).status_code == 201
            assert len(cache) == min(n + 1, 2) and cache.bytes <= size * 10


def test_csv_imports_are_cached_and_budgeted_like_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LOGIC_CACHE_BYTES", 1500)
    app = service(tmp_path)
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client)
        text = "D0,D1\n" + ("1,0\n" * 100 + "0,1\n" * 100) * 5
        for _ in range(3):
            response = import_capture(client, slug, text.encode(), name="x.csv", samplerate="1000000")
            assert response.status_code == 201 and response.json()["capture"]["samples"] == 1000
            assert app.state.logic_cache.bytes <= 1500 and len(app.state.logic_cache) == 1


def test_a_csv_past_the_sample_cap_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(logic, "MAX_SAMPLES", 100)
    with TestClient(service(tmp_path), base_url="http://localhost:8765", raise_server_exceptions=False) as client:
        slug = new_board(client)
        response = import_capture(client, slug, ("D0\n" + "1\n0\n" * 100).encode(), name="x.csv", samplerate="1000")
        assert response.status_code == 422 and response.json()["error"] == "invalid_capture"


def test_excess_import_work_gets_work_busy_and_no_queue(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "JOB_SLOTS", 1)
    started, release = threading.Event(), threading.Event()
    original = logic.read_capture

    def slow(data, name, rate=None):
        started.set()
        assert release.wait(10)
        return original(data, name, rate)

    monkeypatch.setattr(logic, "read_capture", slow)
    with TestClient(service(tmp_path), base_url="http://localhost:8765") as client:
        slug = new_board(client)
        first = {}
        worker = threading.Thread(target=lambda: first.update(response=import_capture(client, slug, sr())))
        worker.start()
        try:
            assert started.wait(10)
            busy = import_capture(client, slug, sr())
            assert busy.status_code == 429 and busy.json()["error"] == "work_busy"
        finally:
            release.set()
            worker.join(10)
        assert first["response"].status_code == 201
        assert import_capture(client, slug, sr()).status_code == 201, "the slot was given back"


def test_concurrent_requests_for_one_cold_capture_load_it_once(tmp_path, monkeypatch):
    app = service(tmp_path)
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client)
        capture_id = import_capture(client, slug, sr()).json()["capture"]["id"]
        app.state.logic_cache._items.clear()
        loads, release = [], threading.Event()
        original = logic.read_sr

        def slow(data):
            loads.append(1)
            assert release.wait(10)
            return original(data)

        monkeypatch.setattr(logic, "read_sr", slow)
        results = []
        workers = [threading.Thread(target=lambda: results.append(
            client.get(f"/api/boards/{slug}/logic/{capture_id}/edges", headers=AUTH).status_code)) for _ in range(5)]
        for worker in workers:
            worker.start()
        while not loads:
            threading.Event().wait(0.01)
        threading.Event().wait(0.2)
        release.set()
        for worker in workers:
            worker.join(10)
        assert results == [200] * 5 and len(loads) == 1


def test_cache_misses_and_decodes_mixed_with_imports_stay_within_budget(tmp_path, monkeypatch):
    size = 20_000
    monkeypatch.setattr(server, "LOGIC_CACHE_BYTES", size * 2 + 10)
    app = service(tmp_path)
    cache = app.state.logic_cache
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client)
        ids = []
        for n in range(3):
            capture = Capture(1_000_000, [f"D{i}" for i in range(8)], bytes(uart_waveform(b"hello", 9600, 1_000_000))[:size].ljust(size, bytes([0xFF - 2 * n])))
            ids.append(import_capture(client, slug, write_sr(capture)).json()["capture"]["id"])
            assert len(cache) <= 2 and cache.bytes <= size * 2 + 10
        for capture_id in ids * 2:                  # the oldest was evicted, so these reload it
            assert client.get(f"/api/boards/{slug}/logic/{capture_id}/edges", headers=AUTH).status_code == 200
            decoded = client.post(f"/api/boards/{slug}/logic/{capture_id}/decode", json={"channel": 0, "baud": 9600}, headers=AUTH)
            assert decoded.status_code == 200
            assert len(cache) <= 2 and cache.bytes <= size * 2 + 10


def free_ipv6_loopback() -> bool:
    try:
        with socket.socket(socket.AF_INET6) as probe:
            probe.bind(("::1", 0))
        return True
    except OSError:
        return False


@pytest.mark.skipif(not free_ipv6_loopback(), reason="IPv6 loopback is not available here")
def test_ipv6_loopback_is_advertised_with_brackets(tmp_path):
    from live_service import running_service
    root = tmp_path / "boards"
    root.mkdir()
    with running_service(root, tmp_path / "run", host="::1") as (url, token, opener, _):
        assert url.startswith("http://[::1]:") and url.rsplit(":", 1)[1].isdigit()
        request = __import__("urllib.request").request.Request(f"{url}/api/boards", headers={"Authorization": f"Bearer {token}"})
        assert opener.open(request, timeout=5).status == 200


def test_a_channel_whose_guessed_speed_cannot_be_decoded_is_skipped_not_half_imported(tmp_path):
    app = service(tmp_path)
    with TestClient(app, base_url="http://localhost:8765") as client:
        slug = new_board(client)
        noise = "D0,D1\n" + "1,0\n0,1\n" * 1000      # flips every sample: the speed guess is beyond the sample rate
        response = import_capture(client, slug, noise.encode(), name="noise.csv", samplerate="1000000")
        assert response.status_code == 201 and response.json()["capture"]["decoded"] == []
        assert len(client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["captures"]) == 1


def test_an_unexpected_crash_still_answers_in_the_error_shape_without_leaking_its_text(tmp_path, monkeypatch):
    def broken(_root):
        raise RuntimeError("secret detail /home/someone/path")

    monkeypatch.setattr(server.boards, "list_boards", broken)
    with TestClient(service(tmp_path), base_url="http://localhost:8765", raise_server_exceptions=False) as client:
        response = client.get("/api/boards", headers=AUTH)
        assert response.status_code == 500 and set(response.json()) == {"error", "message"}
        assert response.json()["error"] == "internal_error" and "secret" not in response.text
