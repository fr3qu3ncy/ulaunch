# ULAUNCH

Neon launcher for the ClockworkPi uConsole — VPN, network scanning, and
system power controls in one fast, keyboard-first app.

- 1280x720 uConsole screen (works on any resolution)
- Black background, neon cyan/magenta/green, big type (Orbitron/Rajdhani)
- Full keyboard + mouse navigation: ←→ move, Enter drops into a tool,
  Backspace exits, Esc menu
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
- Idle screensaver (Matrix) after a configurable timeout (default 60s)

### Keyboard model

Two levels — the tool row and the tool:

| Where        | ← / →                    | Enter            | Backspace                |
|--------------|--------------------------|------------------|--------------------------|
| tool row (logo + tiles) | move between tools (wraps) | **drop into the tool** — focus lands on its first control | — |
| inside a tool | move through the tool's own options (wraps) | activate the focused option | **exit the tool** — focus returns to its tile |

Tab/Shift+Tab work too (same in-tool cycle, wrapping). Inside text-entry
fields, arrows/Backspace keep their native meaning (caret, editing) — Tab
is the way to the next control. The 15s network auto-refresh updates only
the live header stats on VPN/SCAN — it never re-renders the screen or
steals focus.

## Layout

```
backend/
  main.py       FastAPI app: /api/* + static SPA (127.0.0.1:8317)
  net.py        interface/VPN/battery/uptime detection (ip -j, nmcli)
  vpn.py        openvpn presets, connect/disconnect, log tail
  scanner.py    staged nmap engine, WebSocket progress streaming
  system.py     suspend/restart/shutdown via systemd
  settings.py   idle timeout + scan defaults (~/.ulaunch/settings.json)
  sudo.py       in-app sudo prompt (sudo -S, session-cached)
  static/       **prebuilt frontend (committed — no node needed on-device)**
frontend/
  src/          TypeScript + Vite (no framework — small state renderer)
  public/fonts/ self-hosted Orbitron/Rajdhani (woff2)
  vite.config.ts  builds to ../backend/static (only needed when you change it)
ulaunch         entrypoint: server + kiosk browser + clean shutdown
install.sh      venv + python deps + tool probe + desktop icon (no node)
```

State lives in `~/.ulaunch/` (vpn presets + logs, settings.json, run pids).
Scan jobs are in-memory — re-run a scan after a server restart.

## Config

| Env var         | Default     | Meaning                     |
|-----------------|-------------|-----------------------------|
| ULAUNCH_PORT    | 8317        | server port                 |
| ULAUNCH_BROWSER | auto-detect | chromium/chrome binary      |
| ULAUNCH_RUN_DIR | ~/.ulaunch/run | pid dir                   |
