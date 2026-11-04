import json
import os

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from pcbv.board import Board
from pcbv.fsutil import Directory
from pcbv.journal import StorageError
from pcbv.server import create_app

AUTH = {'Authorization': 'Bearer test', 'X-PCBV-Protocol': '2'}


def test_terminal_refuses_frozen_board_before_starting_shell(tmp_path, monkeypatch):
    from pcbv import server
    app = create_app(tmp_path, 'test')
    with TestClient(app, base_url='http://localhost') as client:
        slug = client.post('/api/boards', headers=AUTH, json={'name': 'test'}).json()['slug']
        app.state.registry.get(slug).board.writable = False
        def forbidden(**kwargs):
            pytest.fail('a frozen board must not start a shell')
        monkeypatch.setattr(server.terminal, 'TerminalSession', forbidden)
        with client.websocket_connect(f'/api/boards/{slug}/terminal', headers={'host': 'localhost'}) as ws:
            ws.send_json({'op': 'auth', 'token': 'test', 'protocol': 2})
            assert ws.receive_json()['error'] == 'recovery_required'
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


def test_unknown_commit_notifies_other_connected_windows(tmp_path, monkeypatch):
    app = create_app(tmp_path, 'test')
    with TestClient(app, base_url='http://localhost') as client:
        slug = client.post('/api/boards', headers=AUTH, json={'name': 'test'}).json()['slug']
        board = app.state.registry.get(slug).board
        with client.websocket_connect(f'/api/boards/{slug}/ws', headers={'host': 'localhost'}) as watcher:
            watcher.send_json({'op': 'auth', 'token': 'test', 'protocol': 2})
            assert watcher.receive_json()['op'] == 'snapshot'
            assert watcher.receive_json()['op'] == 'serial'
            def unknown(event):
                raise StorageError('commit_unknown', 'injected failure')
            monkeypatch.setattr(board._journal, 'append', unknown)
            response = client.post(f'/api/boards/{slug}/events', headers=AUTH, json={
                'event': {'type': 'project/metaUpdated', 'patch': {'name': 'uncertain'}}})
            assert response.status_code == 503
            watcher.send_json({'op': 'ping'})
            message = watcher.receive_json()
            assert message['op'] == 'storage'
            assert message['storage']['writable'] is False
            assert watcher.receive_json()['op'] == 'pong'


def test_retry_syncs_directory_entry_after_failed_parent_sync(tmp_path, monkeypatch):
    with Directory(tmp_path) as files:
        real_sync = os.fsync
        def fail_parent(fd):
            if os.fstat(fd).st_ino == os.fstat(files.fd).st_ino:
                raise OSError('parent sync failed')
            real_sync(fd)
        with monkeypatch.context() as patch:
            patch.setattr(os, 'fsync', fail_parent)
            with pytest.raises(OSError):
                files.create_bytes('new/file', b'data')
        synced = []
        def trace(fd):
            synced.append(os.fstat(fd).st_ino)
            real_sync(fd)
        with monkeypatch.context() as patch:
            patch.setattr(os, 'fsync', trace)
            files.create_bytes('new/file', b'data')
        assert tmp_path.stat().st_ino in synced


def test_creation_syncs_all_new_ancestor_entries(tmp_path, monkeypatch):
    real_sync = os.fsync
    synced = []
    def trace(fd):
        synced.append(os.fstat(fd).st_ino)
        real_sync(fd)
    monkeypatch.setattr(os, 'fsync', trace)
    with Board.create(tmp_path / 'newroot/boards/test', 'test'):
        assert tmp_path.stat().st_ino in synced
        assert (tmp_path / 'newroot').stat().st_ino in synced


def test_nonstandard_json_outside_edit_is_preserved_before_valid_mutation(tmp_path):
    with Board.create(tmp_path / 'board', 'test') as board:
        path = board.directory / 'project.pcb.json'
        raw = json.loads(path.read_bytes())
        raw['meta']['extension'] = float('nan')
        content = json.dumps(raw).encode()
        path.write_bytes(content)
        board.apply({'type': 'project/metaUpdated', 'patch': {'notes': 'valid request'}})
        assert board.seq == 2
        saved = board.warning_details['external_edit_preserved']['path']
        assert (board.directory / saved).read_bytes() == content


@pytest.mark.parametrize('damage', ['complete_record', 'old_version'])
def test_first_open_failure_returns_recovery_required_without_changes(tmp_path, damage):
    with Board.create(tmp_path / 'test', 'test'):
        pass
    path = tmp_path / 'test/journal/events.jsonl'
    if damage == 'old_version':
        first = json.loads(path.read_text())
        first['journalVersion'] = 1
        path.write_text(json.dumps(first) + '\n')
    else:
        with path.open('ab') as handle:
            handle.write(json.dumps({'journalVersion': 2, 'seq': 2, 'ts': '2026-10-29T00:00:00.000Z',
                                     'actor': 'test', 'type': 'broken/complete'}).encode() + b'\n')
    before = {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    with TestClient(create_app(tmp_path, 'test'), base_url='http://localhost') as client:
        response = client.get('/api/boards/test', headers=AUTH)
        assert response.status_code == 503
        assert response.json()['error'] == 'recovery_required'
        if damage == 'old_version':
            assert 'pcbv new' in response.json()['message']
        with client.websocket_connect('/api/boards/test/ws', headers={'host': 'localhost'}) as ws:
            ws.send_json({'op': 'auth', 'token': 'test', 'protocol': 2})
            assert ws.receive_json()['error'] == 'recovery_required'
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 1011
    assert before == {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
