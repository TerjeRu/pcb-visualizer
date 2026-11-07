"""Board photos: check an upload, keep the original locally, write a committed copy.

The original goes to `assets/photos/originals/` (git-ignored by the data repo template, since
phone photos are large and their EXIF can hold GPS position). The copy in `assets/photos/` is
upright, at most COPY_LONG_SIDE pixels on its long side, JPEG, with all metadata dropped. The
asset records the copy's size, so marker coordinates are pixels in the copy.
"""
from __future__ import annotations

import io
import os
import re
import secrets
import warnings
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .events import MAX_LABEL_CHARS
from .fsutil import Directory, File
from .schema import ASSET_DIR

PHOTO_DIR = f"{ASSET_DIR}/photos"
ORIGINALS_DIR = f"{PHOTO_DIR}/originals"
MAX_PHOTO_BYTES = 40_000_000
MAX_PIXELS = 100_000_000          # beyond this Pillow could be made to use gigabytes (decompression bomb)
Image.MAX_IMAGE_PIXELS = MAX_PIXELS   # Pillow's own guard, a second line behind open_image
COPY_LONG_SIDE = 2560
SIDES = ("front", "back", "detail", "other")
SAFE_STEM = re.compile(r"[A-Za-z0-9_-]{1,64}")
EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}


class PhotoError(ValueError):
    """The upload is not a usable photo. Maps to HTTP 422."""


def open_image(source) -> Image.Image:
    """Image.open that refuses a picture over MAX_PIXELS from its header, before any pixel is decoded.
    Pillow itself only warns up to twice the limit."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            image = Image.open(source)
    except Image.DecompressionBombError as exc:      # Pillow raises this past twice the limit
        raise PhotoError("the picture has far too many pixels") from exc
    if image.width * image.height > MAX_PIXELS:
        width, height = image.size
        image.close()
        raise PhotoError(f"the picture is {width} x {height} pixels; the limit is {MAX_PIXELS // 1_000_000} million")
    return image


def ingest(board_dir: Path, data: bytes, *, label: str = "", side: str | None = None) -> dict:
    """Store an uploaded photo and return the asset for an `asset/added` event. `side` is kept for older boards."""
    if side is not None and side not in SIDES:
        raise PhotoError(f"side must be one of {', '.join(SIDES)}")
    if not data:
        raise PhotoError("the upload is empty")
    if len(data) > MAX_PHOTO_BYTES:
        raise PhotoError(f"photo larger than {MAX_PHOTO_BYTES // 1_000_000} MB")
    try:
        with open_image(io.BytesIO(data)) as probe:
            kind = probe.format
            probe.verify()                       # structure check without decoding all pixels
        if kind not in EXTENSIONS:
            raise PhotoError(f"{kind or 'this'} files are not supported; use JPEG, PNG or WebP")
        with open_image(io.BytesIO(data)) as image:
            upright = ImageOps.exif_transpose(image)   # phones store rotation in EXIF
            upright.thumbnail((COPY_LONG_SIDE, COPY_LONG_SIDE), Image.Resampling.LANCZOS)
            copy = upright.convert("RGB")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise PhotoError(f"not a readable image: {exc}") from exc

    asset_id = f"img_{secrets.token_hex(5)}"
    out = io.BytesIO()
    copy.save(out, "JPEG", quality=85, optimize=True)   # no exif= argument, so no metadata is written
    copy_rel = f"{PHOTO_DIR}/{asset_id}.jpg"
    original_rel = f"{ORIGINALS_DIR}/{asset_id}.{EXTENSIONS[kind]}"
    with Directory(board_dir) as directory:
        directory.create_bytes(original_rel, data)
        directory.create_bytes(copy_rel, out.getvalue())
    asset = {
        "id": asset_id, "kind": "image", "path": copy_rel,
        "label": label.strip()[:MAX_LABEL_CHARS] or (side.capitalize() if side else "Photo"),
        "width": copy.width, "height": copy.height, "original": original_rel,
    }
    if side:
        asset["side"] = side
    return asset


# Pillow's transposes are counter-clockwise; a photo's rotation counts clockwise.
CLOCKWISE = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}


def _turned_original(board_dir: Path, asset: dict, rotation: int, size: tuple[int, int]) -> Image.Image | None:
    """The copy ingest would write, turned by `rotation`. None when the original is gone or gives another size."""
    source = resolve_file(board_dir, asset["original"]) if asset.get("original") else None
    if source is None:
        return None
    try:
        with source.open() as handle, open_image(handle) as image:
            upright = ImageOps.exif_transpose(image)
            upright.thumbnail((COPY_LONG_SIDE, COPY_LONG_SIDE), Image.Resampling.LANCZOS)
            copy = upright.convert("RGB")
    except (PhotoError, UnidentifiedImageError, OSError, SyntaxError):
        return None
    if rotation:
        copy = copy.transpose(CLOCKWISE[rotation])
    return copy if copy.size == size else None


def rotate(board_dir: Path, asset: dict, turns: int) -> str:
    """Write the photo turned by a quarter (1 right, -1 left) as a new copy, and return its path.

    The copy is made again from the original, so turns do not add JPEG loss. Without the original
    (a board cloned from git) the stored copy is turned at a higher quality.
    """
    rotation = (asset.get("rotation", 0) + 90 * turns) % 360
    copy, quality = _turned_original(board_dir, asset, rotation, (asset["height"], asset["width"])), 85
    if copy is None:
        source = resolve_file(board_dir, asset.get("path") or "")
        if source is None:
            raise PhotoError("the file for this photo is missing")
        try:
            with source.open() as handle, open_image(handle) as image:
                copy, quality = image.convert("RGB").transpose(CLOCKWISE[90 if turns == 1 else 270]), 95
        except (UnidentifiedImageError, OSError, SyntaxError) as exc:
            raise PhotoError(f"not a readable image: {exc}") from exc
    out = io.BytesIO()
    copy.save(out, "JPEG", quality=quality, optimize=True)
    stem = asset["id"] if SAFE_STEM.fullmatch(asset["id"]) else "photo"     # ids come from events
    rel = f"{PHOTO_DIR}/{stem}-{secrets.token_hex(4)}.jpg"
    with Directory(board_dir) as directory:
        directory.create_bytes(rel, out.getvalue())
    return rel


def discard(board_dir: Path, asset: dict) -> None:
    """Remove files written by ingest when the event that should record them was refused."""
    for rel in (asset.get("path"), asset.get("original")):
        if rel:
            with Directory(board_dir) as directory:
                directory.unlink(rel, missing_ok=True)


def resolve_file(board_dir: Path, rel: str) -> File | None:
    """A confined read reference, or None for a missing or unsafe file."""
    try:
        with Directory(board_dir) as directory:
            with directory.parent(rel):
                pass
            os.close(directory.open(rel))
        return File(board_dir, rel)
    except (OSError, ValueError):
        return None
