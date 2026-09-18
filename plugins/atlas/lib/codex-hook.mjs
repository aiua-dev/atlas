import fs from "node:fs";
import path from "node:path";

// 把 Atlas 的 UserPromptSubmit 钩子注册到项目的 Codex 配置里。
//
// 与 Claude Code 的差别:Codex 的钩子同样落在项目内的 hooks 配置文件中
// (`.codex/hooks.json`),格式与 Claude 的 settings.json 一致,都是
// `hooks.UserPromptSubmit[].hooks[]`。
//
// 这里只追加 Atlas 自己的那条,不替换已有的 Trellis 钩子:
// Trellis 注入流程状态,Atlas 注入知识路由,两者职责不同且都必要。
// 历史上 app-manager 曾把 Trellis 的 hook 替换为代理脚本(只为了静默 no_task),
// 那个做法会丢掉 Trellis 在活动任务下的 breadcrumb;现在改为两条并存。

const HOOKS_RELATIVE = path.join(".codex", "hooks.json");
export const DEFAULT_CODEX_COMMAND = "atlas hook";
const DEFAULT_TIMEOUT = 15;

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function registrations(settings) {
  const entries = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
}

export function codexHookStatus(root, { command = DEFAULT_CODEX_COMMAND } = {}) {
  const file = path.join(root, HOOKS_RELATIVE);
  if (!fs.existsSync(file)) return { registered: false, file };
  try {
    const registered = registrations(readJson(file)).some(
      (hook) => hook?.type === "command" && hook?.command === command
    );
    return { registered, file };
  } catch (error) {
    return { registered: false, file, error: `hooks.json 不是合法 JSON：${error.message}` };
  }
}

export function installCodexHook(root, { command = DEFAULT_CODEX_COMMAND, timeout = DEFAULT_TIMEOUT } = {}) {
  const resolved = path.resolve(root);
  const file = path.join(resolved, HOOKS_RELATIVE);
  // Codex 项目即便没有 .codex 目录也应能注册：hooks.json 的位置由约定决定。
  const settings = readJson(file);
  const already = registrations(settings).some(
    (hook) => hook?.type === "command" && hook?.command === command
  );
  if (already) return { file, command, changed: false };

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

export function uninstallCodexHook(root, { command = DEFAULT_CODEX_COMMAND } = {}) {
  const resolved = path.resolve(root);
  const file = path.join(resolved, HOOKS_RELATIVE);
  if (!fs.existsSync(file)) return { file, changed: false };

  const settings = readJson(file);
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

  if (kept.length === entries.length) return { file, changed: false };

  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks.UserPromptSubmit = kept;
  else delete hooks.UserPromptSubmit;

  const next = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { file, changed: true };
}
