#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { installCodexPlugin, packageRootFrom } from "../lib/codex-install.mjs";
import {
  buildIndex,
  diagnose,
  findProjectRoot,
  formatContext,
  initProject,
  queryContext,
  queryHookContext
} from "../lib/core.mjs";

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Atlas Context Router

Usage:
  atlas-router install [--json]
  atlas-router init [ROOT] [--trellis]
  atlas-router index [ROOT]
  atlas-router context [--root ROOT] --prompt TEXT [--json] [--refresh]
  atlas-router doctor [ROOT] [--json]
  atlas-router hook

The prompt path reads the cached index; run 'atlas-router index' after maintained
knowledge changes. Cache files live outside the project workspace.
`);
  process.exit(exitCode);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positional(index = 0) {
  return process.argv.slice(3).filter((argument, offset, all) => {
    if (argument.startsWith("--")) return false;
    if (offset > 0 && all[offset - 1].startsWith("--") && !["--trellis", "--json", "--refresh"].includes(all[offset - 1])) return false;
    return true;
  })[index];
}

function resolveRoot(candidate) {
  if (candidate) return path.resolve(candidate);
  const found = findProjectRoot(process.cwd());
  if (!found) throw new Error(`从 ${process.cwd()} 向上未找到 .atlas/config.json`);
  return found;
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const command = process.argv[2];
  if (!command || ["-h", "--help", "help"].includes(command)) usage(0);
  if (["-v", "--version", "version"].includes(command)) {
    process.stdout.write("0.2.1\n");
    return;
  }

  if (["install", "install-codex"].includes(command)) {
    const result = installCodexPlugin({ packageRoot: packageRootFrom(import.meta.url) });
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write([
        `Codex plugin installed: ${result.plugin}`,
        `marketplace source: ${result.packageRoot}`,
        `legacy standalone skill: ${result.legacyDisabled ? "disabled" : "not present"}`,
        "请在 Codex 的 /hooks 页面确认一次 Atlas hook 信任。"
      ].join("\n") + "\n");
    }
    return;
  }

  if (command === "init") {
    const root = path.resolve(positional() || process.cwd());
    const configPath = initProject(root, { trellis: process.argv.includes("--trellis") });
    const { index, cachePath } = buildIndex(root);
    process.stdout.write(`${configPath}\n已索引 ${index.stats.documents} 个知识文件；缓存：${cachePath}\n`);
    return;
  }

  if (command === "index") {
    const root = resolveRoot(positional());
    const { index, cachePath } = buildIndex(root);
    process.stdout.write(JSON.stringify({ root, cachePath, ...index.stats, scannedAt: index.scannedAt }, null, 2) + "\n");
    return;
  }

  if (command === "context") {
    const root = resolveRoot(option("--root"));
    const prompt = option("--prompt") ?? "";
    if (!prompt) throw new Error("context 需要 --prompt TEXT");
    const refresh = process.argv.includes("--refresh");
    const context = queryContext({ projectRoot: root, prompt, forceRefresh: refresh, cacheOnly: !refresh });
    process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(context, null, 2)}\n` : `${formatContext(context)}\n`);
    return;
  }

  if (command === "doctor") {
    const root = resolveRoot(positional());
    const result = diagnose(root);
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write([
        `Atlas root: ${result.root}`,
        `config: ok (${result.sources} sources, ${result.routes} routes)`,
        `index: ${result.cachePresent ? `ok (${result.indexedDocuments} documents, ${result.lastScan})` : "missing; run atlas-router index"}`,
        `Trellis: ${result.trellis ? `detected; spec adapters=${result.trellisSpecSources}; archiveExcluded=${result.archiveExcluded}` : "not detected"}`,
        `project hook: ${result.projectHook ?? "none"}`,
        result.hookContract
      ].join("\n") + "\n");
    }
    return;
  }

  if (command === "hook") {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const root = findProjectRoot(payload.cwd || process.cwd());
    if (!root || !payload.prompt) return;
    const context = queryHookContext({ projectRoot: root, prompt: payload.prompt, payload });
    if (!context) return;
    const additionalContext = formatContext(context);
    if (!additionalContext) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext
      }
    }) + "\n");
    return;
  }

  usage(1);
}

main().catch((error) => {
  process.stderr.write(`atlas-router: ${error.message}\n`);
  process.exitCode = 1;
});
