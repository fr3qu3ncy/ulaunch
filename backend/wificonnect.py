"""Wireless CONNECT via Network Manager (`nmcli dev wifi connect`).

Complements wifiscan.py (iwlist, read-only scan): this module actually
joins a network. The passphrase is supplied in-app (the wifi connect
prompt) and stored per-SSID in a 0600 file under ~/.ulaunch/ (the same
"stored on this device only, never returned" model as the VPN preset
creds). `nmcli dev wifi connect <ssid> --password <pw>` also persists the
connection in Network Manager, so a later connect can reuse it — our file
is what lets the UI know a passphrase is already on this device and skip
the prompt.

Listing (`nmcli dev wifi list`) is UNPRIVILEGED (Network Manager allows
unprivileged clients to enumerate APs — net.py does the same), so the
UI's periodic refresh needs no sudo. Only connect/disconnect are
privileged (nmcli talks to Network Manager to configure the radio), and
those go through the shared sudo helper — passwordless accounts
(Raspberry Pi / uConsole) run silently, stock accounts get the in-app
sudo modal on 401.
"""
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from sudo import SudoRequired, sudo

BASE = Path.home() / ".ulaunch"
FILE = BASE / "wifi-networks.json"
CONNECT_TIMEOUT = 60  # assoc + auth + DHCP can take a while on busy air
LIST_TIMEOUT = 20

_lock = threading.Lock()


def nmcli_installed() -> bool:
    return shutil.which("nmcli") is not None


# ── saved networks (the passphrase file) ───────────────────────
def _load() -> dict:
    try:
        data = json.loads(FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    BASE.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, FILE)
    try:
        os.chmod(FILE, 0o600)
    except OSError:
        pass


def list_saved() -> list[dict]:
    """Saved networks, newest-connect first. Passphrases are NEVER
    returned — only a `has_pass` flag (the UI prompts once and stores)."""
    with _lock:
        data = _load()
    out = []
    for essid, net in data.items():
        item = {k: v for k, v in net.items() if k != "passphrase"}
        item["ssid"] = essid
        item["has_pass"] = bool(net.get("passphrase"))
        out.append(item)
    out.sort(key=lambda n: n.get("last") or n.get("first") or "", reverse=True)
    return out


def has_stored_pass(essid: str) -> bool:
    with _lock:
        net = _load().get(essid) or {}
    return bool(net.get("passphrase"))


def forget(essid: str) -> bool:
    """Drop the saved network (and its passphrase) from the file. nmcli's
    own copy, if any, stays — it is Network Manager's to manage."""
    with _lock:
        data = _load()
        if essid not in data:
            return False
        del data[essid]
        _save(data)
        return True


# ── list / status (unprivileged) ───────────────────────────────
def _nmcli_list() -> tuple[list[dict], dict | None]:
    """`nmcli -t -f IN-USE,SSID,CHAN,SIGNAL,SECURITY,STATE dev wifi list`
    -> (cells, connected). IN-USE is the connected row's '*'; STATE=
    connected is the same row. Both are read from one output so the two
    can't disagree. UNPRIVILEGED — no sudo."""
    p = subprocess.run(
        ["nmcli", "-t", "-f",
         "IN-USE,SSID,CHAN,SIGNAL,SECURITY,STATE", "dev", "wifi", "list"],
        capture_output=True, text=True, timeout=LIST_TIMEOUT,
    )
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "nmcli failed").strip()
        raise ValueError(err[-300:] or f"nmcli exited {p.returncode}")
    cells: list[dict] = []
    connected: dict | None = None
    for line in p.stdout.splitlines():
        parts = line.split(":", 5)
        if len(parts) < 5:
            continue
        in_use, ssid, chan, sig, security = parts[0], parts[1], parts[2], parts[3], parts[4]
        state = parts[5].strip() if len(parts) > 5 else ""
        if not ssid:  # hidden / nameless beacon — nothing to act on
            continue
        sec = " ".join(s.strip() for s in security.split() if s.strip())
        open_net = sec == "" or sec.upper() == "NONE"
        cell: dict = {
            "ssid": ssid,
            "channel": int(chan) if chan.isdigit() else None,
            "signal": int(sig) if sig.isdigit() else None,
            "security": sec,
            "open": open_net,
        }
        if in_use.strip() == "*" or state == "connected":
            connected = {
                "ssid": ssid,
                "signal": int(sig) if sig.isdigit() else None,
                "security": sec,
                "open": open_net,
            }
        else:
            cells.append(cell)
    cells.sort(key=lambda c: (-(c["signal"] if c["signal"] is not None else 0),
                              c["ssid"].lower()))
    return cells, connected


def list_networks() -> dict:
    """Available networks + the one we're on (if any) + saved networks.
    Unprivileged — never raises SudoRequired. Raises ValueError when
    nmcli is missing or the scan failed (the endpoint maps to 400)."""
    if not nmcli_installed():
        raise ValueError("nmcli is not installed (Network Manager)")
    cells, connected = _nmcli_list()
    with _lock:
        data = _load()
    for c in cells:
        c["saved"] = c["ssid"] in data
    if connected:
        connected["saved"] = connected["ssid"] in data
    return {"cells": cells, "connected": connected, "saved": list_saved()}


# ── connect / disconnect (privileged) ──────────────────────────
def _connect_cmd(essid: str, passphrase: str | None) -> list[str]:
    cmd = ["nmcli", "dev", "wifi", "connect", essid]
    if passphrase is not None:
        # --password (not --ask): the passphrase comes from our in-app
        # prompt, never from an interactive TTY. nmcli stores the
        # connection so a later connect can reuse it without the pass.
        cmd += ["--password", passphrase]
    return cmd


def connect(essid: str, passphrase: str | None = None) -> dict:
    """Join `essid`. A secured network with no passphrase (and none stored)
    fails fast with a clear error instead of a doomed nmcli call. On
    success the passphrase is stored (or refreshed) in the 0600 file.
    Raises SudoRequired when no password is cached (the endpoint maps to
    401 so the UI pops the sudo modal)."""
    essid = (essid or "").strip()
    if not essid or len(essid) > 128:
        raise ValueError("invalid network name")
    if not nmcli_installed():
        raise ValueError("nmcli is not installed (Network Manager)")
    passphrase = passphrase or None

    # a stored passphrase is used when the caller didn't supply one
    if passphrase is None:
        with _lock:
            passphrase = (_load().get(essid) or {}).get("passphrase") or None

    # security pre-check, only for a NEW connection (no passphrase given
    # and none stored): an open network needs none, a secured one must
    # have one. Read the list once to find the target's security.
    if passphrase is None:
        try:
            cells, _ = _nmcli_list()
        except (ValueError, subprocess.TimeoutExpired):
            cells = []
        target = next((c for c in cells if c["ssid"] == essid), None)
        if target and not target["open"]:
            raise ValueError(
                f"'{essid}' is secured — enter its passphrase to connect")

    cmd = _connect_cmd(essid, passphrase)
    try:
        p = sudo.run(*cmd, timeout=CONNECT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return _fail(f"timed out after {CONNECT_TIMEOUT}s — the network may "
                     "be out of range or the passphrase is wrong")
    except SudoRequired:
        raise
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "").strip()
        hint = ""
        low = err.lower()
        if "secret" in low or "disconnected" in low or "password" in low:
            hint = " — the passphrase is likely incorrect; try again"
        return _fail((err or f"nmcli exited {p.returncode}")[-300:] + hint)

    # success — store the passphrase (ONLY when we actually used one — an
    # open network connects without a passphrase and must not end up in the
    # file, or the UI would prompt for one on every later connect)
    if passphrase is not None:
        with _lock:
            data = _load()
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            net = data.get(essid) or {}
            net["passphrase"] = passphrase
            net.setdefault("first", now)
            net["last"] = now
            data[essid] = net
            _save(data)

    # confirm via a fresh status read (nmcli returns once associated)
    try:
        _, connected = _nmcli_list()
    except (ValueError, subprocess.TimeoutExpired):
        connected = None
    return {"ok": True, "connected": connected, "ssid": essid}


def _fail(detail: str) -> dict:
    return {"ok": False, "error": detail, "connected": None}


def disconnect() -> dict:
    """Leave the current wifi (nmcli dev wifi disconnect). Privileged."""
    try:
        p = sudo.run("nmcli", "dev", "wifi", "disconnect", timeout=20)
    except SudoRequired:
        raise
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "nmcli failed").strip()
        return _fail(err[-300:] or f"nmcli exited {p.returncode}")
    try:
        _, connected = _nmcli_list()
    except (ValueError, subprocess.TimeoutExpired):
        connected = None
    return {"ok": True, "connected": connected}


def status() -> dict:
    """The currently connected network (or None). Unprivileged — the UI's
    refresh uses this to flip a row to CONNECTED without a full list."""
    try:
        _, connected = _nmcli_list()
    except (ValueError, subprocess.TimeoutExpired):
        connected = None
    return {"connected": connected}


def install() -> dict:
    """sudo apt-get install network-manager — provides nmcli."""
    try:
        p = sudo.run("apt-get", "install", "-y", "network-manager",
                     timeout=900)
    except SudoRequired:
        raise
    if p.returncode != 0:
        raise ValueError((p.stderr or "")[-400:] or "install failed")
    return {"installed": nmcli_installed()}
