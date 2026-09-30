import sys, types
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / "backend"))
import ble

def make(d: Path, power=None, discoverable=None, pairable=None, address="AA:BB:CC:DD:EE:FF"):
    d.mkdir(parents=True, exist_ok=True)
    (d / "address").write_text(address + "\n")
    for name, val in (("power", power), ("discoverable", discoverable), ("pairable", pairable)):
        if val is not None:
            (d / name).write_text(f"{val}\n")

# Case 1: THE M26 BUG — powered on (power=1) but NOT discoverable (discoverable=0).
# Old code read discoverable -> "powered off". New code must say powered ON.
base = Path("/tmp/bletest"); base.mkdir(exist_ok=True)
hci = base / "hci0"
make(hci, power=1, discoverable=0, pairable=0)
st = ble._adapter_state(hci)
assert st["powered"] is True, f"BUG: power=1 discoverable=0 read as powered={st['powered']}"
assert st["discoverable"] is False
print("PASS  powered-on-but-not-discoverable -> powered ON  (the M26 bug)")

# Case 2: genuinely off (power=0) must read as off
make(hci / ".." / "hci1" if False else (base / "hci1"), power=0, discoverable=0)
st2 = ble._adapter_state(base / "hci1")
assert st2["powered"] is False, f"power=0 should be off, got {st2}"
print("PASS  powered-off (power=0) -> powered OFF")

# Case 3: no power file, discoverable=1 -> falls back, reads ON
make(base / "hci2", power=None, discoverable=1)
st3 = ble._adapter_state(base / "hci2")
assert st3["powered"] is True
print("PASS  missing power file, discoverable=1 -> fallback ON")

# Case 4: no power file, no discoverable -> powered False (unknown), no crash
make(base / "hci3")
st4 = ble._adapter_state(base / "hci3")
assert st4["powered"] is False
print("PASS  no power/discoverable -> powered False, no crash")

# bt_adapters over the fake tree: all four adapters, correct powered flags
import unittest.mock as mock
def fake_iterdir(_):
    return [base / "hci0", base / "hci1", base / "hci2", base / "hci3"]
with mock.patch.object(Path, "iterdir", fake_iterdir):
    with mock.patch.object(Path, "exists", return_value=True):
        # patch the specific path's iterdir only
        pass
# bt_adapters uses Path("/sys/class/bluetooth").iterdir(); patch that exact object
sysfs = Path("/sys/class/bluetooth")
with mock.patch.object(type(sysfs), "iterdir", return_value=[base / "hci0", base / "hci1", base / "hci2", base / "hci3"]):
    out = ble.bt_adapters()
    by = {a["name"]: a for a in out}
    assert len(out) == 4, f"expected 4 adapters, got {len(out)}"
    assert by["hci0"]["powered"] is True   # the bug case
    assert by["hci1"]["powered"] is False
    assert by["hci2"]["powered"] is True
    assert by["hci3"]["powered"] is False
    print(f"PASS  bt_adapters: {[(a['name'], a['powered']) for a in out]}")

print("\nALL POWERED-STATE TESTS PASS")

# M26.4 regression: bleak 3.x passive scanning REQUIRES bluez or_patterns
# (the constructor raises). We scan ACTIVE — that constructor must stay
# buildable, and the passive-without-or_patterns failure mode must remain
# loud (this is what made a scan sit 'running' with 0 devices, no error).
from bleak import BleakScanner  # noqa: E402
from bleak.exc import BleakError  # noqa: E402
try:
    BleakScanner(scanning_mode="passive")
    raise SystemExit("BUG: passive without or_patterns must raise (bleak 3.x)")
except BleakError as e:
    assert "or_patterns" in str(e)
BleakScanner(scanning_mode="active", bluez={"adapter": "hci0"})
print("PASS  active scan ctor OK; passive-without-or_patterns raises (M26.4)")

# M26.5 regression: the D-Bus parser must name adapters by OBJECT NAME
# (hci0 — what bleak's bluez= arg needs), NOT by the Address property
# (the MAC — which made bleak look for /org/bluez/D8:3A:DD:FE:88:07 and
# die with "adapter 'D8:3A:..' not found" on the uConsole).
import unittest.mock as mock  # noqa: E402
uconsole_reply = {
    "/org/bluez/hci0": {
        "org.bluez.Adapter1": {
            "Address": "D8:3A:DD:FE:88:07",
            "Name": "uConsole",
            "Powered": True,
            "Discoverable": False,
            "Pairable": False,
        },
        "org.freedesktop.DBus.Properties": {},
    },
    "/org/bluez/hci0/dev_D8_3A_DD_FE_88_07": {
        "org.bluez.Device1": {"Address": "D8:3A:DD:FE:88:07"},
    },
}
with mock.patch("dbus_fast.aio.message_bus.MessageBus") as MB:
    bus = MB.return_value
    async def _connect():
        pass
    bus.connect = _connect
    async def _call(msg):
        class R:
            body = [uconsole_reply]
        return R()
    bus.call = _call
    async def _disconnect():
        pass
    bus.disconnect = _disconnect
    got = ble.bt_adapters()
assert len(got) == 1, f"expected 1 adapter, got {got}"
a = got[0]
assert a["name"] == "hci0", f"M26.5 BUG: name={a['name']!r} (must be hci0, not the MAC)"
assert a["address"] == "D8:3A:DD:FE:88:07"
assert a["powered"] is True
assert a["path"] == "/org/bluez/hci0"
print("PASS  D-Bus parser names by object name hci0, MAC stays in address (M26.5)")

# M26.6 regression: the poll loop must YIELD the event loop (asyncio.sleep),
# not park it in a blocking threading.Event.wait() — dbus_fast reads the
# bus via loop.add_reader callbacks, so a blocking wait starves the
# advertisement-signal handlers and the scan sits RUNNING · 0 devices.
# Fake scanner through the REAL BleSession._scan, run on its own loop:
import threading as _th, time as _t, types as _ty, asyncio as _aio  # noqa: E402
import bleak as _bleak_mod  # noqa: E402

def _mk_adv(name, rssi):
    from bleak.backends.scanner import AdvertisementData
    return AdvertisementData(local_name=name, manufacturer_data={},
                             service_data={},
                             service_uuids=["00001800-0000-1000-8000-00805f9b34fb"],
                             tx_power=4, rssi=rssi, platform_data=())

class _FakeScanner:
    """The devices only become visible once a task SCHEDULED ON THE
    SCANNER'S EVENT LOOP fires (like a real dbus_fast
    loop.add_reader signal callback). A blocking Event.wait() in the
    poll loop starves that task -> 0 devices (the M26.6 symptom);
    asyncio.sleep lets it run -> 2 devices."""
    def __init__(self, **kw):
        self.kw = kw
        self._armed = False
    async def start(self):
        # Arm 0.3 s from now, via a task ON the scanner's event loop.
        # It fires only while the loop is RUNNING — exactly like a real
        # dbus_fast signal callback. Blocking poll loop -> never fires.
        def _arm():
            self._armed = True
        loop = _aio.get_running_loop()
        loop.call_later(0.3, _arm)
    async def stop(self):
        pass
    @property
    def discovered_devices_and_advertisement_data(self):
        if not self._armed:
            return {}
        d1 = _ty.SimpleNamespace(address="AA:11:22:33:44:55", name="Test Mouse")
        d2 = _ty.SimpleNamespace(address="BB:66:77:88:99:AA", name=None)
        return {"AA:11:22:33:44:55": (d1, _mk_adv("Test Mouse", -55)),
                "BB:66:77:88:99:AA": (d2, _mk_adv(None, -80))}

def _poll_test(s):
    orig = _bleak_mod.BleakScanner
    _bleak_mod.BleakScanner = _FakeScanner
    try:
        s.start("hci0")
        for _ in range(60):
            if len(s.devices) == 2:
                break
            _t.sleep(0.1)
        s.stop()
    finally:
        _bleak_mod.BleakScanner = orig
    assert s.status == "stopped", s.status
    assert len(s.devices) == 2, s.devices
    assert s.error == "", s.error

sess2 = ble.BleSession()
_t2 = _th.Thread(target=_poll_test, args=(sess2,), daemon=True)
_t2.start()
_t2.join(timeout=15)
assert not _t2.is_alive(), "M26.6 BUG: poll loop never yielded / hung"
assert len(sess2.devices) == 2
print("PASS  poll loop yields the event loop; 2 devices merged (M26.6)")
