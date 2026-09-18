import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildIndex,
  cachePathFor,
  currentSessionFocus,
  diagnose,
  formatContext,
  queryContext,
  queryHookContext,
  resolveHookSessionKey,
  updateSessionRoute
} from "../plugins/atlas/lib/core.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(import.meta.dirname, "fixtures", "project");
const cli = path.join(repository, "plugins", "atlas", "bin", "atlas.mjs");

function projectCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-test-"));
  fs.cpSync(fixture, root, { recursive: true });
  return root;
}

function withCache(callback) {
  const old = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cache-"));
  try {
    return callback();
  } finally {
    if (old === undefined) delete process.env.ATLAS_CACHE_DIR;
    else process.env.ATLAS_CACHE_DIR = old;
  }
}

test("incremental indexing reuses unchanged documents and excludes Trellis archive", () => withCache(() => {
  const root = projectCopy();
  const first = buildIndex(root).index;
  const second = buildIndex(root).index;

  assert.equal(first.stats.documents, 6);
  assert.equal(first.stats.readCount, 6);
  assert.equal(second.stats.readCount, 0);
  assert.equal(second.stats.reusedCount, 6);
  assert.equal(second.documents.some((document) => document.path.includes("/archive/")), false);
}));

test("explicit intent route returns canonical auth, topology, and OpenAPI in order", () => withCache(() => {
  const root = projectCopy();
  const context = queryContext({ projectRoot: root, prompt: "帮我测试 consumer 接口" });

  assert.deepEqual(context.matchedRoutes, ["consumer-api-test"]);
  assert.deepEqual(context.results.slice(0, 3).map((result) => result.path), [
    "docs/reference/consumer-auth-orders.md",
    "docs/reference/deployment-topology.md",
    "docs/openapi.yaml"
  ]);
  assert.equal(context.results[0].heading, "iOS 测试会话");
  assert.equal(context.results[0].role, "canonical-doc");
  assert.equal(context.results.length, 3);
  assert.equal(context.results[2].heading, "");
  const formatted = formatContext(context, { hook: true });
  assert.match(formatted, /Atlas hook 已在模型开始工作前完成路由/);
  // 契约:检索只做字面匹配,所以必须说明这条限制并允许一次聚焦搜索,
  // 而不是像旧版那样禁止 rg/find —— 词法层无法判断自己是否因为措辞不同而整体偏了。
  // 提示必须声明检索的能力边界，避免模型把候选当作确定答案。
  assert.match(formatted, /融合了人工配置的显式路由、语义相似度与词面匹配/);
  assert.match(formatted, /明显不符/);
  assert.match(formatted, /聚焦搜索/);
  assert.match(formatted, /不要探测插件缓存或 Atlas skill 的版本路径/);
  assert.match(formatted, /Trellis 适配/);
}));

test("canonical documentation ranks above Trellis task evidence for generic queries", () => withCache(() => {
  const root = projectCopy();
  const context = queryContext({ projectRoot: root, prompt: "consumer token" });
  const canonical = context.results.findIndex((result) => result.path === "docs/reference/consumer-auth-orders.md");
  const task = context.results.findIndex((result) => result.path === ".trellis/tasks/current/prd.md");
  assert.ok(canonical >= 0);
  assert.ok(task < 0 || canonical < task);
}));

test("maintained sources outrank repetitive Trellis task prose", () => withCache(() => {
  const root = projectCopy();
  fs.writeFileSync(
    path.join(root, ".trellis", "tasks", "current", "prd.md"),
    "# 测试环境订单接口同步\n\n测试环境订单接口同步测试接口同步。\n",
    "utf8"
  );
  const context = queryContext({
    projectRoot: root,
    prompt: "测试一下测试环境的订单接口同步",
    forceRefresh: true
  });
  const canonical = context.results.findIndex((result) => result.path === "docs/reference/consumer-auth-orders.md");
  const task = context.results.findIndex((result) => result.path === ".trellis/tasks/current/prd.md");
  assert.ok(canonical >= 0);
  assert.ok(task < 0 || canonical < task);
}));

test("hook restores active focus for arbitrary follow-up wording without rerouting", () => withCache(() => {
  const root = projectCopy();
  buildIndex(root);
  const payload = { session_id: "session-follow-up-test" };
  const first = queryHookContext({ projectRoot: root, prompt: "帮我测试 consumer 接口", payload, env: {} });
  const refusal = queryHookContext({ projectRoot: root, prompt: "这回先算了吧", payload, env: {} });
  const topicalRefusal = queryHookContext({ projectRoot: root, prompt: "consumer 这回也先别弄了", payload, env: {} });
  const acknowledgement = queryHookContext({ projectRoot: root, prompt: "照刚才说的继续", payload, env: {} });
  const differentTask = queryHookContext({ projectRoot: root, prompt: "implementation constraint", payload, env: {} });

  assert.deepEqual(first.matchedRoutes, ["consumer-api-test"]);
  assert.equal(first.routeState.mode, "created");
  for (const followUp of [refusal, topicalRefusal, acknowledgement, differentTask]) {
    assert.equal(followUp.routeState.mode, "focus");
    assert.equal(followUp.routeState.branchId, first.routeState.branchId);
    assert.deepEqual(followUp.results.map((result) => result.path), first.results.map((result) => result.path));
  }
}));

test("long sessions expand, branch, and reactivate routes without losing old nodes", () => withCache(() => {
  const root = projectCopy();
  buildIndex(root);
  const payload = { session_id: "long-session-route-graph" };
  const options = { projectRoot: root, payload, env: {} };

  const created = updateSessionRoute({ ...options, prompt: "帮我测试 consumer 接口" });
  const expanded = updateSessionRoute({
    ...options,
    prompt: "帮我测试 consumer 接口，并核对 consumer token 契约",
    expandExclusive: true
  });
  const branched = updateSessionRoute({ ...options, prompt: "implementation constraint" });
  const reactivated = updateSessionRoute({ ...options, prompt: "帮我测试 consumer 接口" });
  const focus = currentSessionFocus(options);

  assert.equal(created.status, "created");
  assert.equal(expanded.status, "expanded");
  assert.ok(expanded.context.results.length > 0);
  assert.equal(branched.status, "branched");
  assert.equal(branched.graph.branchCount, 2);
  assert.equal(reactivated.status, "reactivated");
  assert.equal(reactivated.graph.branchCount, 2);
  assert.equal(focus.routeState.branchId, created.context.routeState.branchId);
  assert.ok(focus.results.some((result) => result.path === "docs/reference/consumer-auth-orders.md"));
  assert.ok(reactivated.graph.branches.some((branch) => branch.nodeCount === 1));
}));

test("hook session identity accepts Codex thread environment without storing raw ids", () => {
  assert.equal(resolveHookSessionKey({}, {}), null);
  const key = resolveHookSessionKey({}, { CODEX_THREAD_ID: "thread-secret-value" });
  assert.match(key, /^[a-f0-9]{24}$/);
  assert.equal(key.includes("thread-secret-value"), false);
});

test("route and focus CLI commands share the Codex session graph", () => withCache(() => {
  const root = projectCopy();
  buildIndex(root);
  const env = { ...process.env, CODEX_SESSION_ID: "atlas-cli-route-session" };
  const routed = spawnSync(process.execPath, [
    cli, "route", "--root", root, "--prompt", "帮我测试 consumer 接口", "--json"
  ], { encoding: "utf8", env });
  assert.equal(routed.status, 0, routed.stderr);
  const routeResult = JSON.parse(routed.stdout);
  assert.equal(routeResult.status, "created");
  assert.equal(routeResult.graph.branchCount, 1);

  const focused = spawnSync(process.execPath, [cli, "focus", "--root", root, "--json"], {
    encoding: "utf8",
    env
  });
  assert.equal(focused.status, 0, focused.stderr);
  const focus = JSON.parse(focused.stdout);
  assert.equal(focus.routeState.mode, "focus");
  assert.equal(focus.routeState.branchId, routeResult.context.routeState.branchId);
}));

test("session graph migrates v1 state and persists neither raw prompt nor raw session id", () => withCache(() => {
  const root = projectCopy();
  buildIndex(root);
  const rawSession = "raw-session-id-must-not-persist";
  const sessionKey = resolveHookSessionKey({ session_id: rawSession }, {});
  const sessionFile = path.join(path.dirname(cachePathFor(root)), "sessions", `${sessionKey}.json`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({
    version: 1,
    root,
    signature: "legacy-signature",
    updatedAt: "2026-08-21T00:00:00.000Z",
    route: {
      matchedRoutes: ["consumer-api-test"],
      results: [{
        path: "docs/reference/consumer-auth-orders.md",
        heading: "iOS 测试会话",
        line: 7,
        endLine: 11
      }]
    }
  }), "utf8");

  const focus = currentSessionFocus({ projectRoot: root, payload: { session_id: rawSession }, env: {} });
  assert.equal(focus.routeState.mode, "focus");
  assert.equal(focus.results[0].path, "docs/reference/consumer-auth-orders.md");

  const rawPrompt = "consumer token secret-looking-prompt-marker";
  updateSessionRoute({ projectRoot: root, prompt: rawPrompt, payload: { session_id: rawSession }, env: {} });
  const persisted = fs.readFileSync(sessionFile, "utf8");
  assert.doesNotMatch(persisted, /raw-session-id-must-not-persist/);
  assert.doesNotMatch(persisted, /secret-looking-prompt-marker/);
  assert.match(persisted, /"version": 2/);
}));

test("hook is silent without opt-in and emits valid bounded context with config", () => withCache(() => {
  const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-empty-"));
  const silent = spawnSync(process.execPath, [cli, "hook"], {
    input: JSON.stringify({ cwd: noConfig, prompt: "consumer api" }),
    encoding: "utf8",
    env: process.env
  });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, "");

  const root = projectCopy();
  const hookEnv = { ...process.env, CODEX_SESSION_ID: "atlas-hook-test" };
  const routed = spawnSync(process.execPath, [cli, "hook"], {
    input: JSON.stringify({ cwd: root, prompt: "帮我测试 consumer 接口" }),
    encoding: "utf8",
    env: hookEnv
  });
  assert.equal(routed.status, 0, routed.stderr);
  const payload = JSON.parse(routed.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(payload.hookSpecificOutput.additionalContext, /consumer-auth-orders\.md/);
  assert.match(payload.hookSpecificOutput.additionalContext, /融合了人工配置的显式路由、语义相似度与词面匹配/);
  assert.ok(payload.hookSpecificOutput.additionalContext.length < 4000);

  const followUp = spawnSync(process.execPath, [cli, "hook"], {
    input: JSON.stringify({ cwd: root, prompt: "这回先算了吧" }),
    encoding: "utf8",
    env: hookEnv
  });
  assert.equal(followUp.status, 0, followUp.stderr);
  const followUpPayload = JSON.parse(followUp.stdout);
  assert.match(followUpPayload.hookSpecificOutput.additionalContext, /\[Atlas focus\]/);
  assert.match(followUpPayload.hookSpecificOutput.additionalContext, /不要因当前一句话重新检索/);
  assert.doesNotMatch(followUpPayload.hookSpecificOutput.additionalContext, /这回先算了吧/);
}));

test("doctor detects Trellis without treating its project hook as a dependency", () => withCache(() => {
  const root = projectCopy();
  const result = diagnose(root);
  assert.equal(result.trellis, true);
  assert.equal(result.archiveExcluded, true);
  assert.match(result.hookContract, /独立运行/);
}));

test("npm-bundled install command registers the bundled Codex plugin", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-codex-home-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-codex-bin-"));
  const log = path.join(fakeBin, "calls.log");
  const fakeCodex = path.join(fakeBin, "codex");
  fs.mkdirSync(path.join(codexHome, "skills", "atlas"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "skills", "atlas", "SKILL.md"), "---\nname: atlas\n---\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"test\"\n");
  fs.writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\\n' "$*" >> "$ATLAS_TEST_LOG"
case "$*" in
  "plugin list") printf '%s\\n' 'atlas@atlas  installed, enabled' ;;
  "plugin marketplace list") printf '%s\\n' 'atlas  /old/source' ;;
  "--version") printf '%s\\n' 'codex-cli test' ;;
esac
`, { mode: 0o755 });

  const installed = spawnSync(process.execPath, [cli, "install", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ATLAS_CODEX_BIN: fakeCodex,
      ATLAS_TEST_LOG: log,
      CODEX_HOME: codexHome
    }
  });
  assert.equal(installed.status, 0, installed.stderr);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.plugin, "atlas@atlas");
  assert.equal(result.packageRoot, repository);
  assert.equal(result.legacyDisabled, true);
  assert.equal(result.restartRequired, true);

  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, /plugin remove atlas@atlas/);
  assert.match(calls, /plugin marketplace remove atlas/);
  assert.match(calls, new RegExp(`plugin marketplace add ${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(calls, /plugin add atlas@atlas/);
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /enabled = false/);
});
