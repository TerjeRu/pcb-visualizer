import io
import os

import pytest
from PIL import Image
from starlette.testclient import TestClient

from pcbv.photos import COPY_LONG_SIDE, PhotoError, ingest
from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


def jpeg(width=400, height=300, exif=None, color=(200, 30, 30)):
    out = io.BytesIO()
    image = Image.new("RGB", (width, height), color)
    image.save(out, "JPEG", **({"exif": exif} if exif is not None else {}))
    return out.getvalue()


def exif_with_gps_and_rotation():
    exif = Image.Exif()
    exif[0x0112] = 6                       # Orientation: rotate 90 degrees clockwise to display
    exif[0x8825] = {1: "N", 2: (59.0, 54.0, 0.0)}   # GPS IFD
    return exif


@pytest.fixture
def client(tmp_path):
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as c:
        yield c


@pytest.fixture
def slug(client):
    return client.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH).json()["slug"]


def upload(client, slug, data, **params):
    return client.post(f"/api/boards/{slug}/assets", content=data, params=params,
                       headers={**AUTH, "Content-Type": "application/octet-stream"})


def test_ingest_writes_original_and_upright_metadata_free_copy(tmp_path):
    raw = jpeg(400, 300, exif=exif_with_gps_and_rotation())
    asset = ingest(tmp_path, raw, label="Top", side="front")
    assert (tmp_path / asset["original"]).read_bytes() == raw
    with Image.open(tmp_path / asset["path"]) as copy:
        assert copy.size == (300, 400)           # EXIF rotation applied
        assert not copy.getexif()                 # no GPS or anything else
    assert (asset["width"], asset["height"]) == (300, 400)
    assert asset["path"].startswith("assets/photos/") and asset["original"].startswith("assets/photos/originals/")


def test_large_photos_are_scaled_for_the_committed_copy(tmp_path):
    asset = ingest(tmp_path, jpeg(4000, 3000))
    assert max(asset["width"], asset["height"]) == COPY_LONG_SIDE


@pytest.mark.parametrize("data, match", [
    (b"", "empty"),
    (b"definitely not an image", "not a readable image"),
    (b"GIF89a" + b"\0" * 20, "not a readable image|not supported"),
])
def test_ingest_rejects_non_photos(tmp_path, data, match):
    with pytest.raises(PhotoError, match=match):
        ingest(tmp_path, data)
    assert not (tmp_path / "assets").exists()


def test_ingest_rejects_unknown_side(tmp_path):
    with pytest.raises(PhotoError, match="side"):
        ingest(tmp_path, jpeg(), side="top")


def test_upload_records_an_event_and_serves_the_file(client, slug):
    response = upload(client, slug, jpeg(), label="Front", side="front")
    assert response.status_code == 201
    event = response.json()["event"]
    assert event["type"] == "asset/added" and event["asset"]["label"] == "Front"
    project = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]
    assert project["assets"][0]["id"] == event["asset"]["id"]

    file = client.get(f"/api/boards/{slug}/files/{event['asset']['path']}", headers=AUTH)
    assert file.status_code == 200 and file.headers["content-type"] == "image/jpeg"
    assert file.content[:2] == b"\xff\xd8"


def test_files_need_the_token_and_stay_inside_assets(client, slug):
    path = upload(client, slug, jpeg()).json()["event"]["asset"]["path"]
    assert client.get(f"/api/boards/{slug}/files/{path}").status_code == 401
    assert client.get(f"/api/boards/{slug}/files/journal/events.jsonl", headers=AUTH).status_code == 400
    assert client.get(f"/api/boards/{slug}/files/assets/../journal/events.jsonl", headers=AUTH).status_code in (400, 404)
    assert client.get(f"/api/boards/{slug}/files/assets/photos/nope.jpg", headers=AUTH).status_code == 404


def test_bad_upload_is_refused_and_leaves_nothing(client, slug, tmp_path):
    response = upload(client, slug, b"not an image")
    assert response.status_code == 422 and response.json()["error"] == "invalid_photo"
    assert client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["assets"] == []


def test_upload_size_limit_is_separate_from_the_json_limit(client, slug):
    noise = Image.frombytes("RGB", (1400, 1400), os.urandom(1400 * 1400 * 3))   # does not compress
    out = io.BytesIO()
    noise.save(out, "JPEG", quality=95)
    assert len(out.getvalue()) > 2_000_000
    assert upload(client, slug, out.getvalue()).status_code == 201


@pytest.mark.parametrize('target', ['outside', 'journal'])
def test_symlink_in_assets_not_served(client, slug, tmp_path, target):
    outside = tmp_path / 'outside.jpg'
    outside.write_bytes(b'outside sentinel')
    directory = tmp_path / 'boards' / slug / 'assets'
    destination = outside if target == 'outside' else directory.parent / 'journal/events.jsonl'
    (directory / 'linked.jpg').symlink_to(destination)
    response = client.get(f'/api/boards/{slug}/files/assets/linked.jpg', headers=AUTH)
    assert response.status_code == 404 and response.json()['error'] == 'not_found'
    assert outside.read_bytes() == b'outside sentinel'


def test_encoded_traversal_reaches_file_route_and_is_refused(client, slug):
    response = client.get(f'/api/boards/{slug}/files/assets/%2e%2e/journal/events.jsonl', headers=AUTH)
    assert response.status_code == 400 and response.json()['error'] == 'bad_path'


def huge_png(width=15000, height=10000):
    out = io.BytesIO()
    Image.new("1", (width, height)).save(out, "PNG")
    return out.getvalue()


@pytest.mark.filterwarnings("ignore::PIL.Image.DecompressionBombWarning")
@pytest.mark.parametrize("width", [15000, 25000], ids=["150M-pixels", "250M-pixels"])
def test_oversized_png_refused_before_decode(client, slug, tmp_path, monkeypatch, width):
    from PIL import PngImagePlugin

    def decoded(*args, **kwargs):
        raise AssertionError("pixels were decoded")

    data = huge_png(width)
    assert len(data) < 1_000_000, "a small file that claims hundreds of millions of pixels"
    monkeypatch.setattr(PngImagePlugin.PngImageFile, "load", decoded)
    with pytest.raises(PhotoError):
        ingest(tmp_path, data)
    response = upload(client, slug, data)
    assert response.status_code == 422 and response.json()["error"] == "invalid_photo"
    assert not (tmp_path / "assets").exists()


def test_the_pixel_limit_has_an_exact_boundary(tmp_path, monkeypatch):
    from pcbv import photos
    monkeypatch.setattr(photos, "MAX_PIXELS", 1001)
    assert ingest(tmp_path, jpeg(77, 13))["width"] == 77
    with pytest.raises(PhotoError, match="limit"):
        ingest(tmp_path, jpeg(78, 13))


def test_a_picture_between_the_limit_and_twice_it_is_refused_without_a_pillow_warning(monkeypatch):
    import warnings
    from pcbv import photos
    monkeypatch.setattr(photos, "MAX_PIXELS", 1000)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1000)
    buffer = io.BytesIO()
    Image.new("RGB", (40, 40)).save(buffer, "PNG")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        with pytest.raises(PhotoError):
            photos.open_image(io.BytesIO(buffer.getvalue()))
    assert not [w for w in caught if issubclass(w.category, Image.DecompressionBombWarning)]


def test_pillow_is_limited_once_for_every_caller():
    import pcbv.export
    import pcbv.redact  # noqa: F401 - imported to show no module sets its own limit
    import pcbv.vision  # noqa: F401
    from pcbv.photos import MAX_PIXELS
    assert Image.MAX_IMAGE_PIXELS == MAX_PIXELS
