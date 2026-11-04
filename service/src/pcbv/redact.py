"""Redacted copies of a board for sharing: `pcbv redact`.

The board folder stays the complete record. A redacted copy replaces credentials, password hashes,
serial numbers, MAC addresses, public IP addresses, email addresses and any strings listed in the
board's `.pcbv/redact.txt` (ignored by the data repo's git, since it holds the secrets themselves).
The same value always gets the same stand-in within one copy, so logs stay readable. Photos are
re-encoded without metadata; text printed in a photo is beyond reach and the report says so. Photo
originals, the `.pcbv/` folder and symlinks are never copied; logic captures only on request, since
their raw samples cannot be cleaned.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from PIL import ImageOps, UnidentifiedImageError

from .fsutil import Directory, File
from .photos import PhotoError, open_image

CUSTOM_LIST = Path(".pcbv") / "redact.txt"
MAX_TEXT_BYTES = 20_000_000
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

# The credential rule from the data repo's gitleaks config (template/gitleaks.toml), so the commit guard
# and the redaction agree on what a router credential looks like. Spaces are [ \t] here because a value
# never continues on the next line, and multi-line JSON strings would otherwise lose a following word.
CREDENTIAL_RE = re.compile(
    r"(?i)\b(?:wpa_?passphrase|wpa_?psk|wpa_?key|wl\d?_?wpa_psk|psk|ppp(?:oe)?_?(?:password|passwd|pass|secret)"
    r"|sip_?(?:password|passwd|auth_?pass)|voip_?(?:password|passwd)|cwmp_?(?:password|passwd)"
    r"|tr069_?(?:password|passwd)|acs_?(?:password|passwd)|connection_?request_?password"
    r"|admin_?(?:password|passwd)|root_?(?:password|passwd)|http_?passwd|passwd|password)[ \t]*[=:][ \t]*[\"']?([^\s\"']{4,})")
# OpenWrt UCI: option key 'secret'
UCI_RE = re.compile(r"(?i)\boption\s+(?:key|password|passwd|psk|secret|auth_secret|sae_password|wpa_psk)[ \t]+[\"']?([^\s\"']{4,})")
MASKED_RE = re.compile(r"^(?:\*+|x+|<[^>]*>|\$\{?\w+\}?|\[[A-Z0-9-]+\])$")
HASH_RE = re.compile(r"\$(?:1|5|6|2[aby])\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{20,}"
                    r"|\$y\$[./0-9A-Za-z]+\$[./0-9A-Za-z]+\$[./0-9A-Za-z]{20,}"
                    r"|\$sha1\$\d+\$[./0-9A-Za-z]+\$[./0-9A-Za-z]{20,}")
# Traditional DES crypt (13 characters) in the second field of a shadow-style line.
DES_HASH_RE = re.compile(r"(?m)^[^\s:]+:([./0-9A-Za-z]{13})(?=:\d*:)")
# The body stops at the next BEGIN, so a file full of unterminated headers is scanned in linear time.
PEM_RE = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----(?:(?!-----BEGIN )[\s\S])*?-----END \1-----")
# A header whose end line never came (a capture stopped mid-key) and the base64 lines under it. Each
# repetition starts with a required line break, so it cannot backtrack. A bare header gives nothing away.
PEM_OPEN_RE = re.compile(r"-----BEGIN [A-Z0-9 ]+-----(?:\r?\n[A-Za-z0-9+/=]{16,})+")
# Key segments that mark a JSON value as a secret: "wifiPassword" and "api_key" match, "keyboard" does not.
SECRET_KEY_WORDS = {"password", "passwd", "secret", "token", "key", "psk", "wpa"}
SERIAL_RE = re.compile(r"(?i)\b(?:serial[ _-]?(?:no|num|number)?|s/n|sn)[ \t]*[=:][ \t]*[\"']?([A-Za-z0-9][A-Za-z0-9-]{4,})")
SERIAL_XML_RE = re.compile(r"(?i)<SerialNumber>\s*([^<\s]{4,})\s*</SerialNumber>")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
MAC_RE = re.compile(r"(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}([:-]))(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])"
                    r"|(?<![0-9A-Fa-f.])[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}(?![0-9A-Fa-f.])")
IPV4_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
IPV6_RE = re.compile(r"(?<![\w:])[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])")
# Kernel and firmware versions such as 2.6.32.61 look like public IPv4 addresses.
VERSION_BEFORE_RE = re.compile(r"(?i)\b(?:version|ver\.?|v|kernel|linux)\s*$")
UNIDENTIFYING_MACS = {"000000000000", "ffffffffffff"}


class RedactError(Exception):
    """The copy cannot be made as asked."""


@dataclass
class Finding:
    kind: str
    file: str
    line: int | None


@dataclass
class Redactor:
    """Replaces sensitive values in text. Holds the mapping, so a value keeps its stand-in across files."""
    custom: list[str] = field(default_factory=list)
    stand_ins: dict[tuple[str, str], str] = field(default_factory=dict)
    counters: Counter = field(default_factory=Counter)

    def _stand_in(self, kind: str, value: str, make) -> str:
        key = (kind, value.lower() if kind in ("mac", "email") else value)
        if key not in self.stand_ins:
            self.counters[kind] += 1
            self.stand_ins[key] = make(self.counters[kind])
        return self.stand_ins[key]

    def _group(self, pattern, kind, label, text, found):
        def sub(match):
            value = match.group(1)
            if MASKED_RE.match(value):
                return match.group(0)
            found.append(kind)
            start, end = match.span(1)
            replacement = self._stand_in(kind, value, lambda n: f"[{label}-{n}]")
            return match.group(0)[: start - match.start()] + replacement + match.group(0)[end - match.start():]
        return pattern.sub(sub, text)

    def secret(self, value: str, found: list[str]) -> str:
        """The stand-in for a value stored under a secret key. Empty and masked values stay."""
        if not value or MASKED_RE.match(value):
            return value
        found.append("credential")
        return self._stand_in("credential", value, lambda n: f"[SECRET-{n}]")

    def pem(self, match, found: list[str]) -> str:
        found.append("pem-block")
        return self._stand_in("pem-block", match.group(0), lambda n: f"[PEM-BLOCK-{n}]")

    def _mac(self, match, found):
        value = match.group(0)
        digits = re.sub(r"[^0-9A-Fa-f]", "", value).lower()
        if digits in UNIDENTIFYING_MACS:
            return value
        found.append("mac")

        def make(n):
            # Locally administered addresses (02:...) never belong to real hardware.
            raw = f"0200{n:08x}"
            if "." in value:
                return ".".join(raw[i:i + 4] for i in range(0, 12, 4))
            sep = "-" if "-" in value else ":"
            out = sep.join(raw[i:i + 2] for i in range(0, 12, 2))
            return out.upper() if value.isupper() else out
        return self._stand_in("mac", digits, make)

    def _ip(self, match, text, found):
        value = match.group(0)
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return value
        if not address.is_global:
            return value
        if address.version == 4 and VERSION_BEFORE_RE.search(text[max(0, match.start() - 12):match.start()]):
            return value
        found.append("ip")
        # Documentation ranges (RFC 5737, RFC 3849) are reserved for examples and never routed.
        if address.version == 4:
            return self._stand_in("ip", value, lambda n: f"203.0.113.{n % 254 + 1}" if n <= 254 else f"198.51.100.{n % 254 + 1}")
        return self._stand_in("ip6", value, lambda n: f"2001:db8::{n:x}")

    def text(self, text: str) -> tuple[str, list[str]]:
        """The redacted text and the kinds of value replaced, one entry per replacement."""
        found: list[str] = []
        for literal in self.custom:
            if literal in text:
                found.extend(["custom"] * text.count(literal))
                text = text.replace(literal, self._stand_in("custom", literal, lambda n: f"[CUSTOM-{n}]"))
        text = PEM_RE.sub(lambda m: self.pem(m, found), text)
        text = PEM_OPEN_RE.sub(lambda m: self.pem(m, found), text)
        text = self._group(CREDENTIAL_RE, "credential", "SECRET", text, found)
        text = self._group(UCI_RE, "credential", "SECRET", text, found)

        def hash_sub(match):
            found.append("password-hash")
            return self._stand_in("password-hash", match.group(0), lambda n: f"[PASSWORD-HASH-{n}]")
        text = HASH_RE.sub(hash_sub, text)
        text = self._group(DES_HASH_RE, "password-hash", "PASSWORD-HASH", text, found)
        text = self._group(SERIAL_RE, "serial", "SERIAL", text, found)
        text = self._group(SERIAL_XML_RE, "serial", "SERIAL", text, found)

        def email_sub(match):
            found.append("email")
            return self._stand_in("email", match.group(0), lambda n: f"user{n}@example.invalid")
        text = EMAIL_RE.sub(email_sub, text)
        text = MAC_RE.sub(lambda m: self._mac(m, found), text)
        text = IPV4_RE.sub(lambda m: self._ip(m, text, found), text)
        text = IPV6_RE.sub(lambda m: self._ip(m, text, found), text)
        return text, found


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    copied: list[str] = field(default_factory=list)
    photos: list[str] = field(default_factory=list)
    left_out: list[tuple[str, str]] = field(default_factory=list)

    def counts(self) -> Counter:
        return Counter(f.kind for f in self.findings)

    def markdown(self, board: str) -> str:
        lines = [f"# Redaction report: {board}", "",
                 "This copy was made with `pcbv redact`. Replaced values are shown as stand-ins such as",
                 "`[SECRET-1]` or `02:00:00:00:00:01`; the same value always has the same stand-in.", ""]
        counts = self.counts()
        lines += ["## Replaced", ""]
        if counts:
            lines += ["| Kind | Count |", "|---|---|"] + [f"| {kind} | {n} |" for kind, n in sorted(counts.items())]
        else:
            lines.append("Nothing matched the redaction rules.")
        by_file: dict[str, list[Finding]] = {}
        for finding in self.findings:
            by_file.setdefault(finding.file, []).append(finding)
        if by_file:
            lines += ["", "## Where", ""]
            for name, items in sorted(by_file.items()):
                where = ", ".join(sorted({f"{f.kind} (line {f.line})" if f.line else f.kind for f in items}))
                lines.append(f"- `{name}`: {where}")
        if self.photos:
            lines += ["", "## Check by eye", "",
                      "Photo metadata was removed, but text printed in a photo (serial number labels, Wi-Fi",
                      "keys on stickers) cannot be found automatically. Look at each photo before sharing:", ""]
            lines += [f"- `{p}`" for p in self.photos]
        if self.left_out:
            lines += ["", "## Left out", ""] + [f"- `{p}`: {why}" for p, why in self.left_out]
        lines += ["", "## Not covered", "",
                  "The rules find common formats. Unusual credential formats, keys in binary data, user",
                  "names in shell prompts and paths, and personal details in free-text notes can remain. Add",
                  "anything specific to `.pcbv/redact.txt` in the board folder, one string per line, and read",
                  "the copy before publishing it.", ""]
        return "\n".join(lines)


def load_custom(board_dir: Path) -> list[str]:
    try:
        text = File(board_dir, str(CUSTOM_LIST)).read_text()
    except OSError:
        return []
    entries = [line.strip() for line in text.splitlines()]
    # Longest first, so a value that contains another is replaced whole.
    return sorted({e for e in entries if len(e) >= 3 and not e.startswith("#")}, key=len, reverse=True)


def _secret_key(key: str) -> bool:
    segments = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key).lower()
    return any(word in SECRET_KEY_WORDS for word in re.split(r"[^a-z0-9]+", segments))


def _redact_json(value, redactor: Redactor, found: list[str], secret: bool = False):
    """`secret` is set below a secret key: every string or number there is replaced whole."""
    if isinstance(value, str):
        if secret:
            return redactor.secret(value, found)
        cleaned, kinds = redactor.text(value)
        found.extend(kinds)
        return cleaned
    if isinstance(value, list):
        return [_redact_json(v, redactor, found, secret) for v in value]
    if isinstance(value, dict):
        return {k: _redact_json(v, redactor, found, secret or _secret_key(k)) for k, v in value.items()}
    if secret and isinstance(value, (int, float)) and not isinstance(value, bool):
        return redactor.secret(str(value), found)
    return value


def _skip_reason(rel: Path, include_logic: bool) -> str | None:
    parts = rel.parts
    if parts[0] == ".pcbv":
        return "service state and the private redaction list"
    if parts[:3] == ("assets", "photos", "originals"):
        return "photo original, kept on this machine only"
    if not include_logic and rel.suffix == ".sr":
        return "logic capture; raw samples cannot be redacted (use --include-logic to copy it as is)"
    return None


def redact_board(board_dir: Path, out: Path | None, *, include_logic=False, photos=True, redactor=None, files=None):
    with Directory(files if files is not None else board_dir) as root:
        return _redact_board(board_dir, out, include_logic=include_logic, photos=photos, redactor=redactor, files=root)


def _redact_board(board_dir: Path, out: Path | None, *, include_logic: bool = False, photos: bool = True,
                 redactor: Redactor | None = None, files=None) -> Report:
    """Redact every file of a board into `out`. With out=None nothing is written (a check). Pass a redactor
    to share stand-ins with other output, such as an export."""
    board_dir = Path(board_dir).resolve()
    if out is not None:
        out = Path(out).resolve()
        if out == board_dir or board_dir in out.parents:
            raise RedactError("the redacted copy cannot go inside the board folder")
        if out.exists():
            raise FileExistsError(f"{out} already exists; choose a new folder")
    redactor = redactor or Redactor(custom=load_custom(files))
    report = Report()
    with Directory(files) as directory:
        relatives = list(directory.walk(include_symlinks=True))
    for relative in relatives:
        rel = Path(relative)
        path = File(files, relative)
        if (board_dir / rel).is_symlink():
            report.left_out.append((str(rel), "symbolic link"))
            continue
        reason = _skip_reason(rel, include_logic)
        if reason:
            if rel.parts[0] != ".pcbv":
                report.left_out.append((str(rel), reason))
            continue
        target = out / rel if out else None
        if rel.suffix.lower() in PHOTO_SUFFIXES:
            if not photos:
                report.left_out.append((str(rel), "photo (--no-photos)"))
                continue
            if target:
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with path.open() as handle, open_image(handle) as opened:
                        image = ImageOps.exif_transpose(opened)   # the orientation tag is dropped with the rest of the EXIF
                        clean = image.convert("RGB") if image.mode not in ("RGB", "L") else image.copy()
                        # Saving without exif=, xmp= or icc_profile= writes no metadata at all.
                        clean.save(target, "JPEG" if rel.suffix.lower() in (".jpg", ".jpeg") else rel.suffix[1:].upper(), quality=95)
                except (PhotoError, UnidentifiedImageError) as exc:
                    report.left_out.append((str(rel), f"photo that cannot be redacted ({exc})"))
                    continue
            report.photos.append(str(rel))
            continue
        if rel.suffix == ".sr":
            report.copied.append(str(rel))
            if target:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())
            continue
        with path.open() as handle:
            size = os.fstat(handle.fileno()).st_size
        if size > MAX_TEXT_BYTES:
            report.left_out.append((str(rel), "larger than 20 MB"))
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            report.left_out.append((str(rel), "binary file that cannot be redacted"))
            continue
        cleaned, findings = _redact_file(rel, text, redactor)
        report.findings += findings
        report.copied.append(str(rel))
        if target:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(cleaned, encoding="utf-8")
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
        (out / "REDACTION.md").write_text(report.markdown(board_dir.name), encoding="utf-8")
    return report


def _redact_file(rel: Path, text: str, redactor: Redactor) -> tuple[str, list[Finding]]:
    name = str(rel)
    # JSON is redacted value by value: a text replacement could cut through an escaped quote.
    if rel.suffix == ".json":
        try:
            data = json.loads(text)
        except ValueError:
            pass
        else:
            found: list[str] = []
            cleaned = _redact_json(data, redactor, found)
            return json.dumps(cleaned, indent=2, ensure_ascii=False) + "\n", [Finding(k, name, None) for k in found]
    if rel.suffix == ".jsonl":
        out_lines, findings = [], []
        for number, line in enumerate(text.splitlines(), 1):
            try:
                data = json.loads(line)
            except ValueError:
                cleaned, kinds = redactor.text(line)
            else:
                kinds = []
                cleaned = json.dumps(_redact_json(data, redactor, kinds), ensure_ascii=False, separators=(",", ":"))
            out_lines.append(cleaned)
            findings += [Finding(k, name, number) for k in kinds]
        return "\n".join(out_lines) + ("\n" if text.endswith("\n") else ""), findings
    return redact_lines(name, text, redactor)


def _pem_blocks(text: str):
    """Complete PEM blocks, and between them unterminated ones, in the order they appear."""
    position = 0
    for block in PEM_RE.finditer(text):
        yield from PEM_OPEN_RE.finditer(text, position, block.start())
        yield block
        position = block.end()
    yield from PEM_OPEN_RE.finditer(text, position)


def redact_lines(name: str, text: str, redactor: Redactor) -> tuple[str, list[Finding]]:
    """Plain text, line by line, except PEM blocks, which span lines and are replaced first."""
    out, findings, line_no, position = [], [], 1, 0

    def lines(chunk: str) -> str:
        nonlocal line_no
        cleaned = []
        for index, line in enumerate(chunk.split("\n")):
            if index:
                line_no += 1
            result, kinds = redactor.text(line)
            cleaned.append(result)
            findings.extend(Finding(k, name, line_no) for k in kinds)
        return "\n".join(cleaned)

    for block in _pem_blocks(text):
        out.append(lines(text[position:block.start()]))
        kinds: list[str] = []
        out.append(redactor.pem(block, kinds))
        findings.append(Finding(kinds[0], name, line_no))
        line_no += block.group(0).count("\n")
        position = block.end()
    out.append(lines(text[position:]))
    return "".join(out), findings
