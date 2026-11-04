"""Assistant settings, usage totals and API key storage.

Settings (profiles, models, prices) live in `$XDG_CONFIG_HOME/pcbv/assistant.json`. API keys live in
the system keyring and nowhere else: not in that file, not in a board folder, not in the data repo.
"""
from __future__ import annotations

import json
import threading
import urllib.parse
from pathlib import Path
from typing import Any

from ..fsutil import atomic_write
from ..net import is_loopback
from ..workspaces import config_dir
from .errors import AssistantError, KeyStoreError

PROFILES = ("tutor", "analyst", "local")
BUDGET_NAMES = ("normal", "deep")
# The two cloud slots are identical; the user names them. The ids stay, since keyring entries and usage
# totals are filed under them.
DEFAULT_NAMES = {"tutor": "Quick", "analyst": "Thorough"}
MAX_NAME = 24


def profile_label(profile: str, settings: dict | None = None) -> str:
    """What the user sees for a profile: the saved name of a cloud slot, or Local."""
    if profile == "local":
        return "Local"
    saved = ((settings or {}).get("profiles") or {}).get(profile, {}).get("name")
    return saved or DEFAULT_NAMES.get(profile, profile)


def _config_path(name: str) -> Path:
    return config_dir() / name


def default_settings() -> dict:
    return {"default": "tutor",
            "profiles": {name: {"base_url": "", "model": "", "price_in": 0.0, "price_out": 0.0, "photos": False,
                                  "budget": "normal", **({"name": DEFAULT_NAMES[name]} if name in DEFAULT_NAMES else {})}
                         for name in PROFILES}}


def endpoint(url: str) -> tuple[str, str, int] | None:
    """(scheme, host, effective port) of a base URL. A stored key and a photo consent belong to this
    tuple; a change of path keeps them."""
    parsed = urllib.parse.urlparse(url)
    if not parsed.hostname:
        return None
    scheme = parsed.scheme.lower()
    return scheme, parsed.hostname.lower(), parsed.port or (443 if scheme == "https" else 80)


def _number(value: Any, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 10_000:
        raise AssistantError(f"{where} must be a number from 0 to 10000 (dollars per million tokens)")
    return float(value)


def _name(value: Any, profile: str) -> str:
    if not isinstance(value, str):
        raise AssistantError(f"{profile}: name must be text")
    value = value.strip()
    if not 1 <= len(value) <= MAX_NAME or not value.isprintable():
        raise AssistantError(f"{profile}: name must be 1 to {MAX_NAME} characters without control or invisible characters")
    return value


def validate_settings(data: Any, base: dict | None = None) -> dict:
    """Clean settings from `data`. Profiles it leaves out, and the default, come from `base` if given."""
    if not isinstance(data, dict):
        raise AssistantError("settings must be an object")
    clean = json.loads(json.dumps(base)) if base else default_settings()
    default = data.get("default", clean["default"])
    if default not in PROFILES:
        raise AssistantError(f"default must be one of {', '.join(PROFILES)}")
    clean["default"] = default
    profiles = data.get("profiles", {})
    if not isinstance(profiles, dict) or set(profiles) - set(PROFILES):
        raise AssistantError(f"profiles must be an object with only {', '.join(PROFILES)}")
    for name, given in profiles.items():
        who = profile_label(name, clean)        # messages name the profile as the user sees it
        if not isinstance(given, dict) or set(given) - {"base_url", "model", "price_in", "price_out", "photos", "budget", "name"}:
            raise AssistantError(f"{who} may only set name, base_url, model, price_in, price_out, photos and budget")
        if name not in DEFAULT_NAMES and "name" in given:
            raise AssistantError("the local profile is always called Local")
        url = given.get("base_url", "")
        if not isinstance(url, str) or len(url) > 300:
            raise AssistantError(f"{who}: base_url must be text of at most 300 characters")
        url = url.strip().rstrip("/")
        if url:
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                raise AssistantError(f"{who}: base_url must look like https://host/v1, without a user name or password")
            try:
                endpoint(url)                  # reads the port, which raises for a bad one
            except ValueError:
                raise AssistantError(f"{who}: base_url has an invalid port") from None
            if parsed.scheme == "http" and not is_loopback(parsed.hostname):
                raise AssistantError(
                    f"{who}: base_url must use https unless the model server runs on this machine. For a server on "
                    "another machine, open an SSH tunnel in a terminal (ssh -N -L 11434:localhost:11434 <host>) and "
                    "use the address http://localhost:11434/v1")
        photos = given.get("photos")
        if photos is None:
            before = clean["profiles"].get(name, {})
            same = url and endpoint(before.get("base_url", "")) == endpoint(url)
            photos = before.get("photos", False) if same else bool(url) and is_loopback(endpoint(url)[1])
        if not isinstance(photos, bool):
            raise AssistantError(f"{who}: photos must be true or false")
        budget = given.get("budget", clean["profiles"].get(name, {}).get("budget", "normal"))
        if budget not in BUDGET_NAMES:
            raise AssistantError(f"{who}: budget must be normal or deep")
        model = given.get("model", "")
        if not isinstance(model, str) or len(model.strip()) > 100:
            raise AssistantError(f"{who}: model must be text of at most 100 characters")
        before_name = clean["profiles"].get(name, {}).get("name") or DEFAULT_NAMES.get(name)
        clean["profiles"][name] = {"base_url": url, "model": model.strip(),
                                   "price_in": _number(given.get("price_in", 0), f"{who}: price_in"),
                                   "price_out": _number(given.get("price_out", 0), f"{who}: price_out"),
                                   "photos": photos, "budget": budget}
        if name in DEFAULT_NAMES:
            clean["profiles"][name]["name"] = _name(given.get("name", before_name), who)
    return clean


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, (json.dumps(data, indent=2) + "\n").encode())


def load_settings_checked() -> tuple[dict, list[dict]]:
    """Saved settings and the warnings for what was reset. Each profile is checked on its own: one that
    fails keeps its default values and is listed as `{profile, message}`, and the others are kept. A
    missing file gives the defaults. An unreadable or non-object file, or one whose profiles are not an
    object, gives the defaults with every profile listed: their addresses are lost, so saving must not
    keep their keys for whatever address is typed next. A read writes nothing."""
    def all_reset(message: str) -> list[dict]:
        return [{"profile": name, "message": message} for name in PROFILES]

    try:
        raw = json.loads(_config_path("assistant.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default_settings(), []
    except (OSError, ValueError):
        return default_settings(), all_reset("assistant.json could not be read")
    if not isinstance(raw, dict):
        return default_settings(), all_reset("assistant.json must hold an object")
    clean, warnings = default_settings(), []
    if raw.get("default") in PROFILES:
        clean["default"] = raw["default"]
    elif "default" in raw:
        warnings.append({"profile": "default", "message": f"default must be one of {', '.join(PROFILES)}"})
    profiles = raw.get("profiles", {})
    if not isinstance(profiles, dict):
        return clean, [*warnings, *all_reset("profiles must be an object")]
    for name, given in profiles.items():
        try:
            if name not in PROFILES:
                raise AssistantError(f"{name} is not a profile; the profiles are {', '.join(PROFILES)}")
            clean["profiles"][name] = validate_settings({"profiles": {name: given}})["profiles"][name]
        except AssistantError as exc:
            warnings.append({"profile": name, "message": str(exc)})
    return clean, warnings


def load_settings() -> dict:
    return load_settings_checked()[0]


_settings_lock = threading.Lock()


_usage_lock = threading.Lock()


def load_usage() -> dict:
    """Running totals per profile: {requests, prompt_tokens, completion_tokens, cost} (dollars)."""
    try:
        data = json.loads(_config_path("assistant-usage.json").read_text(encoding="utf-8"))
        return {name: data[name] for name in PROFILES if isinstance(data.get(name), dict)}
    except (OSError, ValueError, AttributeError):
        return {}


def record_usage(profile: str, prompt: int, completion: int, cost: float) -> dict:
    with _usage_lock:
        usage = load_usage()
        row = usage.get(profile) or {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0}
        row = {"requests": int(row.get("requests", 0)) + 1,
               "prompt_tokens": int(row.get("prompt_tokens", 0)) + prompt,
               "completion_tokens": int(row.get("completion_tokens", 0)) + completion,
               "cost": round(float(row.get("cost", 0.0)) + cost, 6)}
        usage[profile] = row
        _write_json(_config_path("assistant-usage.json"), usage)
        return row


class MemoryKeyStore:
    """Keeps keys in memory only. For tests and for machines without a keyring."""

    def __init__(self) -> None:
        self._keys: dict[str, str] = {}

    def status(self) -> dict:
        return {"available": True, "detail": "in memory only"}

    def get(self, profile: str) -> str | None:
        return self._keys.get(profile)

    def set(self, profile: str, key: str) -> None:
        self._keys[profile] = key

    def delete(self, profile: str) -> None:
        self._keys.pop(profile, None)


class KeyringStore:
    """The system keyring (KWallet or GNOME Keyring through the Secret Service), via the keyring package."""
    SERVICE = "pcbv"

    def _keyring(self):
        try:
            import keyring
            from keyring.backends import fail
        except ImportError as exc:
            raise KeyStoreError("the keyring package is not installed") from exc
        if isinstance(keyring.get_keyring(), fail.Keyring):
            raise KeyStoreError("no system keyring found; start KWallet (or another Secret Service provider) and try again")
        return keyring

    def status(self) -> dict:
        try:
            kr = self._keyring()
            kr.get_password(self.SERVICE, "status-check")       # a harmless read; a locked wallet fails here
            return {"available": True, "detail": ""}
        except KeyStoreError as exc:
            return {"available": False, "detail": str(exc)}
        except Exception as exc:  # noqa: BLE001 - backends raise their own error types
            return {"available": False, "detail": f"the keyring refused: {exc}"}

    def _call(self, action: str, *args: str):
        kr = self._keyring()
        try:
            return getattr(kr, action)(self.SERVICE, *args)
        except Exception as exc:  # noqa: BLE001 - backends raise their own error types
            raise KeyStoreError(f"the keyring refused: {exc}") from exc

    def get(self, profile: str) -> str | None:
        return self._call("get_password", f"assistant:{profile}")

    def set(self, profile: str, key: str) -> None:
        self._call("set_password", f"assistant:{profile}", key)

    def delete(self, profile: str) -> None:
        try:
            self._call("delete_password", f"assistant:{profile}")
        except KeyStoreError as exc:
            if "not found" not in str(exc).lower() and "no such" not in str(exc).lower():
                raise
