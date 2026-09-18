import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { syncTrellis, classifySpecLine, formatSyncReport } from "../plugins/atlas/lib/sync.mjs";

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sync-"));
  fs.mkdirSync(path.join(root, ".trellis", "spec", "backend"), { recursive: true });
  fs.mkdirSync(path.join(root, ".trellis", "spec", "frontend"), { recursive: true });
  return root;
}

const ENGLISH_RULE = "**Language**: All documentation should be written in **English**.";

function writeIndex(root, layer, extra = []) {
  const body = [
    `# ${layer} Guidelines`,
    "",
    "| Guide | Description | Status |",
    "|-------|-------------|--------|",
    "| [Directory Structure](./directory-structure.md) | Module organization | To fill |",
    ...extra,
    "",
    ENGLISH_RULE
  ].join("\n");
  fs.writeFileSync(path.join(root, ".trellis", "spec", layer, "index.md"), `${body}\n`, "utf8");
}

test("语言规定按层替换为中文优先规则", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  writeIndex(root, "frontend");

  const result = syncTrellis(root);
  assert.equal(result.language.length, 2);

  const content = fs.readFileSync(path.join(root, ".trellis", "spec", "backend", "index.md"), "utf8");
  assert.match(content, /\*\*语言\*\*/);
  assert.doesNotMatch(content, /All documentation should be written in/);
});

test("语言替换保留项目自撰写的索引条目", () => {
  const root = makeProject();
  writeIndex(root, "backend", [
    "| [Icon Contract](./icon.md) | Three-level catalog and ZIP export | Implemented |"
  ]);

  syncTrellis(root);
  const content = fs.readFileSync(path.join(root, ".trellis", "spec", "backend", "index.md"), "utf8");
  assert.match(content, /Icon Contract/);
  assert.match(content, /ZIP export/);
});

test("sync 幂等：第二次执行不再报告语言改动", () => {
  const root = makeProject();
  writeIndex(root, "backend");

  const first = syncTrellis(root);
  assert.equal(first.language.length, 1);
  const second = syncTrellis(root);
  assert.equal(second.language.length, 0);
});

test("dry-run 不写入磁盘", () => {
  const root = makeProject();
  writeIndex(root, "backend");

  const result = syncTrellis(root, { apply: false });
  assert.equal(result.language.length, 1);
  const content = fs.readFileSync(path.join(root, ".trellis", "spec", "backend", "index.md"), "utf8");
  assert.match(content, /All documentation should be written in/);
});

test("无 .trellis 时不做任何修正", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sync-bare-"));
  const result = syncTrellis(root);
  assert.equal(result.trellisPresent, false);
  assert.equal(result.language.length, 0);
});

test("应用路由 /home/ 不被判为个人绝对路径", () => {
  const verdict = classifySpecLine("- App API: `GET /watchface/api/home/iosHomeList/v2` with required fields");
  assert.equal(verdict, null);
});

test("系统用户目录被判为事实", () => {
  const verdict = classifySpecLine("- JAVA_HOME=/Users/dev/Library/Java/JavaVirtualMachines/ms-17/Contents/Home");
  assert.equal(verdict?.kind, "fact");
  assert.ok(verdict.reasons.includes("个人绝对路径"));
});

test("祈使句被判为约束", () => {
  assert.equal(classifySpecLine("- Do not add `appId` to this dashboard API.")?.kind, "constraint");
  assert.equal(classifySpecLine("- 不得在 dashboard API 上新增 appId。")?.kind, "constraint");
});

test("同行兼有两类特征时不归类", () => {
  const verdict = classifySpecLine("- Do not hardcode /Users/dev/config as the default path.");
  assert.equal(verdict, null);
});

test("膨胀检测按行数、体积与场景数触发", () => {
  const root = makeProject();
  // 行数、体积、场景数三个判据都要真实超限，才能验证三者独立生效。
  const filler = Array.from(
    { length: 420 },
    (_, i) =>
      `- 条目 ${i}：这是一段用于撑起文件体积的中文说明文本，确保字节数稳定超过 48 KB 的膨胀阈值，避免边界抖动导致测试结果不稳定。`
  );
  const bloated = [
    "# Quality Guidelines",
    ...filler,
    "### Scenario: One",
    "### Scenario: Two",
    "### Scenario: Three",
    "### Scenario: Four",
    "### Scenario: Five"
  ].join("\n");
  fs.writeFileSync(path.join(root, ".trellis", "spec", "backend", "quality-guidelines.md"), bloated, "utf8");

  const result = syncTrellis(root);
  const report = result.specReports.find((item) => item.path.endsWith("quality-guidelines.md"));
  assert.ok(report);
  assert.equal(report.bloat.length, 3);
  assert.equal(report.scenarios.length, 5);
});

test("适配器安装到项目自有位置且不重复覆盖", () => {
  const root = makeProject();
  writeIndex(root, "backend");

  const first = syncTrellis(root);
  assert.equal(first.adapter.status, "installed");
  assert.ok(fs.existsSync(path.join(root, ".atlas", "hooks", "trellis-active-only.py")));

  const second = syncTrellis(root);
  assert.equal(second.adapter.status, "present");
});

test("报告包含语言、适配器与事实分布三段", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  fs.writeFileSync(
    path.join(root, ".trellis", "spec", "backend", "db.md"),
    "# DB\n- Never query auth tables directly.\n- Default host is 127.0.0.1:3306.\n",
    "utf8"
  );

  const report = formatSyncReport(syncTrellis(root, { apply: false }));
  assert.match(report, /## 语言规则/);
  assert.match(report, /## 注入适配器/);
  assert.match(report, /## 事实与约束分布/);
  assert.match(report, /网络端点/);
});

test("sync 自动注册 Claude 钩子，无需用户另跑命令", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  // 存在 .claude 目录即视为 Claude 平台项目。
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });

  const result = syncTrellis(root);
  const claude = result.hooks.find((hook) => hook.platform === "claude");
  assert.ok(claude, "应识别出 Claude 平台并注册钩子");
  assert.equal(claude.status, "installed");

  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  const registrations = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
  assert.ok(registrations.some((hook) => hook.command === "atlas hook"));
});

test("重复 sync 不重复注册钩子", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });

  syncTrellis(root);
  const second = syncTrellis(root);
  const claude = second.hooks.find((hook) => hook.platform === "claude");
  assert.equal(claude.status, "present");

  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1, "不应产生第二条注册");
});

test("注册钩子保留 settings.json 里的其它键", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(git *)"] }, env: { FOO: "bar" } }, null, 2),
    "utf8"
  );

  syncTrellis(root);
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(git *)"] });
  assert.deepEqual(settings.env, { FOO: "bar" });
  assert.ok(settings.hooks.UserPromptSubmit);
});

test("不碰 settings.local.json", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const local = path.join(root, ".claude", "settings.local.json");
  const before = JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2);
  fs.writeFileSync(local, before, "utf8");

  syncTrellis(root);
  assert.equal(fs.readFileSync(local, "utf8"), before, "个人本地配置不应被改动");
});

test("无 .claude 目录时不注册并说明", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  const result = syncTrellis(root);
  assert.deepEqual(result.hooks, []);
});

test("dry-run 不写钩子", () => {
  const root = makeProject();
  writeIndex(root, "backend");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });

  syncTrellis(root, { apply: false });
  assert.equal(fs.existsSync(path.join(root, ".claude", "settings.json")), false);
});
