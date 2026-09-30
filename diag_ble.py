#!/usr/bin/env python
"""One-shot BLE diagnostics for the uConsole (M26.5 follow-up).

Run:  timeout 25 .venv/bin/python diag_ble.py
It exercises the EXACT same code path the app's scanner uses
(bleak 3.x active scan, D-Bus signal subscription) and reports where
the chain breaks:
  1. adapter seen on the system bus (org.bluez ObjectManager)
  2. scanner start (SetDiscoveryFilter + signal subscription)
  3. advertisement signals (PropertiesChanged on org.bluez.Device1)

Exit codes: 0 = saw at least one advertisement, 1 = none.
"""
import asyncio
import logging
import sys

logging.basicConfig(level=logging.DEBUG, format="%(name)s %(message)s")
logging.getLogger("dbus_fast").setLevel(logging.DEBUG)
logging.getLogger("bleak").setLevel(logging.DEBUG)


async def main():
    from dbus_fast import BusType, Message, unpack_variants
    from dbus_fast.aio.message_bus import MessageBus
    from bleak import BleakScanner

    # ── 1. raw bus: is org.bluez reachable, which adapters does it own? ──
    bus = MessageBus(bus_type=BusType.SYSTEM)
    try:
        await bus.connect()
    except Exception as e:
        print(f"!!! cannot connect to the system D-Bus bus: {e}")
        return 2
    reply = await bus.call(Message(
        destination="org.bluez", path="/",
        interface="org.freedesktop.DBus.ObjectManager",
        member="GetManagedObjects"))
    if not isinstance(reply.body[0], dict):
        print(f"!!! org.bluez answered with an error: {reply.body[0]!r} "
              f"— bluetoothd is not running")
        bus.disconnect()
        return 2
    adapters = {}
    for path, ifaces in reply.body[0].items():
        props = unpack_variants(ifaces).get("org.bluez.Adapter1")
        if props:
            adapters[path] = props
    print(f"\n=== [1] org.bluez adapters: {len(adapters)}")
    for p, a in adapters.items():
        print(f"    {p}  Address={a.get('Address')} Powered={a.get('Powered')} "
              f"Discovering={a.get('Discovering')}")
    bus.disconnect()
    if not adapters:
        print("    -> no adapter objects: bluetoothd is not exporting "
              "the radio (service restart / reboot)")
        return 1
    name = next(iter(adapters))
    print(f"    using {name}")

    # ── 2 + 3. the app's exact scan path, with a detection callback ──
    print("\n=== [2] starting bleak active scan (15 s)...")
    scanner = BleakScanner(
        lambda dev, adv: print(f"    ADVERTISMENT {dev.address} "
                               f"name={dev.name!r} rssi={adv.rssi}"),
        scanning_mode="active",
        bluez={"adapter": name.split("/")[-1]})
    await scanner.start()
    print("=== [3] scanner started; waiting for advertisement signals...")
    try:
        await asyncio.sleep(15)
    finally:
        await scanner.stop()
    seen = scanner.discovered_devices_and_advertisement_data
    print(f"=== result: {len(seen)} device(s) seen")
    for addr, (dev, adv) in seen.items():
        print(f"    {addr}  name={dev.name!r}  rssi={adv.rssi}")
    return 0 if seen else 1


try:
    sys.exit(asyncio.run(asyncio.wait_for(main(), timeout=45)))
except asyncio.TimeoutError:
    print("!!! timed out — the D-Bus bus itself is wedged")
    sys.exit(2)
