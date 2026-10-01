"""Wifi scan tool: `iwlist <iface> scan` on a chosen wireless adapter,
re-run every 5 s while a scan session is live (the first scan starts
immediately; each completed scan waits 5 s, then refreshes).

Cells are parsed from iwlist's text output and merged across scans
(latest observation per BSSID wins). The scan needs root (iwlist reads
the driver's scan dump), so every scan goes through the shared sudo
helper — on a passwordless account (Raspberry Pi) it runs silently, on a
stock account the UI prompts once via the in-app sudo modal.
"""
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

REFRESH_S = 5.0
SCAN_TIMEOUT = 20  # iwlist on a Pi can take several seconds on busy air

_CELL_RE = re.compile(r"Cell \d+ - Address:\s*([0-9A-Fa-f:]{17})")
_FIELD_RES = {
    "channel": re.compile(r"Channel:(\d+)"),
    "frequency": re.compile(r"Frequency:([\d.]+)\s*GHz"),
    "quality": re.compile(r"Quality=(\d+)/(\d+)\s+Signal level=(-?\d+)\s*dBm"),
    "encryption": re.compile(r"Encryption key:(\w+)"),
    "essid": re.compile(r'ESSID:"(.*)"'),
    "mode": re.compile(r"Mode:(\S+)"),
}


def parse_iwlist(text: str) -> list[dict]:
    """Parse `iwlist <iface> scan` output -> list of cell dicts.

    One dict per `Cell NN - Address:` block; fields are None when the
    driver didn't report them (some cards omit frequency/quality)."""
    cells: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        m = _CELL_RE.search(line)
        if m:
            cur = {
                "bssid": m.group(1).upper(),
                "channel": None,
                "frequency": None,
                "band": "other",
                "quality": None,
                "quality_max": None,
                "signal_dbm": None,
                "encryption": "off",
                "essid": "",
                "mode": "",
            }
            cells.append(cur)
            continue
        if cur is None:
            continue
        fm = _FIELD_RES["channel"].search(line)
        if fm and cur["channel"] is None:
            cur["channel"] = int(fm.group(1))
        fm = _FIELD_RES["frequency"].search(line)
        if fm and cur["frequency"] is None:
            cur["frequency"] = float(fm.group(1))
            cur["band"] = band_of(cur["frequency"])
        fm = _FIELD_RES["quality"].search(line)
        if fm and cur["quality"] is None:
            cur["quality"] = int(fm.group(1))
            cur["quality_max"] = int(fm.group(2))
            cur["signal_dbm"] = int(fm.group(3))
        fm = _FIELD_RES["encryption"].search(line)
        if fm:
            cur["encryption"] = fm.group(1).lower()
        fm = _FIELD_RES["essid"].search(line)
        if fm:
            cur["essid"] = fm.group(1)
        fm = _FIELD_RES["mode"].search(line)
        if fm and not cur["mode"]:
            cur["mode"] = fm.group(1)
    # cells without a frequency fall back to the channel's band
    for c in cells:
        if c["band"] == "other" and c["channel"] is not None:
            c["band"] = band_of_channel(c["channel"])
    return cells


def band_of(freq: float) -> str:
    if freq < 3.0:
        return "2.4"
    if freq >= 5.925:  # 6 GHz band starts at 5925 MHz (5 GHz ends ~5850)
        return "6"
    return "5"


def band_of_channel(ch: int) -> str:
    """Fallback for cells that report no frequency (rare). 6 GHz cells
    almost always carry a 5.9 GHz frequency, so anything above the
    classic 2.4 GHz set is 5 GHz (incl. UNII-3 ch 149)."""
    if ch <= 14:
        return "2.4"
    return "5"


def wireless_adapters() -> list[dict]:
    """Wireless interfaces: anything with a sysfs `wireless` dir (the
    real test), plus name-based fallbacks (wlan*/wfi*) so interfaces on
    systems that don't expose the sysfs marker (and our test containers,
    where sysfs is read-only) are still listed. Excludes the usual
    virtual/bridge noise. Exposed as `up` + (best-effort) channel info."""
    seen: dict[str, dict] = {}
    pdir = Path("/sys/class/net")
    try:
        entries = sorted(pdir.iterdir())
    except OSError:
        entries = []
    for d in entries:
        name = d.name
        if not name or name == "lo":
            continue
        is_wireless = (d / "wireless").is_dir()
        name_like = re.fullmatch(r"w(lan|ifi)\d*", name, re.I) is not None
        if not (is_wireless or name_like):
            continue
        if re.fullmatch(r"(docker|br-|veth\w+|virbr\w+)", name):
            continue
        item: dict = {"name": name, "up": False, "channel": None}
        try:
            # sysfs flags are hex with a 0x prefix (e.g. 0x1003) — IF_UP is bit 0
            flags = int((d / "flags").read_text().strip(), 0)
            item["up"] = bool(flags & 1)
        except (OSError, ValueError):
            pass
        if is_wireless:
            try:
                item["channel"] = int(
                    (d / "iw" / "channel").read_text().strip())
            except (OSError, ValueError):
                pass
        seen[name] = item
    return [seen[n] for n in sorted(seen, key=lambda n: (not seen[n]["up"], n))]


def iwlist_installed() -> bool:
    return shutil.which("iwlist") is not None


def probe_scan(iface: str) -> dict:
    """One privileged scan. Returns {cells, error}. Raises SudoRequired
    when no cached password and the account isn't passwordless."""
    if not iwlist_installed():
        return {"cells": None, "error": "iwlist is not installed (wireless-tools package)"}
    from sudo import sudo
    p = sudo.run("iwlist", iface, "scan", timeout=SCAN_TIMEOUT)
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "").strip()
        # iwlist prints "Scan completed :" on stdout; errors on stderr
        if not err:
            err = f"iwlist exited with code {p.returncode}"
        return {"cells": None, "error": err[-300:]}
    return {"cells": parse_iwlist(p.stdout), "error": ""}


class WifiSession:
    """One live scan session: the scan loop runs in a daemon thread and
    merges cells across iterations. Single global instance — the UI is a
    single-operator device."""

    def __init__(self):
        self.iface: str | None = None
        self.status: str = "idle"  # idle|running|stopped|error
        self.scanning: bool = False          # a scan is in flight right now
        self.error: str = ""
        self.started: float = 0
        self.updated: float = 0              # last successful scan
        self.cells: dict[str, dict] = {}     # bssid -> latest cell
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # ── control ────────────────────────────────────────────────
    def start(self, iface: str, seed: list[dict] | None = None) -> dict:
        if self.status == "running":
            return self.public()
        if not Path("/sys/class/net", iface).is_dir() and \
                not re.fullmatch(r"w(lan|ifi)\d*", iface, re.I):
            raise ValueError(f"unknown or non-wireless interface: {iface}")
        with self._lock:
            self.iface = iface
            self.status = "running"
            self.error = ""
            self.started = time.time()
            # the start-probe already scanned once — seed its results so
            # the UI shows networks immediately, not after the loop's own
            # first scan (on a Pi that can be another several seconds)
            self.cells = {c["bssid"]: c for c in (seed or [])}
            self.updated = time.time() if self.cells else 0
            self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self.public()

    def stop(self) -> dict:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=SCAN_TIMEOUT + 5)
        with self._lock:
            if self.status == "running":
                self.status = "stopped"
            self.scanning = False
        return self.public()

    def reset(self) -> None:
        """Test hook: stop and clear everything."""
        self.stop()
        with self._lock:
            self.cells = {}
            self.iface = None
            self.status = "idle"
            self.error = ""
            self.updated = 0

    # ── loop ───────────────────────────────────────────────────
    def _loop(self) -> None:
        iface = self.iface
        if not iface:
            return
        while not self._stop.is_set():
            with self._lock:
                self.scanning = True
            try:
                res = probe_scan(iface)
            except Exception as e:  # noqa: BLE001 — incl. SudoRequired
                with self._lock:
                    self.scanning = False
                    self.status = "error"
                    self.error = str(e)
                return
            with self._lock:
                self.scanning = False
                if self.status != "running":
                    return
                if res["cells"] is None:
                    self.status = "error"
                    self.error = res["error"]
                    return
                for c in res["cells"]:
                    self.cells[c["bssid"]] = c
                self.updated = time.time()
            # refresh: after the results are in, wait REFRESH_S before the
            # next scan (the first scan ran immediately on start)
            self._stop.wait(REFRESH_S)
        with self._lock:
            if self.status == "running":
                self.status = "stopped"
            self.scanning = False

    # ── view ───────────────────────────────────────────────────
    def public(self) -> dict:
        with self._lock:
            cells = list(self.cells.values())
            return {
                "status": self.status,
                "scanning": self.scanning,
                "iface": self.iface,
                "error": self.error,
                "started": self.started,
                "updated": self.updated,
                "cells": cells,
            }

    def overlay(self) -> dict:
        """Lightweight state for the idle overlay: is the scan session live.
        No cells — those are heavy while a scan is running."""
        with self._lock:
            return {"scanning": self.status == "running"}


wifi = WifiSession()
