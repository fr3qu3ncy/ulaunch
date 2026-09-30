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
import contextlib
import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

REFRESH_S = 5.0
SCAN_TIMEOUT = 20

BLUEZ_BUS_TIMEOUT = 6  # s — a wedged/absent bus must not hang the pick view

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
        gets a dead connection. Active mode: passive mode on bleak 3.x
        REQUIRES bluez or_patterns (raising in the constructor — M26.4
        bug: we passed none, the ctor blew up inside the thread, the
        session stayed 'running' with 0 devices and no error). Active is
        what bluetoothctl 'scan on' does — it sees every device, which is
        what a launcher's scanner should too; BLE devices re-advertise
        continuously and the extra probe packets are harmless."""
        from bleak import BleakScanner
        kwargs: dict = {"scanning_mode": "active"}
        if adapter:
            # 3.0: `bluez={"adapter": name}`; 2.x: `bluez=adapter`
            try:
                from bleak.args.bluez import BlueZScannerArgs  # noqa: F401
            except ImportError:
                kwargs["bluez"] = adapter
            else:
                kwargs["bluez"] = {"adapter": adapter}
        # The CONSTRUCTOR is inside the try on purpose (M26.4): on bleak 3.x
        # a misconfigured scanner raises in the ctor (e.g. passive without
        # or_patterns). Outside the try, that killed the thread with the
        # session already marked 'running' -> "running, 0 devices, no
        # error" forever.
        try:
            scanner = BleakScanner(**kwargs)
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


def bluez_adapters_from_managed(managed: dict[str, dict]) -> list[dict]:
    """org.bluez ObjectManager.GetManagedObjects reply -> adapter dicts.
    Pure function over the unpacked {path: {iface: {props}}} mapping so
    the parsing is unit-testable without a D-Bus bus.

    `name` MUST be the D-Bus OBJECT NAME (path last segment, "hci0") —
    it is what bleak's bluez={'adapter': ...} needs: bleak builds the
    path itself as /org/bluez/<name> (bluezdbus/scanner.py) and looks it
    up among the managed objects. M26.5 bug: we used the Address
    PROPERTY (the MAC, D8:3A:DD:FE:88:07) as the name — bleak looked for
    /org/bluez/D8:3A:DD:FE:88:07, for which no such object exists, and
    the scan died with "adapter 'D8:3A:..' not found" although the radio
    was fine. The MAC stays in `address` for display only."""
    out: list[dict] = []
    for path, ifaces in managed.items():
        props = ifaces.get("org.bluez.Adapter1")
        if not props:
            continue
        obj_name = path.rsplit("/", 1)[-1]
        out.append({
            "name": obj_name,
            "address": props.get("Address", ""),
            "powered": bool(props.get("Powered")),
            "discoverable": bool(props.get("Discoverable")),
            "pairable": bool(props.get("Pairable")),
            "path": f"/org/bluez/{obj_name}",
        })
    return out


def _adapters_from_bluez() -> list[dict]:
    """Adapters straight from BlueZ over D-Bus (org.bluez
    ObjectManager.GetManagedObjects) — the authoritative source: it is the
    same path the rest of the stack (and bleak itself) uses. Returns []
    when BlueZ can't be reached (no system bus, no bluetoothd, timeout) —
    the caller then falls back to the kernel's sysfs view.

    Why this is primary: on the uConsole (kernel 6.12, BCM4345C0 over
    hci_uart) the kernel registers hci0 but never creates the sysfs
    attribute files — /sys/class/bluetooth/hci0/ holds only
    device/power/rfkill0/subsystem/uevent, NO address file. The sysfs
    reader below skips such entries and reports "no adapter" even though
    the radio works (the BT mouse connects fine through BlueZ). D-Bus has
    the real data: Address, Name, Powered, Discoverable, Pairable.

    One-shot pattern: connect, GetManagedObjects, disconnect. We must NOT
    reuse bleak's BlueZManager (it adds signal listeners and expects the
    bus connection to stay alive) and must not leave the bus connected in
    a daemon thread that outlives the call. Runs in a fresh thread with its
    own event loop — same shape as the scanner thread, because the app's
    main loop is a sync FastAPI thread and MessageBus is asyncio-bound."""
    from dbus_fast import BusType, Message, unpack_variants
    from dbus_fast.aio.message_bus import MessageBus

    async def probe() -> list[dict]:
        bus = MessageBus(bus_type=BusType.SYSTEM)
        try:
            await bus.connect()
        except Exception:
            with contextlib.suppress(Exception):
                bus.disconnect()
            return []
        out: list[dict] = []
        try:
            reply = await bus.call(Message(
                destination="org.bluez",
                path="/",
                interface="org.freedesktop.DBus.ObjectManager",
                member="GetManagedObjects",
            ))
            out = bluez_adapters_from_managed(
                {p: unpack_variants(ifaces) for p, ifaces in reply.body[0].items()})
        finally:
            with contextlib.suppress(Exception):
                bus.disconnect()
        return out

    result: list[dict] = []
    err: str = ""

    def run() -> None:
        nonlocal result, err
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                asyncio.wait_for(probe(), timeout=BLUEZ_BUS_TIMEOUT))
        except Exception as e:  # noqa: BLE001 — bus timeout / auth / protocol
            err = f"{type(e).__name__}: {e}"[:120]
        finally:
            loop.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout=BLUEZ_BUS_TIMEOUT + 2)
    if t.is_alive():  # wedged bus — don't hold the endpoint hostage
        err = err or "bluez D-Bus probe wedged (timed out)"
    return result


def bt_adapters() -> list[dict]:
    """Bluetooth adapters, primary source BlueZ over D-Bus (see
    _adapters_from_bluez — the uConsole's kernel 6.12 never creates the
    sysfs attribute files, so the sysfs view alone reports "no adapter"
    on a perfectly working radio), fallback the kernel's sysfs view
    (/sys/class/bluetooth, one dir per adapter, hci0-style names — no
    D-Bus, no root). Returns [] only when BOTH sources are empty —
    e.g. this dev box, a VM, or a genuinely absent radio (see
    bt_diagnostics). `name` is the D-Bus object name (hci0) in BOTH
    paths — that is what bleak's bluez= adapter arg needs (it builds
    /org/bluez/<name> from it); the MAC lives in `address` only.
    The scan itself goes through bleak/BlueZ; if BlueZ is missing the
    scan reports the error, which the UI turns into INSTALL BLUETOOTH."""
    out = _adapters_from_bluez()
    if out:
        return out
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
    # hci driver registered? Two distinct radio classes:
    #  - USB dongles:  /sys/bus/usb/drivers/btusb
    #  - SoC/UART (the uConsole's BCM4345C0): hci_uart/btbcm kernel modules,
    #    no USB device at all — btusb is ABSENT and always was; probing it
    #    alone made every uConsole read "NOT registered" (M26.3 bug)
    hci_drv_registered = Path("/sys/bus/usb/drivers/btusb").exists()
    mods_path = Path("/proc/modules")
    try:
        mods = {ln.split()[0] for ln in mods_path.read_text().splitlines()}
    except OSError:
        mods = set()
    hci_soc_registered = {"bluetooth", "hci_uart"} <= mods
    hci_drv_registered = hci_drv_registered or hci_soc_registered
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
    elif not adapters and hci_drv_registered and svc in ("active", "running"):
        hints.append("the kernel + bluetooth service are up but no adapter "
                     "is answering — try RESTART BLUETOOTH below, then "
                     "REFRESH (hci0 can take a few seconds after boot)")
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
