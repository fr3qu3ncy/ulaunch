"""ulaunch backend — FastAPI app: API + static frontend on 127.0.0.1.

Lifecycle: the `ulaunch` launcher script owns both the server and the
kiosk browser. Closing the browser (via /api/exit) ends the launcher,
whose trap cleans up the server. Desktop re-launch = run ./ulaunch again.
"""
import os
import shutil
import signal
import subprocess
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from net import gather_net

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


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "name": "ulaunch", "port": PORT}


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


if STATIC.exists():
    (STATIC / "assets").mkdir(exist_ok=True)
    app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        candidate = (STATIC / path).resolve()
        if path and candidate.exists() and candidate.is_file() \
                and str(candidate).startswith(str(STATIC.resolve())):
            return FileResponse(candidate)
        return FileResponse(STATIC / "index.html")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
