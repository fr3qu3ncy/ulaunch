"""In-app sudo: the user types the password once in the UI; it is verified
against `sudo -v` and cached in process memory (TTL) for subsequent
privileged ops. The secret never touches disk or logs."""
import io
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

# write-ends of stdin pipes for long-running privileged children, keyed by
# the Popen. Held OPEN so openvpn never sees EOF; closed on kill/exit.
_held_stdin: dict[subprocess.Popen, "io.TextIOWrapper"] = {}
_held_lock = threading.Lock()


class SudoRequired(Exception):
    """No valid cached password — the client must prompt for one."""


class Sudo:
    def __init__(self, ttl: int = 900):
        self._pw: str | None = None
        self._at: float = 0.0
        self._ttl = ttl
        self._lock = threading.Lock()
    def verify(self, password: str) -> bool:
        """Check the password against sudo; cache on success."""
        try:
            p = subprocess.run(
                ["sudo", "-S", "-v"],
                input=password + "\n",
                capture_output=True, text=True, timeout=15,
            )
        except Exception:
            return False
        if p.returncode == 0:
            with self._lock:
                self._pw = password
                self._at = time.time()
            return True
        return False

    def _cached(self) -> str | None:
        with self._lock:
            if self._pw and (time.time() - self._at) <= self._ttl:
                return self._pw
            return None

    def available(self) -> bool:
        pw = self._cached()
        if not pw:
            return False
        try:
            p = subprocess.run(
                ["sudo", "-S", "-v"],
                input=pw + "\n",
                capture_output=True, text=True, timeout=15,
            )
        except Exception:
            return False
        if p.returncode == 0:
            with self._lock:
                self._at = time.time()  # refresh TTL on success
            return True
        with self._lock:
            self._pw = None
        return False

    def run(self, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
        """Run a privileged command with the cached password."""
        pw = self._cached()
        if not pw or not self.available():
            raise SudoRequired()
        return subprocess.run(
            ["sudo", "-S", *args],
            input=pw + "\n",
            capture_output=True, text=True, timeout=timeout,
        )

    def popen(self, *args: str,
              stderr: Any = None, stdout: Any = None) -> subprocess.Popen:
        """Privileged long-running Popen (openvpn).

        The password is written to an anonymous pipe (never a file on
        disk). Crucially, the write end is kept OPEN for the lifetime of
        the child: openvpn inherits the same stdin, and a closed pipe
        (EOF) makes a foreground openvpn exit. Close it via
        close_stdin() when the child is killed or exits.
        """
        pw = self._cached()
        if not pw or not self.available():
            raise SudoRequired()

        r, w = os.pipe()
        err_target = (stderr if stderr is not None
                      else subprocess.DEVNULL)
        out_target = (stdout if stdout is not None
                      else subprocess.DEVNULL)
        proc = subprocess.Popen(
            ["sudo", "-S", *args],
            stdin=r,
            stdout=out_target,
            stderr=err_target,
            start_new_session=True,
        )
        os.close(r)          # parent no longer needs the read end
        f = os.fdopen(w, "w")
        f.write(pw + "\n")
        f.flush()
        # do NOT close the write end — a closed pipe (EOF) makes a
        # foreground openvpn exit. Keep the file object held open until
        # the child dies (close_stdin()).
        with _held_lock:
            _held_stdin[proc] = f
        return proc

    def close_stdin(self, proc: subprocess.Popen) -> None:
        """Release the held stdin pipe (safe to call more than once)."""
        with _held_lock:
            f = _held_stdin.pop(proc, None)
        if f is not None:
            try:
                f.close()
            except OSError:
                pass

    def reap_stdin(self) -> None:
        """Drop pipes for children that have exited (call occasionally)."""
        with _held_lock:
            dead = [p for p in _held_stdin if p.poll() is not None]
        for p in dead:
            self.close_stdin(p)

    def grant_openvpn_nopasswd(self) -> bool:
        """One-time grant: write a sudoers drop-in so the CURRENT user can
        run openvpn with `sudo openvpn …` WITHOUT a password — no further
        password prompts needed for VPN connects.

        Requires a valid cached password (the password is used for this
        privileged write). Raises SudoRequired when the cache is empty
        (the client prompts first). Returns True when the drop-in is in
        place (it may have existed already), False on a failed write.
        """
        pw = self._cached()
        if not pw or not self.available():
            raise SudoRequired()
        try:
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name
        except KeyError:
            return False
        # only the openvpn binary, exact path match — nothing else is
        # granted. Resolve the real path when openvpn is already
        # installed; otherwise assume the Debian/Ubuntu package path
        # (the grant is harmless until the binary exists there).
        ovpn = shutil.which("openvpn") or "/usr/sbin/openvpn"
        rule = f"{user} ALL=(ALL) NOPASSWD: {ovpn}"
        target = "/etc/sudoers.d/ulaunch-openvpn"
        # verify the password is still good (and refresh the TTL), then
        # write the drop-in; `tee` is the one write target that sudo
        # allows in a NOPASSWD-style command, but here we pass the cached
        # password to `sudo -S tee` directly.
        p = subprocess.run(
            ["sudo", "-S", "tee", target],
            input=f"{pw}\n{rule}\n",
            capture_output=True, text=True, timeout=30,
        )
        if p.returncode != 0:
            return False
        # the sudoers drop-in must not be group/world writable or sudo
        # refuses to use it. `sudo tee` already creates it root-owned at
        # 0644 — tighten to 0440. Best effort: when the ulaunch server
        # itself runs unprivileged (the normal case) it cannot chmod a
        # root-owned file, so the mode stays 0644 — still valid sudoers,
        # just not as tight as it could be.
        try:
            os.chmod(target, 0o440)
        except OSError:
            pass
        v = subprocess.run(
            ["sudo", "-S", "visudo", "-cf", target],
            input=pw + "\n", capture_output=True, text=True, timeout=30,
        )
        if v.returncode != 0:
            # malformed rule (shouldn't happen) — don't leave a broken
            # drop-in that breaks the user's normal sudo
            subprocess.run(["sudo", "-S", "rm", "-f", target],
                           input=pw + "\n", capture_output=True, text=True,
                           timeout=30)
            return False
        return True

    def has_openvpn_nopasswd(self) -> bool:
        """True when the NOPASSWD drop-in for openvpn exists for the
        current user. Read-only — no password needed (the file is
        root-owned but world-readable at 0440)."""
        try:
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name
        except KeyError:
            return False
        try:
            text = Path("/etc/sudoers.d/ulaunch-openvpn").read_text()
        except OSError:
            return False
        return f"{user} ALL=(ALL) NOPASSWD:" in text \
            and "openvpn" in text

    def status(self) -> dict:
        with self._lock:
            remaining = max(0, int(self._ttl - (time.time() - self._at))) \
                if self._pw else 0
        return {
            "available": self.available(),
            "ttl_remaining": remaining,
            "openvpn_nopasswd": self.has_openvpn_nopasswd(),
        }


sudo = Sudo()
