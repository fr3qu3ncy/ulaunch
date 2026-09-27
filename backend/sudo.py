"""In-app sudo: the user types the password once in the UI; it is verified
against `sudo -v` and cached in process memory (TTL) for subsequent
privileged ops. The secret never touches disk or logs."""
import io
import os
import subprocess
import threading
import time
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

    def status(self) -> dict:
        with self._lock:
            remaining = max(0, int(self._ttl - (time.time() - self._at))) \
                if self._pw else 0
        return {
            "available": self.available(),
            "ttl_remaining": remaining,
        }


sudo = Sudo()
