import shutil
import subprocess

import pytest

from pcbv import cli, datarepo, github, settings
from pcbv.board import Board
from pcbv.datarepo import RepoError, commit_message, git, guard_problem, init_repo, run, sync

import helpers as h

needs_gitleaks = pytest.mark.skipif(shutil.which("gitleaks") is None, reason="gitleaks not installed")


@pytest.fixture(autouse=True)
def isolated_git(tmp_path, monkeypatch):
    """Keep the user's global git config (signing, hooks, identity) out of the tests."""
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for var in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{var}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{var}_EMAIL", "test@example.invalid")
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "hw"
    init_repo(path)
    return path


def log(repo):
    return git(repo, "log", "--format=%s", check=False).stdout.splitlines()


def test_init_lays_out_the_repo_and_activates_the_guard(repo):
    for folder in ["boards", "wiki", "library/datasheets", "playbooks", "journal"]:
        assert (repo / folder).is_dir()
    assert (repo / ".gitignore").read_text().startswith("#")
    assert (repo / ".gitleaks.toml").is_file()
    assert (repo / ".githooks/pre-commit").stat().st_mode & 0o100
    assert git(repo, "config", "core.hooksPath").stdout.strip() == ".githooks"


def test_init_is_idempotent_and_keeps_edits(repo):
    (repo / ".gitignore").write_text("mine\n")
    git(repo, "config", "--unset", "core.hooksPath")
    assert init_repo(repo) == []
    assert (repo / ".gitignore").read_text() == "mine\n"
    assert guard_problem(repo) in (None, "gitleaks is not installed, so the secret scan cannot run; "
                                         "install it with: sudo pacman -S gitleaks")


def test_sync_refuses_without_the_guard(repo):
    git(repo, "config", "--unset", "core.hooksPath")
    with pytest.raises(RepoError, match="pcbv repo init"):
        sync(repo, push=False)
    assert log(repo) == []


@needs_gitleaks
def test_guard_blocks_dumps_and_big_files_and_leaves_nothing_staged(repo):
    (repo / "boards/x/dumps").mkdir(parents=True)
    (repo / "boards/x/dumps/flash.bin").write_bytes(b"\0" * 10)
    git(repo, "add", "-f", "boards/x/dumps/flash.bin")
    with pytest.raises(RepoError, match="never committed"):
        sync(repo, push=False)
    assert git(repo, "diff", "--cached", "--name-only").stdout == ""

    (repo / "boards/x/dumps/flash.bin").unlink()
    (repo / "wiki/big.bin").write_bytes(b"\0" * (5 * 1024 * 1024 + 1))
    with pytest.raises(RepoError, match="5 MB"):
        sync(repo, push=False)
    assert log(repo) == []


@needs_gitleaks
@pytest.mark.parametrize("line", [
    "wpa_passphrase=Sup3rS3cretWifi",
    "ppp_password: hunter2isnotsafe",
    "root:$6$saltsalt$Zx0kq3Jx3lR9sQ1hY2wV8uN4mP6tB7cD5eF1gH2iJ3kL4mN5oP6qR7sT8uV9wX0yZ1aB2cD3eF4gH5iJ6kL7m:19000:0",
])
def test_guard_catches_router_secrets(repo, line):
    (repo / "boards/x").mkdir(parents=True)
    (repo / "boards/x/bootlog.txt").write_text(f"booting\n{line}\n")
    with pytest.raises(RepoError, match="secret"):
        sync(repo, push=False)
    assert log(repo) == []


@needs_gitleaks
def test_guard_lets_a_login_prompt_through(repo):
    """A prompt at the end of a line has no value; the next line is ordinary boot output."""
    (repo / "boards/x").mkdir(parents=True)
    (repo / "boards/x/bootlog.txt").write_text("OpenWrt login: root\nPassword:\nBusyBox v1.24.1 built-in shell (ash)\n")
    sync(repo, push=False)
    assert len(log(repo)) == 1


@needs_gitleaks
def test_sync_commits_with_a_message_from_the_journal_and_pushes(repo, tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    git(repo, "remote", "add", "origin", str(remote))

    board = Board.create(repo / "boards/demo", "Demo")
    board.apply(h.add_asset(), "test")
    board.close()
    report = sync(repo)
    assert report[-1] == "pushed main to origin"
    assert log(repo)[0] == "Sync demo (+2 events)"
    body = git(repo, "log", "-1", "--format=%b").stdout
    assert "1 x asset/added" in body and "1 x project/created" in body
    assert "other files" in body
    assert git(remote, "log", "--format=%s", "main").stdout.splitlines()[0] == "Sync demo (+2 events)"

    assert sync(repo)[0] == "nothing to commit"


@pytest.fixture
def diverged(repo, tmp_path):
    """A repo whose next sync conflicts: the remote changed wiki/note.md and so did the working tree."""
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    git(repo, "remote", "add", "origin", str(remote))
    (repo / "wiki/note.md").write_text("base\n")
    sync(repo)
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(remote), str(other)], check=True)
    (other / "wiki/note.md").write_text("theirs\n")
    git(other, "commit", "-qam", "Other machine")
    git(other, "push", "-q", "origin", "main")
    (repo / "wiki/note.md").write_text("mine\n")
    return repo


def rebase_state(repo):
    folder = repo / ".git" / "rebase-merge"
    return {str(p.relative_to(folder)): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}


@needs_gitleaks
def test_a_conflicting_sync_aborts_its_own_rebase_and_keeps_the_commit(diverged):
    with pytest.raises(RepoError, match="rebase was aborted"):
        sync(diverged)
    assert not (diverged / ".git" / "rebase-merge").exists() and not (diverged / ".git" / "rebase-apply").exists()
    assert git(diverged, "status", "--porcelain").stdout == ""
    assert (diverged / "wiki/note.md").read_text() == "mine\n"
    assert log(diverged)[0] == "Sync 1 file"


@needs_gitleaks
def test_sync_refuses_while_a_rebase_is_in_progress_and_leaves_it_alone(diverged):
    git(diverged, "add", "-A")
    git(diverged, "commit", "-qm", "mine")
    assert git(diverged, "pull", "-q", "--rebase", "origin", "main", check=False).returncode != 0
    before = rebase_state(diverged)
    note = (diverged / "wiki/note.md").read_bytes()
    assert before and b"<<<<<<<" in note
    (diverged / "wiki/extra.md").write_text("new\n")
    with pytest.raises(RepoError, match="rebase is already in progress"):
        sync(diverged)
    assert rebase_state(diverged) == before
    assert (diverged / "wiki/note.md").read_bytes() == note
    assert git(diverged, "diff", "--cached", "--name-only").stdout.strip() == "wiki/note.md"


def test_message_for_non_board_changes(repo):
    (repo / "wiki/uart.md").write_text("# UART\n")
    git(repo, "add", "-A")
    assert commit_message(repo).startswith("Sync 1")


@needs_gitleaks
def test_cli_repo_init_and_sync(tmp_path, capsys):
    root = tmp_path / "hw" / "boards"
    assert cli.main(["--root", str(root), "repo", "init"]) == 0
    assert "guard      active" in capsys.readouterr().out
    assert cli.main(["--root", str(root), "new", "Demo"]) == 0
    assert cli.main(["--root", str(root), "sync", "--no-push"]) == 0
    out = capsys.readouterr().out
    assert "committed: Sync demo (+1 events)" in out and "not pushed" in out


def test_cli_sync_outside_a_repo(tmp_path, capsys):
    root = tmp_path / "boards"
    root.mkdir()
    assert cli.main(["--root", str(root), "sync"]) == 1
    assert "Settings" in capsys.readouterr().err       # git is off by default
    settings.save({"git": "on"}, root)
    assert cli.main(["--root", str(root), "sync"]) == 1
    assert "pcbv repo init" in capsys.readouterr().err


@needs_gitleaks
def test_guard_lets_masked_passwords_through(repo):
    (repo / "boards/x").mkdir(parents=True)
    (repo / "boards/x/bootlog.txt").write_text("login: admin\nPassword: ********\n")
    assert sync(repo, push=False)[0].startswith("committed")


@needs_gitleaks
def test_board_history_lists_commits_for_that_board_only(repo):
    from pcbv.datarepo import board_history
    Board.create(repo / "boards/demo", "Demo").close()
    sync(repo, push=False)
    (repo / "wiki/x.md").write_text("# X\n")
    sync(repo, push=False, message="Wiki only")
    history = board_history(repo / "boards/demo")
    assert [c["subject"] for c in history] == ["Sync demo (+1 events)"]
    assert len(history[0]["hash"]) == 40 and history[0]["date"][:2] == "20"


def test_board_history_outside_a_repo_is_empty(tmp_path):
    from pcbv.datarepo import board_history
    assert board_history(tmp_path) == []


def test_git_never_opens_a_password_window(tmp_path, monkeypatch):
    marker = tmp_path / "asked"
    askpass = tmp_path / "askpass"
    askpass.write_text(f"#!/bin/sh\necho asked >> {marker}\necho secret\n")
    askpass.chmod(0o755)
    monkeypatch.setenv("SSH_ASKPASS", str(askpass))
    monkeypatch.setenv("SSH_ASKPASS_REQUIRE", "prefer")
    monkeypatch.setenv("GIT_ASKPASS", str(askpass))
    result = run(["git", "credential", "fill"], input="protocol=https\nhost=host.example\n\n", timeout=20)
    assert result.returncode != 0 and "terminal prompts disabled" in result.stderr
    assert not marker.exists()


def test_every_git_command_runs_without_a_prompt(monkeypatch):
    seen = {}

    def fake(argv, **kwargs):
        seen.update(kwargs["env"])
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake)
    run(["git", "status"], env={"EXTRA": "1"})
    assert seen["GIT_TERMINAL_PROMPT"] == "0" and seen["GIT_ASKPASS"] == "" and seen["SSH_ASKPASS_REQUIRE"] == "never"
    assert seen["EXTRA"] == "1"


# --- the private check before every push (20e) ---

GITHUB_ORIGIN = "git@github.com:Ada/boards.git"


@pytest.fixture
def bare_origin(repo, tmp_path):
    """A repo with a local bare repository as origin and one board to commit, so a push has something to send."""
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    git(repo, "remote", "add", "origin", str(remote))
    Board.create(repo / "boards/demo", "Demo").close()
    return remote


def pushed(remote):
    return git(remote, "log", "--format=%s", "main", check=False).stdout.splitlines()


def asked_github(monkeypatch, answer):
    asked = []

    def status(owner, name):
        asked.append((owner, name))
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(github, "github_status", status)
    return asked


@needs_gitleaks
def test_a_public_github_origin_is_never_pushed_to(repo, bare_origin, monkeypatch):
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: [GITHUB_ORIGIN])
    asked_github(monkeypatch, 200)
    with pytest.raises(RepoError, match="Not pushed: origin is a public GitHub repository.*local commit is kept"):
        sync(repo)
    assert log(repo)[0] == "Sync demo (+1 events)"
    assert pushed(bare_origin) == []


@needs_gitleaks
def test_a_private_github_origin_is_pushed_after_one_question(repo, bare_origin, monkeypatch):
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: [GITHUB_ORIGIN])
    asked = asked_github(monkeypatch, 404)
    assert sync(repo)[-1] == "pushed main to origin"
    assert asked == [("Ada", "boards")]
    assert pushed(bare_origin) == ["Sync demo (+1 events)"]


@needs_gitleaks
@pytest.mark.parametrize("answer", [OSError("Network is unreachable"), 403, 500])
def test_a_check_that_cannot_tell_stops_the_push(repo, bare_origin, monkeypatch, answer):
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: [GITHUB_ORIGIN])
    asked_github(monkeypatch, answer)
    with pytest.raises(RepoError, match="Not pushed: could not check whether origin is private: .*sync again later"):
        sync(repo)
    assert log(repo)[0] == "Sync demo (+1 events)"
    assert pushed(bare_origin) == []


@needs_gitleaks
def test_a_github_address_without_owner_and_repository_stops_the_push(repo, bare_origin, monkeypatch):
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: ["https://github.com/Ada"])
    with pytest.raises(RepoError, match="Not pushed: origin is a GitHub address without a plain owner and repository"):
        sync(repo)
    assert pushed(bare_origin) == []


@needs_gitleaks
def test_another_host_is_pushed_without_asking_github(repo, bare_origin, monkeypatch):
    asked = asked_github(monkeypatch, 200)
    assert sync(repo)[-1] == "pushed main to origin"
    assert asked == [] and pushed(bare_origin) == ["Sync demo (+1 events)"]


@needs_gitleaks
def test_one_public_address_among_several_stops_the_push(repo, bare_origin, monkeypatch):
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: [GITHUB_ORIGIN, "git@github.com:Ada/public.git"])
    monkeypatch.setattr(github, "github_status", lambda owner, name: 200 if name == "public" else 404)
    with pytest.raises(RepoError, match="public GitHub repository"):
        sync(repo)
    assert pushed(bare_origin) == []


def test_push_urls_returns_every_push_address(repo):
    git(repo, "remote", "add", "origin", GITHUB_ORIGIN)
    git(repo, "remote", "set-url", "--add", "--push", "origin", GITHUB_ORIGIN)
    git(repo, "remote", "set-url", "--add", "--push", "origin", "git@github.com:Ada/second.git")
    assert datarepo.push_urls(repo) == [GITHUB_ORIGIN, "git@github.com:Ada/second.git"]


def test_push_urls_that_cannot_be_read_stop_the_push(repo):
    with pytest.raises(RepoError, match="Not pushed: could not read the addresses origin pushes to"):
        datarepo.push_urls(repo)

@needs_gitleaks
def test_no_push_and_no_origin_never_ask_github(repo, bare_origin, monkeypatch):
    monkeypatch.setattr(github, "github_status", lambda owner, name: pytest.fail("asked GitHub"))
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: pytest.fail("read the push addresses"))
    assert sync(repo, push=False)[-1] == "not pushed (--no-push)"
    git(repo, "remote", "remove", "origin")
    assert "no remote named origin" in sync(repo)[-1]


@needs_gitleaks
def test_pcbv_sync_with_a_public_origin_prints_the_reason_and_exits_1(repo, bare_origin, monkeypatch, capsys):
    settings.save({"git": "on"}, repo / "boards")
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: [GITHUB_ORIGIN])
    asked_github(monkeypatch, 200)
    assert cli.main(["--root", str(repo / "boards"), "sync"]) == 1
    assert "Not pushed: origin is a public GitHub repository" in capsys.readouterr().err
    assert pushed(bare_origin) == []
