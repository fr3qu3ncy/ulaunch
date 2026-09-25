#!/usr/bin/env bash
# ulaunch — one-time / re-runnable installer
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ ulaunch installer"
echo "────────────────────────────"

PY="${PYTHON:-python3}"
"$PY" --version

# 1. python venv
echo "▸ venv"
"$PY" -m venv .venv
./.venv/bin/pip install --upgrade pip >/dev/null
./.venv/bin/pip install -r backend/requirements.txt
echo "  ✓ python deps"

# 2. frontend build (node only needed at install time)
if command -v npm >/dev/null 2>&1; then
  echo "▸ frontend build"
  (cd frontend && npm install --no-fund --no-audit --loglevel=error && npm run build)
  echo "  ✓ frontend"
else
  echo "  ⚠ node/npm not found — using existing build if present"
fi

[ -f backend/static/index.html ] || {
  echo "✗ frontend build missing (backend/static/index.html) — install node and re-run"
  exit 1
}

# 3. system tool probe (warn only — the app offers in-app install at runtime)
echo "▸ system tools"
for tool in nmap openvpn ip nmcli curl; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "  ✓ $tool"
  else
    echo "  ✗ $tool (missing — in-app installer will offer to install it)"
  fi
done

# 4. desktop quick-launch entry
APPS_DIR="${HOME}/.local/share/applications"
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/ulaunch.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ULAUNCH
Comment=uConsole network & system launcher
Exec=$(pwd)/ulaunch
Icon=utilities-system-monitor
Terminal=false
Categories=Utility;Network;
EOF
echo "  ✓ desktop launcher ($APPS_DIR/ulaunch.desktop)"

echo "────────────────────────────"
echo "Done. Start with:  ./ulaunch"
