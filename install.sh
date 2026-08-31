#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Codex CLI is required" >&2; exit 1; }

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20+ is required" >&2; exit 1; }

echo "[1/2] Install @aiua/atlas"
npm install --global "$ROOT"

echo "[2/2] Install bundled Codex plugin"
atlas-router install

cat <<'EOF'
For each project: atlas-router init . --trellis, edit .atlas/config.json, then atlas-router index .
Fully quit and reopen Codex Desktop after install; creating a new task does not reload the running app-server hooks.
EOF
