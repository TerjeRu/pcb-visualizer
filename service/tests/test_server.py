import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from pcbv.board import JOURNAL_REL, Board, BoardLocked, replay
from pcbv.journal import read_journal
from pcbv.server import create_app

import helpers as h

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def root(tmp_path):
    return tmp_path / "boards"


@pytest.fixture
def client(root):
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as c:
        yield c


@pytest.fixture
def slug(client):
    response = client.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH)
    assert response.status_code == 201
    return response.json()["slug"]


def post_event(client, slug, event, actor="http"):
    return client.post(f"/api/boards/{slug}/events", json={"event": event, "actor": actor}, headers=AUTH)


WS_HEADERS = {"host": "localhost:8765"}


def ws_connect(client, slug, **hello):
    ws = client.websocket_connect(f"/api/boards/{slug}/ws", headers=dict(WS_HEADERS))
    session = ws.__enter__()
    session.send_json({"op": "auth", "protocol": 2, "token": TOKEN, **hello})
    return ws, session


def drain_events(session, count, acks=0):
    """Read until `count` events and `acks` acks arrived. Returns (events, acks, other messages)."""
    events, ack_msgs, others = [], [], []
    while len(events) < count or len(ack_msgs) < acks:
        message = session.receive_json()
        if message["op"] == "event":
            events.append(message["event"])
        elif message["op"] == "ack":
            ack_msgs.append(message)
        else:
            others.append(message)
    return events, ack_msgs, others


def test_health_is_open_everything_else_needs_the_token(client, slug):
    assert client.get("/api/health").json()["ok"] is True
    for headers in ({}, {"X-PCBV-Protocol": "2", "Authorization": "Bearer wrong"}, {"X-PCBV-Protocol": "2", "Authorization": TOKEN}, {"X-PCBV-Protocol": "2", "Authorization": "Basic abc"}):
        assert client.get("/api/boards", headers=headers).status_code == 401
        assert client.get(f"/api/boards/{slug}", headers=headers).status_code == 401
        unauthenticated = client.post(f"/api/boards/{slug}/events", json={"event": h.add_asset()}, headers=headers)
        assert unauthenticated.status_code == 401
    assert client.get(f"/api/boards/{slug}", headers=AUTH).json()["seq"] == 1, "no unauthenticated write may land"
    assert client.get("/api/boards", headers=AUTH).status_code == 200


@pytest.mark.parametrize("host", ["evil.example", "localhost.evil.example", "127.0.0.1.evil.example:8765", "10.0.0.5",
                                  "[localhost]", "[localhost]:80", "[127.0.0.1]:80", "::1", "::1:8765"])
def test_dns_rebinding_hosts_are_refused(client, host):
    response = client.get("/api/boards", headers={**AUTH, "Host": host})
    assert response.status_code == 403 and response.json()["error"] == "bad_host"


@pytest.mark.parametrize("host", ["localhost", "localhost:8765", "127.0.0.1:9", "[::1]:8765"])
def test_loopback_hosts_are_accepted(client, host):
    assert client.get("/api/boards", headers={**AUTH, "Host": host}).status_code == 200


def test_other_websites_cannot_call_the_api_from_a_browser(client, slug):
    evil = {**AUTH, "Origin": "https://evil.example"}
    assert client.get("/api/boards", headers=evil).status_code == 403
    assert client.post(f"/api/boards/{slug}/events", json={"event": h.add_asset()}, headers=evil).status_code == 403
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/api/boards/{slug}/ws", headers={**WS_HEADERS, "origin": "https://evil.example"}):
            pass
    assert closed.value.code == 1008


def test_websocket_with_a_non_loopback_host_is_refused(client, slug):
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/api/boards/{slug}/ws", headers={"host": "evil.example"}):
            pass
    assert closed.value.code == 1008


def test_websocket_from_the_local_web_app_is_accepted(client, slug):
    headers = {**WS_HEADERS, "origin": "http://localhost:8080"}
    with client.websocket_connect(f"/api/boards/{slug}/ws", headers=headers) as ws:
        ws.send_json({"op": "auth", "protocol": 2, "token": TOKEN})
        assert ws.receive_json()["op"] == "snapshot"


def test_the_local_web_app_and_tauri_shell_are_allowed_origins(client, slug):
    for origin in ("http://localhost:8080", "http://127.0.0.1:8080", "tauri://localhost", "http://tauri.localhost"):
        assert client.get("/api/boards", headers={**AUTH, "Origin": origin}).status_code == 200
    preflight = client.options("/api/boards", headers={"Origin": "http://localhost:8080",
                                                       "Access-Control-Request-Method": "POST",
                                                       "Access-Control-Request-Headers": "authorization,content-type"})
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:8080"
    bad = client.options("/api/boards", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers


@pytest.mark.parametrize("first_message", [
    {"op": "auth", "protocol": 2, "token": "wrong"},
    {"op": "auth"},
    {"op": "apply", "event": h.add_asset()},     # trying to write before authenticating
    {"token": TOKEN},
])
def test_websocket_must_authenticate_first(client, slug, first_message):
    with client.websocket_connect(f"/api/boards/{slug}/ws", headers=dict(WS_HEADERS)) as ws:
        ws.send_json(first_message)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4401
    assert client.get(f"/api/boards/{slug}", headers=AUTH).json()["seq"] == 1, "unauthenticated write must not land"


def test_boards_are_created_listed_and_read_over_http(client):
    created = client.post("/api/boards", json={"name": "Nimbus N100 (rev B)"}, headers=AUTH)
    assert created.json() == {"slug": "nimbus-n100-rev-b", "seq": 1, "warnings": []}
    assert client.post("/api/boards", json={"name": "Nimbus N100 (rev B)"}, headers=AUTH).status_code == 409
    assert client.get("/api/boards", headers=AUTH).json() == {"boards": ["nimbus-n100-rev-b"]}
    state = client.get("/api/boards/nimbus-n100-rev-b", headers=AUTH).json()
    assert state["project"]["meta"]["name"] == "Nimbus N100 (rev B)"


@pytest.mark.parametrize("bad_name", [None, "", "   ", 5, "x" * 121, "!!!"])
def test_board_names_are_validated(client, bad_name):
    assert client.post("/api/boards", json={"name": bad_name}, headers=AUTH).status_code in (400, 422)


def test_unknown_and_malformed_board_names(client):
    assert client.get("/api/boards/nope", headers=AUTH).status_code == 404
    for name in ("Bad_Name", "-x", "a" * 65, "..", "%2e%2e"):
        assert client.get(f"/api/boards/{name}", headers=AUTH).status_code in (400, 404)


def test_a_board_open_elsewhere_reports_locked_not_broken(root, client):
    held = Board.create(root / "held", "Held")
    try:
        response = client.get("/api/boards/held", headers=AUTH)
        assert response.status_code == 423 and response.json()["error"] == "locked"
    finally:
        held.close()
    assert client.get("/api/boards/held", headers=AUTH).status_code == 200


def test_the_service_keeps_other_processes_out_of_a_board_it_serves(root, client, slug):
    with pytest.raises(BoardLocked):
        Board.open(root / slug)


def test_symlinked_board_pointing_outside_the_root_is_unreachable(root, client, tmp_path):
    outside = Board.create(tmp_path / "outside", "Outside")
    outside.close()
    (root / "sneaky").symlink_to(tmp_path / "outside", target_is_directory=True)
    assert client.get("/api/boards/sneaky", headers=AUTH).status_code == 400
    assert "sneaky" not in client.get("/api/boards", headers=AUTH).json()["boards"]


def test_http_events_are_applied_and_rejections_leave_no_trace(client, slug, root):
    assert post_event(client, slug, h.add_asset()).json()["event"]["seq"] == 2
    journal = (root / slug / JOURNAL_REL).read_bytes()

    invalid = post_event(client, slug, h.add_asset(id="img_x", path="assets/../../etc/passwd"))
    conflict = post_event(client, slug, h.add_asset())
    assert (invalid.status_code, invalid.json()["error"]) == (422, "invalid_event")
    assert (conflict.status_code, conflict.json()["error"]) == (409, "conflict")
    assert client.post(f"/api/boards/{slug}/events", content=b"{nope", headers=AUTH).status_code == 422
    assert client.post(f"/api/boards/{slug}/events", json=[1], headers=AUTH).status_code == 422
    assert client.post(f"/api/boards/{slug}/events", json={}, headers=AUTH).status_code == 422
    assert (root / slug / JOURNAL_REL).read_bytes() == journal


def test_oversized_request_bodies_are_refused_before_parsing(client, slug):
    big = json.dumps({"event": h.add_asset(), "pad": "x" * 2_100_000})
    assert client.post(f"/api/boards/{slug}/events", content=big, headers=AUTH).status_code == 413


def test_events_since_returns_exactly_the_missed_tail(client, slug):
    for n in range(3):
        post_event(client, slug, h.add_asset(id=f"img_{n}", path=f"assets/{n}.jpg"))
    tail = client.get(f"/api/boards/{slug}/events?since=2", headers=AUTH).json()
    assert [e["seq"] for e in tail["events"]] == [3, 4] and tail["seq"] == 4
    assert client.get(f"/api/boards/{slug}/events?since=9", headers=AUTH).status_code == 409


def test_every_client_sees_every_change_in_the_same_order(client, slug, root):
    ws1, a = ws_connect(client, slug, actor="web")
    ws2, b = ws_connect(client, slug, actor="ws")
    try:
        assert a.receive_json()["op"] == "snapshot" and b.receive_json()["op"] == "snapshot"

        assert post_event(client, slug, h.add_asset(), actor="cli").status_code == 201
        a.send_json({"op": "apply", "id": "c1", "event": h.add_marker()})
        b.send_json({"op": "apply", "id": "c2", "event": h.pin("sch_a", 1, {"role": "GND"})})

        seen_a, acks_a, _ = drain_events(a, 3, acks=1)
        seen_b, acks_b, _ = drain_events(b, 3, acks=1)
    finally:
        ws1.__exit__(None, None, None)
        ws2.__exit__(None, None, None)

    assert [e["seq"] for e in seen_a] == [2, 3, 4]
    assert seen_a == seen_b, "both clients must receive identical events in identical order"
    assert [e["actor"] for e in seen_a] == ["cli", "web", "ws"]
    assert acks_a == [{"op": "ack", "id": "c1", "seq": 3, "warnings": [], "storage": {"writable": True, "warnings": []}}]
    assert acks_b == [{"op": "ack", "id": "c2", "seq": 4, "warnings": [], "storage": {"writable": True, "warnings": []}}]

    live = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]
    assert replay(read_journal(root / slug / JOURNAL_REL).events) == live


def test_a_rejected_websocket_event_reaches_nobody_and_uses_no_sequence_number(client, slug):
    ws1, a = ws_connect(client, slug)
    ws2, b = ws_connect(client, slug)
    try:
        for ws in (a, b):
            assert ws.receive_json()["op"] == "snapshot"
            assert ws.receive_json() == {"op": "serial", "state": None, "backlog": ""}   # no console open
        a.send_json({"op": "apply", "id": "bad", "event": h.add_marker("mk_z", asset_id="img_missing")})
        error = a.receive_json()
        assert error["op"] == "error" and error["id"] == "bad" and error["code"] == "conflict"
        a.send_json({"op": "apply", "id": "worse", "event": {"type": "nope"}})
        assert a.receive_json()["code"] == "invalid_event"
        a.send_json({"op": "frobnicate", "id": "odd"})
        assert a.receive_json()["code"] == "invalid_event"

        a.send_json({"op": "apply", "id": "ok", "event": h.add_asset()})
        events_b, _, _ = drain_events(b, 1)
        assert events_b[0]["seq"] == 2, "b saw no trace of the rejected events, and no gap"
    finally:
        ws1.__exit__(None, None, None)
        ws2.__exit__(None, None, None)


def test_reconnecting_client_gets_exactly_what_it_missed(client, slug):
    post_event(client, slug, h.add_asset(id="img_0", path="assets/0.jpg"))          # seq 2
    ws, session = ws_connect(client, slug)
    first = session.receive_json()
    assert first["op"] == "snapshot" and first["seq"] == 2
    assert [e["seq"] for e in first["recent"]] == [1, 2]                             # history for the feed
    ws.__exit__(None, None, None)                                                    # network drops

    post_event(client, slug, h.add_asset(id="img_1", path="assets/1.jpg"))          # seq 3, missed
    post_event(client, slug, h.add_asset(id="img_2", path="assets/2.jpg"))          # seq 4, missed

    ws, session = ws_connect(client, slug, sinceSeq=2)
    try:
        assert session.receive_json() == {"op": "ready", "mode": "resume", "seq": 4, "storage": {"writable": True, "warnings": []}}
        caught_up, _, _ = drain_events(session, 2)
        assert [e["seq"] for e in caught_up] == [3, 4]
        post_event(client, slug, h.add_asset(id="img_3", path="assets/3.jpg"))      # live again
        live, _, _ = drain_events(session, 1)
        assert live[0]["seq"] == 5, "no event is delivered twice or skipped around the catch-up"
    finally:
        ws.__exit__(None, None, None)


@pytest.mark.parametrize("since", [99, -1, "3", True, None, 2.5])
def test_unusable_resume_points_fall_back_to_a_full_snapshot(client, slug, since):
    ws, session = ws_connect(client, slug, sinceSeq=since)
    try:
        message = session.receive_json()
        assert message["op"] == "snapshot" and message["project"]["meta"]["name"] == "Nimbus"
    finally:
        ws.__exit__(None, None, None)


def test_a_dead_client_does_not_stop_the_others(client, slug):
    ws1, a = ws_connect(client, slug)
    ws2, b = ws_connect(client, slug)
    a.receive_json(), b.receive_json()
    ws1.__exit__(None, None, None)
    try:
        assert post_event(client, slug, h.add_asset()).status_code == 201
        events, _, _ = drain_events(b, 1)
        assert events[0]["seq"] == 2
    finally:
        ws2.__exit__(None, None, None)


def test_outside_edit_is_broadcast_in_order_before_the_event_that_found_it(client, slug, root):
    ws, session = ws_connect(client, slug)
    try:
        session.receive_json()
        path = root / slug / "project.pcb.json"
        edited = json.loads(path.read_text())
        edited["meta"]["name"] = "Edited by the browser app directly"
        path.write_text(json.dumps(edited, indent=2) + "\n")

        assert post_event(client, slug, {"type": "project/metaUpdated", "patch": {"notes": "n"}}).status_code == 201
        events, _, _ = drain_events(session, 2)
        assert [(e["seq"], e["type"], e["actor"]) for e in events] == [
            (2, "project/replaced", "external"), (3, "project/metaUpdated", "http")]
        state = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]
        assert state["meta"]["name"] == "Edited by the browser app directly" and state["meta"]["notes"] == "n"
    finally:
        ws.__exit__(None, None, None)


@pytest.mark.parametrize("event, status", [
    ({"type": "playbook/updated", "playbookId": "find-uart", "stepId": "ground", "patch": {"done": "x"}}, 201),
    ({"type": "playbook/updated", "playbookId": "Find UART", "patch": {}}, 422),
    ({"type": "playbook/updated", "playbookId": "find-uart", "stepId": "../x", "patch": {}}, 422),
    ({"type": "playbook/updated", "playbookId": "find-uart", "patch": {"steps": {}}}, 422),
    ({"type": "playbook/updated", "playbookId": "find-uart", "patch": []}, 422),
])
def test_playbook_progress_events_are_validated(client, slug, event, status):
    assert post_event(client, slug, event).status_code == status


def test_annotations_are_validated_against_the_board(client, slug):
    assert post_event(client, slug, h.add_asset(id="img_a", path="assets/a.jpg")).status_code == 201
    good = {"id": "an_1", "assetId": "img_a", "x": 1, "y": 2, "lx": 50, "ly": -20, "text": "SoC", "wiki": "soc"}
    assert post_event(client, slug, {"type": "annotation/added", "annotation": good}).status_code == 201
    assert post_event(client, slug, {"type": "annotation/added", "annotation": good}).status_code == 409
    assert post_event(client, slug, {"type": "annotation/added", "annotation": {**good, "id": "an_2", "assetId": "img_x"}}).status_code == 409
    assert post_event(client, slug, {"type": "annotation/added", "annotation": {**good, "id": "an_3", "x": "1"}}).status_code == 422
    assert post_event(client, slug, {"type": "annotation/added", "annotation": {**good, "id": "an_4", "wiki": "../x"}}).status_code == 422
    assert post_event(client, slug, {"type": "annotation/updated", "id": "an_1", "patch": {"text": "x" * 201}}).status_code == 422
    assert post_event(client, slug, {"type": "annotation/updated", "id": "an_9", "patch": {"text": "x"}}).status_code == 409
    assert post_event(client, slug, {"type": "annotation/removed", "id": "an_1"}).status_code == 201


def mint(client):
    return client.post("/api/session/code", json={}, headers=AUTH)


def redeem(client, body, headers=None):
    return client.post("/api/session", json=body, headers=headers or {})


def test_session_code_single_use(client):
    minted = mint(client)
    assert minted.status_code == 200 and minted.headers["cache-control"] == "no-store"
    code = minted.json()["code"]
    assert minted.json()["expiresIn"] == 60 and len(code) == 43
    first = redeem(client, {"code": code})
    assert first.status_code == 200 and first.json() == {"token": TOKEN} and first.headers["cache-control"] == "no-store"
    again = redeem(client, {"code": code})
    assert again.status_code == 401 and again.json()["error"] == "invalid_code"


def test_session_code_expires(client, monkeypatch):
    import types

    now = [1000.0]
    monkeypatch.setattr("pcbv.sessioncodes.time", types.SimpleNamespace(monotonic=lambda: now[0]))
    young, old = mint(client).json()["code"], mint(client).json()["code"]
    now[0] += 59.9
    assert redeem(client, {"code": young}).status_code == 200
    now[0] += 0.2
    assert redeem(client, {"code": old}).status_code == 401


def test_codes_cannot_be_minted_without_the_token(client):
    assert client.post("/api/session/code", json={}).status_code == 401
    assert client.post("/api/session/code", json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_a_bad_code_is_refused_in_every_shape(client):
    for body in ({}, {"code": ""}, {"code": 5}, {"code": None}, {"code": "x" * 200}, {"code": "nope"},
                 {"code": mint(client).json()["code"], "extra": 1}):
        refused = redeem(client, body)
        assert refused.status_code == 401 and refused.json()["error"] == "invalid_code", body


def test_redeeming_still_checks_host_and_origin(client):
    code = mint(client).json()["code"]
    assert redeem(client, {"code": code}, {"Origin": "https://evil.example"}).json()["error"] == "bad_origin"
    assert client.post("/api/session", json={"code": code}, headers={"Host": "evil.example"}).json()["error"] == "bad_host"
    assert redeem(client, {"code": code}).status_code == 200, "the refused attempts did not use the code"


def test_the_redeem_body_is_limited_to_one_kib(client):
    ok = '{"code": "' + "a" * 100 + '"}'
    assert client.post("/api/session", content=ok).status_code == 401
    big = '{"code": "' + "a" * 1100 + '"}'
    assert client.post("/api/session", content=big).status_code == 413
    chunked = client.post("/api/session", content=(c for c in [b'{"code": "', b"a" * 1100, b'"}']))
    assert chunked.status_code == 413


def test_live_codes_are_bounded(client):
    for _ in range(128):
        assert mint(client).status_code == 200
    full = mint(client)
    assert full.status_code == 429 and full.json()["error"] == "session_busy"


def test_a_code_is_only_for_the_session_it_was_minted_in():
    from pcbv.sessioncodes import CodeStore

    one, two = CodeStore(), CodeStore()
    assert not two.redeem(one.mint()), "codes die with the process that minted them"
