import io

import pytest
from PIL import Image

from pcbv.photos import ingest
from pcbv.vision import VIEW_LONG_SIDE, VisionError, marker_region, render_view


def photo(width=3000, height=2000):
    image = Image.new("RGB", (width, height), (20, 90, 40))
    image.paste((250, 250, 250), (int(width * 0.6), int(height * 0.3), int(width * 0.7), int(height * 0.4)))
    out = io.BytesIO()
    image.save(out, "JPEG")
    return out.getvalue()


def opened(data):
    return Image.open(io.BytesIO(data))


def test_the_overview_is_the_whole_photo_scaled_to_a_predictable_size(tmp_path):
    asset = ingest(tmp_path, photo())
    data, info = render_view(tmp_path, asset)
    assert max(opened(data).size) == VIEW_LONG_SIDE
    assert info["whole_photo"] and info["from"] == "original" and info["source_pixels"] == [3000, 2000]
    assert info["grid_step_percent"] == 10


def test_a_close_up_comes_from_the_original_at_full_detail(tmp_path):
    asset = ingest(tmp_path, photo())
    assert asset["width"] == 2560, "the committed copy is smaller than the original"
    data, info = render_view(tmp_path, asset, {"x": 60, "y": 30, "w": 10, "h": 10})
    assert info["source_pixels"] == [300, 200] and info["from"] == "original"
    assert opened(data).size == (600, 400), "small crops are enlarged, at most twice"
    middle = opened(data).convert("RGB").getpixel((330, 230))
    assert min(middle) > 200, "the crop shows the white part that sits there in the photo"


def test_without_the_original_the_copy_is_used(tmp_path):
    asset = ingest(tmp_path, photo())
    (tmp_path / asset["original"]).unlink()
    _, info = render_view(tmp_path, asset, {"x": 0, "y": 0, "w": 50, "h": 50})
    assert info["from"] == "copy"
    (tmp_path / asset["path"]).unlink()
    with pytest.raises(VisionError, match="missing"):
        render_view(tmp_path, asset)


@pytest.mark.parametrize("region, expected", [
    ({"x": 98, "y": -5, "w": 10, "h": 10}, {"x": 90.0, "y": 0.0, "w": 10.0, "h": 10.0}),
    ({"x": 50, "y": 50, "w": 0.1, "h": 500}, {"x": 50.0, "y": 0.0, "w": 3.0, "h": 100.0}),
])
def test_regions_are_kept_inside_the_photo_and_not_too_small(tmp_path, region, expected):
    asset = ingest(tmp_path, photo())
    assert render_view(tmp_path, asset, region)[1]["region"] == expected


def test_a_bad_region_is_explained(tmp_path):
    asset = ingest(tmp_path, photo())
    with pytest.raises(VisionError, match="x, y, w and h"):
        render_view(tmp_path, asset, {"x": "left"})


def test_a_marker_region_covers_the_header_and_some_of_its_surroundings():
    region = marker_region({"x": 100, "y": 200, "w": 100, "h": 50}, {"width": 1000, "height": 1000})
    assert region == pytest.approx({"x": 4.0, "y": 17.0, "w": 22.0, "h": 11.0})


def test_a_photo_is_decoded_once_for_many_views(tmp_path, monkeypatch):
    from pcbv import vision
    monkeypatch.setattr(vision, "_decoded", vision.ByteLru(vision.VISION_CACHE_BYTES, lambda entry: entry[0].width * entry[0].height * 3))
    asset = ingest(tmp_path, photo())
    decodes = []
    real = vision._upright
    monkeypatch.setattr(vision, "_upright", lambda handle: (decodes.append(1), real(handle))[1])
    for region in (None, {"x": 10, "y": 10, "w": 20, "h": 20}, {"x": 60, "y": 30, "w": 10, "h": 10}, None):
        render_view(tmp_path, asset, region)
    assert len(decodes) == 1


def test_decoded_photos_stay_within_the_pixel_budget_and_evict_the_oldest(tmp_path, monkeypatch):
    from pcbv import vision
    budget = 400 * 300 * 3 + 10                        # room for one decoded photo
    monkeypatch.setattr(vision, "_decoded", vision.ByteLru(budget, lambda entry: entry[0].width * entry[0].height * 3))
    assets = [ingest(tmp_path, photo(400, 300)) for _ in range(3)]
    decodes = []
    real = vision._upright
    monkeypatch.setattr(vision, "_upright", lambda handle: (decodes.append(1), real(handle))[1])
    for asset in assets:
        render_view(tmp_path, asset)
        assert len(vision._decoded) == 1 and vision._decoded.bytes <= budget
    render_view(tmp_path, assets[0])                   # evicted by the others, so it is decoded again
    assert len(decodes) == 4


def test_big_photos_are_kept_smaller_but_still_report_original_pixels(tmp_path, monkeypatch):
    from pcbv import vision
    monkeypatch.setattr(vision, "CACHE_LONG_SIDE", 1000)
    monkeypatch.setattr(vision, "_decoded", vision.ByteLru(vision.VISION_CACHE_BYTES, lambda entry: entry[0].width * entry[0].height * 3))
    asset = ingest(tmp_path, photo(3000, 2000))
    _, info = render_view(tmp_path, asset)
    ((kept, _), _size), = vision._decoded._items.values()
    assert max(kept.size) <= 1000
    assert info["source_pixels"] == [3000, 2000]
    _, close = render_view(tmp_path, asset, {"x": 60, "y": 30, "w": 10, "h": 10})
    across, down = close["source_pixels"]               # the crop is cut from the smaller copy: within one of its pixels
    assert abs(across - 300) <= 3 and abs(down - 200) <= 3


def test_a_replaced_file_is_not_served_from_the_old_decode(tmp_path):
    asset = ingest(tmp_path, photo(3000, 2000))
    first, _ = render_view(tmp_path, asset, {"x": 60, "y": 30, "w": 10, "h": 10})
    assert min(opened(first).convert("RGB").getpixel((330, 230))) > 200
    Image.new("RGB", (3000, 1999), (0, 0, 0)).save(tmp_path / asset["original"], "JPEG")
    again, _ = render_view(tmp_path, asset, {"x": 60, "y": 30, "w": 10, "h": 10})
    assert max(opened(again).convert("RGB").getpixel((330, 230))) < 60


def test_a_rotated_photo_reports_upright_original_pixels_through_the_cache(tmp_path, monkeypatch):
    from pcbv import vision
    monkeypatch.setattr(vision, "CACHE_LONG_SIDE", 1000)
    monkeypatch.setattr(vision, "_decoded", vision.ByteLru(vision.VISION_CACHE_BYTES, lambda entry: entry[0].width * entry[0].height * 3))
    exif = Image.Exif()
    exif[0x0112] = 6                                    # stored 3000 x 2000, shown 2000 x 3000
    out = io.BytesIO()
    Image.new("RGB", (3000, 2000), (20, 90, 40)).save(out, "JPEG", exif=exif)
    asset = ingest(tmp_path, out.getvalue())
    _, info = render_view(tmp_path, asset)
    ((kept, _), _size), = vision._decoded._items.values()
    assert kept.size[1] > kept.size[0] and info["source_pixels"] == [2000, 3000]


@pytest.mark.parametrize("keep_original", [True, False])
def test_a_turned_photo_shows_turned_close_ups(tmp_path, keep_original):
    from pcbv.photos import rotate
    asset = ingest(tmp_path, photo())
    turned = {**asset, "path": rotate(tmp_path, asset, 1), "width": asset["height"], "height": asset["width"], "rotation": 90}
    if not keep_original:
        (tmp_path / asset["original"]).unlink()
    data, info = render_view(tmp_path, turned, {"x": 60, "y": 60, "w": 10, "h": 10})
    assert info["from"] == ("original" if keep_original else "copy")
    view = opened(data).convert("RGB")
    middle = view.getpixel((int(view.width * 0.55), int(view.height * 0.55)))     # 65.5 %, between grid lines
    assert min(middle) > 200, "the white part moved with the turn"
    if keep_original:
        assert info["source_pixels"] == [200, 300]


def test_a_turn_is_not_served_from_the_unturned_decode(tmp_path, monkeypatch):
    from pcbv import vision
    monkeypatch.setattr(vision, "CACHE_LONG_SIDE", 1000)
    out = io.BytesIO()
    Image.new("RGB", (3000, 5), (20, 90, 40)).save(out, "JPEG")   # kept at 1000 x 2: 3 and 2.5 pixels per kept pixel
    asset = ingest(tmp_path, out.getvalue())
    assert render_view(tmp_path, asset)[1]["source_pixels"] == [3000, 5]
    assert render_view(tmp_path, {**asset, "rotation": 90})[1]["source_pixels"] == [5, 3000]
