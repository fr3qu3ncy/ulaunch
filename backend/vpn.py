"""OpenVPN lifecycle: named presets (pasted configs), connect/disconnect,
live log tail. Presets live in ~/.ulaunch/vpn/<name>.ovpn (+ .json meta).
openvpn runs as a foreground child in its own process group (via
sudo.popen) so disconnect = killpg."""
import json
import os
import re
import signal
import shutil
import subprocess
import time
from pathlib import Path

from net import gather_net
from sudo import SudoRequired, sudo

BASE = Path.home() / ".ulaunch"
VPN_DIR = BASE / "vpn"
LOG_DIR = BASE / "vpn-logs"
RUN_DIR = BASE / "run"


def _ensure_dirs() -> None:
    VPN_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)


def _safe_name(name: str) -> str:
    name = (name or "").strip().replace("/", "-").replace("\\", "-")
    name = re.sub(r"[^A-Za-z0-9._ -]", "", name).strip()
    if not name or len(name) > 48:
        raise ValueError("invalid preset name (use 1-48 chars, no slashes)")
    return name


def _meta_path(name: str) -> Path:
    return VPN_DIR / f"{name}.json"


def _pid_file(name: str) -> Path:
    return RUN_DIR / f"vpn-{name}.pid"


def _log_path(name: str) -> Path:
    return LOG_DIR / f"{name}.log"


def list_presets() -> list[dict]:
    _ensure_dirs()
    out = []
    for f in sorted(VPN_DIR.glob("*.ovpn")):
        name = f.stem
        meta = {}
        mp = _meta_path(name)
        if mp.exists():
            try:
                meta = json.loads(mp.read_text())
            except Exception:
                meta = {}
        try:
            lines = f.read_text().splitlines()
        except Exception:
            lines = []
        server = next((l.split()[1] for l in lines
                       if l.strip().lower().startswith("remote ") and " " in l), None)
        proto = next((l.split()[1] for l in lines
                      if l.strip().lower().startswith("proto ")), None)
        out.append({
            "name": name,
            "server": server,
            "proto": proto,
            "created": meta.get("created"),
            "last_connected": meta.get("last_connected"),
            "size": f.stat().st_size,
        })
    return out


def save_preset(name: str, config: str) -> dict:
    _ensure_dirs()
    name = _safe_name(name)
    config = (config or "").strip()
    if len(config) < 20 or "client" not in config.lower() \
            and "remote" not in config.lower():
        raise ValueError("that doesn't look like an OpenVPN config "
                         "(missing client/remote directives)")
    _validate_config(config)
    (VPN_DIR / f"{name}.ovpn").write_text(config + "\n")
    meta = {"created": time.strftime("%Y-%m-%d %H:%M:%S")}
    mp = _meta_path(name)
    if mp.exists():
        try:
            old = json.loads(mp.read_text())
            meta = {**old, **meta}
        except Exception:
            pass
    mp.write_text(json.dumps(meta))
    return next(p for p in list_presets() if p["name"] == name)


def _validate_config(config: str) -> None:
    """openvpn --test is not a thing; do a syntax sanity check with
    openvpn --show-config is also not portable. Use openvpn itself in
    a dry way: `openvpn --config <f>` would connect — too heavy. Instead
    check the essential directives are present."""
    low = config.lower()
    for req in ("remote", "proto", "dev"):
        if not re.search(rf"^\s*{req}\b", low, re.M):
            raise ValueError(f"config is missing the '{req}' directive")


def delete_preset(name: str) -> bool:
    name = _safe_name(name)
    p = VPN_DIR / f"{name}.ovpn"
    if not p.exists():
        return False
    p.unlink()
    _meta_path(name).unlink(missing_ok=True)
    return True


def _read_pid(name: str) -> int | None:
    try:
        return int(_pid_file(name).read_text().strip())
    except Exception:
        return None


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, ValueError):
        return False


def status() -> dict:
    active = None
    for p in list_presets():
        pid = _read_pid(p["name"])
        if _pid_alive(pid):
            active = p["name"]
            break
    if active:
        return {"connected": True, "preset": active, "pid": _read_pid(active)}
    # maybe connected outside ulaunch?
    net = gather_net()
    if net["vpn"]["active"]:
        return {"connected": True, "preset": None,
                "note": "openvpn running outside ulaunch"}
    return {"connected": False}


def connect(name: str) -> dict:
    name = _safe_name(name)
    cfg = VPN_DIR / f"{name}.ovpn"
    if not cfg.exists():
        raise ValueError(f"preset '{name}' not found")
    cur = status()
    if cur["connected"] and cur.get("preset") == name:
        raise ValueError("already connected")
    if cur["connected"]:
        raise ValueError(f"already connected to '{cur.get('preset')}' — "
                         "disconnect first")

    log = _log_path(name)
    log.unlink(missing_ok=True)
    proc = sudo.popen(
        "openvpn",
        "--config", str(cfg),
        "--log", str(log),
        "--write-dn",
        str(RUN_DIR / "vpn-dn"),
    )
    _pid_file(name).write_text(str(proc.pid))
    # give it a moment: a bad config dies fast
    time.sleep(2.5)
    if proc.poll() is not None:
        tail = ""
        if log.exists():
            tail = log.read_text()[-600:]
        _pid_file(name).unlink(missing_ok=True)
        raise ValueError(f"openvpn exited immediately\n{tail}")
    mp = _meta_path(name)
    meta = {}
    if mp.exists():
        try:
            meta = json.loads(mp.read_text())
        except Exception:
            pass
    meta["last_connected"] = time.strftime("%Y-%m-%d %H:%M:%S")
    mp.write_text(json.dumps(meta))
    return {"connected": True, "preset": name, "pid": proc.pid}


def disconnect() -> dict:
    s = status()
    if not s["connected"]:
        return {"connected": False, "note": "not connected"}
    name = s.get("preset")
    pid = s.get("pid")
    killed = False
    if name and pid and _pid_alive(pid):
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            killed = True
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
                killed = True
            except (ProcessLookupError, PermissionError):
                pass
        for _ in range(20):
            if not _pid_alive(pid):
                break
            time.sleep(0.25)
        if _pid_alive(pid):
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
    if name:
        _pid_file(name).unlink(missing_ok=True)
    return {"connected": False, "killed": killed}


def log_tail(name: str, lines: int = 80) -> str:
    log = _log_path(name)
    if not log.exists():
        return ""
    try:
        all_lines = log.read_text(errors="replace").splitlines()
    except Exception:
        return ""
    tail = all_lines[-lines:]
    # keep the UI light: drop the huge OpenVPN banner, keep signal lines
    keep = [l for l in tail if not l.startswith("OpenVPN 2.6")
            and "Use --show-ciphers" not in l]
    return "\n".join(keep[-lines:])


def tool() -> dict:
    path = shutil.which("openvpn")
    ver = ""
    if path:
        try:
            p = subprocess.run(["openvpn", "--version"],
                               capture_output=True, text=True, timeout=5)
            m = re.search(r"OpenVPN (\d+\.\d+(?:\.\d+)?)", p.stdout)
            if m:
                ver = m.group(1)
        except Exception:
            pass
    return {"installed": bool(path), "version": ver, "path": path}


def install() -> dict:
    """sudo apt-get install openvpn — may take a minute."""
    try:
        p = sudo.run("apt-get", "install", "-y", "openvpn", timeout=600)
    except SudoRequired:
        raise
    if p.returncode != 0:
        raise ValueError(p.stderr[-400:] or "apt install failed")
    return tool()
