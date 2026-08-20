#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MARKETPLACE=atlas-router
PLUGIN="atlas@${MARKETPLACE}"

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Codex CLI is required" >&2; exit 1; }

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20+ is required" >&2; exit 1; }

echo "[1/4] Install atlas-router CLI"
npm install --global "$ROOT"

echo "[2/4] Preserve and disable a legacy standalone Atlas skill when present"
python3 - "$HOME/.codex/config.toml" "$HOME/.codex/skills/atlas/SKILL.md" <<'PY'
from pathlib import Path
import re
import sys

config = Path(sys.argv[1])
legacy = Path(sys.argv[2])
if not legacy.exists() or not config.exists():
    raise SystemExit(0)

text = config.read_text(encoding="utf-8")
escaped = re.escape(str(legacy))
block_re = re.compile(
    r"(\[\[skills\.config\]\]\s*\n"
    r"(?:(?!\n\[).)*?path\s*=\s*[\"']" + escaped + r"[\"']"
    r"(?:(?!\n\[).)*?)(?=\n\[|\Z)",
    re.DOTALL,
)
match = block_re.search(text)
if match:
    block = match.group(1)
    if re.search(r"^enabled\s*=", block, re.MULTILINE):
        replacement = re.sub(r"^enabled\s*=.*$", "enabled = false", block, flags=re.MULTILINE)
    else:
        replacement = block.rstrip() + "\nenabled = false\n"
    text = text[:match.start(1)] + replacement + text[match.end(1):]
else:
    text = text.rstrip() + f'\n\n[[skills.config]]\npath = "{legacy}"\nenabled = false\n'
config.write_text(text, encoding="utf-8")
PY

echo "[3/4] Register the local Atlas marketplace"
if codex plugin list 2>/dev/null | grep -Fq "$PLUGIN"; then
  codex plugin remove "$PLUGIN" >/dev/null
fi
if codex plugin marketplace list 2>/dev/null | awk '{print $1}' | grep -Fxq "$MARKETPLACE"; then
  codex plugin marketplace remove "$MARKETPLACE" >/dev/null
fi
codex plugin marketplace add "$ROOT" >/dev/null
codex plugin add "$PLUGIN" >/dev/null

echo "[4/4] Validate installation"
atlas-router --version
codex plugin list | grep -F "$PLUGIN"

cat <<'EOF'
Installed. In Codex, review /hooks once to trust Atlas's UserPromptSubmit hook.
For each project: atlas-router init . --trellis, edit .atlas/config.json, then atlas-router index .
EOF
