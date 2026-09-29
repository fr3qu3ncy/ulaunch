"""ulaunch backend — FastAPI app: API + static frontend on 127.0.0.1.

Lifecycle: the `ulaunch` launcher script owns both the server and the
kiosk browser. Closing the browser (via /api/exit) ends the launcher,
whose trap cleans up the server. Desktop re-launch = run ./ulaunch again.
"""
import asyncio
import json
import os
import shutil
import signal
import subprocess
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import vpn
import settings
import system
from net import gather_net
from scanner import scanner
from wifiscan import wifi, wireless_adapters, iwlist_installed, probe_scan
from ble import (ble, bt_adapters, bluetooth_available, bt_diagnostics,
                 restart_bluetooth, power_adapter)
from sudo import SudoRequired, sudo

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
PORT = int(os.environ.get("ULAUNCH_PORT", "8317"))
RUN_DIR = Path(os.environ.get("ULAUNCH_RUN_DIR", str(Path.home() / ".ulaunch/run")))

app = FastAPI(title="ulaunch")


def _read_pid(fname: str) -> int | None:
    try:
        return int((RUN_DIR / fname).read_text().strip())
    except Exception:
        return None


def _kill_browser() -> bool:
    try:
        os.kill(_read_pid("browser.pid"), signal.SIGTERM)
        return True
    except (ProcessLookupError, PermissionError, TypeError, ValueError, OSError):
        return False


def _build_info() -> dict:
    """The frontend build stamps backend/static/build.json (commit + date)
    so the About screen can show which bundle is actually running."""
    try:
        return json.loads((BASE / "static" / "build.json").read_text())
    except Exception:
        return {}


@app.get("/api/health")
def health() -> dict:
    import platform
    return {
        "ok": True,
        "name": "ulaunch",
        "port": PORT,
        "build": _build_info(),
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
    }


@app.get("/api/net")
def net(all: bool = Query(False, alias="all")) -> dict:
    return gather_net(show_virtual=all)


@app.post("/api/exit")
def exit_action(payload: dict) -> dict:
    """action: hide -> minimise the kiosk window (xdotool, best-effort).
    desktop/exit -> close the browser; the launcher exits and cleans up
    the server. Re-launch from the desktop icon or ./ulaunch."""
    action = (payload or {}).get("action", "desktop")
    browser_pid = _read_pid("browser.pid")

    if action == "hide" and browser_pid and shutil.which("xdotool"):
        try:
            subprocess.run(
                ["xdotool", "search", "--name", "127.0.0.1", "windowsminimize"],
                capture_output=True, timeout=3,
            )
            return {"ok": True, "action": action, "minimised": True}
        except Exception:
            pass  # fall through to close

    closed = _kill_browser()
    return {"ok": True, "action": action, "browser_closed": closed}


# ── sudo ────────────────────────────────────────────────────────

@app.get("/api/sudo/status")
def sudo_status() -> dict:
    return sudo.status()


@app.post("/api/sudo/verify")
def sudo_verify(payload: dict) -> dict:
    pw = (payload or {}).get("password", "")
    if not sudo.verify(pw):
        raise HTTPException(401, "wrong password")
    return {"ok": True}


@app.post("/api/sudo/openvpn-nopasswd")
def sudo_openvpn_nopasswd() -> dict:
    """One-time grant: after this, `sudo openvpn …` needs no password for
    the current user (dedicated, openvpn-only drop-in, visudo-checked).
    The already-verified cached password is used for the write."""
    try:
        ok = vpn.grant_nopasswd()
    except SudoRequired:
        raise HTTPException(401, "sudo password required")
    if not ok:
        raise HTTPException(500, "could not add the sudoers rule")
    return {"ok": True, "openvpn_nopasswd": True}


# ── tools ───────────────────────────────────────────────────────

@app.get("/api/tools")
def tools() -> dict:
    import shutil as _sh
    nmap_path = _sh.which("nmap")
    return {
        "nmap": {
            "installed": bool(nmap_path),
            "version": _nmap_version(nmap_path),
        },
        "openvpn": vpn.tool(),
        "bluez": bluetooth_available(),
    }


def _nmap_version(path: str | None) -> str:
    if not path:
        return ""
    try:
        p = subprocess.run([path, "--version"],
                           capture_output=True, text=True, timeout=5)
        import re
        m = re.search(r"[Nn]map version (\d+\.\d+(?:\.\d+)?)", p.stdout)
        return m.group(1) if m else ""
    except Exception:
        return ""


@app.post("/api/tools/install")
def tools_install(payload: dict) -> dict:
    tool = (payload or {}).get("tool", "")
    if tool not in ("nmap", "openvpn", "wireless-tools", "bluez"):
        raise HTTPException(400, "unknown tool")
    try:
        p = sudo.run("apt-get", "install", "-y", tool, timeout=900)
    except SudoRequired:
        raise HTTPException(401, "sudo password required")
    if p.returncode != 0:
        raise HTTPException(500, (p.stderr or "")[-400:] or "install failed")
    return tools()


# ── vpn ─────────────────────────────────────────────────────────

@app.get("/api/vpn/presets")
def vpn_presets() -> list:
    return vpn.list_presets()


@app.post("/api/vpn/presets")
def vpn_preset_add(payload: dict) -> dict:
    try:
        return vpn.save_preset(
            payload.get("name", ""), payload.get("config", ""),
            username=(payload.get("username") or "").strip() or None,
            password=(payload.get("password") or ""),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/vpn/presets/{name}/credentials")
def vpn_preset_creds(name: str, payload: dict) -> dict:
    try:
        return vpn.set_credentials(
            name,
            (payload or {}).get("username", ""),
            (payload or {}).get("password", ""),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/vpn/presets/{name}")
def vpn_preset_del(name: str) -> dict:
    try:
        ok = vpn.delete_preset(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "preset not found")
    return {"ok": True}


@app.get("/api/vpn/status")
def vpn_status() -> dict:
    return vpn.status()


@app.post("/api/vpn/connect")
def vpn_connect(payload: dict) -> dict:
    try:
        return vpn.connect(payload.get("name", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except SudoRequired:
        raise HTTPException(401, "sudo password required")


@app.post("/api/vpn/disconnect")
def vpn_disconnect() -> dict:
    return vpn.disconnect()


@app.get("/api/vpn/log")
def vpn_log(name: str = Query(...), lines: int = Query(80, le=400)) -> dict:
    return {"name": name, "log": vpn.log_tail(name, lines)}


# ── system ──────────────────────────────────────────────────────

@app.get("/api/system/status")
def system_status() -> dict:
    return {
        "has_systemd": system.has_systemd(),
        "actions": list(system.ACTIONS.keys()),
    }


@app.post("/api/system/{action}")
def system_action(action: str) -> dict:
    try:
        return system.do_action(action)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except SudoRequired:
        raise HTTPException(401, "sudo password required")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, str(e))


# ── settings ────────────────────────────────────────────────────

@app.get("/api/settings")
def settings_get() -> dict:
    return settings.get()


@app.put("/api/settings")
def settings_put(payload: dict) -> dict:
    try:
        return settings.set_all(payload or {})
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── scanner ─────────────────────────────────────────────────────

@app.get("/api/scan/subnets")
def scan_subnets() -> dict:
    res = []
    for i in gather_net(show_virtual=False)["interfaces"]:
        if i["up"] and i["ipv4"] and i["type"] in ("eth", "wifi", "vpn"):
            res.append({
                "name": i["name"], "type": i["type"],
                "subnet": i["ipv4"]["subnet"], "ipv4": i["ipv4"]["addr"],
            })
    return {"options": res}


@app.get("/api/scan/jobs")
def scan_jobs() -> list:
    return scanner.jobs()


@app.delete("/api/scan/jobs")
def scan_jobs_clear() -> dict:
    """Cancel any live jobs and drop the whole store (test hook + reset)."""
    return {"cleared": scanner.clear()}


@app.get("/api/scan/jobs/{job_id}")
def scan_job(job_id: str) -> dict:
    job = scanner.get(job_id)
    if not job:
        raise HTTPException(404, "scan not found")
    return scanner._public(job)


@app.post("/api/scan/start")
def scan_start(payload: dict) -> dict:
    # pre-check: a job with no nmap would just die on stage 1 — fail fast
    # with a clear message (the UI offers the install button)
    if shutil.which("nmap") is None:
        raise HTTPException(
            400, "nmap is not installed — use the INSTALL NMAP button on the SCAN screen")
    subnet = (payload or {}).get("subnet", "")
    iface = (payload or {}).get("interface", "")
    flags = (payload or {}).get("flags", {}) or {}
    import ipaddress
    try:
        ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        raise HTTPException(400, f"not a valid subnet: {subnet!r}")
    if not flags:
        flags = {"deep": True, "service_version": True, "scripts": True,
                 "udp": False, "full_tcp": False, "udp_top": 100}
    job = scanner.start(subnet, iface, flags)
    return scanner._public(job)


@app.post("/api/scan/jobs/{job_id}/cancel")
def scan_cancel(job_id: str) -> dict:
    return {"ok": scanner.cancel(job_id)}


# ── wifi scan ───────────────────────────────────────────────────

@app.get("/api/wifi/adapters")
def wifi_adapters() -> dict:
    return {
        "adapters": wireless_adapters(),
        "iwlist": iwlist_installed(),
    }


@app.get("/api/wifi/status")
def wifi_status() -> dict:
    return wifi.public()


@app.post("/api/wifi/scan/start")
def wifi_scan_start(payload: dict) -> dict:
    iface = (payload or {}).get("interface", "")
    if not iface:
        raise HTTPException(400, "missing interface")
    if not iwlist_installed():
        raise HTTPException(
            400, "iwlist is not installed — use the INSTALL WIRELESS-TOOLS "
                 "button on the WIFI screen")
    # probe once before starting the loop: a missing password or a broken
    # adapter should surface immediately, not after the first 5s refresh
    try:
        res = probe_scan(iface)
    except SudoRequired:
        raise HTTPException(401, "sudo password required")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if res["cells"] is None:
        raise HTTPException(400, res["error"])
    try:
        return wifi.start(iface, res["cells"])
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/wifi/scan/stop")
def wifi_scan_stop() -> dict:
    return wifi.stop()


@app.delete("/api/wifi/scan")
def wifi_scan_reset() -> dict:
    """Test hook: stop and clear the session."""
    wifi.reset()
    return {"ok": True}


# ── bluetooth (BLE) scan ────────────────────────────────────────

@app.get("/api/ble/adapters")
def ble_adapters() -> dict:
    return {
        "adapters": bt_adapters(),
        "bluez": bluetooth_available(),
    }


@app.get("/api/ble/diagnostics")
def ble_diagnostics() -> dict:
    """Plain-user BT stack probe for the 'no adapters' screen: sysfs,
    rfkill, service state, dmesg tail, actionable hints."""
    return bt_diagnostics()


@app.post("/api/ble/restart")
def ble_restart() -> dict:
    """Restart the bluetooth service (sudo — 401 pops the in-app modal).
    The recovery path for a uConsole whose BT service is down or whose
    firmware failed to load at boot."""
    from sudo import SudoRequired
    try:
        return restart_bluetooth()
    except SudoRequired:
        raise HTTPException(401, "sudo password required")
    except ValueError as e:
        raise HTTPException(500, str(e))


@app.post("/api/ble/power")
def ble_power(payload: dict) -> dict:
    """Power an adapter on/off (bluetoothctl — no root, the uConsole user
    is in the bluetooth group)."""
    name = (payload or {}).get("name", "")
    on = bool((payload or {}).get("on", True))
    if not name:
        raise HTTPException(400, "missing adapter name")
    try:
        return power_adapter(name, on)
    except ValueError as e:
        raise HTTPException(500, str(e))


@app.get("/api/ble/status")
def ble_status() -> dict:
    return ble.public()


@app.post("/api/ble/scan/start")
def ble_scan_start(payload: dict) -> dict:
    adapter = (payload or {}).get("adapter") or None
    # no root needed — but BlueZ must exist or the session would just
    # error out after a second; fail fast with the install hint instead
    if not bluetooth_available()["installed"]:
        raise HTTPException(
            400, "bluez bluetooth daemon is not installed — use the "
                 "INSTALL BLUETOOTH button on the BT screen")
    # an explicit adapter must exist; with none, bleak picks the default
    # (single-adapter boxes are the norm)
    if adapter and not any(a["name"] == adapter for a in bt_adapters()):
        raise HTTPException(400, f"unknown bluetooth adapter: {adapter}")
    return ble.start(adapter)


@app.post("/api/ble/scan/stop")
def ble_scan_stop() -> dict:
    return ble.stop()


@app.delete("/api/ble/scan")
def ble_scan_reset() -> dict:
    """Test hook: stop and clear the session."""
    ble.reset()
    return {"ok": True}


@app.websocket("/ws/scan/{job_id}")
async def scan_ws(ws: WebSocket, job_id: str):
    import json as _json
    job = scanner.get(job_id)
    if not job:
        await ws.close(code=4004)
        return
    await ws.accept()
    q = job.subscribe()
    import queue as _queue
    try:
        await ws.send_text(_json.dumps({
            "type": "state", "state": scanner._public(job),
        }))
        while True:
            try:
                stage, line = q.get_nowait()
                await ws.send_text(_json.dumps(
                    {"type": "line", "stage": stage, "line": line}))
                continue
            except _queue.Empty:
                await asyncio.sleep(0.2)
            if job.status in ("done", "error", "cancelled"):
                await ws.send_text(_json.dumps(
                    {"type": "state", "state": scanner._public(job)}))
                break
    except WebSocketDisconnect:
        pass
    finally:
        job.unsubscribe(q)


if STATIC.exists():
    (STATIC / "assets").mkdir(exist_ok=True)

    class _Assets(StaticFiles):
        """Content-hashed files (index-<hash>.js/css) never change —
        cache them aggressively. index.html gets no-cache instead, so
        the kiosk browser always re-fetches it and picks up the new
        hashed bundle after an update (without this, Chromium's
        heuristic freshness can serve a stale index.html that still
        points at the old bundle — the "pulled the latest, still see
        the old UI" trap)."""

        def file_response(self, full_path, stat_result, scope, status_code=200):
            resp = super().file_response(full_path, stat_result, scope, status_code)
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp

    app.mount("/assets", _Assets(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        candidate = (STATIC / path).resolve()
        if path and candidate.exists() and candidate.is_file() \
                and str(candidate).startswith(str(STATIC.resolve())):
            return FileResponse(candidate,
                                headers={"Cache-Control": "no-cache"})
        return FileResponse(STATIC / "index.html",
                            headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

