"""Photo views for the bench assistant: the whole photo, or a close-up cut from the original.

Every view carries a light grid labelled in percent of the whole photo (x from the left edge, y from the
top), and the model gives positions back in the same percent. A point read off a close-up therefore
means the same as one read off the overview, and converts to pixels in the committed copy, which is
what markers and callouts use.

Close-ups are cut from the original in `assets/photos/originals/` when it is there, since chip markings
are often unreadable in the 2560-pixel copy. The original is turned upright the same way the copy was,
then by the photo's `rotation` when it was turned in the app.
"""
from __future__ import annotations

import io
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from .limits import VISION_CACHE_BYTES, ByteLru
from .photos import CLOCKWISE, open_image, resolve_file

CACHE_LONG_SIDE = 4096         # decoded photos are kept at most this big; 48 MP phone originals are not held whole
VIEW_LONG_SIDE = 1568          # model servers scale larger images down anyway; this keeps the cost predictable
MIN_SPAN = 3.0                 # percent: a narrower close-up is mostly blur
MAX_UPSCALE = 2.0
GRID_STEPS = (1, 2, 5, 10, 20, 25)
MARKER_MARGIN = 0.6            # around a header marker, as a share of its size, so nearby parts show too


class VisionError(ValueError):
    """The photo or region cannot be shown. The message is meant for the model."""


# (upright RGB image, original pixels per cached pixel across and down), keyed by file and its size and
# time so a replaced file is read again. Images are only ever cropped and copied, never changed in place.
_decoded: ByteLru[tuple, tuple[Image.Image, tuple[float, float]]] = ByteLru(
    VISION_CACHE_BYTES, lambda entry: entry[0].width * entry[0].height * 3)


def _upright(handle) -> tuple[Image.Image, tuple[float, float]]:
    with open_image(handle) as opened:
        full = opened.size
        opened.draft("RGB", (CACHE_LONG_SIDE, CACHE_LONG_SIDE))   # JPEG: decode at a reduced scale
        drafted = opened.size
        upright = ImageOps.exif_transpose(opened).convert("RGB")
    if upright.size != drafted:                                   # turned by its EXIF orientation
        full = full[::-1]
    if max(upright.size) > CACHE_LONG_SIDE:
        upright.thumbnail((CACHE_LONG_SIDE, CACHE_LONG_SIDE), Image.Resampling.LANCZOS)
    return upright, (full[0] / upright.width, full[1] / upright.height)


def _region(region: dict | None) -> tuple[float, float, float, float]:
    """A clean (x, y, w, h) in percent, inside the photo and at least MIN_SPAN wide and high."""
    if region is None:
        return 0.0, 0.0, 100.0, 100.0
    try:
        x, y, w, h = (float(region[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise VisionError("region needs x, y, w and h in percent of the whole photo") from None
    w, h = max(MIN_SPAN, min(100.0, w)), max(MIN_SPAN, min(100.0, h))
    x, y = max(0.0, min(100.0 - w, x)), max(0.0, min(100.0 - h, y))
    return x, y, w, h


def marker_region(marker: dict, asset: dict) -> dict:
    """The area around a header marker, in percent of the photo."""
    width, height = asset.get("width") or 0, asset.get("height") or 0
    if not width or not height:
        raise VisionError("this photo has no recorded size")
    mw, mh = marker.get("w") or width * 0.04, marker.get("h") or height * 0.04
    pad_x, pad_y = mw * MARKER_MARGIN, mh * MARKER_MARGIN
    left, top = (marker.get("x") or 0) - pad_x, (marker.get("y") or 0) - pad_y
    return {"x": 100 * left / width, "y": 100 * top / height,
            "w": 100 * (mw + 2 * pad_x) / width, "h": 100 * (mh + 2 * pad_y) / height}


def _grid_step(span: float) -> int:
    return next((step for step in GRID_STEPS if span / step <= 10), GRID_STEPS[-1])


def _label(value: float) -> str:
    return f"{value:g}%"


def _draw_grid(image: Image.Image, x: float, y: float, w: float, h: float) -> int:
    """Grid lines at round percentages of the whole photo, labelled along the top and left edges."""
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = ImageFont.load_default(size=max(14, image.width // 70))
    step = _grid_step(max(w, h))
    lines = []
    for value in range(int(x // step + 1) * step, int(x + w) + 1, step):
        px = round((value - x) / w * (image.width - 1))
        lines.append(("x", value, px))
    for value in range(int(y // step + 1) * step, int(y + h) + 1, step):
        py = round((value - y) / h * (image.height - 1))
        lines.append(("y", value, py))
    for axis, _, pos in lines:
        end = (pos, image.height) if axis == "x" else (image.width, pos)
        draw.line([(pos, 0) if axis == "x" else (0, pos), end], fill=(255, 230, 0, 110), width=1)
    for axis, value, pos in lines:
        text = _label(value)
        left, top, right, bottom = font.getbbox(text)
        if axis == "x":
            at = (pos + 3, 2) if pos + right + 6 < image.width else (pos - right - 5, 2)
        else:
            at = (2, pos + 2) if pos + bottom + 4 < image.height else (2, pos - bottom - 4)
        draw.rectangle([at[0] - 2, at[1] - 1, at[0] + right + 2, at[1] + bottom + 2], fill=(0, 0, 0, 170))
        draw.text(at, text, font=font, fill=(255, 230, 0, 255))
    image.alpha_composite(overlay)
    return step


def render_view(board_dir: Path, asset: dict, region: dict | None = None) -> tuple[bytes, dict]:
    """A JPEG of the photo or a region of it, with the percent grid, and a description of the view."""
    x, y, w, h = _region(region)
    source, kind = None, "copy"
    if asset.get("original"):
        source = resolve_file(board_dir, asset["original"])
        kind = "original" if source else kind
    source = source or resolve_file(board_dir, asset.get("path") or "")
    if source is None:
        raise VisionError("the file for this photo is missing")
    # The original is never turned on disk; a photo turned in the app records its quarter turns.
    turn = asset.get("rotation", 0) if kind == "original" else 0
    with source.open() as handle:
        stat = os.fstat(handle.fileno())
        key = (str(board_dir), kind, asset.get("id"), stat.st_size, stat.st_mtime_ns, turn)
        cached = _decoded.get(key)
        if cached is None:
            cached = _upright(handle)
            if turn in CLOCKWISE:
                image, (across, down) = cached
                cached = image.transpose(CLOCKWISE[turn]), ((down, across) if turn != 180 else (across, down))
            _decoded.put(key, cached)
    upright, (across, down) = cached
    box = (round(upright.width * x / 100), round(upright.height * y / 100),
           round(upright.width * (x + w) / 100), round(upright.height * (y + h) / 100))
    crop = upright.crop(box)
    scale = min(VIEW_LONG_SIDE / max(crop.size), MAX_UPSCALE)
    if scale != 1:
        crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
    view = crop.convert("RGBA")
    step = _draw_grid(view, x, y, w, h)
    out = io.BytesIO()
    view.convert("RGB").save(out, "JPEG", quality=85)
    info = {"photo": asset.get("id"), "label": asset.get("label"), "side": asset.get("side"),
            "region": {"x": round(x, 2), "y": round(y, 2), "w": round(w, 2), "h": round(h, 2)},
            "whole_photo": (x, y, w, h) == (0.0, 0.0, 100.0, 100.0), "from": kind,
            "source_pixels": [round((box[2] - box[0]) * across), round((box[3] - box[1]) * down)], "grid_step_percent": step}
    return out.getvalue(), info
