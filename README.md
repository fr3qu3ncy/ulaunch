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
| Frontend  | TypeScript + Vite, **prebuilt static committed in the repo** (no node needed on-device) |
| Display   | Chromium kiosk at 1280x720                        |
| Tools     | nmap, openvpn, ip, nmcli, systemctl (system binaries via subprocess) |

## Install (uConsole or any Linux with Chromium)

The frontend ships prebuilt in `backend/static/`, so **you do not need node**
on the uConsole — important when you're on the 8GB EMMC. All the device needs
is Python 3 (for the venv) and Chromium.

```sh
git clone https://github.com/fr3qu3ncy/ulaunch
cd ulaunch
./install.sh      # venv + python deps + desktop icon (uses the prebuilt frontend)
./ulaunch
```

`install.sh` is idempotent — re-run it after every `git pull`.
It creates the venv, uses the prebuilt frontend (or rebuilds it if node
happens to be present), probes for nmap/openvpn (warns only — the app offers
in-app install with a sudo prompt at runtime), and drops a desktop
quick-launch icon.

### Rebuilding the frontend (only if you change it)

The committed `backend/static/` is generated from `frontend/`. To regenerate
after editing the TypeScript/CSS (needs node + npm, ~30MB — do this on a
machine with space, then push):

```sh
cd frontend
npm ci
npm run build        # writes to ../backend/static
cd ..
git add backend/static
git commit -am "rebuild frontend"
```

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
  vpn.py        openvpn presets, connect/disconnect, log tail
  scanner.py    staged nmap engine, WebSocket progress streaming
  system.py     suspend/restart/shutdown via systemd
  sudo.py       in-app sudo prompt (sudo -S, session-cached)
  static/       **prebuilt frontend (committed — no node needed on-device)**
frontend/
  src/          TypeScript + Vite (no framework — small state renderer)
  public/fonts/ self-hosted Orbitron/Rajdhani (woff2)
  vite.config.ts  builds to ../backend/static (only needed when you change it)
ulaunch         entrypoint: server + kiosk browser + clean shutdown
install.sh      venv + python deps + tool probe + desktop icon (no node)
```

State lives in `~/.ulaunch/` (vpn presets, scan history, settings, run pids).

## Config

| Env var         | Default     | Meaning                     |
|-----------------|-------------|-----------------------------|
| ULAUNCH_PORT    | 8317        | server port                 |
| ULAUNCH_BROWSER | auto-detect | chromium/chrome binary      |
| ULAUNCH_RUN_DIR | ~/.ulaunch/run | pid dir                   |
