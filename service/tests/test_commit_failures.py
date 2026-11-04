import os

import pytest

from pcbv.board import Board
from pcbv.journal import Journal, StorageError


def test_short_journal_writes_complete(tmp_path, monkeypatch):
    journal = Journal(tmp_path / 'events')
    real = os.write
    monkeypatch.setattr(os, 'write', lambda fd, data: real(fd, data[:3]))
    journal.append({'seq': 1})
    journal.close()
    assert (tmp_path / 'events').read_bytes() == b'{"seq":1}\n'


def test_failed_append_rolls_back_and_allows_next_write(tmp_path, monkeypatch):
    journal = Journal(tmp_path / 'events')
    journal.append({'seq': 1})
    before = (tmp_path / 'events').read_bytes()
    real = os.write
    calls = 0

    def failing(fd, data):
        nonlocal calls
        calls += 1
        if calls == 1:
            return real(fd, data[:4])
        raise OSError('disk error')

    with monkeypatch.context() as patch:
        patch.setattr(os, 'write', failing)
        with pytest.raises(StorageError) as caught:
            journal.append({'seq': 2})
        assert caught.value.code == 'not_committed'
    assert (tmp_path / 'events').read_bytes() == before
    journal.append({'seq': 2})
    journal.close()
    assert (tmp_path / 'events').read_bytes() == before + b'{"seq":2}\n'


def test_failed_rollback_freezes_board(board, monkeypatch):
    def fail(*args):
        raise OSError('disk unavailable')

    with monkeypatch.context() as patch:
        patch.setattr(os, 'write', fail)
        patch.setattr(os, 'ftruncate', fail)
        with pytest.raises(StorageError) as caught:
            board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'uncertain'}})
    assert caught.value.code == 'commit_unknown'
    assert not board.writable
    assert board.seq == 1
    with pytest.raises(StorageError) as caught:
        board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'later'}})
    assert caught.value.code == 'recovery_required'
    directory = board.directory
    board.close()
    with Board.open(directory) as reopened:
        assert reopened.writable
        assert reopened.seq == 1


def test_snapshot_failure_keeps_commit_and_retries(board, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(Board, '_write_snapshot', lambda self: (_ for _ in ()).throw(OSError('snapshot failure')))
        event = board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'committed'}})
    assert event['seq'] == 2
    assert board.project['meta']['name'] == 'committed'
    assert 'snapshot_dirty' in board.warnings
    board.apply({'type': 'project/metaUpdated', 'patch': {'device': 'next'}})
    assert 'snapshot_dirty' not in board.warnings
    directory = board.directory
    board.close()
    with Board.open(directory) as reopened:
        assert reopened.project['meta']['name'] == 'committed'


def test_preservation_failure_leaves_snapshot_untouched(board, monkeypatch):
    from pcbv.fsutil import Directory
    snapshot = board.directory / 'project.pcb.json'
    snapshot.write_bytes(b'{outside broken edit')
    with monkeypatch.context() as patch:
        patch.setattr(Directory, 'create_bytes', lambda *args: (_ for _ in ()).throw(OSError('no space')))
        with pytest.raises(StorageError) as caught:
            board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'requested'}})
    assert caught.value.code == 'recovery_required'
    assert snapshot.read_bytes() == b'{outside broken edit'
    assert board.seq == 1


def test_photo_survives_snapshot_failure(tmp_path, monkeypatch):
    import io
    from PIL import Image
    from starlette.testclient import TestClient
    from pcbv.server import create_app

    root = tmp_path / 'boards'
    root.mkdir()
    auth = {'X-PCBV-Protocol': '2', 'Authorization': 'Bearer test-session'}
    data = io.BytesIO()
    Image.new('RGB', (2, 2)).save(data, 'JPEG')
    with TestClient(create_app(root, 'test-session'), base_url='http://localhost') as client:
        slug = client.post('/api/boards', headers=auth, json={'name': 'test'}).json()['slug']
        with monkeypatch.context() as patch:
            patch.setattr(Board, '_write_snapshot', lambda self: (_ for _ in ()).throw(OSError('disk error')))
            response = client.post(f'/api/boards/{slug}/assets', headers=auth, content=data.getvalue())
        assert response.status_code == 201
        asset = response.json()['event']['asset']
        assert (root / slug / asset['path']).is_file()
        assert (root / slug / asset['original']).is_file()


@pytest.mark.parametrize('rollback_fails', [False, True])
def test_journal_fsync_failure_has_explicit_restart_outcome(tmp_path, monkeypatch, rollback_fails):
    with Board.create(tmp_path / 'board', 'original') as board:
        real_fsync = os.fsync
        journal_fd = board._journal._fd
        calls = 0
        def fail_sync(fd):
            nonlocal calls
            if fd == journal_fd:
                calls += 1
                if calls == 1 or rollback_fails:
                    raise OSError('injected fsync failure')
            return real_fsync(fd)
        with monkeypatch.context() as patch:
            patch.setattr(os, 'fsync', fail_sync)
            with pytest.raises(StorageError) as caught:
                board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'candidate'}})
        assert caught.value.code == ('commit_unknown' if rollback_fails else 'not_committed')
        assert board.project['meta']['name'] == 'original'
    with Board.open(tmp_path / 'board') as reopened:
        assert reopened.seq == 1 and reopened.writable


def test_complete_record_with_unknown_rollback_recovers_on_reopen(tmp_path, monkeypatch):
    with Board.create(tmp_path / 'board', 'original') as board:
        fd = board._journal._fd
        real_fsync = os.fsync
        def fail_sync(target):
            if target == fd:
                raise OSError('journal fsync unavailable')
            real_fsync(target)
        with monkeypatch.context() as patch:
            patch.setattr(os, 'fsync', fail_sync)
            patch.setattr(os, 'ftruncate', lambda *args: (_ for _ in ()).throw(OSError('truncate failed')))
            with pytest.raises(StorageError, match='rollback'):
                board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'candidate'}})
        assert board.seq == 1 and not board.writable
    with Board.open(tmp_path / 'board') as reopened:
        assert reopened.seq == 2 and reopened.project['meta']['name'] == 'candidate'
        assert reopened.writable


def test_external_edit_during_dirty_snapshot_is_preserved(board, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(Board, '_write_snapshot', lambda self: (_ for _ in ()).throw(OSError('disk error')))
        board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'committed'}})
    path = board.directory / 'project.pcb.json'
    path.write_bytes(b'{external edit while dirty')
    board.apply({'type': 'project/metaUpdated', 'patch': {'device': 'next'}})
    relative = board.warning_details['external_edit_preserved']['path']
    assert (board.directory / relative).read_bytes() == b'{external edit while dirty'
    assert 'snapshot_dirty' not in board.warnings


def test_repeated_reopen_retains_recovery_copy_without_repeating_notice(tmp_path):
    with Board.create(tmp_path / 'board', 'test') as board:
        snapshot = board.directory / 'project.pcb.json'
    content = b'{invalid outside file'
    snapshot.write_bytes(content)
    with Board.open(tmp_path / 'board') as reopened:
        relative = reopened.warning_details['external_edit_preserved']['path']
        assert (reopened.directory / relative).read_bytes() == content
    with Board.open(tmp_path / 'board') as reopened:
        assert 'external_edit_preserved' not in reopened.warnings
        assert (reopened.directory / relative).read_bytes() == content
