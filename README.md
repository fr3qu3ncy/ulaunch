# ULAUNCH

Neon launcher for the ClockworkPi uConsole — VPN, network scanning, and
system power controls in one fast, keyboard-first app.

- 1280x720 uConsole screen (works on any resolution)
- Black background, neon cyan/magenta/green, big type (Orbitron/Rajdhani)
- Full keyboard + mouse navigation: arrows/Tab switch, Enter activates, Esc menu
- Local-only: server on 127.0.0.1, nothing exposed

## Stack

| Layer     | Tech                                              |
|-----------|---------------------------------------------------|
| Backend   | Python 3.11+ / FastAPI / uvicorn / websockets (venv) |
| Frontend  | TypeScript + Vite, built to static assets served by the same process |
| Display   | Chromium kiosk at 1280x720                        |
| Tools     | nmap, openvpn, ip, nmcli, systemctl (system binaries via subprocess) |

## Install (uConsole or any Linux with Chromium)

```sh
git clone https://github.com/fr3qu3ncy/ulaunch
cd ulaunch
./install.sh
./ulaunch
```

`install.sh` is idempotent — re-run it after every `git pull`.
It creates the venv, builds the frontend, probes for nmap/openvpn
(warns only — the app offers in-app install with a sudo prompt at runtime),
and drops a desktop quick-launch icon.

## Daily use

- `./ulaunch` or the ULAUNCH desktop icon — starts server + kiosk browser
- **Esc** opens the quick menu: Back to Desktop / Minimise / Exit
- Arrows or Tab switch sections, Enter activates
- Idle screensaver (Matrix) after a configurable timeout (default 60s)

## Layout

```
backend/
  main.py       FastAPI app: /api/* + static SPA (127.0.0.1:8317)
  net.py        interface/VPN/battery/uptime detection (ip -j, nmcli)
  vpn.py        (M2) openvpn presets, connect/disconnect, log tail
  scanner.py    (M3) staged nmap engine, WebSocket progress streaming
  system.py     (M4) suspend/restart/shutdown via systemd
  sudo.py       (M2) in-app sudo prompt (sudo -S, session-cached)
  tools.py      (M2) tool detection + apt install
frontend/
  src/          TypeScript + Vite (no framework — small state renderer)
  public/fonts/ self-hosted Orbitron/Rajdhani (woff2)
  vite.config.ts  builds to ../backend/static
ulaunch         entrypoint: server + kiosk browser + clean shutdown
install.sh      venv + frontend build + tool probe + desktop icon
```

State lives in `~/.ulaunch/` (vpn presets, scan history, settings, run pids).

## Config

| Env var         | Default     | Meaning                     |
|-----------------|-------------|-----------------------------|
| ULAUNCH_PORT    | 8317        | server port                 |
| ULAUNCH_BROWSER | auto-detect | chromium/chrome binary      |
| ULAUNCH_RUN_DIR | ~/.ulaunch/run | pid dir                   |
