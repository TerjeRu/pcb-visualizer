import json

import pytest
from starlette.testclient import TestClient

from pcbv.board import Board, JOURNAL_REL
from pcbv.events import EventError, EventConflict
from pcbv.journal import JournalError
from pcbv.server import ROUTERS, create_app


def test_batch_is_one_record_and_validates_staged_references(board):
    events = [
        {'type': 'asset/added', 'asset': {'id': 'photo', 'path': 'assets/a.jpg'}},
        {'type': 'asset/updated', 'id': 'photo', 'patch': {'label': 'updated'}},
    ]
    stored = board.apply({'type': 'board/batch', 'events': events})
    assert stored['journalVersion'] == 2 and stored['seq'] == 2
    assert board.project['schemaVersion'] == 2
    directory = board.directory
    board.close()
    with Board.open(directory) as reopened:
        assert reopened.seq == 2 and reopened.project['assets'][0]['label'] == 'updated'


def test_batch_rejects_all_children_if_last_conflicts(board):
    before = (board.directory / JOURNAL_REL).read_bytes()
    with pytest.raises(EventConflict):
        board.apply({'type': 'board/batch', 'events': [
            {'type': 'project/metaUpdated', 'patch': {'name': 'uncommitted'}},
            {'type': 'asset/removed', 'id': 'missing'},
        ]})
    assert board.seq == 1 and (board.directory / JOURNAL_REL).read_bytes() == before


@pytest.mark.parametrize('children', [[], [{}] * 257, [{'type': 'board/batch', 'events': []}],
                                      [{'type': 'project/created', 'project': {}}],
                                      [{'type': 'project/metaUpdated', 'patch': {}, 'seq': 7}]])
def test_batch_rejects_invalid_children(board, children):
    with pytest.raises(EventError):
        board.apply({'type': 'board/batch', 'events': children})


@pytest.mark.parametrize('version', [None, 1, 3, True, '2'])
def test_unsupported_journal_refused_without_creating_lock(tmp_path, version):
    directory = tmp_path / 'board'
    with Board.create(directory, 'test'):
        pass
    path = directory / JOURNAL_REL
    event = json.loads(path.read_text())
    if version is None:
        event.pop('journalVersion', None)
    else:
        event['journalVersion'] = version
    path.write_text(json.dumps(event) + '\n')
    (directory / '.pcbv/lock').unlink()
    before = {str(p.relative_to(directory)): p.read_bytes() for p in directory.rglob('*') if p.is_file()}
    with pytest.raises(JournalError):
        Board.open(directory)
    after = {str(p.relative_to(directory)): p.read_bytes() for p in directory.rglob('*') if p.is_file()}
    assert after == before


def test_protocol_gate_precedes_board_access(tmp_path):
    with TestClient(create_app(tmp_path, 'test'), base_url='http://localhost') as client:
        assert client.get('/api/health').json()['protocol'] == 2
        for path in ['/api/boards', '/api/boards/missing/events', '/api/boards/missing/assets',
                     '/api/boards/missing/logic', '/api/boards/missing/assistant/proposals/id',
                     '/api/boards/missing/serial', '/api/boards/missing/shell']:
            response = client.post(path, headers={'Authorization': 'Bearer test'}, json={})
            assert response.status_code == 409, path
            assert response.json()['error'] == 'protocol_incompatible'


@pytest.mark.parametrize('version', [None, 1, 3, True, '2'])
def test_unsupported_snapshot_refused_before_lock(tmp_path, version):
    directory = tmp_path / 'board'
    with Board.create(directory, 'test'):
        pass
    path = directory / 'project.pcb.json'
    snapshot = json.loads(path.read_bytes())
    if version is None:
        snapshot.pop('schemaVersion')
    else:
        snapshot['schemaVersion'] = version
    path.write_text(json.dumps(snapshot))
    (directory / '.pcbv/lock').unlink()
    before = {str(p.relative_to(directory)): p.read_bytes() for p in directory.rglob('*') if p.is_file()}
    with pytest.raises(JournalError):
        Board.open(directory)
    assert before == {str(p.relative_to(directory)): p.read_bytes() for p in directory.rglob('*') if p.is_file()}


def test_every_http_board_mutation_refuses_stale_clients(tmp_path):
    import re
    app = create_app(tmp_path, 'test')
    with TestClient(app, base_url='http://localhost') as client:
        routes = [r.path for router in ROUTERS for r in router.routes if 'POST' in getattr(r, 'methods', set()) and r.path.startswith('/api/boards')]
        assert len(routes) >= 15
        for route in routes:
            path = re.sub(r'\{[^}]+\}', 'missing', route)
            for version in (None, '1', '3', 'true'):
                headers = {'Authorization': 'Bearer test'}
                if version is not None:
                    headers['X-PCBV-Protocol'] = version
                response = client.post(path, headers=headers, json={})
                assert response.status_code == 409, path
                assert response.json()['error'] == 'protocol_incompatible'
        assert not app.state.registry.entries
        assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize('endpoint', ['ws', 'terminal'])
@pytest.mark.parametrize('version', [None, 1, True, '2'])
def test_stale_websocket_is_refused_before_board_open(tmp_path, endpoint, version):
    from starlette.websockets import WebSocketDisconnect
    app = create_app(tmp_path, 'test')
    with TestClient(app, base_url='http://localhost') as client:
        with client.websocket_connect(f'/api/boards/missing/{endpoint}', headers={'host': 'localhost'}) as ws:
            hello = {'op': 'auth', 'token': 'test'}
            if version is not None:
                hello['protocol'] = version
            ws.send_json(hello)
            assert ws.receive_json()['error'] == 'protocol_incompatible'
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4409
        assert not app.state.registry.entries


def test_durable_proposal_receipt_survives_restart_and_cache_loss(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from pcbv import server
    from pcbv.assistant import AssistantService, MemoryKeyStore
    assistant = AssistantService(MemoryKeyStore())
    monkeypatch.setattr(server, 'AssistantService', lambda _: assistant)
    auth = {'Authorization': 'Bearer test', 'X-PCBV-Protocol': '2'}
    app = create_app(tmp_path, 'test')
    with TestClient(app, base_url='http://localhost') as client:
        client.post('/api/settings', headers=auth, json={'assistant': 'on'})
        slug = client.post('/api/boards', headers=auth, json={'name': 'test'}).json()['slug']
        board = app.state.registry.get(slug).board
        board.apply({'type': 'asset/added', 'asset': {'id': 'photo', 'path': 'assets/photo.jpg', 'width': 100, 'height': 100}})
        proposal = assistant.suggest(slug, {'kind': 'label', 'photo': 'photo', 'x': 50, 'y': 50,
                                          'text': 'chip', 'confidence': 'low', 'evidence': 'synthetic'}, 'test')
        assert len(proposal['id']) == 37
        path = f'/api/boards/{slug}/assistant/proposals/{proposal["id"]}'
        def approve(_):
            response = client.post(path, headers=auth, json={'action': 'approve'})
            assert response.status_code == 200, response.text
            return response.json()
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(approve, range(2)))
        assert sorted(r['alreadyAccepted'] for r in results) == [False, True]
        assert results[0]['seq'] == results[1]['seq']
        sequence = board.seq
        assistant.proposals.clear()
        assert approve(0)['alreadyAccepted'] is True
        assert board.seq == sequence and len(board.project['annotations']) == 1
    with TestClient(create_app(tmp_path, 'test'), base_url='http://localhost') as client:
        response = client.post(path, headers=auth, json={'action': 'approve'})
        assert response.json()['alreadyAccepted'] is True
        missing = client.post(f'/api/boards/{slug}/assistant/proposals/prop_missing', headers=auth, json={'action': 'approve'})
        assert missing.status_code == 404 and missing.json()['error'] == 'proposal_not_found'


def test_encoded_record_limit_includes_envelope(board):
    with pytest.raises(EventError):
        board.apply({'type': 'project/metaUpdated', 'patch': {'notes': 'x' * 999900}})
    assert board.seq == 1


def test_public_event_cannot_forge_proposal_receipt(board):
    with pytest.raises(EventError):
        board.apply({'type': 'board/batch', 'events': [{'type': 'project/metaUpdated', 'patch': {}}], 'proposalId': 'forged'})
