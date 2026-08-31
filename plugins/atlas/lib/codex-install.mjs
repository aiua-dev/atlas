import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKETPLACE = "atlas-router";
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
  const plugins = run(codexBin, ["plugin", "list"], env);
  if (plugins.includes(PLUGIN)) run(codexBin, ["plugin", "remove", PLUGIN], env);

  const marketplaces = run(codexBin, ["plugin", "marketplace", "list"], env);
  if (marketplaces.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === MARKETPLACE)) {
    run(codexBin, ["plugin", "marketplace", "remove", MARKETPLACE], env);
  }

  run(codexBin, ["plugin", "marketplace", "add", packageRoot], env);
  run(codexBin, ["plugin", "add", PLUGIN], env);
  const legacyDisabled = disableLegacySkill(codexHome);

  return {
    packageRoot,
    marketplace: MARKETPLACE,
    plugin: PLUGIN,
    legacyDisabled,
    restartRequired: true
  };
}
