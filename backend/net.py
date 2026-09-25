"""Network / system info gathering — best-effort, never throws."""
import ipaddress
import json
import platform
import shutil
import subprocess
from pathlib import Path


def _run(cmd: list[str], timeout: int = 5) -> str:
    if not shutil.which(cmd[0]):
        return ""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout
    except Exception:
        return ""


def _uptime() -> int:
    try:
        return int(float(Path("/proc/uptime").read_text().split()[0]))
    except Exception:
        return 0


def _battery() -> dict | None:
    pdir = Path("/sys/class/power_supply")
    try:
        bats = [p for p in pdir.iterdir() if p.name.startswith("BAT")]
    except OSError:
        bats = []
    for b in bats:
        try:
            cap = int((b / "capacity").read_text().strip())
            status = (b / "status").read_text().strip()
            return {"percent": cap, "charging": status == "Charging"}
        except Exception:
            continue
    return None


def _iftype(name: str) -> str:
    n = name.lower()
    if n.startswith(("tun", "tap")):
        return "vpn"
    try:
        if (Path("/sys/class/net") / n / "wireless").is_dir():
            return "wifi"
    except OSError:
        pass
    if n.startswith(("docker", "br-", "veth", "virbr")):
        return "virtual"
    return "eth"


def _wifi_info() -> tuple[str | None, int | None]:
    out = _run(["nmcli", "-t", "-f", "SSID,SIGNAL,STATE", "device", "wifi"])
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[2] == "connected":
            try:
                sig = int(parts[1])
            except ValueError:
                sig = None
            return parts[0], sig
    return None, None


def _interfaces() -> list[dict]:
    out = _run(["ip", "-j", "addr"])
    try:
        data = json.loads(out)
    except Exception:
        return []
    res = []
    for ifc in data:
        name = ifc.get("ifname", "")
        if not name or name == "lo":
            continue
        up = "UP" in ifc.get("flags", [])
        ipv4 = None
        v6 = 0
        for ai in ifc.get("addr_info", []):
            fam = ai.get("family")
            if fam == "inet" and ipv4 is None:
                addr = ai.get("local", "")
                prefix = ai.get("prefixlen", 0)
                try:
                    subnet = str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))
                except ValueError:
                    subnet = addr
                ipv4 = {"addr": addr, "prefix": prefix, "subnet": subnet}
            elif fam == "inet6":
                v6 += 1
        itype = _iftype(name)
        item = {
            "name": name,
            "type": itype,
            "up": up,
            "state": ifc.get("operstate", "UNKNOWN"),
            "ipv4": ipv4,
            "ipv6_count": v6,
            "ssid": None,
            "signal": None,
        }
        if itype == "wifi":
            item["ssid"], item["signal"] = _wifi_info()
        res.append(item)
    order = {"eth": 0, "wifi": 1, "vpn": 2, "virtual": 3}
    res.sort(key=lambda i: (order.get(i["type"], 9), i["name"]))
    return res


def _vpn(ifaces: list[dict]) -> dict:
    names = [i["name"] for i in ifaces if i["type"] == "vpn" and i["up"]]
    procs = _run(["pgrep", "-a", "openvpn"]).strip()
    return {
        "active": bool(names) or bool(procs),
        "interfaces": names,
        "processes": procs.splitlines() if procs else [],
    }


def gather_net(show_virtual: bool = False) -> dict:
    ifaces = _interfaces()
    if not show_virtual:
        real = [i for i in ifaces if i["type"] != "virtual"]
        ifaces = real or ifaces
    return {
        "hostname": platform.node(),
        "uptime_s": _uptime(),
        "battery": _battery(),
        "vpn": _vpn(ifaces),
        "interfaces": ifaces,
    }
