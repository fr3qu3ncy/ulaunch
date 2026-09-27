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
SUDOERS_DROPIN = Path("/etc/sudoers.d/ulaunch-openvpn")

# live Popen per preset, for stdin-pipe release on kill/exit
_procs: dict[str, subprocess.Popen] = {}


def _ensure_dirs() -> None:
    VPN_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    # RUN_DIR now holds per-connection VPN login files — keep it private
    try:
        os.chmod(RUN_DIR, 0o700)
    except OSError:
        pass


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
    return RUN_DIR / f".{name}.conf"


def _creds_file_path(name: str) -> Path:
    # per-connection OpenVPN login file (auth-user-pass); 0600, deleted
    # when the process exits — never kept on disk between connects
    return RUN_DIR / f"{name}.vpnc"


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
    _cleanup_vpn_files(name)
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


def _effective_config(name: str, cfg: Path,
                      username: str, password: str) -> Path:
    """Config file to hand to openvpn.

    The login is written to a 0600 credentials file and referenced with
    `auth-user-pass <file>` — the only non-interactive login mechanism
    OpenVPN supports. (Inline `username`/`password` config lines are NOT
    valid OpenVPN directives — openvpn dies at option-parse with
    'Unrecognized option', before it even opens the --log file, which is
    exactly the old 'exited immediately / no log' bug.)

    Any existing `auth-user-pass` line (pfsense generates one pointing at
    a path that doesn't exist on this device) is replaced. The temp config
    + creds file live in RUN_DIR and are removed when the process exits.
    """
    text = cfg.read_text(errors="replace")
    lines = text.splitlines()
    lines = [l for l in lines if not re.match(r"^\s*auth-user-pass\b", l)]
    creds = _creds_file_path(name)
    creds.write_text(f"{username}\n{password}\n")
    os.chmod(creds, 0o600)
    lines.append(f"auth-user-pass {creds}")
    tc = _temp_config_path(name)
    tc.write_text("\n".join(lines).rstrip() + "\n")
    os.chmod(tc, 0o600)
    return tc


def _cleanup_vpn_files(name: str) -> None:
    _temp_config_path(name).unlink(missing_ok=True)
    _creds_file_path(name).unlink(missing_ok=True)


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

    # stored login → creds file + auth-user-pass (see _effective_config)
    meta = _load_meta(name)
    username = (meta.get("username") or "").strip()
    password = meta.get("password") or ""
    if not username or not password:
        raise ValueError("no credentials stored — enter the VPN username "
                         "and password first")

    log = _log_path(name)
    log.unlink(missing_ok=True)
    # stdout+stderr → the log file. This is the ONLY place openvpn's early
    # option-parse errors surface (2.6 prints them to stdout, before it
    # would ever open a --log file), and it also carries the runtime log,
    # so the --log directive is dropped.
    logf = log.open("ab")
    run_cfg = _effective_config(name, cfg, username, password)
    try:
        proc = sudo.popen(
            "openvpn",
            "--config", str(run_cfg),
            # NOTE: --write-dn is NOT a valid option on OpenVPN 2.6 — it
            # aborts at option-parse. Removed.
            stdout=logf,
            stderr=logf,
        )
    except BaseException:
        _cleanup_vpn_files(name)
        logf.close()
        raise
    logf.close()  # parent's handle; the child holds its own fd
    _pid_file(name).write_text(str(proc.pid))
    # give it a moment: a bad config dies fast
    time.sleep(2.5)
    if proc.poll() is not None:
        tail = ""
        if log.exists():
            tail = log.read_text()[-600:]
        _pid_file(name).unlink(missing_ok=True)
        _cleanup_vpn_files(name)
        _release(name, proc)
        raise ValueError(f"openvpn exited immediately\n{tail}")
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
            _cleanup_vpn_files(name)
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


def nopasswd_granted() -> bool:
    """True when the current user can run openvpn via sudo without a
    password (the ulaunch drop-in exists for this user)."""
    try:
        import pwd
        user = pwd.getpwuid(os.getuid()).pw_name
        text = SUDOERS_DROPIN.read_text()
    except (OSError, KeyError):
        return False
    return f"{user} ALL=(ALL) NOPASSWD:" in text \
        and "/openvpn" in text


def grant_nopasswd() -> bool:
    """One-time: allow the CURRENT user to run `sudo openvpn …` without a
    password, so VPN connects don't need a fresh password every time.

    Writes a single, tightly-scoped rule to a dedicated drop-in file
    (only the openvpn binary, nothing else) and validates it with
    visudo. Requires a cached sudo password — the password the UI just
    verified is used for this privileged write. Idempotent. Raises
    SudoRequired when no password is cached yet."""
    return sudo.grant_openvpn_nopasswd()
