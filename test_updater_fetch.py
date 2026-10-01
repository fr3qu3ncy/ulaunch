"""M28 updater regression: check-fetch, frozen local version, no downgrades.

Covers the bugs found in the field:

  M28.1 — _fetch_remote fetched into refs/heads/ulaunch-upstream while
  _remote_version_cached() read refs/ulaunch/upstream, so a fresh clone's
  first check never saw a remote version and sat on CHECKING forever.

  M28.3 — a manual `git pull` rewrites the on-disk VERSION out from under
  the RUNNING server. local_version() used to read that live file, so after
  a pull it compared the *pulled* version (e.g. 1.1.2) against a *stale*
  upstream read (e.g. 1.1.1) and happily offered a DOWNGRADE. Now
  local_version() is frozen at process start (what code is actually
  running), and an update is only ever offered when upstream is strictly
  NEWER — never a downgrade.

Drives the app's own private functions in a fresh clone + fake origin,
exactly like a device does. It also doubles as a regression detector: the
`patch_updater` helper tolerates attributes that pre-M28.3 code doesn't
have (e.g. `_STARTUP_VERSION`), so running this file against the OLD
updater.py FAILS the downgrade checks instead of crashing — proving the
test actually sees the bug.

Run:  .venv/bin/python test_updater_fetch.py
"""
import contextlib
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))
import updater  # noqa: E402

GIT = ["git"]
COMMIT = ["-c", "user.email=t@t", "-c", "user.name=t"]
_MISSING = object()


def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    assert p.returncode == 0, f"failed: {cmd}\n{p.stderr}"
    return p.stdout.strip()


def make_origin(root: Path, versions: list[str]) -> Path:
    """A fake origin with one commit per version (VERSION file each)."""
    origin = root / "origin"
    origin.mkdir()
    run(GIT + ["init", "-q", "-b", "main"], origin)
    (origin / "install.sh").write_text("#!/bin/sh\nexit 0\n")
    for v in versions:
        (origin / "VERSION").write_text(v + "\n")
        run(GIT + COMMIT + ["add", "-A"], origin)
        run(GIT + COMMIT + ["commit", "-qm", f"v{v}"], origin)
    return origin


@contextlib.contextmanager
def patch_updater(**overrides):
    """Override updater module attributes for the duration of the block,
    restoring the originals on exit. Tolerates attributes that don't exist
    on older code (saved as _MISSING and removed on restore), so this test
    runs against pre-M28.3 updater.py too — where the downgrade checks FAIL
    instead of the whole run crashing."""
    saved = {}
    for k, v in overrides.items():
        saved[k] = getattr(updater, k, _MISSING)
        setattr(updater, k, v)
    try:
        yield
    finally:
        for k, old in saved.items():
            if old is _MISSING:
                delattr(updater, k)
            else:
                setattr(updater, k, old)


def wait_lock_clear(max_s=10.0):
    """Wait for a background update thread (started by run_update) to
    release its lock, so the next scenario isn't blocked by it."""
    deadline = time.monotonic() + max_s
    while updater._update_lock.locked() and time.monotonic() < deadline:
        time.sleep(0.05)


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  {'PASS' if cond else 'FAIL'}  {name}"
              + (f"  ({detail})" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    # ── 1. device behind: check-fetch populates the read ref, update offered ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-upd1-") as td:
        td = Path(td)
        origin = make_origin(td, ["1.0.0", "1.2.3"])
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        old = run(GIT + ["rev-list", "-n", "1", "--skip=1", "main"], clone)
        run(GIT + ["reset", "--hard", "--quiet", old], clone)  # device @ 1.0.0

        with patch_updater(
            REPO=clone, VERSION_FILE=clone / "VERSION",
            _STARTUP_VERSION="1.0.0",  # process booted from 1.0.0
            INSTALL_SH=clone / "no-install",  # never run the real install.sh
            REPO_URL=str(origin),  # offline: fetch the fake origin
            RUN_DIR=td / "run",  # relaunch must not touch the real flag
            RESTART_FLAG=td / "run" / "restart-after-update",
        ):
            updater._fetch_remote(clone, str(origin))
            check("check-fetch populates the ref the check reads",
                  updater._remote_version_cached() == "1.2.3",
                  f"remote={updater._remote_version_cached()!r}")

            st = updater.check_for_update()
            check("behind: remote known", st["remote_known"] is True, str(st))
            check("behind: update available", st["available"] is True, str(st))
            check("behind: local/remote",
                  st["local"] == "1.0.0" and st["remote"] == "1.2.3", str(st))

            # the update path is allowed (upstream is newer)
            run_update_ok = updater.run_update()
            check("behind: run_update accepted", run_update_ok.get("ok") is True,
                  str(run_update_ok))
            wait_lock_clear()

    # ── 2. THE field bug: manual pull + stale upstream read => NO downgrade ──
    #    Process booted from 1.1.1 (that's what's RUNNING). Someone then did
    #    a `git pull` (disk VERSION is now 1.1.2), and the device's last
    #    successful fetch predates the 1.1.2 push so the cached remote is
    #    1.1.1. Old code: local=1.1.2 (live file) vs remote=1.1.1 => offered
    #    a DOWNGRADE. New code: local is frozen 1.1.1; 1.1.1 is not > 1.1.1
    #    => no update offered, and run_update refuses.
    with tempfile.TemporaryDirectory(prefix="ulaunch-upd2-") as td:
        td = Path(td)
        origin = make_origin(td, ["1.1.1", "1.1.2"])
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        # the clone's main is at 1.1.2 (that's the manual pull — the working
        # tree AND the file already say 1.1.2)
        # but the cached upstream read is the OLDER 1.1.1
        run(GIT + ["update-ref", "refs/ulaunch/upstream",
                   run(GIT + ["rev-list", "-n", "1", "--skip=1", "main"], clone)],
            clone)

        with patch_updater(
            REPO=clone, VERSION_FILE=clone / "VERSION",
            _STARTUP_VERSION="1.1.1",  # the RUNNING version (pre-pull)
            INSTALL_SH=clone / "no-install",
            REPO_URL=str(origin),
            RUN_DIR=td / "run",
            RESTART_FLAG=td / "run" / "restart-after-update",
        ):
            st = updater.check_for_update()
            check("pull+stale: local is the FROZEN running version (not the "
                  "pulled file)", st["local"] == "1.1.1", str(st))
            check("pull+stale: NO update offered (would be a downgrade)",
                  st["available"] is False, str(st))
            run_update_ok = updater.run_update()
            check("pull+stale: run_update REFUSED",
                  run_update_ok.get("ok") is False, str(run_update_ok))
            wait_lock_clear()

    # ── 3. up to date: running == upstream, nothing to do ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-upd3-") as td:
        td = Path(td)
        origin = make_origin(td, ["1.1.1"])
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        run(GIT + ["fetch", "--force", str(origin),
                   f"main:{updater.REMOTE_REF}"], clone)

        with patch_updater(
            REPO=clone, VERSION_FILE=clone / "VERSION",
            _STARTUP_VERSION="1.1.1",
            INSTALL_SH=clone / "no-install",
            REPO_URL=str(origin),
            RUN_DIR=td / "run",
            RESTART_FLAG=td / "run" / "restart-after-update",
        ):
            st = updater.check_for_update()
            check("uptodate: remote known", st["remote_known"] is True, str(st))
            check("uptodate: nothing available", st["available"] is False, str(st))
            # single call: run_update() is NOT idempotent to probe (on old
            # code a call here would start a real update thread)
            ru = updater.run_update()
            check("uptodate: run_update refused", ru.get("ok") is False, str(ru))
            wait_lock_clear()

    # ── 4. ref stays out of `git branch` ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-upd4-") as td:
        td = Path(td)
        origin = make_origin(td, ["1.0.0"])
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        run(GIT + ["fetch", "--force", str(origin),
                   f"main:{updater.REMOTE_REF}"], clone)
        branches = run(GIT + ["branch", "--list"], clone)
        check("ref does not appear in git branch",
              "ulaunch" not in branches, f"branches={branches!r}")

    # ── 5. origin-fallback: update URL unreachable, `origin` works ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-upd5-") as td:
        td = Path(td)
        origin = make_origin(td, ["2.0.0"])
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        with patch_updater(REPO=clone, VERSION_FILE=clone / "VERSION"):
            updater._fetch_remote(clone, "https://no-such-host.invalid/ulaunch.git")
            check("origin fallback: ref populated via origin remote",
                  updater._remote_version_cached() == "2.0.0",
                  f"remote={updater._remote_version_cached()!r}")

    # ── 6. stale pre-M28.1 branch is removed on check ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-upd6-") as td:
        td = Path(td)
        clone = td / "clone"
        run(GIT + ["init", "-q", "-b", "main", str(clone)], td)
        (clone / "VERSION").write_text("1.0.0\n")
        run(GIT + COMMIT + ["add", "-A"], clone)
        run(GIT + COMMIT + ["commit", "-qm", "v1.0.0"], clone)
        run(GIT + ["update-ref", "refs/heads/ulaunch-upstream", "main"], clone)
        updater._stale_ref_cleaned = False  # fresh process
        with patch_updater(
            REPO=clone, VERSION_FILE=clone / "VERSION",
            _STARTUP_VERSION="1.0.0",
            REPO_URL="https://no-such-host.invalid/ulaunch.git",
        ):
            assert "ulaunch-upstream" in run(GIT + ["branch", "--list"], clone)
            updater.check_for_update()
            check("stale refs/heads/ulaunch-upstream removed on check",
                  "ulaunch-upstream" not in run(GIT + ["branch", "--list"], clone))
        updater._stale_ref_cleaned = False

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {failures}")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
