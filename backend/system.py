"""System power ops via systemctl — works on uConsoleOS and stock Debian.
All actions go through the in-app sudo cache."""
import shutil

from sudo import sudo

# action -> command. poweroff is what a handheld actually wants (full
# power cut); shutdown -h leaves the SoC powered.
ACTIONS = {
    "suspend": ["systemctl", "suspend"],
    "reboot": ["systemctl", "reboot"],
    "shutdown": ["systemctl", "shutdown", "-h", "now"],
    "poweroff": ["systemctl", "poweroff"],
}


def has_systemd() -> bool:
    return shutil.which("systemctl") is not None


def do_action(action: str) -> dict:
    cmd = ACTIONS.get(action)
    if cmd is None:
        raise ValueError(f"unknown action: {action!r}")
    if not has_systemd():
        raise RuntimeError("systemctl not found on this system")
    p = sudo.run(*cmd, timeout=15)
    if p.returncode != 0:
        raise RuntimeError(
            f"{action} failed (rc={p.returncode}): {(p.stderr or p.stdout).strip()[-200:]}")
    return {"ok": True, "action": action}
