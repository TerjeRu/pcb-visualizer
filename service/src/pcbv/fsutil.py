"""Directory-relative file operations that never follow board-derived symlinks."""
from __future__ import annotations

import os
import secrets
import stat
from contextlib import contextmanager
from pathlib import Path


class AtomicWriteError(OSError):
    def __init__(self, cause: OSError, *, replaced: bool):
        super().__init__(cause.errno, str(cause))
        self.replaced = replaced


def write_all(fd: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        count = os.write(fd, remaining)
        if count <= 0:
            raise OSError("write made no progress")
        remaining = remaining[count:]


class Directory:
    def __init__(self, path: Path):
        self.fd = os.dup(path.fd) if isinstance(path, Directory) else os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)

    def close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    @contextmanager
    def parent(self, relative: str | Path, *, create: bool = False):
        value = str(relative)
        parts = value.split('/')
        if '\\' in value or '\x00' in value or any(p in ('', '.', '..') for p in parts):
            raise ValueError("expected a plain relative path without empty, dot or parent components")
        fd = os.dup(self.fd)
        try:
            for part in parts[:-1]:
                if create:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                if create:
                    try:
                        os.fsync(child)
                        os.fsync(fd)
                    except BaseException:
                        os.close(child)
                        raise
                os.close(fd)
                fd = child
            yield fd, parts[-1]
        finally:
            os.close(fd)

    def open(self, relative: str | Path, flags: int = os.O_RDONLY, *, create_parents: bool = False) -> int:
        with self.parent(relative, create=create_parents) as (parent, name):
            fd = os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o600, dir_fd=parent)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise OSError("expected a regular file")
                return fd
            except BaseException:
                os.close(fd)
                raise

    def subdirectory(self, relative, *, create=False):
        with self.parent(str(relative) + "/entry", create=create) as (parent, _):
            child = object.__new__(Directory)
            child.fd = os.dup(parent)
            return child

    def read_bytes(self, relative: str | Path) -> bytes:
        with os.fdopen(self.open(relative), 'rb') as handle:
            return handle.read()

    def unlink(self, relative: str | Path, *, missing_ok: bool = False) -> None:
        try:
            with self.parent(relative) as (parent, name):
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise OSError("cleanup requires a regular file")
                os.unlink(name, dir_fd=parent)
                os.fsync(parent)
        except FileNotFoundError:
            if not missing_ok:
                raise

    def remove_tree(self, relative: str | Path) -> None:
        """Delete a folder with everything in it. A symlink inside is removed as a link; nothing is followed."""
        with self.parent(relative) as (parent, name):
            _remove_entry(parent, name)
            os.fsync(parent)

    def walk(self, *, include_symlinks=False):
        def visit(fd, prefix):
            for name in sorted(os.listdir(fd)):
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                relative = f"{prefix}/{name}" if prefix else name
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        yield from visit(child, relative)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode) or include_symlinks and stat.S_ISLNK(info.st_mode):
                    yield relative
        yield from visit(self.fd, "")

    def create_bytes(self, relative: str | Path, data: bytes) -> None:
        with self.parent(relative, create=True) as (parent, name):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                write_all(fd, data)
                os.fsync(fd)
                os.fsync(parent)
            finally:
                os.close(fd)

    def atomic_write(self, relative: str | Path, data: bytes) -> None:
        with self.parent(relative, create=True) as (parent, name):
            mode = 0o600
            try:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                if not stat.S_ISREG(info.st_mode):
                    raise OSError("replacement requires a regular file")
                mode = stat.S_IMODE(info.st_mode)
            temporary = f'.{name}.{secrets.token_hex(16)}.tmp'
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            replaced = False
            try:
                os.fchmod(fd, mode)
                write_all(fd, data)
                os.fsync(fd)
                os.close(fd)
                fd = None
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                replaced = True
                os.fsync(parent)
            except OSError as exc:
                raise AtomicWriteError(exc, replaced=replaced) from exc
            finally:
                if fd is not None:
                    os.close(fd)
                if not replaced:
                    os.unlink(temporary, dir_fd=parent)


def _remove_entry(parent: int, name: str) -> None:
    if stat.S_ISDIR(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            for entry in os.listdir(child):
                _remove_entry(child, entry)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)


def ensure_directory(path: Path) -> None:
    absolute = Path(path).absolute()
    with Directory(absolute.anchor) as anchor:
        relative = "/".join(absolute.parts[1:])
        if relative:
            with anchor.subdirectory(relative, create=True):
                pass
        else:
            os.fsync(anchor.fd)


def atomic_write(path: Path, data: bytes) -> None:
    with Directory(path.parent) as directory:
        directory.atomic_write(path.name, data)


class File:
    """A file reference whose reads always traverse with no-follow descriptors."""
    def __init__(self, root: Path, relative: str):
        self.root, self.relative = root, relative

    def open(self, mode="rb"):
        if mode != "rb":
            raise ValueError("confined file references are read-only binary streams")
        with Directory(self.root) as directory:
            return os.fdopen(directory.open(self.relative), mode)

    def read_bytes(self):
        with self.open() as handle:
            return handle.read()

    def read_text(self, encoding="utf-8", errors="strict"):
        return self.read_bytes().decode(encoding, errors)


def open_capture(root: Path, relative: str):
    with Directory(root) as directory:
        fd = directory.open(relative, os.O_WRONLY | os.O_CREAT | os.O_EXCL, create_parents=True)
        try:
            with directory.parent(relative) as (parent, _):
                os.fsync(fd)
                os.fsync(parent)
            stream = os.fdopen(fd, "ab", buffering=0)
            fd = None
            return stream
        finally:
            if fd is not None:
                os.close(fd)
