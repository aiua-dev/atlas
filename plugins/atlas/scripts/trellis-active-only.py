#!/usr/bin/env python3
"""Atlas 的 Trellis 注入适配器：无任务时保持静默。

Trellis 原生的 inject-workflow-state.py 在无活动任务时仍注入 `Status: no_task`
的 breadcrumb，导致每个小请求都要模型询问「是否创建 Trellis 任务」。
本适配器代理调用原始 hook，过滤掉 no_task 状态，其余状态原样透传。

原始 hook 文件保持不动，本文件注册在项目自带的位置，因此不受 trellis update 影响。
由 `atlas sync --install-adapter` 安装。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Trellis 各平台的原生 hook 位置，按顺序探测。
VENDOR_HOOK_CANDIDATES = (
    Path(".codex") / "hooks" / "inject-workflow-state.py",
    Path(".claude") / "hooks" / "inject-workflow-state.py",
    Path(".cursor") / "hooks" / "inject-workflow-state.py",
    Path(".opencode") / "hooks" / "inject-workflow-state.py",
)

SILENT_STATUS = "Status: no_task"


def find_vendor_hook(project_root: Path) -> Path | None:
    for candidate in VENDOR_HOOK_CANDIDATES:
        full = project_root / candidate
        if full.is_file():
            return full
    return None


def main() -> int:
    raw = sys.stdin.read()
    project_root = Path(os.environ.get("ATLAS_PROJECT_ROOT") or Path.cwd()).resolve()
    vendor_hook = find_vendor_hook(project_root)
    if vendor_hook is None:
        return 0

    try:
        completed = subprocess.run(
            [sys.executable, "-X", "utf8", str(vendor_hook)],
            input=raw,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(project_root),
            timeout=12,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        # 代理失败时不阻断对话，交由 Trellis 的正常路径处理。
        return 0

    if completed.returncode != 0 or not completed.stdout.strip():
        return 0

    try:
        payload = json.loads(completed.stdout)
        context = payload["hookSpecificOutput"]["additionalContext"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return 0

    if SILENT_STATUS in context:
        return 0

    sys.stdout.write(completed.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
