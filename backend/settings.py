"""Persistent settings in ~/.ulaunch/settings.json."""
import json
import os
import threading
from pathlib import Path

RUN = Path(os.environ.get("ULAUNCH_RUN_DIR", str(Path.home() / ".ulaunch" / "run")))
FILE = Path.home() / ".ulaunch" / "settings.json"

DEFAULTS = {
    "idle_timeout": 60,          # seconds until the matrix overlay kicks in
    "scan_flags": {              # default flags for new scans
        "deep": True,
        "service_version": True,
        "scripts": True,
        "udp": False,
        "full_tcp": False,
        "udp_top": 100,
    },
}

_lock = threading.Lock()


def _load() -> dict:
    try:
        with open(FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            out = dict(DEFAULTS)
            out.update({k: v for k, v in data.items() if k in DEFAULTS})
            return out
    except (OSError, ValueError):
        pass
    return dict(DEFAULTS)


def get() -> dict:
    with _lock:
        return _load()


def set_all(payload: dict) -> dict:
    with _lock:
        cur = _load()
        if "idle_timeout" in payload:
            try:
                cur["idle_timeout"] = max(10, min(3600, int(payload["idle_timeout"])))
            except (TypeError, ValueError):
                raise ValueError("idle_timeout must be an integer")
        if "scan_flags" in payload and isinstance(payload["scan_flags"], dict):
            cur["scan_flags"] = {**cur["scan_flags"], **payload["scan_flags"]}
        FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = FILE.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(cur, f, indent=2)
        os.replace(tmp, FILE)
        return cur
