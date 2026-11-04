import asyncio
import json
import time

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect

import helpers as h
from pcbv import sender as sendermod
from pcbv.sender import ClientSender, encode
from pcbv.server import create_app
from starlette.testclient import TestClient
from test_server import AUTH, TOKEN, WS_HEADERS, post_event


@pytest.fixture
def client(tmp_path):
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as c:
        yield c


@pytest.fixture
def slug(client):
    response = client.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH)
    assert response.status_code == 201
    return response.json()["slug"]


class FakeSocket:
    """Records what is sent. `gate` holds every send until it is set."""

    def __init__(self, gate: asyncio.Event | None = None):
        self.gate = gate
        self.sent: list[str] = []
        self.closed: list[tuple[int, str]] = []

    async def send(self, data: str) -> None:
        if self.gate is not None:
            await self.gate.wait()
        self.sent.append(data)

    async def close(self, code: int, reason: str) -> None:
        self.closed.append((code, reason))


def make(socket: FakeSocket, **budgets) -> ClientSender:
    return ClientSender(socket.send, socket.close, **budgets)


def run(coro):
    return asyncio.run(coro)


def test_messages_leave_in_the_order_they_were_queued():
    async def scenario():
        socket = FakeSocket()
        sender = make(socket)
        task = asyncio.create_task(sender.run())
        for n in range(5):
            assert sender.put(encode({"n": n}))
        sender.close_after(1000)
        await task
        return socket

    socket = run(scenario())
    assert [json.loads(m)["n"] for m in socket.sent] == [0, 1, 2, 3, 4]
    assert socket.closed == [(1000, "")]


def test_put_never_waits_for_a_socket_that_does_not_send():
    async def scenario():
        socket = FakeSocket(gate=asyncio.Event())
        sender = make(socket, max_messages=50)
        task = asyncio.create_task(sender.run())
        started = time.monotonic()
        for n in range(20):
            assert sender.put(encode({"n": n}))
        elapsed = time.monotonic() - started
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return elapsed

    assert run(scenario()) < 0.5


@pytest.mark.parametrize("budget", [{"max_messages": 3}, {"max_bytes": 40}])
def test_passing_a_budget_closes_the_client_with_4408_and_drops_the_queue(budget):
    async def scenario():
        socket = FakeSocket(gate=asyncio.Event())
        sender = make(socket, deadline_s=0.05, **budget)
        task = asyncio.create_task(sender.run())
        accepted = [sender.put(encode({"n": n})) for n in range(10)]
        await task
        return socket, sender, accepted

    socket, sender, accepted = run(scenario())
    assert not all(accepted) and sender.closing
    assert socket.closed == [(4408, "slow-client")]
    assert socket.sent == []


def test_a_message_larger_than_the_byte_budget_is_refused_with_a_notice_and_its_own_reason():
    async def scenario():
        socket = FakeSocket()
        sender = make(socket, max_bytes=100)
        task = asyncio.create_task(sender.run())
        assert not sender.put("x" * 101)
        await task
        return socket

    socket = run(scenario())
    assert [json.loads(m)["code"] for m in socket.sent] == ["board_too_large"]
    assert socket.closed == [(4408, "board-too-large")]


def test_a_send_that_misses_its_deadline_closes_the_client():
    async def scenario():
        socket = FakeSocket(gate=asyncio.Event())
        sender = make(socket, deadline_s=0.05)
        task = asyncio.create_task(sender.run())
        sender.put(encode({"n": 1}))
        await asyncio.wait_for(task, 2)
        return socket

    assert run(scenario()).closed == [(4408, "slow-client")]


def test_a_close_waits_for_queued_messages_unless_told_to_drop_them():
    async def scenario():
        socket = FakeSocket()
        sender = make(socket)
        sender.put(encode({"n": 1}))
        sender.close_after(4400)
        await sender.run()
        return socket

    socket = run(scenario())
    assert len(socket.sent) == 1 and socket.closed == [(4400, "")]


def test_cancelling_the_sender_leaves_no_task_behind():
    async def scenario():
        sender = make(FakeSocket(gate=asyncio.Event()))
        task = asyncio.create_task(sender.run())
        sender.put(encode({"n": 1}))
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return task

    assert run(scenario()).cancelled()


# Server level: a Starlette socket whose send_text never finishes, for connections marked with x-stall.

@pytest.fixture
def stall(monkeypatch):
    def stalling(real):
        async def send(self, data):
            if self.headers.get("x-stall"):
                await asyncio.Event().wait()
            await real(self, data)
        return send

    monkeypatch.setattr(WebSocket, "send_text", stalling(WebSocket.send_text))
    monkeypatch.setattr(WebSocket, "send_json", stalling(WebSocket.send_json))


def connect(client, slug, *, stalled=False, **hello):
    headers = {**WS_HEADERS, **({"x-stall": "1"} if stalled else {})}
    ws = client.websocket_connect(f"/api/boards/{slug}/ws", headers=headers)
    session = ws.__enter__()
    session.send_json({"op": "auth", "protocol": 2, "token": TOKEN, **hello})
    return ws, session


def event_seqs(session, count):
    seqs = []
    while len(seqs) < count:
        message = session.receive_json()
        if message["op"] == "event":
            seqs.append(message["event"]["seq"])
    return seqs


def post_assets(client, slug, count, start=0):
    for n in range(start, start + count):
        response = post_event(client, slug, h.add_asset(id=f"img_{n}", path=f"assets/{n}.jpg"))
        assert response.status_code == 201


def test_a_client_that_stops_reading_does_not_delay_writes_or_other_clients(client, slug, stall):
    stuck_ws, _ = connect(client, slug, stalled=True)
    fast_ws, fast = connect(client, slug)
    try:
        assert fast.receive_json()["op"] == "snapshot"
        assert fast.receive_json()["op"] == "serial"
        started = time.monotonic()
        post_assets(client, slug, 5)
        assert event_seqs(fast, 5) == [2, 3, 4, 5, 6]
        assert time.monotonic() - started < 2
    finally:
        fast_ws.__exit__(None, None, None)
        stuck_ws.__exit__(None, None, None)


@pytest.mark.parametrize("budget, limit", [("MAX_QUEUED_MESSAGES", 3), ("MAX_QUEUED_BYTES", 1000)])
def test_overflow_closes_only_the_slow_client_and_it_resyncs_without_gaps(client, slug, stall, monkeypatch, budget, limit):
    count = 8
    base_ws, base = connect(client, slug)
    assert base.receive_json()["seq"] == 1
    base.receive_json()
    # Sized from the message lengths: the snapshot (about 700 bytes) goes out first, then the notice
    # and two or three events fit, and the rest of the eight do not.
    monkeypatch.setattr(sendermod, "SEND_DEADLINE_S", 0.2)
    monkeypatch.setattr(sendermod, budget, limit)
    stuck_ws, stuck = connect(client, slug, stalled=True)
    try:
        post_assets(client, slug, count)
        assert event_seqs(base, count) == list(range(2, 2 + count))
        with pytest.raises(WebSocketDisconnect) as closed:
            stuck.receive_json()
        assert (closed.value.code, closed.value.reason) == (4408, "slow-client")
    finally:
        stuck_ws.__exit__(None, None, None)
        base_ws.__exit__(None, None, None)

    monkeypatch.undo()
    ws, again = connect(client, slug, sinceSeq=1)
    try:
        assert again.receive_json() == {"op": "ready", "mode": "resume", "seq": 1 + count, "storage": {"writable": True, "warnings": []}}
        assert event_seqs(again, count) == list(range(2, 2 + count))
    finally:
        ws.__exit__(None, None, None)


def test_a_catch_up_the_outbox_cannot_hold_falls_back_to_a_snapshot(client, slug, monkeypatch):
    post_assets(client, slug, 6)
    monkeypatch.setattr(sendermod, "MAX_QUEUED_MESSAGES", 8)
    ws, session = connect(client, slug, sinceSeq=1)
    try:
        message = session.receive_json()
        assert message["op"] == "snapshot" and message["seq"] == 7
    finally:
        ws.__exit__(None, None, None)


def test_a_board_too_large_to_send_gets_a_notice_and_a_distinct_close(client, slug, monkeypatch):
    monkeypatch.setattr(sendermod, "MAX_QUEUED_BYTES", 200)
    ws, session = connect(client, slug)
    try:
        notice = session.receive_json()
        assert notice["op"] == "error" and notice["code"] == "board_too_large"
        with pytest.raises(WebSocketDisconnect) as closed:
            session.receive_json()
        assert (closed.value.code, closed.value.reason) == (4408, "board-too-large")
    finally:
        ws.__exit__(None, None, None)


def test_an_ack_never_arrives_before_the_event_it_acknowledges(client, slug):
    ws, session = connect(client, slug)
    try:
        session.receive_json(), session.receive_json()
        for n in range(5):
            session.send_json({"op": "apply", "id": f"c{n}", "event": h.add_asset(id=f"img_{n}", path=f"assets/{n}.jpg")})
        order = []
        while sum(1 for m in order if m[0] == "ack") < 5:
            message = session.receive_json()
            order.append((message["op"], message.get("seq") or message.get("event", {}).get("seq")))
        for position, (op, seq) in enumerate(order):
            if op == "ack":
                assert ("event", seq) in order[:position]
    finally:
        ws.__exit__(None, None, None)


def test_closing_a_socket_cancels_its_sender(client, slug):
    def senders():
        return sum(1 for t in asyncio.all_tasks() if t.get_coro().__qualname__ == "ClientSender.run")

    async def count():
        await asyncio.sleep(0.1)
        return senders()

    ws, session = connect(client, slug)
    session.receive_json()
    assert client.portal.call(count) == 1
    ws.__exit__(None, None, None)
    assert client.portal.call(count) == 0


def test_a_server_cancelling_the_handler_while_it_closes_is_not_reported_as_an_error(tmp_path):
    """The test client sends a disconnect and then cancels the handler at once. Wherever that cancel
    lands in the handler's own cleanup, the server must recognise the cancellation as its own."""
    import anyio

    root = tmp_path / "boards"
    root.mkdir()
    app = create_app(root, TOKEN)
    slug, _ = app.state.registry.create("Nimbus")
    path = f"/api/boards/{slug}/ws"
    scope = {"type": "websocket", "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
             "headers": [(b"host", b"localhost:8765")], "scheme": "ws", "subprotocols": [], "app": app,
             "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8765), "asgi": {"version": "3.0"}}

    async def close_with_cancel(steps):
        inbox, outbox, scopes = asyncio.Queue(), asyncio.Queue(), []
        for message in ({"type": "websocket.connect"},
                        {"type": "websocket.receive", "text": json.dumps({"op": "auth", "protocol": 2, "token": TOKEN})}):
            inbox.put_nowait(message)

        async def serve():
            with anyio.CancelScope() as cancel_scope:
                scopes.append(cancel_scope)
                await app(scope, inbox.get, outbox.put)
                await anyio.sleep_forever()

        task = asyncio.create_task(serve())
        while not (await outbox.get()).get("text", "").startswith('{"op":"serial"'):
            pass
        inbox.put_nowait({"type": "websocket.disconnect", "code": 1000})
        for _ in range(steps):
            await asyncio.sleep(0)
        scopes[0].cancel()
        try:
            await task
        except asyncio.CancelledError:
            return False
        return True

    async def every_point():
        return [steps for steps in range(12) if not await close_with_cancel(steps)]

    try:
        assert run(every_point()) == []
    finally:
        app.state.registry.close_all()
