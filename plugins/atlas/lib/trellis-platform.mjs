import fs from "node:fs";
import path from "node:path";

// Stable entry points shared by Trellis 0.6.x Codex workflows. This is a local
// installation check, not proof that Codex has loaded or trusted these hooks.
const CODEX_SKILLS = ["start", "brainstorm", "before-dev", "check", "update-spec", "finish-work"];
const WORKFLOW_HOOK = ".codex/hooks/inject-workflow-state.py";
const ATLAS_ADAPTER = ".atlas/hooks/trellis-active-only.py";

function nonemptyFile(root, relative) {
  try {
    const stat = fs.statSync(path.join(root, relative));
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}

export function inspectTrellisPlatform(root, platform = "codex") {
  // Other platforms remain owned by the official CLI; do not infer readiness
  // from a directory convention that varies across platforms and versions.
  if (platform !== "codex") return null;
  const required = [
    ...CODEX_SKILLS.map((name) => `.agents/skills/trellis-${name}/SKILL.md`),
    ".codex/config.toml", ".codex/hooks.json", WORKFLOW_HOOK
  ];
  const missing = required.filter((relative) => !nonemptyFile(root, relative));
  const issues = [];
  if (!missing.includes(".codex/hooks.json")) {
    try {
      const hooks = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf8"));
      const entries = hooks?.hooks?.UserPromptSubmit;
      const commands = (Array.isArray(entries) ? entries : []).flatMap((entry) =>
        Array.isArray(entry?.hooks) ? entry.hooks : []).filter((hook) => hook?.type === "command");
      const registered = commands.some((hook) => [WORKFLOW_HOOK, ATLAS_ADAPTER].some((script) =>
        nonemptyFile(root, script) && String(hook.command).split(/\s+/).some((token) =>
          token.replace(/^["']|["']$/g, "").replaceAll("\\", "/").replace(/^\.\//, "") === script)));
      if (!registered) issues.push(".codex/hooks.json 未注册 Trellis 工作流 hook（Atlas hook 不能替代它）。");
    } catch (error) { issues.push(`.codex/hooks.json 无法读取：${error.message}`); }
  }
  return { platform, ready: missing.length === 0 && issues.length === 0, missing, issues };
}
