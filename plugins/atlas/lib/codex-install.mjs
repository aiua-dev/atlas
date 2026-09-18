import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKETPLACE = "atlas";
const PLUGIN = `atlas@${MARKETPLACE}`;

export function packageRootFrom(importMetaUrl) {
  const source = fs.realpathSync(fileURLToPath(importMetaUrl));
  return path.resolve(path.dirname(source), "../../..");
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} 执行失败：${detail}`);
  }
  return result.stdout;
}

/**
 * 容忍失败的执行。
 *
 * Codex 的 `plugin list` 与 `marketplace list` 是**查询**命令，但它们在
 * 存在失效注册时会整体报错（一个指向已消失目录的 marketplace 会让所有
 * plugin 子命令一起失败）。安装流程必须对这种状态有韧性，否则用户会在
 * 一个本可自愈的问题上前进不得。
 *
 * 因此查询与清理一律用容忍版本，只有最终的提交动作（add）才严格要求成功。
 */
function tryRun(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim()
  };
}

function disableLegacySkill(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  const legacySkill = path.join(codexHome, "skills", "atlas", "SKILL.md");
  if (!fs.existsSync(configPath) || !fs.existsSync(legacySkill)) return false;

  let config = fs.readFileSync(configPath, "utf8");
  const escapedPath = legacySkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(
    `(\\[\\[skills\\.config\\]\\]\\s*\\n(?:(?!\\n\\[).)*?path\\s*=\\s*["']${escapedPath}["'](?:(?!\\n\\[).)*?)(?=\\n\\[|$)`,
    "s"
  );
  const match = config.match(blockPattern);
  if (match) {
    const block = match[1];
    const replacement = /^enabled\s*=/m.test(block)
      ? block.replace(/^enabled\s*=.*$/m, "enabled = false")
      : `${block.trimEnd()}\nenabled = false\n`;
    config = config.replace(blockPattern, replacement);
  } else {
    config = `${config.trimEnd()}\n\n[[skills.config]]\npath = ${JSON.stringify(legacySkill)}\nenabled = false\n`;
  }
  fs.writeFileSync(configPath, config, "utf8");
  return true;
}

export function installCodexPlugin({
  packageRoot,
  codexBin = process.env.ATLAS_CODEX_BIN || "codex",
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  env = process.env
}) {
  const marketplaceManifest = path.join(packageRoot, ".agents", "plugins", "marketplace.json");
  const pluginManifest = path.join(packageRoot, "plugins", "atlas", ".codex-plugin", "plugin.json");
  if (!fs.existsSync(marketplaceManifest) || !fs.existsSync(pluginManifest)) {
    throw new Error(`npm 包内容不完整：${packageRoot}`);
  }

  run(codexBin, ["--version"], env);

  // 查询当前状态。失败不中断——多半是已有失效注册，后面会尝试清理。
  const plugins = tryRun(codexBin, ["plugin", "list"], env);
  const marketplaces = tryRun(codexBin, ["plugin", "marketplace", "list"], env);
  const stateUnreadable = !plugins.ok || !marketplaces.ok;

  // 清理旧注册。remove 在目标不存在时会失败，同样容忍。
  if (plugins.ok && plugins.stdout.includes(PLUGIN)) {
    tryRun(codexBin, ["plugin", "remove", PLUGIN], env);
  } else if (!plugins.ok) {
    tryRun(codexBin, ["plugin", "remove", PLUGIN], env);
  }
  if (
    !marketplaces.ok ||
    marketplaces.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === MARKETPLACE)
  ) {
    tryRun(codexBin, ["plugin", "marketplace", "remove", MARKETPLACE], env);
  }

  // 提交：这两步必须成功，否则注册没有生效。
  run(codexBin, ["plugin", "marketplace", "add", packageRoot], env);
  run(codexBin, ["plugin", "add", PLUGIN], env);
  const legacyDisabled = disableLegacySkill(codexHome);

  return {
    packageRoot,
    marketplace: MARKETPLACE,
    plugin: PLUGIN,
    legacyDisabled,
    stateUnreadable,
    restartRequired: true
  };
}
