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

# live Popen per preset, for stdin-pipe release on kill/exit
_procs: dict[str, subprocess.Popen] = {}


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


def _load_meta(name: str) -> dict:
    mp = _meta_path(name)
    if mp.exists():
        try:
            return json.loads(mp.read_text())
        except Exception:
            pass
    return {}


def _save_meta(name: str, meta: dict) -> None:
    # may hold a VPN password — keep it private
    mp = _meta_path(name)
    mp.write_text(json.dumps(meta))
    os.chmod(mp, 0o600)


def _temp_config_path(name: str) -> Path:
    # .conf (not .ovpn) so list_presets' *.ovpn glob never picks it up
    return VPN_DIR / f".{name}.conf"


def _has_inline_auth(config: str) -> bool:
    """Config already carries its own login (username/password directives)."""
    return bool(re.search(r"^\s*(?:username|password)\b", config, re.M | re.I))


def _pid_file(name: str) -> Path:
    return RUN_DIR / f"vpn-{name}.pid"


def _log_path(name: str) -> Path:
    return LOG_DIR / f"{name}.log"


def list_presets() -> list[dict]:
    _ensure_dirs()
    out = []
    for f in sorted(VPN_DIR.glob("*.ovpn")):
        name = f.stem
        meta = _load_meta(name)
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
            "username": meta.get("username") or None,
            "has_creds": bool(meta.get("username") and meta.get("password")),
            "created": meta.get("created"),
            "last_connected": meta.get("last_connected"),
            "size": f.stat().st_size,
        })
    return out


def save_preset(name: str, config: str,
                username: str | None = None,
                password: str | None = None) -> dict:
    _ensure_dirs()
    name = _safe_name(name)
    config = (config or "").strip()
    if len(config) < 20 or "client" not in config.lower() \
            and "remote" not in config.lower():
        raise ValueError("that doesn't look like an OpenVPN config "
                         "(missing client/remote directives)")
    _validate_config(config)
    (VPN_DIR / f"{name}.ovpn").write_text(config + "\n")
    meta = {**_load_meta(name), "created": time.strftime("%Y-%m-%d %H:%M:%S")}
    if username is not None:
        meta["username"] = username
    if password is not None:
        meta["password"] = password
    _save_meta(name, meta)
    return next(p for p in list_presets() if p["name"] == name)


def set_credentials(name: str, username: str, password: str) -> dict:
    """Store/replace the stored login for a preset."""
    name = _safe_name(name)
    if not (VPN_DIR / f"{name}.ovpn").exists():
        raise ValueError(f"preset '{name}' not found")
    username = (username or "").strip()
    if not username or not password:
        raise ValueError("username and password are both required")
    meta = _load_meta(name)
    meta["username"] = username
    meta["password"] = password
    _save_meta(name, meta)
    return next(p for p in list_presets() if p["name"] == name)


def _validate_config(config: str) -> None:
    """openvpn --test is not a thing; do a syntax sanity check with
    openvpn --show-config is also not portable. Use openvpn itself in
    a dry way: `openvpn --config <f>` would connect — too heavy. Instead
    check the essential directives are present.

    'proto' is NOT required: OpenVPN defaults to UDP when it is absent
    (OpenVPN 2.4 manual: "The default protocol is udp when --proto is
    not specified"). pfsense-generated .ovpn files commonly omit it.
    """
    low = config.lower()
    for req in ("remote", "dev"):
        if not re.search(rf"^\s*{req}\b", low, re.M):
            raise ValueError(f"config is missing the '{req}' directive")


def delete_preset(name: str) -> bool:
    name = _safe_name(name)
    p = VPN_DIR / f"{name}.ovpn"
    if not p.exists():
        return False
    p.unlink()
    _meta_path(name).unlink(missing_ok=True)
    _temp_config_path(name).unlink(missing_ok=True)
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


def _find_openvpn() -> list[tuple[int, str]]:
    """(pid, cmdline) for live openvpn processes started by ulaunch."""
    out = []
    try:
        p = subprocess.run(["ps", "-eo", "pid=,args="],
                           capture_output=True, text=True, timeout=5)
        for line in p.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            pid_s, args = parts
            if "openvpn" in args and "--config" in str(VPN_DIR):
                try:
                    out.append((int(pid_s), args))
                except ValueError:
                    pass
    except Exception:
        pass
    return out


def status() -> dict:
    sudo.reap_stdin()
    active = None
    for p in list_presets():
        pid = _read_pid(p["name"])
        if _pid_alive(pid):
            active = p["name"]
            break
    if active:
        return {"connected": True, "preset": active, "pid": _read_pid(active)}
    # maybe connected outside ulaunch (or by a previous server instance)?
    ovpn = _find_openvpn()
    if ovpn:
        return {"connected": True, "preset": None,
                "note": "openvpn running outside ulaunch"}
    net = gather_net()
    if net["vpn"]["active"]:
        return {"connected": True, "preset": None,
                "note": "vpn interface active — openvpn running outside ulaunch"}
    return {"connected": False}


def _effective_config(name: str, cfg: Path) -> Path:
    """Config file to hand to openvpn.

    Stored credentials are injected into a temp copy (0600) — never into
    the saved .ovpn. Any `auth-user-pass <file>` line (pfsense generates
    one pointing at a file that doesn't exist here) is replaced, since
    openvpn would fail to read it. Configs that already carry inline
    username/password directives are used as-is (they win over stored
    creds).
    """
    try:
        text = cfg.read_text()
    except Exception:
        return cfg
    meta = _load_meta(name)
    user, pw = meta.get("username"), meta.get("password")
    if user and pw and not _has_inline_auth(text):
        lines = text.splitlines()
        if re.search(r"^\s*auth-user-pass\b", "\n".join(lines), re.M):
            lines = [l for l in lines if not re.match(r"^\s*auth-user-pass\b", l)]
        lines = [l for l in lines if not re.match(r"^\s*username\b", l)]
        lines.append(f"username {user}")
        lines.append(f"password {pw}")
        tc = _temp_config_path(name)
        tc.write_text("\n".join(lines).rstrip() + "\n")
        os.chmod(tc, 0o600)
        return tc
    _temp_config_path(name).unlink(missing_ok=True)
    return cfg


def connect(name: str) -> dict:
    name = _safe_name(name)
    cfg = VPN_DIR / f"{name}.ovpn"
    if not cfg.exists():
        raise ValueError(f"preset '{name}' not found")
    if not tool()["installed"]:
        raise ValueError("openvpn is not installed — use the INSTALL button "
                         "on the VPN screen first")
    cur = status()
    if cur["connected"] and cur.get("preset") == name:
        raise ValueError("already connected")
    if cur["connected"]:
        raise ValueError(f"already connected to '{cur.get('preset')}' — "
                         "disconnect first")

    # a login is needed when the config doesn't carry one inline and none
    # is stored — surface a clear error (the UI prompts before this call)
    meta = _load_meta(name)
    cfg_text = cfg.read_text(errors="replace")
    if not meta.get("username") and not _has_inline_auth(cfg_text):
        raise ValueError("no credentials stored — enter the VPN username "
                         "and password first")

    log = _log_path(name)
    log.unlink(missing_ok=True)
    run_cfg = _effective_config(name, cfg)
    proc = sudo.popen(
        "openvpn",
        "--config", str(run_cfg),
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
        _temp_config_path(name).unlink(missing_ok=True)
        _release(name, proc)
        raise ValueError(f"openvpn exited immediately\n{tail}")
    mp = _meta_path(name)
    meta = _load_meta(name)
    meta["last_connected"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _save_meta(name, meta)
    _procs[name] = proc
    return {"connected": True, "preset": name, "pid": proc.pid}


def _release(name: str | None, proc: subprocess.Popen | None) -> None:
    """Drop the held stdin pipe for a dead/killed openvpn."""
    if proc is not None:
        sudo.close_stdin(proc)
    if name and name in _procs:
        _procs.pop(name, None)
    sudo.reap_stdin()


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
        _release(name, _procs.get(name))
        _pid_file(name).unlink(missing_ok=True)
        if name:
            _temp_config_path(name).unlink(missing_ok=True)
        return {"connected": False, "killed": killed}

    # connected outside ulaunch — best effort: kill the openvpn we found
    for ovp in _find_openvpn():
        try:
            os.killpg(os.getpgid(ovp[0]), signal.SIGTERM)
            killed = True
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(ovp[0], signal.SIGTERM)
                killed = True
            except (ProcessLookupError, PermissionError):
                pass
    return {"connected": not _find_openvpn(), "killed": killed}


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
