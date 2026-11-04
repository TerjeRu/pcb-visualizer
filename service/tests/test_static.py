"""The service also serves the front end (app/). It is code, so it needs no token, but it must stay
read-only, confined to its folder, and protected by the same Host and Origin checks as the API."""
import pytest
from starlette.testclient import TestClient

from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def app_dir(tmp_path):
    folder = tmp_path / "site"
    (folder / "js").mkdir(parents=True)
    (folder / "index.html").write_text("<!doctype html><title>pcbv</title><h1>front end</h1>")
    (folder / "js" / "main.js").write_text("export const hello = 1;\n")
    (tmp_path / "secret.txt").write_text("SECRET-OUTSIDE-THE-SITE")
    (folder / "sneaky").symlink_to(tmp_path / "secret.txt")
    return folder


@pytest.fixture
def client(tmp_path, app_dir):
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN, app_dir), base_url="http://localhost:8765") as c:
        yield c


def test_front_end_is_served_without_a_token_with_hardening_headers(client):
    page = client.get("/")
    assert page.status_code == 200 and "front end" in page.text
    assert client.get("/js/main.js").text.startswith("export const hello")
    assert page.headers["x-content-type-options"] == "nosniff"
    assert page.headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert "default-src 'self'" in page.headers["content-security-policy"]


def test_the_api_still_needs_the_token_next_to_the_static_mount(client):
    assert client.get("/api/boards").status_code == 401
    assert client.get("/api/boards", headers=AUTH).status_code == 200
    assert client.get("/api/health").json()["ok"] is True
    assert client.get("/api/does-not-exist", headers=AUTH).status_code == 404
    assert client.get("/api/does-not-exist").status_code == 401, "unknown API paths must not leak without a token"


@pytest.mark.parametrize("path", [
    "/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/js/../../secret.txt",
    "/%2e%2e%2fsecret.txt", "//etc/passwd", "/sneaky",   # the last one is a symlink pointing outside the site
])
def test_nothing_outside_the_front_end_folder_is_served(client, path):
    response = client.get(path)
    assert response.status_code != 200
    assert "SECRET-OUTSIDE" not in response.text and "root:" not in response.text


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_static_files_are_read_only(client, method):
    assert client.request(method, "/index.html", json={}).status_code == 405


def test_static_files_get_the_same_host_and_origin_checks(client):
    assert client.get("/", headers={"Host": "evil.example"}).status_code == 403
    assert client.get("/", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/", headers={"Origin": "http://localhost:8765"}).status_code == 200


def test_without_a_front_end_folder_nothing_is_mounted(tmp_path):
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as c:
        assert c.get("/").status_code == 404
        assert c.get("/api/health").status_code == 200
