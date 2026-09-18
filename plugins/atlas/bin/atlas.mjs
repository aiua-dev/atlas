#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { installCodexPlugin, packageRootFrom } from "../lib/codex-install.mjs";
import {
  DEFAULT_COMMAND,
  claudeHookStatus,
  installClaudeHook,
  uninstallClaudeHook
} from "../lib/claude-install.mjs";
import { composeInjection } from "../lib/inject.mjs";
import { readTrellisState } from "../lib/trellis.mjs";
import { bootstrapProject, ensureAtlas, hasAtlas, hasTrellis } from "../lib/bootstrap.mjs";
import {
  buildIndex,
  currentSessionFocus,
  diagnose,
  findProjectRoot,
  formatContext,
  initProject,
  knowledgeSources,
  queryContext,
  queryContextWithEmbedding,
  updateSessionRoute
} from "../lib/core.mjs";
import { syncTrellis, formatSyncReport } from "../lib/sync.mjs";
import { recordClaim, formatRecordResult } from "../lib/record.mjs";
import { recordDecision } from "../lib/decisions.mjs";
import { inspectTrellisPlatform } from "../lib/trellis-platform.mjs";

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Atlas

Usage:
  atlas install [--json]                     注册 Codex 插件(全局)
  atlas install --claude [ROOT] [--command C] 把钩子注册到项目的 Claude Code 配置
  atlas uninstall-claude [ROOT]              从项目配置移除 Atlas 钩子
  atlas init [ROOT] [--trellis]
  atlas sync [ROOT] [--dry-run] [--json]     修正 Trellis 的知识层与注入层
  atlas bootstrap [ROOT] [--platform P] [--user NAME] [--json]
                                             补齐 Atlas 与 Trellis 的初始化
  atlas record --claim TEXT [--owner PATH] [--title T] [--platform P]
                                             把一条项目事实落进维护中的真源；
                                             缺配置时自动初始化 Atlas（不创建 Trellis）
  atlas record --decision-file JSON --owner PATH [--expect HASH] [--dry-run] [--json]
                                             将决策归并到已索引真源；JSON 可用 - 从 stdin 读取
                          [--supersede ID]    同一 topic 下原子取代旧决定，--expect 为旧决定指纹
  atlas index [ROOT]
  atlas context [--root ROOT] --prompt TEXT [--json] [--refresh] [--lexical] [--intent all|current|history]
  atlas route [--root ROOT] --prompt TEXT [--json] [--refresh] [--intent all|current|history]
  atlas focus [--root ROOT] [--json]
  atlas doctor [ROOT] [--json] [--platform codex]
  atlas hook

The prompt path reads the cached index; run 'atlas index' after maintained
knowledge changes. Cache files live outside the project workspace.
`);
  process.exit(exitCode);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const packageVersion = JSON.parse(
  fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
).version;

// 布尔标志后面的东西仍然是位置参数；只有取值型标志（--root/--prompt/--command）会吃掉下一个。
const BOOLEAN_FLAGS = new Set(["--trellis", "--json", "--refresh", "--claude", "--dry-run", "--lexical"]);

function positional(index = 0) {
  return process.argv.slice(3).filter((argument, offset, all) => {
    if (argument.startsWith("--")) return false;
    if (offset > 0 && all[offset - 1].startsWith("--") && !BOOLEAN_FLAGS.has(all[offset - 1])) return false;
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

function refreshIndex(root, result) {
  try {
    const { index } = buildIndex(root);
    result.indexed = true;
    result.knowledgeIssues = index.documents.flatMap((document) =>
      (document.knowledgeIssues ?? []).map((issue) => ({ path: document.path, ...issue })));
    if (result.knowledgeIssues.length) process.exitCode = 1;
  } catch (error) {
    result.indexed = false;
    result.indexError = error.message;
    process.exitCode = 1;
  }
}

function indexMessage(result) {
  if (result.indexError) return `索引刷新失败：${result.indexError}`;
  if (result.knowledgeIssues?.length) return `索引已刷新，但有 ${result.knowledgeIssues.length} 条决策校验问题；请运行 atlas doctor。`;
  return result.indexed ? "索引已刷新。" : "";
}

async function main() {
  const command = process.argv[2];
  if (!command || ["-h", "--help", "help"].includes(command)) usage(0);
  if (["-v", "--version", "version"].includes(command)) {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }

  if (command === "uninstall-claude") {
    const root = resolveRoot(positional());
    const result = uninstallClaudeHook(root, { command: option("--command") ?? DEFAULT_COMMAND });
    process.stdout.write(
      result.changed ? `已移除 Atlas 钩子：${result.file}\n` : `未找到已注册的 Atlas 钩子：${result.file}\n`
    );
    return;
  }

  if (["install", "install-codex"].includes(command)) {
    if (process.argv.includes("--claude")) {
      const root = resolveRoot(positional());
      const hookCommand = option("--command") ?? DEFAULT_COMMAND;
      const result = installClaudeHook(root, { command: hookCommand });
      process.stdout.write([
        result.changed ? `已注册 Claude Code 钩子：${result.file}` : `钩子已存在，未改动：${result.file}`,
        `command: ${result.command}`,
        `timeout: 15s`,
        "重开一个 Claude Code 会话即可生效（钩子按会话加载）。"
      ].join("\n") + "\n");
      return;
    }
    const result = installCodexPlugin({ packageRoot: packageRootFrom(import.meta.url) });
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const lines = [];
      if (result.stateUnreadable) {
        // 出现这种情况说明此前有失效注册，本次已尝试清理并重新注册。
        lines.push(
          "注意：Codex 插件状态此前无法读取（多半存在指向已消失目录的 marketplace）。",
          "本次已尝试清理并重新注册；若仍有异常，请检查 ~/.codex/config.toml 的 [marketplaces.*] 段。"
        );
      }
      process.stdout.write([
        ...lines,
        `Codex plugin installed: ${result.plugin}`,
        `marketplace source: ${result.packageRoot}`,
        `legacy standalone skill: ${result.legacyDisabled ? "disabled" : "not present"}`,
        "必须完全退出并重新打开 Codex Desktop，使运行中的 app-server 重新加载插件 hooks；只新建任务不等于重启。",
        "重启后请在 Codex 的 /hooks 页面确认一次 Atlas hook 信任。"
      ].join("\n") + "\n");
    }
    return;
  }

  if (command === "bootstrap") {
    // 一步补齐 Atlas 与 Trellis，无论哪边缺失。
    // 供 AI 在用户明确接入 Trellis 或要求任务跟踪时调用，
    // 使两个初始化顺序都能走通。
    const root = path.resolve(positional() || option("--root") || process.cwd());
    const result = bootstrapProject(root, {
      initProject,
      runCommand: (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8" }),
      platform: option("--platform") ?? "codex",
      user: option("--user")
    });
    if (result.atlas) {
      if (result.trellis && !result.steps.some((step) => step.ok === false)) result.sync = syncTrellis(result.root);
      refreshIndex(result.root, result);
    }
    if (!result.atlas || !result.trellis || result.steps.some((step) => step.ok === false)) process.exitCode = 1;
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const lines = [`Atlas bootstrap → ${result.root}`];
    for (const step of result.steps) {
      if (step.name === "trellis") {
        if (step.ok === false) lines.push(`Trellis：接入未完成（${step.stderr || step.reason}）`);
        else if (step.created) lines.push(`Trellis：已初始化（开发者 ${step.user}）`);
        else if (step.platformAdded) lines.push(`Trellis：已补接 ${option("--platform") ?? "codex"} 平台，保留已有身份与任务`);
        else if (step.present) lines.push("Trellis：已存在，Codex 核心入口齐全，保持不变");
        else lines.push(`Trellis：未初始化${step.stderr || step.reason ? `（${step.stderr || step.reason}）` : ""}`);
      } else {
        if (step.created) lines.push(`Atlas：已初始化（${step.configPath}）`);
        else if (step.present) lines.push("Atlas：已存在，保持不变");
        else if (step.skipped) lines.push(`Atlas：未初始化（${step.reason}）`);
        else if (step.error) lines.push(`Atlas：初始化失败（${step.error}）`);
      }
    }
    if (result.sync) lines.push("", formatSyncReport(result.sync));
    lines.push(indexMessage(result));
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (command === "record") {
    const decisionFile = option("--decision-file");
    if (decisionFile) {
      if (option("--claim")) throw new Error("--decision-file 与 --claim 不能同时使用。");
      const target = resolveRoot(option("--root") ?? positional());
      const owner = option("--owner");
      if (!owner) throw new Error("结构化决策需要 --owner 指定已核对的真源。");
      const relativeOwner = path.relative(target, path.resolve(target, owner)).split(path.sep).join("/");
      const source = knowledgeSources(target).find((item) => item.path === relativeOwner);
      if (!source || ["task-intent", "task-evidence", "task-design"].includes(source.role)) {
        throw new Error("决策 owner 必须是配置纳入索引的维护中文档，不能是任务工件。");
      }
      const input = JSON.parse(decisionFile === "-" ? await readStdin() : fs.readFileSync(decisionFile, "utf8"));
      const result = recordDecision(target, input, { owner, expect: option("--expect"),
        supersede: option("--supersede"), dryRun: process.argv.includes("--dry-run") });
      if (result.reason === "decision-conflict") process.exitCode = 1;
      if (!process.argv.includes("--dry-run") && result.reason !== "decision-conflict") {
        refreshIndex(target, result);
      }
      if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write([
        result.reason === "decision-conflict" ? `同一 topic 已有现行决定，未写入 ${result.owner}；核对理由和证据后才能取代。` :
        result.reason === "dry-run" ? `预览 ${result.action} → ${result.owner}，未写入` :
          result.recorded ? `已归并决策 ${result.id} → ${result.owner}` : `相同决策已存在：${result.id}`,
        `status: ${result.status}; fingerprint: ${result.fingerprint}`,
        result.preview,
        ...(result.reviewCandidates ?? []).map((item) =>
          `核对 ${item.id} (${item.status}; lines ${item.line}-${item.endLine}; fingerprint ${item.fingerprint})\n` +
          `  结论：${item.claim}\n  理由：${item.reason}\n  依据：${item.evidence ?? "未提供"}`),
        indexMessage(result)
      ].filter(Boolean).join("\n") + "\n");
      return;
    }
    const claim = option("--claim");
    if (!claim) throw new Error("record 需要 --claim TEXT");

    // 记录知识不隐式创建任务系统；在子目录运行时复用已有 Atlas 项目根。
    if (process.argv.includes("--dry-run")) throw new Error("普通 --claim 不支持 --dry-run；结构化决策才支持预览。");
    const target = path.resolve(option("--root") ?? positional() ?? findProjectRoot(process.cwd()) ?? process.cwd());
    const atlas = ensureAtlas(target, { initProject });
    if (!atlas.created && !atlas.present) throw new Error(atlas.error || atlas.reason);
    const boot = { root: target, atlas: true, trellis: hasTrellis(target), steps: [{ name: "atlas", ...atlas }] };
    if (atlas.created && boot.trellis) boot.sync = syncTrellis(target);
    const bootLines = atlas.created ? [`已初始化 Atlas：${atlas.configPath}`] : [];
    const result = recordClaim(target, claim, {
      owner: option("--owner"),
      date: option("--date"),
      title: option("--title")
    });
    refreshIndex(target, result);
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ bootstrap: boot, ...result }, null, 2)}\n`);
    else process.stdout.write(`${[...bootLines, formatRecordResult(result), indexMessage(result)].filter(Boolean).join("\n")}\n`);
    return;
  }

  if (command === "sync") {
    const root = path.resolve(positional() || option("--root") || process.cwd());
    const dryRun = process.argv.includes("--dry-run");
    const result = syncTrellis(root, { apply: !dryRun });
    if (!dryRun && hasAtlas(root)) refreshIndex(root, result);
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatSyncReport(result, { applied: !dryRun })}\n`);
      if (result.indexed !== undefined) process.stdout.write(`${indexMessage(result)}\n`);
      if (dryRun) process.stdout.write("\n(dry-run：未写入任何改动)\n");
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
    const knowledgeIssues = index.documents.flatMap((document) =>
      (document.knowledgeIssues ?? []).map((issue) => ({ path: document.path, ...issue })));
    process.stdout.write(JSON.stringify({ root, cachePath, ...index.stats, scannedAt: index.scannedAt, knowledgeIssues }, null, 2) + "\n");
    if (knowledgeIssues.length) process.exitCode = 1;
    return;
  }

  if (command === "context") {
    const root = resolveRoot(option("--root"));
    const prompt = option("--prompt") ?? "";
    if (!prompt) throw new Error("context 需要 --prompt TEXT");
    const refresh = process.argv.includes("--refresh");
    // 默认走混合检索（词法 + 嵌入语义）；未配嵌入凭据或调用失败时自动降级为词法。
    // --lexical 强制纯词法，用于离线环境或需要与历史结果对照时。
    const forceLexical = process.argv.includes("--lexical");
    const decisionIntent = option("--intent") ?? "all";
    const context = forceLexical
      ? queryContext({ projectRoot: root, prompt, forceRefresh: refresh, cacheOnly: !refresh, decisionIntent })
      : await queryContextWithEmbedding({ projectRoot: root, prompt, forceRefresh: refresh, decisionIntent });
    process.stdout.write(
      process.argv.includes("--json") ? `${JSON.stringify(context, null, 2)}\n` : `${formatContext(context)}\n`
    );
    return;
  }

  if (command === "route") {
    const root = resolveRoot(option("--root"));
    const prompt = option("--prompt") ?? "";
    if (!prompt) throw new Error("route 需要 --prompt TEXT");
    const existingFocus = currentSessionFocus({ projectRoot: root });
    const result = updateSessionRoute({
      projectRoot: root,
      prompt,
      decisionIntent: option("--intent") ?? "all",
      forceRefresh: process.argv.includes("--refresh"),
      expandExclusive: Boolean(existingFocus)
    });
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.context) {
      process.stdout.write(`${formatContext(result.context)}\n`);
    } else {
      process.stdout.write("[Atlas route] no-match；保持当前活动分支，不覆盖已有知识节点。\n");
    }
    return;
  }

  if (command === "focus") {
    const root = resolveRoot(option("--root"));
    const context = currentSessionFocus({ projectRoot: root });
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    } else if (context) {
      process.stdout.write(`${formatContext(context)}\n`);
    }
    return;
  }

  if (command === "doctor") {
    const root = resolveRoot(positional());
    const platform = option("--platform");
    if (platform && platform !== "codex") throw new Error("doctor --platform 目前只支持 codex。");
    const result = diagnose(root);
    if (platform) result.trellisPlatform = inspectTrellisPlatform(root, platform);
    const claude = claudeHookStatus(root);
    const trellisState = readTrellisState(root);
    const trellisLine = !trellisState.present
      ? "未检测到 .trellis"
      : (trellisState.state ?? `读取失败：${trellisState.error ?? "未知原因"}`);
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ...result, claudeHook: claude, trellisState }, null, 2)}\n`);
    } else {
      process.stdout.write([
        `Atlas root: ${result.root}`,
        `config: ok (${result.sources} sources, ${result.routes} routes)`,
        `index: ${result.cachePresent ? `ok (${result.indexedDocuments} documents, ${result.lastScan})` : "missing; run atlas index"}`,
        ...result.knowledgeIssues.map((issue) => `决策校验：${issue.path}:${issue.line} ${issue.message}`),
        `Trellis: ${result.trellis ? `detected; spec adapters=${result.trellisSpecSources}; archiveExcluded=${result.archiveExcluded}` : "not detected"}`,
        `Trellis 状态: ${trellisLine}`,
        ...(result.trellisPlatform ? [
          `Trellis Codex 核心入口: ${result.trellisPlatform.ready ? "齐全（加载与信任需在 Codex 确认）" : "不完整"}`,
          ...result.trellisPlatform.missing.map((file) => `缺失：${file}`),
          ...result.trellisPlatform.issues
        ] : []),
        `Claude Code 钩子: ${claude.registered ? "已注册" : `未注册；运行 atlas install --claude ${root}`}`,
        `project hook: ${result.projectHook ?? "none"}`,
        result.hookContract
      ].join("\n") + "\n");
    }
    if (result.knowledgeIssues.length || result.trellisPlatform?.ready === false) process.exitCode = 1;
    return;
  }

  if (command === "hook") {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const root = findProjectRoot(payload.cwd || process.cwd());
    if (!root || !payload.prompt) return;
    const additionalContext = await composeInjection({ root, prompt: payload.prompt, payload });
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
  process.stderr.write(`atlas: ${error.message}\n`);
  process.exitCode = 1;
});
