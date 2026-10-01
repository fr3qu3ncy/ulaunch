"""ulaunch self-update.

The repo on GitHub is the source of truth for the version: the ``VERSION``
file at the root of the repo is read at BUILD time (the vite build stamp
bakes the number into the served bundle) and at RUN time (frozen at process
start — the version the server actually booted from, NOT the live file,
which a manual ``git pull`` can change out from under a running server).
``check_for_update`` compares the running version against ``origin/main``
on GitHub using a background ``git fetch`` — so the endpoint never blocks
the API on network latency. An update is only ever offered when upstream
is strictly NEWER — never a downgrade.

``run_update`` does the actual upgrade, in a background thread, streaming
every line of output into an in-memory log the UI polls:

  1. ``git pull``                — new code (including the prebuilt frontend)
  2. ``./install.sh``            — venv + deps (re-runnable, idempotent)
  3. restart flag + SIGTERM      — the ``ulaunch`` launcher loop re-runs us

Step 3 is where the trick lives. The app runs inside the ``ulaunch``
launcher script, which wraps the server + kiosk browser in a loop: when it
receives SIGTERM while a restart flag is set, it cleans up the browser and
server, then starts them again with the freshly pulled code. The kiosk
window is recreated (``--app=http://127.0.0.1:8317``), so the user ends up
looking at the new UI — no manual ``fuser -k`` dance on the device.

Safety: the whole sequence runs as the current user; no sudo is involved
(git pull into the user's clone + pip into the user's venv). The log is
kept bounded so a runaway installer can't grow it.
"""
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # repo root
REPO = BASE
VERSION_FILE = BASE / "VERSION"
INSTALL_SH = BASE / "install.sh"

# Where the running server finds the pids the launcher wrote, and where the
# launcher looks for the "please restart after update" flag.
RUN_DIR = Path(os.environ.get("ULAUNCH_RUN_DIR",
                              str(Path.home() / ".ulaunch/run")))
RESTART_FLAG = RUN_DIR / "restart-after-update"

# GitHub origin for the remote version lookup (the repo's origin is exactly
# this; hardcoding keeps check_for_update working even if the local clone's
# config is disturbed). Overridable via env for forks / tests.
REPO_URL = os.environ.get("ULAUNCH_UPDATE_URL",
                          "https://github.com/fr3qu3ncy/ulaunch.git")

# The stable local ref the updater fetches upstream into — and the ref it
# fast-forwards `main` to on update. It lives OUTSIDE refs/heads so it never
# shows up in `git branch`, and keeping it separate from `origin` means the
# updater never rewrites the user's remote config (a fork that points origin
# somewhere else is left alone).
REMOTE_REF = "refs/ulaunch/upstream"

# How long the update thread lets the UI show its RESTARTING screen before
# it closes the kiosk browser (which drives the launcher's restart loop).
RELAUNCH_DELAY = 2.5

_log_lock = threading.Lock()
_log: list[str] = []
MAX_LOG = 2000  # lines — the UI tails this, it never needs history

_update_lock = threading.Lock()   # one update at a time
_fetch_lock = threading.Lock()    # one git fetch at a time
_last_fetch_at = 0.0
FETCH_MIN_INTERVAL = 60.0  # don't hammer the network on every 15s refresh

# Outcome of the most recent update: idle (never run / cleared), running,
# done (pull + install OK — the launcher is relaunching us), or error (the
# log holds the reason). The UI polls this instead of parsing the log.
_outcome = "idle"


def _read_version_file() -> str:
    try:
        return VERSION_FILE.read_text().strip()
    except Exception:
        return ""


# The version THIS PROCESS was started from — frozen at import time. The
# VERSION file in the working tree can change out from under a running
# server (a manual `git pull`), and reporting that file would make the
# update check compare against code that isn't actually running. The
# relaunch (in-app update or ./ulaunch restart) is what moves the running
# version: the new process re-freezes at its own start.
_STARTUP_VERSION = _read_version_file()


def local_version() -> str:
    """The version this server is actually running (frozen at boot)."""
    return _STARTUP_VERSION


def _parse_ver(v: str) -> tuple[int, ...] | None:
    """`1.1.2` -> (1, 1, 2); None when it isn't a plain dotted number."""
    parts = v.split(".")
    if not parts or not all(p.isdigit() for p in parts):
        return None
    return tuple(int(p) for p in parts)


def _log_line(line: str) -> None:
    with _log_lock:
        _log.append(line)
        if len(_log) > MAX_LOG:
            del _log[: len(_log) - MAX_LOG]


def update_status() -> dict:
    with _log_lock:
        log = list(_log)
    return {
        "running": _update_lock.locked(),
        "outcome": _outcome,
        "log": log,
    }


def _run_logged(cmd: list[str], cwd: Path, timeout: int = 900) -> int:
    """Run a command, streaming stdout+stderr into the update log line by line."""
    _log_line(f"$ {' '.join(cmd)}")
    p = subprocess.Popen(
        cmd, cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, errors="replace",
    )
    assert p.stdout is not None
    for line in p.stdout:
        line = line.rstrip("\n")
        if line:
            _log_line(line)
    rc = p.wait(timeout=timeout)
    if rc != 0:
        _log_line(f"!! command exited with {rc}")
    return rc


_stale_ref_cleaned = False


def _clean_stale_ref() -> None:
    """Remove the pre-M28.1 stray ref (refs/heads/ulaunch-upstream) that
    older check-fetches created. It showed up in `git branch` on devices;
    the ref was later moved outside refs/heads. Best-effort, once per
    process."""
    global _stale_ref_cleaned
    if _stale_ref_cleaned:
        return
    _stale_ref_cleaned = True
    try:
        subprocess.run(
            ["git", "-C", str(REPO), "update-ref", "-d",
             "refs/heads/ulaunch-upstream"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        pass


def check_for_update() -> dict:
    """Compare the local VERSION against the upstream on GitHub.

    Runs a ``git fetch <url> main:<REMOTE_REF>`` in a
    background thread (at most once per FETCH_MIN_INTERVAL) so the endpoint
    answers immediately from the last known state. It fetches the URL into a
    stable LOCAL ref — it never touches the clone's ``origin`` remote, so a
    user's fork setup is left alone. ``available`` is True when the upstream
    VERSION parses and is STRICTLY NEWER than the running version (never a
    downgrade). A dirty working tree is
    reported but does NOT block the update (git pull --ff-only would refuse,
    so the update itself shows why in the log).
    """
    global _last_fetch_at
    _clean_stale_ref()
    now = time.monotonic()
    if not _update_lock.locked() and now - _last_fetch_at >= FETCH_MIN_INTERVAL:
        with _fetch_lock:
            if now - _last_fetch_at >= FETCH_MIN_INTERVAL:
                threading.Thread(
                    target=_fetch_remote, args=(REPO, REPO_URL), daemon=True,
                ).start()
                _last_fetch_at = now

    local = local_version()
    remote = _remote_version_cached()
    lv, rv = _parse_ver(local), _parse_ver(remote)
    return {
        "local": local,
        "remote": remote,
        # False while the first fetch is still in flight (or it failed): the
        # UI shows "checking…" and keeps the button idle rather than
        # claiming "UP TO DATE" from a version we couldn't read.
        "remote_known": bool(remote),
        # NEVER a downgrade: an update is only offered when the upstream
        # version is strictly NEWER than the running one. A stale upstream
        # read (e.g. the device manually pulled ahead of its last
        # successful fetch, or the fetch has been failing) must not propose
        # an older version.
        "available": bool(lv and rv and rv > lv),
        "checked": _last_fetch_at is not None and _last_fetch_at != 0.0,
        "dirty": _worktree_dirty(),
    }


def _worktree_dirty() -> bool:
    try:
        p = subprocess.run(
            ["git", "-C", str(REPO), "status", "--porcelain"],
            capture_output=True, text=True, timeout=10,
        )
        return bool(p.stdout.strip())
    except Exception:
        return False


def _remote_version_cached() -> str:
    """VERSION from the last upstream fetch (the stable local ref). Empty
    string when unknown — either the first fetch is still in flight, it
    failed, or the upstream commit predates the VERSION file. The caller
    reports ``remote_known: false`` in that case and the UI shows
    "checking…" instead of falsely claiming "UP TO DATE"."""
    try:
        p = subprocess.run(
            ["git", "-C", str(REPO), "show", f"{REMOTE_REF}:VERSION"],
            capture_output=True, text=True, timeout=10,
        )
        if p.returncode == 0:
            return p.stdout.strip()
    except Exception:
        pass
    return ""


def _fetch_remote(repo: Path, url: str) -> None:
    try:
        # fetch the URL's main branch into a stable local ref. --force so a
        # repeat fetch always tracks upstream (the ref is ours, not a branch
        # the user tracks). This never rewrites the clone's `origin`.
        p = subprocess.run(
            ["git", "-C", str(repo), "fetch", "--force",
             url, f"main:{REMOTE_REF}"],
            capture_output=True, text=True, timeout=120,
        )
        if p.returncode != 0:
            # The device may have no direct route to the update URL (e.g. a
            # network that blocks github.com). Fall back to the clone's
            # `origin` remote — for a stock setup that is the same repo —
            # into the SAME stable ref.
            p2 = subprocess.run(
                ["git", "-C", str(repo), "fetch", "--force",
                 "origin", f"main:{REMOTE_REF}"],
                capture_output=True, text=True, timeout=120,
            )
            if p2.returncode != 0:
                _log_line(f"[fetch] {p.stderr.strip()[:120]} | "
                          f"origin fallback: {p2.stderr.strip()[:120]}")
            return
    except Exception as e:  # noqa: BLE001 — a failed fetch must never crash
        _log_line(f"[fetch] {e}")


def run_update() -> dict:
    """Start the update in a background thread (idempotent — a second call
    while one is running is rejected by the endpoint).

    Refuses to run when the last known upstream is not NEWER than the
    running version — the UI only offers the button in that case, but the
    endpoint is open and must not be able to trigger a pointless (or
    worse, downgrading) update cycle from a stale upstream read."""
    if _update_lock.locked():
        return {"ok": False, "error": "update already running"}
    local, remote = local_version(), _remote_version_cached()
    lv, rv = _parse_ver(local), _parse_ver(remote)
    if not (lv and rv and rv > lv):
        return {"ok": False,
                "error": f"no newer version to update to (running {local or '?'}, "
                         f"upstream {remote or 'unknown'})"}
    global _outcome
    with _log_lock:
        _log.clear()
    _outcome = "running"
    _update_lock.acquire()
    threading.Thread(target=_do_update, daemon=True).start()
    return {"ok": True}


def _do_update() -> None:
    try:
        _update_run()
    finally:
        _update_lock.release()


def _update_run() -> None:
    global _outcome
    _log_line("── ulaunch update ────────────────────────")
    if not shutil.which("git"):
        _outcome = "error"
        _log_line("!! git is not installed — cannot update")
        return

    # 1. pull the new code: fetch the upstream URL into our stable ref, then
    #    fast-forward `main` to it. ff-only: a local commit that isn't
    #    upstream must not be silently merged away by the updater (a dirty
    #    or diverged tree will error and the log explains why).
    rc = _run_logged(
        ["git", "-C", str(REPO), "fetch", "--force",
         REPO_URL, f"main:{REMOTE_REF}"],
        REPO,
    )
    if rc == 0:
        rc = _run_logged(
            ["git", "-C", str(REPO), "merge", "--ff-only", REMOTE_REF],
            REPO,
        )
    if rc != 0:
        _outcome = "error"
        _log_line("!! git pull failed — nothing was updated")
        return

    # 2. (re)install: venv + pip deps + desktop icon. install.sh is
    #    re-runnable; it reuses the existing venv.
    if INSTALL_SH.exists():
        rc = _run_logged(
            ["bash", str(INSTALL_SH)], REPO, timeout=1800,
        )
        if rc != 0:
            _outcome = "error"
            _log_line("!! install.sh failed — the new code may need deps")
            return

    # 3. signal the launcher to relaunch us with the new code.
    #    The flag is written BEFORE the signal so the launcher, which
    #    restarts in its trap, always sees it (and consumes it there).
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    RESTART_FLAG.write_text(str(time.time()))
    _outcome = "done"
    _log_line("update complete — restarting ulaunch…")
    _relaunch()


def _relaunch() -> None:
    """Drive the `ulaunch` launcher's restart loop by closing the kiosk
    browser. The launcher waits on the browser; when it exits and a restart
    flag is present, it cleans up the server and starts again with the new
    code. We give the UI a moment to show its RESTARTING screen before the
    window is torn down.

    Dev mode (`python backend/main.py` directly, no launcher) has no browser
    to close — we drop the server instead so `./ulaunch` can start cleanly."""
    time.sleep(RELAUNCH_DELAY)  # let the RESTARTING screen paint
    browser_pid = _read_pid("browser.pid")
    if browser_pid:
        try:
            os.kill(browser_pid, signal.SIGTERM)
            return
        except (ProcessLookupError, PermissionError, OSError):
            pass
    server_pid = _read_pid("server.pid")
    if server_pid:
        try:
            os.kill(server_pid, signal.SIGTERM)
            _log_line("server stopped (dev mode) — run ./ulaunch to start the new version")
            return
        except (ProcessLookupError, PermissionError, OSError):
            pass
    _log_line("no launcher found — restart ulaunch by hand (./ulaunch)")


def _find_launcher() -> int | None:
    """Best-effort: the `ulaunch` bash script that spawned this server.
    Walk the ppid chain looking for a process whose cmdline ends in the
    launcher path. (The relaunch itself closes the browser, not the
    launcher — this is kept for diagnostics / future use.)"""
    launcher_path = str(BASE / "ulaunch")
    cur = _read_pid("server.pid") or os.getpid()
    seen: set[int] = set()
    while cur > 1 and cur not in seen:
        seen.add(cur)
        try:
            cmd = Path(f"/proc/{cur}/cmdline").read_bytes()
        except Exception:
            return None
        parts = [p for p in cmd.split(b"\x00") if p]
        if parts and (parts[0].decode(errors="replace").endswith("ulaunch")
                      or launcher_path in parts):
            return cur
        try:
            status = Path(f"/proc/{cur}/status").read_text()
        except Exception:
            return None
        for line in status.splitlines():
            if line.startswith("PPid:"):
                cur = int(line.split()[1])
                break
        else:
            return None
    return None


def _read_pid(fname: str) -> int | None:
    try:
        return int((RUN_DIR / fname).read_text().strip())
    except Exception:
        return None
