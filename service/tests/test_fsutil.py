import os
import stat

import pytest

from pcbv.fsutil import AtomicWriteError, Directory, atomic_write


def test_atomic_write_ignores_predictable_temp_symlink(tmp_path):
    outside = tmp_path / 'outside'
    outside.write_bytes(b'sentinel')
    target = tmp_path / 'settings.json'
    target.with_suffix('.json.tmp').symlink_to(outside)
    atomic_write(target, b'new')
    assert outside.read_bytes() == b'sentinel'
    assert target.read_bytes() == b'new'
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    target.chmod(0o640)
    atomic_write(target, b'next')
    assert stat.S_IMODE(target.stat().st_mode) == 0o640


@pytest.mark.parametrize('relative', ['/outside', '../outside', 'a/../outside', './outside', 'a//outside', ''])
def test_rejects_unsafe_components(tmp_path, relative):
    with Directory(tmp_path) as directory, pytest.raises(ValueError):
        directory.read_bytes(relative)


def test_ancestor_and_leaf_symlinks_refused(tmp_path):
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'sentinel').write_bytes(b'safe')
    board = tmp_path / 'board'
    board.mkdir()
    (board / 'assets').symlink_to(outside, target_is_directory=True)
    (board / 'file').symlink_to(outside / 'sentinel')
    with Directory(board) as directory:
        for relative in ('assets/sentinel', 'file'):
            with pytest.raises(OSError):
                directory.read_bytes(relative)
            with pytest.raises(OSError):
                directory.atomic_write(relative, b'bad')
            with pytest.raises(OSError):
                directory.unlink(relative)
    assert (outside / 'sentinel').read_bytes() == b'safe'


def test_open_directory_survives_path_substitution(tmp_path):
    board = tmp_path / 'board'
    board.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    with Directory(board) as directory:
        board.rename(tmp_path / 'moved')
        board.symlink_to(outside, target_is_directory=True)
        directory.atomic_write('snapshot', b'anchored')
    assert (tmp_path / 'moved/snapshot').read_bytes() == b'anchored'
    assert not (outside / 'snapshot').exists()


def test_post_replace_failure_is_distinguished(tmp_path, monkeypatch):
    target = tmp_path / 'snapshot'
    target.write_bytes(b'old')
    real_fsync = os.fsync

    def fail_directory(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError('directory fsync failed')
        real_fsync(fd)

    monkeypatch.setattr(os, 'fsync', fail_directory)
    with pytest.raises(AtomicWriteError) as caught:
        atomic_write(target, b'new')
    assert caught.value.replaced
    assert target.read_bytes() == b'new'
    assert sorted(p.name for p in tmp_path.iterdir()) == ['snapshot']


def test_photo_ingest_refuses_symlinked_assets(tmp_path):
    import io
    from PIL import Image
    from pcbv.photos import ingest

    outside = tmp_path / 'outside'
    outside.mkdir()
    board = tmp_path / 'board'
    board.mkdir()
    (board / 'assets').symlink_to(outside, target_is_directory=True)
    data = io.BytesIO()
    Image.new('RGB', (2, 2)).save(data, 'JPEG')
    with pytest.raises(OSError):
        ingest(board, data.getvalue())
    assert list(outside.iterdir()) == []


def test_capture_reference_refuses_ancestor_swap(tmp_path):
    from pcbv.photos import resolve_file

    captures = tmp_path / 'captures'
    captures.mkdir()
    (captures / 'boot.log').write_bytes(b'capture')
    reference = resolve_file(tmp_path, 'captures/boot.log')
    captures.rename(tmp_path / 'original')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'boot.log').write_bytes(b'secret')
    captures.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        reference.read_bytes()


@pytest.mark.parametrize('boundary', ['write', 'file_sync', 'replace'])
def test_atomic_failure_before_replacement_keeps_original(tmp_path, monkeypatch, boundary):
    target = tmp_path / 'state'
    target.write_bytes(b'old')

    def fail(*args, **kwargs):
        raise OSError('injected failure')

    monkeypatch.setattr(os, {'write': 'write', 'file_sync': 'fsync', 'replace': 'replace'}[boundary], fail)
    with pytest.raises(AtomicWriteError) as caught:
        atomic_write(target, b'new')
    assert not caught.value.replaced
    assert target.read_bytes() == b'old'
    assert sorted(p.name for p in tmp_path.iterdir()) == ['state']


def test_atomic_write_completes_partial_writes(tmp_path, monkeypatch):
    real_write = os.write
    monkeypatch.setattr(os, 'write', lambda fd, data: real_write(fd, data[:2]))
    atomic_write(tmp_path / 'state', b'complete bytes')
    assert (tmp_path / 'state').read_bytes() == b'complete bytes'


def test_atomic_write_refuses_zero_progress(tmp_path, monkeypatch):
    monkeypatch.setattr(os, 'write', lambda fd, data: 0)
    with pytest.raises(AtomicWriteError):
        atomic_write(tmp_path / 'state', b'new')
    assert list(tmp_path.iterdir()) == []


def test_export_does_not_read_symlinked_capture_ancestor(tmp_path):
    from pcbv.export import _latest_serial_log
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'boot.log').write_text('private serial output')
    board = tmp_path / 'board'
    board.mkdir()
    (board / 'captures').symlink_to(outside, target_is_directory=True)
    project = {'captures': [{'kind': 'serial', 'path': 'captures/boot.log'}]}
    assert _latest_serial_log(board, project) is None


def test_open_board_remains_anchored_after_board_path_swap(tmp_path):
    from pcbv.board import Board
    original = tmp_path / 'board'
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'project.pcb.json').write_bytes(b'sentinel')
    with Board.create(original, 'test') as board:
        original.rename(tmp_path / 'moved')
        original.symlink_to(outside, target_is_directory=True)
        board.apply({'type': 'project/metaUpdated', 'patch': {'name': 'anchored'}})
        assert board.project['meta']['name'] == 'anchored'
    assert (outside / 'project.pcb.json').read_bytes() == b'sentinel'
    assert b'anchored' in (tmp_path / 'moved/project.pcb.json').read_bytes()


@pytest.mark.parametrize('boundary', ['file', 'directory', 'stream'])
def test_failed_capture_creation_closes_descriptor(tmp_path, monkeypatch, boundary):
    from pcbv.fsutil import open_capture

    (tmp_path / 'captures').mkdir()
    opened = []
    real_open = Directory.open
    real_fsync = os.fsync

    def track_open(self, *args, **kwargs):
        fd = real_open(self, *args, **kwargs)
        opened.append(fd)
        return fd

    def fail_sync(fd):
        is_directory = stat.S_ISDIR(os.fstat(fd).st_mode)
        if opened and ((boundary == 'directory' and is_directory) or (boundary == 'file' and not is_directory)):
            raise OSError('injected sync failure')
        real_fsync(fd)

    def fail_stream(*args, **kwargs):
        raise OSError('injected stream failure')

    monkeypatch.setattr(Directory, 'open', track_open)
    monkeypatch.setattr(os, 'fsync', fail_sync)
    if boundary == 'stream':
        monkeypatch.setattr(os, 'fdopen', fail_stream)
    for index in range(3):
        opened.clear()
        with pytest.raises(OSError, match='injected'):
            open_capture(tmp_path, f'captures/{index}.log')
        with pytest.raises(OSError):
            os.fstat(opened[-1])
