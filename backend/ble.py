"""BLE scan tool: live Bluetooth LE advertising via bleak (BlueZ/DBus).

Unlike the wifi tool (iwlist, root) this runs as the normal user — the
uConsole user is in the `bluetooth` group and BlueZ exposes its D-Bus API
without root. One scanner thread owns an asyncio event loop and a
BleakScanner; it merges advertisements into a device table (latest
observation per MAC wins) and serves it to the UI every 5 s.

Manufacturer names: each advertisement's manufacturer_data is keyed by the
Bluetooth SIG Company Identifier. We map it with the full SIG list bundled
in data/company_ids.json (4000+ entries), falling back to bleak's own
built-in table, then the raw hex code. The advertised device *name* is
shown when the device sends one — that is the model/identifier for most
consumer devices.
"""
import asyncio
import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

REFRESH_S = 5.0
SCAN_TIMEOUT = 20

DATA = Path(__file__).resolve().parent / "data" / "company_ids.json"

# ── company identifier mapping ─────────────────────────────────
_company: dict[int, str] = {}
try:
    for entry in json.loads(DATA.read_text()):
        _company[entry["code"]] = entry["name"]
except (OSError, ValueError, KeyError):
    pass
if not _company:
    try:
        from bleak.backends._manufacturers import MANUFACTURERS
        _company = dict(MANUFACTURERS)
    except ImportError:
        _company = {}


def manufacturer_of(cid: int) -> str:
    name = _company.get(cid)
    if name:
        return name
    return f"0x{cid:04X}"


def _device_dict(addr: str, name: str | None, adv) -> dict:
    """One BLEDevice + AdvertisementData -> the JSON device dict."""
    return {
        "address": addr,
        "name": name or adv.local_name or "",
        "rssi": adv.rssi,
        "tx_power": adv.tx_power,
        "manufacturer": manufacturer_of(
            next(iter(adv.manufacturer_data)))
        if adv.manufacturer_data else None,
        "manufacturer_raw": [
            {"cid": cid, "hex": f"{cid:04X}",
             "data": raw.hex()}
            for cid, raw in adv.manufacturer_data.items()
        ],
        "services": [u for u in adv.service_uuids],
        "service_data": {u: raw.hex() for u, raw in adv.service_data.items()},
    }


class BleSession:
    """One live scan session: the scanner runs in a daemon thread with its
    own event loop. Single global instance — the UI is a single-operator
    device."""

    def __init__(self):
        self.status: str = "idle"  # idle|running|stopped|error
        self.error: str = ""
        self.started: float = 0
        self.updated: float = 0
        self.devices: dict[str, dict] = {}  # addr -> latest device dict
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # ── control ────────────────────────────────────────────────
    def start(self, adapter: str | None = None) -> dict:
        if self.status == "running":
            return self.public()
        with self._lock:
            self.status = "running"
            self.error = ""
            self.started = time.time()
            self.updated = 0
            self.devices = {}
            self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, args=(adapter,), daemon=True)
        self._thread.start()
        return self.public()

    def stop(self) -> dict:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=SCAN_TIMEOUT + 5)
        with self._lock:
            if self.status == "running":
                self.status = "stopped"
        return self.public()

    def reset(self) -> None:
        """Test hook: stop and clear everything."""
        self.stop()
        with self._lock:
            self.devices = {}
            self.status = "idle"
            self.error = ""
            self.started = 0
            self.updated = 0

    # ── scanner thread ─────────────────────────────────────────
    def _run(self, adapter: str | None) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._scan(adapter))
        loop.close()

    async def _scan(self, adapter: str | None) -> None:
        """Start the scanner, let it run until stopped. The scanner is
        started INSIDE the thread's event loop — creating a BleakScanner
        on one loop and starting it on another is how the DBus transport
        gets a dead connection."""
        from bleak import BleakScanner
        kwargs: dict = {"scanning_mode": "passive"}
        if adapter:
            # 3.0: `bluez={"adapter": name}`; 2.x: `bluez=adapter`
            try:
                from bleak.args.bluez import BlueZScannerArgs  # noqa: F401
            except ImportError:
                kwargs["bluez"] = adapter
            else:
                kwargs["bluez"] = {"adapter": adapter}
        scanner = BleakScanner(**kwargs)
        try:
            await scanner.start()
        except Exception as e:  # noqa: BLE001 — any backend/DBus failure
            with self._lock:
                if self.status == "running":
                    self.status = "error"
                self.error = self._friendly(e)
            return
        try:
            while not self._stop.is_set():
                try:
                    seen = scanner.discovered_devices_and_advertisement_data
                    for addr, (dev, adv) in seen.items():
                        with self._lock:
                            self.devices[addr] = _device_dict(
                                addr, dev.name, adv)
                            self.updated = time.time()
                except Exception:  # noqa: BLE001 — never kill the session
                    pass
                self._stop.wait(1.0)
        finally:
            try:
                await scanner.stop()
            except Exception:  # noqa: BLE001
                pass
            with self._lock:
                if self.status == "running":
                    self.status = "stopped"

    @staticmethod
    def _friendly(e: Exception) -> str:
        msg = str(e).strip() or e.__class__.__name__
        low = msg.lower()
        if "org.bluez" in low or "dbus" in low or "bluez" in low:
            return ("bluez bluetooth daemon not reachable — "
                    "is the bluez package installed and bluetooth "
                    "running? (INSTALL BLUETOOTH on this screen, then "
                    "SCAN AGAIN)")
        if ("not powered on" in low or "powered off" in low
                or "no suitable adapter" in low or "controller" in low
                or "adapter" in low):
            return (f"no usable bluetooth adapter ({msg[:180]} — the "
                    "adapter may be powered off or rfkill-blocked; use "
                    "the BT screen's POWER ON / RESTART BLUETOOTH "
                    "controls, then SCAN AGAIN)")
        return msg[:300]

    # ── view ───────────────────────────────────────────────────
    def public(self) -> dict:
        with self._lock:
            return {
                "status": self.status,
                "error": self.error,
                "started": self.started,
                "updated": self.updated,
                "devices": list(self.devices.values()),
            }


ble = BleSession()


# ── adapters ───────────────────────────────────────────────────
def _run_user(argv: list[str], timeout: int = 5) -> subprocess.CompletedProcess:
    """Run a plain-user command (no sudo) — rfkill, systemctl is-active.
    These work as the uConsole user without root."""
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return subprocess.CompletedProcess(argv, 127, "", "")


def _adapter_state(d: Path) -> dict:
    """Power/pairable state from sysfs. NOTE: `powered` must come from the
    `power` file (0/1) — `discoverable` is a separate mode and was the
    original M26 bug: an adapter that's ON but not discoverable read as
    "powered off"."""
    def _flag(name: str) -> bool | None:
        try:
            v = int((d / name).read_text().strip() or 0)
        except (OSError, ValueError):
            return None
        return v == 1
    powered = _flag("power")
    if powered is None:  # sysfs file unreadable — fall back to discoverable
        powered = _flag("discoverable")
    return {
        "powered": bool(powered),
        "discoverable": _flag("discoverable"),
        "pairable": _flag("pairable"),
    }


def bt_adapters() -> list[dict]:
    """Bluetooth adapters from the kernel's sysfs view (/sys/class/bluetooth,
    one dir per adapter, hci0-style names — no D-Bus, no root). Returns []
    when the box has no adapter or no kernel support (e.g. this dev box, or
    a VM, or a uConsole whose bluetooth service is down / firmware not
    loaded — see bt_diagnostics). The scan itself goes through
    bleak/BlueZ; if BlueZ is missing the scan reports the error, which the
    UI turns into INSTALL BLUETOOTH."""
    out: list[dict] = []
    try:
        for d in sorted(Path("/sys/class/bluetooth").iterdir()):
            try:
                addr = (d / "address").read_text().strip()
            except OSError:
                continue
            out.append({
                "name": d.name,
                "address": addr,
                **_adapter_state(d),
                "path": f"/org/bluez/{d.name}",
            })
    except OSError:
        pass
    return out


def bt_diagnostics() -> dict:
    """What the kernel + userspace say about the BT stack, for the
    "no adapters" screen on the pick view. All plain-user probes — the
    uConsole user runs this with no root:
      - hci driver registered? (driver in /sys/bus)
      - adapter sysfs entries (bt_adapters)
      - rfkill soft/hard blocks
      - bluetooth systemd service state
      - last bluez/hci lines from dmesg (firmware load failures show up
        there — "Failed to load bluetooth firmware" is the classic)
    Hints are actionable, in priority order."""
    adapters = bt_adapters()
    drv = Path("/sys/bus/usb/drivers/btusb")
    hci_drv_registered = drv.exists()
    rfkill = _run_user(["rfkill"]).stdout.strip()
    svc = _run_user(["systemctl", "is-active", "bluetooth"]).stdout.strip()
    dmesg = _run_user(["dmesg"]).stdout
    bt_lines = [ln.strip() for ln in dmesg.splitlines()
                if re.search(r"blue|hci|btusb|firmware.*bluetooth", ln, re.I)][-10:]
    hints: list[str] = []
    if not adapters and not hci_drv_registered:
        hints.append("no hci adapter in the kernel — check the dmesg lines "
                     "below (firmware load failures land there); a reboot "
                     "often recovers it")
    for a in adapters:
        if not a["powered"]:
            hints.append(f"adapter {a['name']} is powered off — use "
                         f"POWER ON {a['name']} below")
    if re.search(r"Soft blocked|soft blocked", rfkill, re.I):
        hints.append("an rfkill SOFT block is on — unblock with: "
                     "sudo rfkill unblock bluetooth")
    if re.search(r"Hard blocked|hard blocked", rfkill, re.I):
        hints.append("an rfkill HARD block is on (hardware kill switch) — "
                     "toggle the physical switch")
    if svc and svc not in ("active", "running"):
        hints.append("the bluetooth service is not active — RESTART "
                     "BLUETOOTH below (needs your password)")
    return {
        "adapters": adapters,
        "hci_drv_registered": hci_drv_registered,
        "rfkill": rfkill.splitlines(),
        "service": svc or "unknown",
        "dmesg": bt_lines,
        "hints": hints,
    }


def restart_bluetooth() -> dict:
    """Restart the bluetooth service (sudo) — the recovery for a uConsole
    whose BT service is down or whose firmware failed to load at boot.
    Waits up to ~8s for an adapter to appear in sysfs, then re-probes."""
    from sudo import SudoRequired, sudo
    try:
        p = sudo.run("systemctl", "restart", "bluetooth", timeout=60)
    except SudoRequired:
        raise
    if p.returncode != 0:
        raise ValueError((p.stderr or p.stdout or "systemctl restart bluetooth failed")[-300:])
    for _ in range(16):
        if bt_adapters():
            break
        time.sleep(0.5)
    return {
        "ok": True,
        "adapters": bt_adapters(),
        "service": _run_user(["systemctl", "is-active", "bluetooth"]).stdout.strip(),
    }


def power_adapter(name: str, on: bool) -> dict:
    """Power an adapter on/off. bluetoothctl works for a normal user in the
    `bluetooth` group (no sudo); if it's not on the PATH, fall back to
    hciconfig (needs the `bluetooth` group too)."""
    argv = ["bluetoothctl", "power", "on" if on else "off"]
    p = _run_user(argv, timeout=15)
    if p.returncode != 0 and shutil.which("hciconfig"):
        p = _run_user(["hciconfig", name, "up" if on else "down"], timeout=15)
    if p.returncode != 0:
        raise ValueError((p.stderr or p.stdout or "power change failed")[-300:])
    return {"ok": True, "adapters": bt_adapters()}


def bluetooth_available() -> dict:
    """BlueZ presence for /api/tools + the in-app install banner: is the
    bluez package installed (bluetoothd on the PATH) and is the daemon
    running (best-effort systemctl probe; without systemd the binary
    presence counts)?"""
    installed = shutil.which("bluetoothd") is not None
    running = False
    if installed:
        try:
            p = subprocess.run(["systemctl", "is-active", "bluetooth"],
                               capture_output=True, text=True, timeout=5)
            running = p.stdout.strip() == "active"
        except (OSError, subprocess.SubprocessError):
            running = True  # no systemd (container) — binary is enough
    return {"installed": installed, "running": running}
