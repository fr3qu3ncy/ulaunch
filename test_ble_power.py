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
