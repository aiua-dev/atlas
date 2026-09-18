import fs from "node:fs";
import path from "node:path";

// 把 Atlas 的 UserPromptSubmit 钩子注册到项目的 Claude Code 配置里。
//
// Claude Code 与 Codex 的差别:Codex 走插件 marketplace(全局),Claude Code 读项目内的
// .claude/settings.json。所以这里写的是项目文件,幂等,且只动 hooks.UserPromptSubmit,
// 不碰同一文件里的其它键,也不碰 settings.local.json(那是个人本地配置)。

const SETTINGS_RELATIVE = path.join(".claude", "settings.json");
export const DEFAULT_COMMAND = "atlas hook";
const DEFAULT_TIMEOUT = 15;

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function commandRegistrations(settings) {
  const entries = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
}

export function claudeHookStatus(root, { command = DEFAULT_COMMAND } = {}) {
  const file = path.join(root, SETTINGS_RELATIVE);
  if (!fs.existsSync(file)) return { registered: false, file };
  try {
    const registered = commandRegistrations(readSettings(file)).some(
      (hook) => hook?.type === "command" && hook?.command === command
    );
    return { registered, file };
  } catch (error) {
    return { registered: false, file, error: `settings.json 不是合法 JSON:${error.message}` };
  }
}

export function installClaudeHook(root, { command = DEFAULT_COMMAND, timeout = DEFAULT_TIMEOUT } = {}) {
  const resolved = path.resolve(root);
  const file = path.join(resolved, SETTINGS_RELATIVE);
  const settings = readSettings(file);
  const alreadyRegistered = commandRegistrations(settings).some(
    (hook) => hook?.type === "command" && hook?.command === command
  );

  if (alreadyRegistered) return { file, command, changed: false };

  const hooks = settings.hooks ?? {};
  const entries = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
  entries.push({ hooks: [{ type: "command", command, timeout }] });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...settings, hooks: { ...hooks, UserPromptSubmit: entries } }, null, 2)}\n`,
    "utf8"
  );

  return { file, command, changed: true };
}

export function uninstallClaudeHook(root, { command = DEFAULT_COMMAND } = {}) {
  const resolved = path.resolve(root);
  const file = path.join(resolved, SETTINGS_RELATIVE);
  if (!fs.existsSync(file)) return { file, changed: false };

  const settings = readSettings(file);
  const entries = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(entries)) return { file, changed: false };

  const kept = entries
    .map((entry) => ({
      ...entry,
      hooks: (Array.isArray(entry?.hooks) ? entry.hooks : []).filter(
        (hook) => !(hook?.type === "command" && hook?.command === command)
      )
    }))
    .filter((entry) => entry.hooks.length > 0);

  const changed = kept.length !== entries.length;
  if (!changed) return { file, changed: false };

  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks.UserPromptSubmit = kept;
  else delete hooks.UserPromptSubmit;

  const next = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { file, changed: true };
}
