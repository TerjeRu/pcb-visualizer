import json
import shutil
import subprocess

import pytest
from starlette.testclient import TestClient

from pcbv import cli, datarepo, github, gitsetup
from pcbv.assistant import MemoryKeyStore
from pcbv.datarepo import RepoError, git, init_repo, redact, run
from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}
REAL = {"github_status": github.github_status, "ls_remote": gitsetup.ls_remote}
needs_gitleaks = pytest.mark.skipif(shutil.which("gitleaks") is None, reason="gitleaks not installed")


@pytest.fixture(autouse=True)
def isolated_git(tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for var in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{var}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{var}_EMAIL", "test@example.invalid")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """The login check is replaced for every test (it works); conftest.py already answers 404 for GitHub."""
    monkeypatch.setattr(gitsetup, "ls_remote", lambda folder, url: gitsetup.Reply(0, ""))


@pytest.fixture
def folder(tmp_path):
    return tmp_path / "hw"


@pytest.fixture
def client(folder):
    boards = folder / "boards"
    boards.mkdir(parents=True)
    with TestClient(create_app(boards, TOKEN, keystore=MemoryKeyStore()), base_url="http://localhost:8765") as c:
        c.settings = lambda: c.get("/api/settings", headers=AUTH).json()
        c.step = lambda step, **fields: c.post("/api/git/setup", json={"step": step, **fields}, headers=AUTH)
        assert c.settings()["git"] == "off"            # the first start writes the settings before any setup
        yield c


def test_the_git_routes_need_the_session_token(client):
    assert client.get("/api/git").status_code == 401
    assert client.post("/api/git/setup", json={"step": "check"}).status_code == 401


@pytest.mark.parametrize("url", [
    "git@github.com:example/hw.git", "git@host.example:owner/repo", "https://github.com/example/hw.git", "https://host.example:8443/a/b",
])
def test_remote_addresses_that_are_accepted(url):
    assert gitsetup.check_url(url) == url


@pytest.mark.parametrize("url", [
    "", None, 5, "http://host/repo.git", "ssh://git@host/repo.git", "file:///tmp/repo", "ext::sh -c id", "-oProxyCommand=id",
    "--upload-pack=id", "git@host:repo with space", "git@host:repo\nx", "git@host:repo\x00", "https://user@host/repo.git",
    "https://user:token@host/repo.git", "https://host/repo.git?x=1", "https://host/repo#x", "https:///repo", "/tmp/repo",
    "git@-host:repo", "git@host:-repo", "https://host/" + "a" * 2048, "https://[abc/repo.git",
])
def test_remote_addresses_that_are_refused(url):
    with pytest.raises(gitsetup.SetupError):
        gitsetup.check_url(url)


def test_credentials_are_hidden_even_when_the_password_holds_an_at_sign():
    assert redact("fatal: https://user:p@ss@host/hw.git not found") == "fatal: https://***@host/hw.git not found"


def test_the_ignore_check_asks_about_the_real_boards_folder(folder):
    init_repo(folder)
    boards = folder / "mine"
    (boards / "nimbus").mkdir(parents=True)
    assert gitsetup._originals_ignored(folder, boards) is False


def test_a_fresh_folder_reports_what_is_missing(client):
    body = client.get("/api/git", headers=AUTH).json()
    assert body["ok"] is False
    assert body["detail"]["repository"] is False and body["detail"]["setting"] == "off"
    assert any("init step" in line for line in body["detail"]["problems"])


def test_check_gives_the_install_command_for_what_is_missing(client, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/git" if name == "git" else None)
    body = client.step("check").json()
    assert body == {"ok": False, "detail": "gitleaks not installed. Run: sudo pacman -S gitleaks"}
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert "sudo pacman -S git && sudo pacman -S gitleaks" in client.step("check").json()["detail"]
    assert "run the check step" in client.step("init").json()["detail"]


@needs_gitleaks
def test_the_five_steps_set_git_up_and_commit(client, folder):
    assert client.step("check").json()["ok"] is True
    init = client.step("init").json()
    assert init["ok"] is True and "git repository" in init["detail"] and "guard" not in init["detail"].replace(".githooks", "")
    assert client.step("ignore").json()["ok"] is True
    assert client.step("remote").json() == {"ok": True, "detail": "no remote address given; the repository stays on this machine"}
    synced = client.step("sync").json()
    assert synced["ok"] is True and "committed: Sync" in synced["detail"] and "not pushed" not in synced["detail"].split("\n")[0]
    assert "not pushed: no remote set" in synced["detail"] and "--no-push" not in synced["detail"]
    assert git(folder, "log", "--format=%s").stdout.startswith("Sync")
    assert client.get("/api/git", headers=AUTH).json()["ok"] is True
    assert client.settings()["git"] == "off"                          # setup does not turn it on
    assert client.post("/api/settings", json={"git": "on"}, headers=AUTH).json()["git"] == "on"


def test_completed_local_steps_can_be_repeated(client, folder):
    first = client.step("init").json()
    again = client.step("init").json()
    assert first["ok"] and again == {"ok": True, "detail": "the layout was already complete; the commit guard is active"}
    assert client.step("ignore").json()["ok"] and client.step("ignore").json()["ok"]


def test_setup_survives_a_restart(client, folder):
    client.step("init")
    boards = folder / "boards"
    with TestClient(create_app(boards, TOKEN, keystore=MemoryKeyStore()), base_url="http://localhost:8765") as again:
        detail = again.get("/api/git", headers=AUTH).json()["detail"]
        assert detail["repository"] is True and detail["guard"] is True and detail["originals_ignored"] is True


def test_the_ignore_step_refuses_when_originals_would_be_committed(client, folder):
    client.step("init")
    ignore = folder / ".gitignore"
    ignore.write_text("\n".join(line for line in ignore.read_text().splitlines() if "originals" not in line) + "\n")
    result = client.step("ignore").json()
    assert result["ok"] is False and "EXIF and GPS" in result["detail"]
    status = client.get("/api/git", headers=AUTH).json()
    assert status["ok"] is False and status["detail"]["originals_ignored"] is False
    refused = client.post("/api/settings", json={"git": "on"}, headers=AUTH)
    assert refused.status_code == 422 and refused.json()["error"] == "git_not_ready" and "EXIF and GPS" in refused.json()["message"]
    assert client.settings()["git"] == "off"


def test_git_stays_off_until_the_local_checks_pass(client):
    refused = client.post("/api/settings", json={"git": "on", "theme": "dark"}, headers=AUTH)
    assert refused.status_code == 422 and refused.json()["error"] == "git_not_ready"
    assert client.settings()["theme"] == "system"                      # nothing in the request was saved


def test_a_setting_change_while_git_is_on_is_not_held_back_by_the_checks(client, folder, tmp_path):
    client.step("init")
    assert client.post("/api/settings", json={"git": "on"}, headers=AUTH).status_code == 200
    shutil.rmtree(folder / ".git")
    assert client.post("/api/settings", json={"theme": "dark"}, headers=AUTH).json()["git"] == "on"
    assert client.post("/api/settings", json={"git": "off"}, headers=AUTH).json()["git"] == "off"
    assert (folder / "boards").is_dir()                                # turning it off deletes nothing


def test_remote_step_adds_then_asks_before_replacing(client, folder):
    client.step("init")
    added = client.step("remote", url="git@github.com:example/hw.git").json()
    assert added["ok"] and git(folder, "remote", "get-url", "origin").stdout.strip() == "git@github.com:example/hw.git"
    assert client.step("remote", url="git@github.com:example/hw.git").json()["ok"] is True
    asked = client.step("remote", url="https://example.org/other.git").json()
    assert asked["ok"] is False and asked["confirm"] == {"old": "git@github.com:example/hw.git", "new": "https://example.org/other.git"}
    assert git(folder, "remote", "get-url", "origin").stdout.strip() == "git@github.com:example/hw.git"
    done = client.step("remote", url="https://example.org/other.git", replace=True).json()
    assert done["ok"] and git(folder, "remote", "get-url", "origin").stdout.strip() == "https://example.org/other.git"


def test_remote_step_keeps_the_rest_of_the_repository_configuration(client, folder):
    client.step("init")
    git(folder, "config", "user.name", "Somebody")
    git(folder, "remote", "add", "upstream", "https://example.org/up.git")
    client.step("remote", url="git@github.com:example/hw.git")
    assert git(folder, "config", "user.name").stdout.strip() == "Somebody"
    assert git(folder, "remote").stdout.split() == ["origin", "upstream"]


@pytest.mark.parametrize("fields", [{"url": "http://example.org/a.git"}, {"url": "-oProxyCommand=id"}, {"url": "https://u:p@example.org/a"}, {"url": 7}])
def test_remote_step_refuses_bad_addresses_before_touching_git(client, folder, fields):
    client.step("init")
    response = client.step("remote", **fields)
    assert response.status_code == 422 and response.json()["error"] == "invalid_git_setup"
    assert git(folder, "remote").stdout.split() == []


@pytest.mark.parametrize("body", [{"step": "push"}, {"step": 3}, {}, {"step": "check", "url": "git@h:r"}, {"step": "remote", "x": 1}, {"step": "sync", "replace": True}])
def test_unknown_steps_and_stray_fields_are_refused(client, body):
    response = client.post("/api/git/setup", json=body, headers=AUTH)
    assert response.status_code == 422 and response.json()["error"] == "invalid_git_setup"


def test_setup_bodies_over_four_kib_are_refused(client):
    response = client.post("/api/git/setup", json={"step": "remote", "url": "https://h/" + "a" * 5000}, headers=AUTH)
    assert response.status_code == 413 and response.json()["error"] == "too_large"


def test_a_second_request_while_a_step_runs_gets_409(client):
    assert gitsetup.busy.acquire(blocking=False)
    try:
        response = client.step("check")
    finally:
        gitsetup.busy.release()
    assert response.status_code == 409 and response.json()["error"] == "git_busy"
    assert client.step("check").status_code == 200


@needs_gitleaks
def test_a_failed_push_says_so_hides_credentials_and_keeps_the_commit(client, folder):
    client.step("init")
    git(folder, "remote", "add", "origin", "https://user:hunter2@127.0.0.1:9/hw.git")
    detail = client.get("/api/git", headers=AUTH).json()["detail"]
    assert detail["remote"] == "https://***@127.0.0.1:9/hw.git"
    result = client.step("sync").json()
    assert result["ok"] is False and "hunter2" not in json.dumps(result)
    assert git(folder, "log", "--format=%s").stdout.startswith("Sync")       # the local commit stays
    again = client.step("sync").json()                                       # no automatic retry; a new request tries once more
    assert again["ok"] is False


@needs_gitleaks
def test_sync_pushes_to_a_reachable_remote(client, folder, tmp_path):
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    client.step("init")
    git(folder, "remote", "add", "origin", str(bare))
    result = client.step("sync").json()
    assert result["ok"] is True and "pushed main to origin" in result["detail"]
    assert git(bare, "log", "--format=%s", "main").stdout.startswith("Sync")


def test_a_git_command_over_its_deadline_is_stopped():
    with pytest.raises(RepoError, match="did not finish in 0.2 seconds"):
        run(["sleep", "5"], timeout=0.2)


def test_git_commands_never_wait_for_a_terminal(folder):
    init_repo(folder)
    git(folder, "remote", "add", "origin", "https://127.0.0.1:9/none.git")
    assert git(folder, "ls-remote", "origin", check=False, timeout=30).returncode != 0


def test_commits_are_empty_while_git_is_off(client, folder):
    slug = client.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH).json()["slug"]
    assert client.settings()["git"] == "off"
    client.post("/api/settings", json={"assistant": "off"}, headers=AUTH)
    init_repo(folder)
    git(folder, "add", "-A")
    git(folder, "commit", "-q", "--no-verify", "-m", "First")
    assert client.get(f"/api/boards/{slug}/commits", headers=AUTH).json() == {"commits": []}
    assert client.post("/api/settings", json={"git": "on"}, headers=AUTH).status_code == 200
    commits = client.get(f"/api/boards/{slug}/commits", headers=AUTH).json()["commits"]
    assert [c["subject"] for c in commits] == ["First"]


def test_the_cli_sync_refuses_while_git_is_off(folder, capsys):
    boards = folder / "boards"
    boards.mkdir(parents=True)
    assert cli.main(["--root", str(boards), "sync"]) == 1
    err = capsys.readouterr().err
    assert "git is off" in err and "Settings" in err
    assert not (folder / ".git").exists()


GITHUB_FORMS = ["git@github.com:Ada/boards.git", "https://github.com/Ada/boards.git", "https://github.com/Ada/boards", "https://GitHub.com/Ada/boards/",
                "https://github.com:443/Ada/boards.git", "https://github.com./Ada/boards.git", "https://www.github.com/Ada/boards",
                "git@GitHub.com.:Ada/boards.git", "git@ssh.github.com:Ada/boards.git"]


@pytest.mark.parametrize("url", GITHUB_FORMS)
def test_both_github_address_forms_give_the_owner_and_repository(url):
    assert github.github_repo(url) == ("Ada", "boards")


@pytest.mark.parametrize("url", [
    "git@gitlab.com:Ada/boards.git", "https://host.example/Ada/boards.git", "https://github.com.evil.example/Ada/boards.git",
    "https://github.com:8443/Ada/boards.git", "git@github.com.evil.example:Ada/boards.git",
])
def test_other_hosts_are_not_github(url):
    assert github.github_repo(url) is None


@pytest.mark.parametrize("url", ["https://github.com/Ada", "git@github.com:Ada/a/b.git", "https://github.com/../boards", "git@github.com:./boards.git"])
def test_a_github_address_without_owner_and_repository_is_refused(url):
    with pytest.raises(github.GitHubAddressError, match="owner and the repository"):
        github.github_repo(url)


def test_the_remote_step_turns_a_bad_github_address_into_a_setup_error():
    with pytest.raises(gitsetup.SetupError, match="owner and the repository"):
        gitsetup._private_check("https://github.com/Ada")


@pytest.fixture
def ready(client, folder):
    client.step("init")
    return client


@pytest.mark.parametrize("url", GITHUB_FORMS[:2])
def test_a_public_github_repository_is_refused_and_not_set(ready, folder, monkeypatch, url):
    asked = []
    monkeypatch.setattr(github, "github_status", lambda owner, repo: asked.append((owner, repo)) or 200)
    result = ready.step("remote", url=url).json()
    assert result["ok"] is False and result["detail"].startswith("This repository is public. Anyone could read your boards.")
    assert "Change visibility" in result["detail"]
    assert asked == [("Ada", "boards")]
    assert git(folder, "remote").stdout.split() == []
    assert ready.settings()["git"] == "off"


def test_a_private_github_repository_goes_on_and_says_so(ready, folder):
    result = ready.step("remote", url="git@github.com:Ada/boards.git").json()
    assert result["ok"] is True and "private" in result["detail"] and "can read the repository" in result["detail"]
    assert git(folder, "remote", "get-url", "origin").stdout.strip() == "git@github.com:Ada/boards.git"


@pytest.mark.parametrize("failure", [OSError("Network is unreachable"), TimeoutError("timed out"), 403, 500, 301])
def test_a_check_that_cannot_tell_never_counts_as_private(ready, folder, monkeypatch, failure):
    def answer(owner, repo):
        if isinstance(failure, Exception):
            raise failure
        return failure
    monkeypatch.setattr(github, "github_status", answer)
    result = ready.step("remote", url="https://github.com/Ada/boards.git").json()
    assert result["ok"] is False
    assert result["detail"].startswith("Could not check whether the repository is private: ") and result["detail"].endswith(" Try again.")
    assert git(folder, "remote").stdout.split() == []


def test_a_host_that_is_not_github_skips_the_check_with_a_note(ready, monkeypatch):
    monkeypatch.setattr(github, "github_status", lambda owner, repo: pytest.fail("asked GitHub about another host"))
    result = ready.step("remote", url="git@git.example:Ada/boards.git").json()
    assert result["ok"] is True and "Not a GitHub address; make sure the repository is private." in result["detail"]


def test_the_check_runs_again_when_the_address_is_already_set(ready, folder, monkeypatch):
    ready.step("remote", url="git@github.com:Ada/boards.git")
    monkeypatch.setattr(github, "github_status", lambda owner, repo: 200)
    assert ready.step("remote", url="git@github.com:Ada/boards.git").json()["ok"] is False


def test_replacing_an_address_asks_first_and_checks_the_new_one(ready, folder, monkeypatch):
    ready.step("remote", url="git@github.com:Ada/boards.git")
    monkeypatch.setattr(github, "github_status", lambda owner, repo: pytest.fail("no question to GitHub before the confirmation"))
    assert ready.step("remote", url="git@github.com:Ada/other.git").json()["confirm"]
    monkeypatch.setattr(github, "github_status", lambda owner, repo: 200)
    assert ready.step("remote", url="git@github.com:Ada/other.git", replace=True).json()["ok"] is False
    assert git(folder, "remote", "get-url", "origin").stdout.strip() == "git@github.com:Ada/boards.git"


def test_no_address_means_no_outside_request(ready, monkeypatch):
    monkeypatch.setattr(github, "github_status", lambda owner, repo: pytest.fail("asked GitHub"))
    monkeypatch.setattr(gitsetup, "ls_remote", lambda folder, url: pytest.fail("asked a remote"))
    assert ready.step("remote").json()["ok"] is True


@pytest.mark.parametrize("stderr, hint", [
    ("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "Log in first: gh auth login"),
    ("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/Ada/boards.git/'", "Log in first: gh auth login"),
    ("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "Add your SSH key to GitHub"),
    ("Host key verification failed.\nfatal: Could not read from remote repository.", "Run ssh -T git@github.com once in a terminal and accept GitHub's key"),
    ("remote: Repository not found.\nfatal: repository 'https://github.com/Ada/x.git/' not found", "Check the address, and that you are logged in as the owner."),
])
def test_a_failed_access_check_gives_the_last_line_and_one_hint(ready, folder, monkeypatch, stderr, hint):
    monkeypatch.setattr(gitsetup, "ls_remote", lambda folder, url: gitsetup.Reply(128, stderr + "\n"))
    result = ready.step("remote", url="git@github.com:Ada/boards.git").json()
    assert result["ok"] is False
    assert stderr.splitlines()[-1] in result["detail"] and result["detail"].endswith(hint)
    assert result["detail"].count(". ") <= 3 and sum(h in result["detail"] for h in ("gh auth login", "SSH key", "ssh -T", "Check the address")) == 1


def test_an_access_failure_without_a_known_message_has_no_hint(ready, monkeypatch):
    monkeypatch.setattr(gitsetup, "ls_remote", lambda folder, url: gitsetup.Reply(128, "fatal: something new\n"))
    detail = ready.step("remote", url="git@github.com:Ada/boards.git").json()["detail"]
    assert "fatal: something new" in detail and "gh auth login" not in detail


def test_the_access_check_hides_credentials_from_git_output(ready, monkeypatch):
    monkeypatch.setattr(gitsetup, "ls_remote", lambda folder, url: gitsetup.Reply(128, "fatal: unable to access 'https://user:hunter2@host.example/r.git/'\n"))
    assert "hunter2" not in ready.step("remote", url="https://host.example/o/r.git").json()["detail"]


def test_an_access_check_over_its_deadline_fails_clearly(ready, monkeypatch):
    def slow(folder, url):
        raise RepoError("git did not finish in 20 seconds and was stopped")
    monkeypatch.setattr(gitsetup, "ls_remote", slow)
    detail = ready.step("remote", url="git@github.com:Ada/boards.git").json()["detail"]
    assert "did not answer within 20 seconds" in detail


def test_ls_remote_never_waits_for_a_password_or_a_host_key_question(folder, monkeypatch):
    seen = {}

    def fake(argv, **kwargs):
        seen.update(argv=argv, env=kwargs["env"], timeout=kwargs["timeout"])
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(gitsetup, "ls_remote", REAL["ls_remote"])
    monkeypatch.setattr(subprocess, "run", fake)
    assert gitsetup.ls_remote(folder, "git@github.com:Ada/boards.git").code == 0
    assert seen["env"]["GIT_TERMINAL_PROMPT"] == "0" and seen["env"]["GIT_SSH_COMMAND"] == "ssh -o BatchMode=yes"
    assert seen["env"]["GIT_ASKPASS"] == ""
    assert seen["timeout"] == 20 and seen["argv"][-2:] == ["--", "git@github.com:Ada/boards.git"]


def test_ls_remote_accepts_an_empty_repository_and_reports_a_missing_one(folder, tmp_path, monkeypatch):
    monkeypatch.setattr(gitsetup, "ls_remote", REAL["ls_remote"])
    init_repo(folder)
    bare = tmp_path / "empty.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    assert gitsetup.ls_remote(folder, str(bare)).code == 0
    assert gitsetup.ls_remote(folder, str(tmp_path / "missing.git")).code != 0


def test_the_github_question_is_one_plain_request_with_a_deadline(monkeypatch):
    seen = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake(request, timeout):
        seen.update(url=request.full_url, headers=dict(request.header_items()), timeout=timeout, data=request.data)
        return Response()

    monkeypatch.setattr(github, "github_status", REAL["github_status"])
    monkeypatch.setattr(github.urllib.request, "urlopen", fake)
    assert github.github_status("Ada", "boards") == 200
    assert seen["url"] == "https://api.github.com/repos/Ada/boards" and seen["timeout"] == 10 and seen["data"] is None
    assert seen["headers"]["Accept"] == "application/vnd.github+json" and "Authorization" not in seen["headers"]


def test_github_status_answers_with_the_code_of_an_error_reply(monkeypatch):
    def fake(request, timeout):
        raise github.urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(github, "github_status", REAL["github_status"])
    monkeypatch.setattr(github.urllib.request, "urlopen", fake)
    assert github.github_status("Ada", "boards") == 404


def test_a_broken_reply_from_github_counts_as_a_network_failure(monkeypatch):
    def fake(request, timeout):
        raise github.http.client.IncompleteRead(b"{")

    monkeypatch.setattr(github, "github_status", REAL["github_status"])
    monkeypatch.setattr(github.urllib.request, "urlopen", fake)
    with pytest.raises(OSError, match="broken reply"):
        github.github_status("Ada", "boards")


@needs_gitleaks
def test_test_sync_refuses_a_public_origin_and_keeps_the_commit(ready, folder, tmp_path, monkeypatch):
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    git(folder, "remote", "add", "origin", str(bare))
    monkeypatch.setattr(datarepo, "push_urls", lambda r, timeout=None: ["git@github.com:Ada/boards.git"])
    monkeypatch.setattr(github, "github_status", lambda owner, repo: 200)
    (folder / "wiki" / "note.md").write_text("hello\n")
    result = ready.step("sync").json()
    assert result["ok"] is False and result["detail"].startswith("Not pushed: origin is a public GitHub repository")
    assert git(folder, "log", "-1", "--format=%s").stdout.strip()
    assert git(bare, "log", "main", check=False).returncode != 0
