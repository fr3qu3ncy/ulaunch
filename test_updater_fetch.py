"""M28.1 regression: the check-fetch must populate the ref the check READS.

The bug (found on the uConsole): _fetch_remote fetched into
refs/heads/ulaunch-upstream while _remote_version_cached() read
refs/ulaunch/upstream — a fresh clone's first check could never see a
remote version, so the app sat on "CHECKING…" forever (and the update
button stayed disabled, so it couldn't self-heal).

This test drives the app's own private functions in a fresh clone with a
fake origin, exactly like a device does on first boot:
  _fetch_remote(repo, url)  →  _remote_version_cached()
and also verifies the ref stays out of `git branch`.

Run:  .venv/bin/python test_updater_fetch.py
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))
import updater  # noqa: E402

GIT = ["git"]


def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    assert p.returncode == 0, f"failed: {cmd}\n{p.stderr}"
    return p.stdout.strip()


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory(prefix="ulaunch-m281-") as td:
        td = Path(td)
        # fake origin: two commits, VERSION 1.0.0 then 1.2.3
        origin = td / "origin"
        origin.mkdir()
        run(GIT + ["init", "-q", "-b", "main"], origin)
        (origin / "VERSION").write_text("1.0.0\n")
        (origin / "install.sh").write_text("#!/bin/sh\nexit 0\n")
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], origin)
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1.0.0"], origin)
        (origin / "VERSION").write_text("1.2.3\n")
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], origin)
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1.2.3"], origin)

        # the "device": a fresh clone reset to the OLDER commit — clean and
        # behind, exactly like a uConsole that has an old release
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        old = run(GIT + ["rev-list", "-n", "1", "--skip=1", "main"], clone)
        run(GIT + ["reset", "--hard", "--quiet", old], clone)

        # point the module at the fake clone: REPO (the read/merge side) and
        # VERSION_FILE (local_version() uses the module-level constant)
        old_repo, old_vf = updater.REPO, updater.VERSION_FILE
        updater.REPO = clone
        updater.VERSION_FILE = clone / "VERSION"
        try:
            # 1. the app's own background check path
            updater._fetch_remote(clone, str(origin))
            remote = updater._remote_version_cached()
            check("check-fetch populates the ref the check reads",
                  remote == "1.2.3", f"remote={remote!r}")

            # 2. check_for_update() agrees (throttle is per-process; a fresh
            #    process has _last_fetch_at=0, but call it directly anyway)
            st = updater.check_for_update()
            check("check_for_update: remote known", st["remote_known"] is True, str(st))
            check("check_for_update: available", st["available"] is True, str(st))
            check("check_for_update: local/remote", st["local"] == "1.0.0" and st["remote"] == "1.2.3", str(st))

            # 3. the ref must stay OUT of git branch (the whole reason it
            #    lives outside refs/heads)
            branches = run(GIT + ["branch", "--list"], clone)
            check("ref does not appear in git branch",
                  "ulaunch" not in branches, f"branches={branches!r}")

            # 4. the update path's fetch must use the same ref too — a
            #    second fetch via _fetch_remote must still be readable, and
            #    main must ff-merge cleanly to it
            run(GIT + ["fetch", "--force", str(origin), f"main:{updater.REMOTE_REF}"], clone)
            run(GIT + ["merge", "--ff-only", updater.REMOTE_REF], clone)
            got = (clone / "VERSION").read_text().strip()
            check("update path: ff-merge to the same ref works", got == "1.2.3", f"VERSION={got!r}")

            # 5. origin remote untouched (the updater never rewrites it)
            url = run(GIT + ["remote", "get-url", "origin"], clone)
            check("origin remote untouched", url == str(origin), f"origin={url!r}")
        finally:
            updater.REPO, updater.VERSION_FILE = old_repo, old_vf

    # ── stale ref: the pre-M28.1 stray branch is removed on check ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-m281c-") as td:
        td = Path(td)
        clone = td / "clone"
        run(GIT + ["init", "-q", "-b", "main", str(clone)], td)
        (clone / "VERSION").write_text("1.0.0\n")
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], clone)
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1.0.0"], clone)
        # simulate what the buggy release left behind on a device
        run(GIT + ["update-ref", "refs/heads/ulaunch-upstream", "main"], clone)
        old_repo, old_vf = updater.REPO, updater.VERSION_FILE
        updater.REPO, updater.VERSION_FILE = clone, clone / "VERSION"
        updater._stale_ref_cleaned = False  # fresh process
        try:
            branches = run(GIT + ["branch", "--list"], clone)
            assert "ulaunch-upstream" in branches  # fixture sanity
            updater.check_for_update()
            branches = run(GIT + ["branch", "--list"], clone)
            check("stale refs/heads/ulaunch-upstream removed on check",
                  "ulaunch-upstream" not in branches, f"branches={branches!r}")
        finally:
            updater.REPO, updater.VERSION_FILE = old_repo, old_vf
            updater._stale_ref_cleaned = False

    # ── origin-fallback: the update URL is unreachable, `origin` works ──
    with tempfile.TemporaryDirectory(prefix="ulaunch-m281b-") as td:
        td = Path(td)
        origin = td / "origin"
        origin.mkdir()
        run(GIT + ["init", "-q", "-b", "main"], origin)
        (origin / "VERSION").write_text("2.0.0\n")
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], origin)
        run(GIT + ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v2.0.0"], origin)
        clone = td / "clone"
        run(GIT + ["clone", "-q", str(origin), str(clone)], td)
        old_repo, old_vf = updater.REPO, updater.VERSION_FILE
        updater.REPO, updater.VERSION_FILE = clone, clone / "VERSION"
        try:
            # a URL that can never work (the device has no route there)
            updater._fetch_remote(clone, "https://no-such-host.invalid/ulaunch.git")
            check("origin fallback: ref populated via origin remote",
                  updater._remote_version_cached() == "2.0.0",
                  f"remote={updater._remote_version_cached()!r}")
        finally:
            updater.REPO, updater.VERSION_FILE = old_repo, old_vf

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {failures}")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
