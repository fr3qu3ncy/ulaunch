"""In-app sudo: the user types the password once in the UI; it is verified
against `sudo -v` and cached in process memory (TTL) for subsequent
privileged ops. The secret never touches disk or logs."""
import os
import subprocess
import threading
import time
import tempfile


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

    def popen(self, *args: str) -> subprocess.Popen:
        """Privileged long-running Popen (openvpn).

        The password is written to a short-lived FIFO the sudo child reads
        once from stdin — the secret is never written to a real file on disk
        (FIFOs live in page cache, not the filesystem), and the fd is closed
        immediately after the child has consumed it.
        """
        pw = self._cached()
        if not pw or not self.available():
            raise SudoRequired()

        # Create an anonymous pipe; pass the write end via fd inheritance.
        r, w = os.pipe()
        proc = subprocess.Popen(
            ["sudo", "-S", *args],
            stdin=r,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        os.close(r)          # parent no longer needs the read end
        with os.fdopen(w, "w") as f:
            f.write(pw + "\n")
            f.flush()
        os.close(w)          # EOF -> sudo consumes the password and runs
        return proc

    def status(self) -> dict:
        with self._lock:
            remaining = max(0, int(self._ttl - (time.time() - self._at))) \
                if self._pw else 0
        return {
            "available": self.available(),
            "ttl_remaining": remaining,
        }


sudo = Sudo()
