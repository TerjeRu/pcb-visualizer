import io
import json
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


def test_a_photo_has_no_side_unless_one_is_given(tmp_path):
    asset = ingest(tmp_path, jpeg())
    assert "side" not in asset and asset["label"] == "Photo"
    assert ingest(tmp_path, jpeg(), side="back")["label"] == "Back"
    assert ingest(tmp_path, jpeg(), side="back", label="Underside")["side"] == "back"


def test_uploads_are_named_photo_n_and_carry_no_side(client, slug):
    first = upload(client, slug, jpeg()).json()["event"]["asset"]
    second = upload(client, slug, jpeg(), side="back").json()["event"]["asset"]
    named = upload(client, slug, jpeg(), label="  Case label  ").json()["event"]["asset"]
    assert [first["label"], second["label"], named["label"]] == ["Photo 1", "Photo 2", "Case label"]
    assert "side" not in first and "side" not in second


def test_upload_label_is_cut_at_80_characters(client, slug):
    asset = upload(client, slug, jpeg(), label="x" * 200).json()["event"]["asset"]
    assert asset["label"] == "x" * 80


def test_upload_records_an_event_and_serves_the_file(client, slug):
    response = upload(client, slug, jpeg(), label="Front")
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


def test_a_photo_over_the_upload_limit_is_refused_with_a_message_the_app_can_show(client, slug, monkeypatch):
    from pcbv.server import body
    monkeypatch.setattr(body, "MAX_PHOTO_BYTES", 2000)
    refused = upload(client, slug, jpeg(800, 600))
    assert refused.status_code == 413 and refused.json()["error"] == "too_large"
    assert refused.json()["message"], "the app shows this text"
    project = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]
    assert project["assets"] == []


def test_a_blank_upload_label_gets_the_photo_n_name(client, slug):
    assert upload(client, slug, jpeg(), label="   ").json()["event"]["asset"]["label"] == "Photo 1"


def cornered(width=400, height=300):
    """A white photo with a dark block in its top left corner, to see where a turn puts it."""
    image = Image.new("RGB", (width, height), (255, 255, 255))
    image.paste((0, 0, 0), (0, 0, 100, 80))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=95)
    return out.getvalue()


def post_event(client, slug, event):
    response = client.post(f"/api/boards/{slug}/events", json={"event": event, "actor": "web"}, headers=AUTH)
    assert response.status_code == 201, response.text
    return response


def rotate(client, slug, asset_id, body=None, **kwargs):
    return client.post(f"/api/boards/{slug}/assets/{asset_id}/rotate", headers=AUTH,
                       **({"json": body} if body is not None else kwargs))


def board_with_marks(client, slug):
    asset = upload(client, slug, cornered()).json()["event"]["asset"]
    post_event(client, slug, {"type": "marker/added", "marker": {
        "id": "mk_1", "assetId": asset["id"], "schematicId": "sch_1", "shape": "box", "x": 10, "y": 20, "w": 40, "h": 30},
        "schematic": {"id": "sch_1", "kind": "header", "rows": 1, "cols": 4, "rotation": 0, "pins": []}})
    post_event(client, slug, {"type": "annotation/added", "annotation": {
        "id": "an_1", "assetId": asset["id"], "x": 10, "y": 20, "lx": 30, "ly": 40, "text": "SoC"}})
    return asset


def project_of(client, slug):
    return client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]


def dark(client, slug, path, x, y):
    data = client.get(f"/api/boards/{slug}/files/{path}", headers=AUTH).content
    with Image.open(io.BytesIO(data)) as image:
        return sum(image.convert("RGB").getpixel((x, y))) < 100


def board_dir(tmp_path, slug):
    return tmp_path / "boards" / slug


def test_rotate_right_turns_the_photo_and_everything_on_it(client, slug, tmp_path):
    asset = board_with_marks(client, slug)
    response = rotate(client, slug, asset["id"], {"turns": 1})
    assert response.status_code == 200, response.text
    assert response.json()["event"]["type"] == "board/batch"
    project = project_of(client, slug)
    turned = project["assets"][0]
    assert turned["id"] == asset["id"] and turned["path"] != asset["path"]
    assert (turned["width"], turned["height"], turned["rotation"]) == (300, 400, 90)
    assert {k: project["markers"][0][k] for k in ("x", "y", "w", "h")} == {"x": 250, "y": 10, "w": 30, "h": 40}
    assert {k: project["annotations"][0][k] for k in ("x", "y", "lx", "ly")} == {"x": 280, "y": 10, "lx": 260, "ly": 30}
    assert project["schematics"][0]["rotation"] == 90
    assert dark(client, slug, turned["path"], 290, 10) and not dark(client, slug, turned["path"], 10, 10)
    assert (board_dir(tmp_path, slug) / asset["path"]).exists()        # the old file stays for undo


def test_rotate_left_turns_the_other_way(client, slug):
    asset = board_with_marks(client, slug)
    assert rotate(client, slug, asset["id"], {"turns": -1}).status_code == 200
    turned = project_of(client, slug)["assets"][0]
    assert turned["rotation"] == 270
    assert dark(client, slug, turned["path"], 10, 390) and not dark(client, slug, turned["path"], 10, 10)


def test_four_turns_from_the_original_give_the_first_copy_back(client, slug, tmp_path):
    asset = board_with_marks(client, slug)
    for _ in range(4):
        assert rotate(client, slug, asset["id"], {"turns": 1}).status_code == 200
    project = project_of(client, slug)
    turned = project["assets"][0]
    assert (turned["width"], turned["height"], turned["rotation"]) == (400, 300, 0)
    folder = board_dir(tmp_path, slug)
    assert (folder / turned["path"]).read_bytes() == (folder / asset["path"]).read_bytes()
    assert {k: project["markers"][0][k] for k in ("x", "y", "w", "h")} == {"x": 10, "y": 20, "w": 40, "h": 30}


def test_without_the_original_the_copy_is_turned(client, slug, tmp_path):
    asset = board_with_marks(client, slug)
    (board_dir(tmp_path, slug) / asset["original"]).unlink()
    assert rotate(client, slug, asset["id"], {"turns": 1}).status_code == 200
    turned = project_of(client, slug)["assets"][0]
    assert dark(client, slug, turned["path"], 290, 10)
    with Image.open(board_dir(tmp_path, slug) / turned["path"]) as image:
        assert image.size == (300, 400)


def photo_files(tmp_path, slug):
    return sorted(p.name for p in (board_dir(tmp_path, slug) / "assets" / "photos").glob("*.jpg"))


@pytest.mark.parametrize("failure", ["conflict", "not_committed", "crash"])
def test_a_refused_turn_removes_only_the_new_file(client, slug, tmp_path, monkeypatch, failure):
    from pcbv.events import EventConflict
    from pcbv.journal import StorageError
    import pcbv.server.files as files
    asset = board_with_marks(client, slug)
    before = photo_files(tmp_path, slug)

    async def refuse(*args, **kwargs):
        raise {"conflict": EventConflict("no"), "not_committed": StorageError("not_committed", "no"),
               "crash": KeyError("no")}[failure]
    monkeypatch.setattr(files, "submit", refuse)
    if failure == "crash":
        with pytest.raises(KeyError):
            rotate(client, slug, asset["id"], {"turns": 1})
    else:
        assert rotate(client, slug, asset["id"], {"turns": 1}).status_code in (409, 503)
    assert photo_files(tmp_path, slug) == before
    assert (board_dir(tmp_path, slug) / asset["original"]).exists()
    assert project_of(client, slug)["assets"][0]["path"] == asset["path"]


def test_a_photo_changed_while_it_was_turned_is_refused(client, slug, tmp_path, monkeypatch):
    import pcbv.server.files as files
    asset = board_with_marks(client, slug)
    before = photo_files(tmp_path, slug)
    entry = client.app.state.pcbv.registry.get(slug)
    real = files.rotate

    def turn_and_change(*args, **kwargs):
        path = real(*args, **kwargs)
        entry.board.apply({"type": "asset/updated", "id": asset["id"], "patch": {"rotation": 180}}, "http")
        return path
    monkeypatch.setattr(files, "rotate", turn_and_change)
    response = rotate(client, slug, asset["id"], {"turns": 1})
    assert response.status_code == 409 and response.json()["error"] == "conflict"
    assert photo_files(tmp_path, slug) == before


def test_a_board_that_needs_a_reopen_writes_no_turned_copy(client, slug, tmp_path):
    asset = board_with_marks(client, slug)
    before = photo_files(tmp_path, slug)
    client.app.state.pcbv.registry.get(slug).board.writable = False
    response = rotate(client, slug, asset["id"], {"turns": 1})
    assert response.status_code == 503 and response.json()["error"] == "recovery_required"
    assert photo_files(tmp_path, slug) == before


def edit_project_file(tmp_path, slug, change):
    path = board_dir(tmp_path, slug) / "project.pcb.json"
    project = json.loads(path.read_text())
    change(project)
    path.write_text(json.dumps(project, indent=2) + "\n")


def test_a_callout_added_to_the_project_file_while_the_photo_turns_turns_too(client, slug, tmp_path, monkeypatch):
    import pcbv.server.files as files
    asset = board_with_marks(client, slug)
    real = files.rotate

    def turn_and_edit(*args, **kwargs):
        path = real(*args, **kwargs)
        edit_project_file(tmp_path, slug, lambda project: project["annotations"].append(
            {"id": "an_2", "assetId": asset["id"], "x": 100, "y": 50, "lx": 120, "ly": 60, "text": "Flash"}))
        return path
    monkeypatch.setattr(files, "rotate", turn_and_edit)
    assert rotate(client, slug, asset["id"], {"turns": 1}).status_code == 200
    added = next(a for a in project_of(client, slug)["annotations"] if a["id"] == "an_2")
    assert {k: added[k] for k in ("x", "y", "lx", "ly")} == {"x": 250, "y": 100, "lx": 240, "ly": 120}


def test_a_photo_path_changed_in_the_project_file_while_it_turns_is_kept(client, slug, tmp_path, monkeypatch):
    import pcbv.server.files as files
    asset = board_with_marks(client, slug)
    before = photo_files(tmp_path, slug)
    real = files.rotate

    def turn_and_edit(*args, **kwargs):
        path = real(*args, **kwargs)
        edit_project_file(tmp_path, slug, lambda project: project["assets"][0].update(path="assets/photos/other.jpg"))
        return path
    monkeypatch.setattr(files, "rotate", turn_and_edit)
    response = rotate(client, slug, asset["id"], {"turns": 1})
    assert response.status_code == 409 and response.json()["error"] == "conflict"
    assert project_of(client, slug)["assets"][0]["path"] == "assets/photos/other.jpg"
    assert photo_files(tmp_path, slug) == before


@pytest.mark.parametrize("body", [{"turns": 0}, {"turns": 2}, {"turns": "1"}, {"turns": True}, {"turns": 1.0}, {}])
def test_turns_must_be_one_or_minus_one(client, slug, body):
    asset = upload(client, slug, jpeg()).json()["event"]["asset"]
    response = rotate(client, slug, asset["id"], body)
    assert response.status_code == 422 and response.json()["error"] == "invalid_event"


def test_the_rotate_body_has_a_64_byte_limit(client, slug):
    asset = upload(client, slug, jpeg()).json()["event"]["asset"]
    at_limit = '{"turns": 1' + " " * (64 - 12) + "}"
    assert len(at_limit) == 64
    assert rotate(client, slug, asset["id"], content=at_limit).status_code == 200
    over = '{"turns": 1' + " " * (65 - 12) + "}"
    assert rotate(client, slug, asset["id"], content=over).status_code == 413


def test_rotate_needs_a_photo_with_a_size_and_the_token(client, slug):
    assert rotate(client, slug, "img_nope", {"turns": 1}).status_code == 404
    post_event(client, slug, {"type": "asset/added", "asset": {"id": "img_x", "kind": "image", "path": "assets/x.jpg"}})
    response = rotate(client, slug, "img_x", {"turns": 1})
    assert response.status_code == 409 and response.json()["error"] == "conflict"
    asset = upload(client, slug, jpeg()).json()["event"]["asset"]
    assert client.post(f"/api/boards/{slug}/assets/{asset['id']}/rotate", json={"turns": 1}).status_code == 401


@pytest.mark.parametrize("rotation, ok", [(0, True), (90, True), (270, True), (45, False), (360, False), (True, False)])
def test_an_asset_rotation_is_a_quarter_turn(client, slug, rotation, ok):
    asset = upload(client, slug, jpeg()).json()["event"]["asset"]
    response = client.post(f"/api/boards/{slug}/events", headers=AUTH, json={
        "event": {"type": "asset/updated", "id": asset["id"], "patch": {"rotation": rotation}}, "actor": "web"})
    assert (response.status_code == 201) is ok
    if not ok:
        assert response.json()["message"].startswith("asset/updated:")


def test_an_unusual_asset_id_does_not_reach_the_file_name(tmp_path):
    from pcbv.photos import rotate as turn
    asset = ingest(tmp_path, jpeg())
    asset["id"] = "../../x/y"
    rel = turn(tmp_path, asset, 1)
    assert rel.startswith("assets/photos/photo-") and (tmp_path / rel).exists()
