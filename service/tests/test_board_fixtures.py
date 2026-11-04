"""Checked-in sample boards (tests/fixtures/boards, see its README). They are never regenerated here."""
import json
import shutil
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from pcbv import cli
from pcbv.board import Board, JOURNAL_REL
from pcbv.journal import JournalError
from pcbv.server import create_app

FIXTURES = Path(__file__).parent / 'fixtures' / 'boards'
UNSUPPORTED = {
    'unversioned': ('journal', 'missing'),
    'v1': ('journal', '1'),
    'future-v3': ('journal', '3'),
    'snapshot-v1': ('snapshot', '1'),
}
REFUSED = [(name, *case) for name, case in UNSUPPORTED.items()]
SNAPSHOT = 'project.pcb.json'


def copy_fixture(name, destination):
    shutil.copytree(FIXTURES / name, destination)
    return destination


def tree(directory):
    """Every file with its bytes and every directory, so a created folder counts as a change."""
    return {str(p.relative_to(directory)): (p.read_bytes() if p.is_file() else None)
            for p in sorted(directory.rglob('*'))}


def assert_refusal(message, kind, found):
    assert f'unsupported {kind} version {found}' in message
    assert f'reads {kind} version 2' in message
    assert 'Recreate the test board' in message


@pytest.fixture(autouse=True)
def isolated_runtime_dir(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(tmp_path / 'run'))


def test_current_fixture_replays_to_its_checked_in_snapshot(tmp_path):
    directory = copy_fixture('current', tmp_path / 'board')
    with Board.open(directory) as board:
        assert board.warnings == []
        assert [event['seq'] for event in board.events] == list(range(1, 7))
        assert board.events[-1]['type'] == 'board/batch' and len(board.events[-1]['events']) == 3
        assert board.project == json.loads((FIXTURES / 'current' / SNAPSHOT).read_text())
        assert (directory / board.project['assets'][0]['path']).is_file()


def test_current_fixture_round_trips_through_rebuild(tmp_path):
    directory = copy_fixture('current', tmp_path / 'board')
    journal = directory / JOURNAL_REL
    original_journal = journal.read_bytes()
    original_snapshot = (directory / SNAPSHOT).read_bytes()

    def open_once():
        with Board.open(directory) as board:
            return board.project, [event['seq'] for event in board.events], board.warnings

    first = open_once()
    (directory / SNAPSHOT).unlink()
    rebuilt = open_once()
    again = open_once()

    assert first == rebuilt == again
    assert first[1] == list(range(1, 7)) and first[2] == []
    assert journal.read_bytes() == original_journal
    assert (directory / SNAPSHOT).read_bytes() == original_snapshot


def test_interrupted_rebuild_leaves_journal_alone_and_next_open_rebuilds(tmp_path, monkeypatch):
    directory = copy_fixture('current', tmp_path / 'board')
    journal = directory / JOURNAL_REL
    original_journal = journal.read_bytes()
    original_snapshot = (directory / SNAPSHOT).read_bytes()
    (directory / SNAPSHOT).unlink()

    with monkeypatch.context() as patch:
        patch.setattr(Board, '_write_snapshot', lambda self: (_ for _ in ()).throw(OSError('disk error')))
        with Board.open(directory) as board:
            assert 'snapshot_dirty' in board.warnings and board.seq == 6
    assert journal.read_bytes() == original_journal
    assert not (directory / SNAPSHOT).exists()

    with Board.open(directory) as board:
        assert board.warnings == [] and board.seq == 6
    assert (directory / SNAPSHOT).read_bytes() == original_snapshot
    assert journal.read_bytes() == original_journal


@pytest.mark.parametrize('name,kind,found', REFUSED)
def test_unsupported_fixture_is_refused_by_board_open_without_a_trace(tmp_path, name, kind, found):
    directory = copy_fixture(name, tmp_path / 'board')
    before = tree(directory)
    with pytest.raises(JournalError) as caught:
        Board.open(directory)
    assert_refusal(str(caught.value), kind, found)
    assert tree(directory) == before


@pytest.mark.parametrize('name,kind,found', REFUSED)
def test_unsupported_fixture_is_refused_by_the_api_without_a_trace(tmp_path, name, kind, found):
    root = tmp_path / 'boards'
    directory = copy_fixture(name, root / name)
    before = tree(directory)
    headers = {'Authorization': 'Bearer test', 'X-PCBV-Protocol': '2'}
    app = create_app(root, 'test')
    with TestClient(app, base_url='http://localhost') as client:
        response = client.get(f'/api/boards/{name}', headers=headers)
        assert response.status_code == 503
        assert response.json()['error'] == 'recovery_required'
        assert_refusal(response.json()['message'], kind, found)
        assert not app.state.registry.entries
    assert tree(directory) == before


@pytest.mark.parametrize('argv', [['status'], ['note', '{name}', 'hello']])
@pytest.mark.parametrize('name,kind,found', REFUSED)
def test_unsupported_fixture_is_refused_by_the_cli_without_a_trace(tmp_path, capsys, argv, name, kind, found):
    root = tmp_path / 'boards'
    directory = copy_fixture(name, root / name)
    before = tree(directory)
    code = cli.main(['--root', str(root), *[word.format(name=name) for word in argv]])
    assert code == 1
    assert_refusal(capsys.readouterr().err, kind, found)
    assert tree(directory) == before
