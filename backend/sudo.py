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

    def passwordless(self) -> bool:
        """True when the current user can sudo ANYTHING without a password
        — a broad NOPASSWD rule, e.g. Raspberry Pi's 010_pi-nopasswd
        (`pi ALL=(ALL) NOPASSWD: ALL`). In that case `sudo -S` never
        consumes a password line, and feeding one would leak it into the
        child's stdin. Uses `sudo -l` (lists the user's rules; needs no
        password and is not affected by the timestamp cache)."""
        try:
            p = subprocess.run(["sudo", "-l"],
                               capture_output=True, text=True, timeout=10)
            return p.returncode == 0 and "NOPASSWD: ALL" in p.stdout
        except Exception:
            return False

    def nopasswd_for(self, command: str) -> bool:
        """True when the current user can run `command` via sudo without a
        password (any NOPASSWD rule that covers it — ours or a broader
        pre-existing one). Read-only, no password needed."""
        try:
            p = subprocess.run(
                ["sudo", "-l", command],
                capture_output=True, text=True, timeout=10,
            )
            return p.returncode == 0 and "NOPASSWD" in p.stdout
        except Exception:
            return False

    def available(self, command: str | None = None) -> bool:
        """True when a privileged op may proceed: the user is broadly
        passwordless, the cached password is still valid, or (command
        given) that specific command already has a NOPASSWD rule — e.g.
        openvpn after the grant, once the password TTL has expired."""
        if self.passwordless():
            return True
        if command is not None and self.nopasswd_for(command):
            return True
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
        """Run a privileged command with the cached password (or no
        password at all when the user is already passwordless)."""
        pw = self._pw_for()
        if pw is None and not self.available(args[0] if args else None):
            raise SudoRequired()
        return subprocess.run(
            ["sudo", "-S", *args],
            input=(pw + "\n" if pw else None),
            capture_output=True, text=True, timeout=timeout,
        )

    def _pw_for(self) -> str | None:
        """Password to feed `sudo -S` for a privileged op: the cached one,
        or None when sudo is passwordless (feeding stdin there would leak
        into the child)."""
        if self.passwordless():
            return None
        return self._cached()

    def popen(self, *args: str,
              stderr: Any = None, stdout: Any = None) -> subprocess.Popen:
        """Privileged long-running Popen (openvpn).

        The password is written to an anonymous pipe (never a file on
        disk). Crucially, the write end is kept OPEN for the lifetime of
        the child: openvpn inherits the same stdin, and a closed pipe
        (EOF) makes a foreground openvpn exit. Close it via
        close_stdin() when the child is killed or exits.
        """
        pw = self._pw_for()
        if pw is None and not self.available(args[0] if args else None):
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
        if pw is None:
            # passwordless sudo: nothing to feed; close the pipe so the
            # child sees clean EOF instead of a stray password line
            os.close(w)
            return proc
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

        Works whether or not the user already has passwordless sudo: the
        rule is staged in a temp file and `sudo install`ed (no stdin at
        all, atomic, root-owned 0440). Raises SudoRequired when the cache
        is empty AND sudo is not passwordless (the client prompts first).
        Returns True when the drop-in is in place (it may have existed
        already), False on a failed write.
        """
        import tempfile
        if not self.available():
            raise SudoRequired()
        # the password to feed the privileged writes below — the cached
        # one when sudo needs it, None when the user is passwordless
        # (feeding a password then would leak into the child's stdin).
        pw = self._pw_for()
        feed = (pw + "\n") if pw else None
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
        # stage the rule in a private temp file and install it with the
        # correct owner+mode in one privileged step. Deliberately NO
        # `sudo -S` stdin here: when sudo is passwordless (e.g. Raspberry
        # Pi's 010_pi-nopasswd) `sudo -S` never consumes a password line
        # and the child (tee) would receive the password as its first
        # input line — corrupting the drop-in. `install` has no stdin
        # coupling at all.
        staged = None
        try:
            fd, staged = tempfile.mkstemp(prefix="ulaunch-openvpn-", suffix=".rule")
            with os.fdopen(fd, "w") as f:
                f.write(rule + "\n")
            os.chmod(staged, 0o400)
            p = subprocess.run(
                ["sudo", "-S", "install", "-o", "root", "-g", "root",
                 "-m", "0440", staged, target],
                input=feed, capture_output=True, text=True, timeout=30,
            )
            if p.returncode != 0:
                return False
            v = subprocess.run(
                ["sudo", "-S", "visudo", "-cf", target],
                input=feed, capture_output=True, text=True, timeout=30,
            )
            if v.returncode != 0:
                # malformed rule (shouldn't happen) — don't leave a broken
                # drop-in that breaks the user's normal sudo
                subprocess.run(["sudo", "-S", "rm", "-f", target],
                               input=feed, capture_output=True, text=True,
                               timeout=30)
                return False
            return True
        finally:
            # the staged rule may contain user names/paths — never leave it
            if staged:
                try:
                    os.unlink(staged)
                except OSError:
                    pass

    def has_openvpn_nopasswd(self) -> bool:
        """True when openvpn needs NO password for the current user — either
        because they're already passwordless (Raspberry Pi's
        010_pi-nopasswd, or any NOPASSWD sudoers rule) OR via our own
        drop-in. Read-only, no password needed."""
        if self.passwordless():
            return True
        try:
            p = subprocess.run(
                ["sudo", "-n", "-l", "openvpn"],
                capture_output=True, text=True, timeout=10,
            )
            if p.returncode == 0 and "NOPASSWD" in p.stdout:
                return True
        except Exception:
            pass
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
            "passwordless": self.passwordless(),
            "ttl_remaining": remaining,
            "openvpn_nopasswd": self.has_openvpn_nopasswd(),
        }


sudo = Sudo()
