import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DEFAULT_COMMAND,
  claudeHookStatus,
  installClaudeHook,
  uninstallClaudeHook
} from "../plugins/atlas/lib/claude-install.mjs";
import { composeInjection } from "../plugins/atlas/lib/inject.mjs";
import { parseCurrentTaskOutput, parseTaskStatus, readTrellisState, runCommand } from "../plugins/atlas/lib/trellis.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(import.meta.dirname, "fixtures", "project");
const cli = path.join(repository, "plugins", "atlas", "bin", "atlas.mjs");

function projectCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-inject-"));
  fs.cpSync(fixture, root, { recursive: true });
  return root;
}

function withCache(callback) {
  const old = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-inject-cache-"));
  try {
    return callback();
  } finally {
    if (old === undefined) delete process.env.ATLAS_CACHE_DIR;
    else process.env.ATLAS_CACHE_DIR = old;
  }
}

const runReturning = (stdout) => () => stdout;
const ACTIVE = "Current task: .trellis/tasks/current\nSource: session\n";

function hasPython() {
  return spawnSync("python3", ["--version"], { encoding: "utf8" }).error === undefined;
}

test("runCommand keeps stdout when the command exits non-zero", () => {
  // Trellis 用退出码 1 表示"没有活动任务" —— 那是正常结果,不是错误。
  // execFileSync 会因此抛错,把 no_task 静默降级成"读不到状态";这个 bug 只有端到端才暴露,
  // 所以这里用真实进程把它钉住(用 node 作被调命令,测试不依赖 python)。
  const output = runCommand(
    process.execPath,
    ["-e", "console.log('Current task: (none)'); console.log('Source: none'); process.exit(1)"],
    { cwd: os.tmpdir() }
  );
  const parsed = parseCurrentTaskOutput(output);
  assert.equal(parsed.active, false);
  assert.equal(parsed.source, "none");
});

test("readTrellisState works against a real python3 process", { skip: hasPython() ? false : "python3 unavailable" }, () => {
  const root = projectCopy();
  fs.writeFileSync(
    path.join(root, ".trellis", "scripts", "task.py"),
    "import sys\nprint('Current task: (none)')\nprint('Source: none')\nsys.exit(1)\n",
    "utf8"
  );
  const state = readTrellisState(root);
  assert.equal(state.present, true);
  assert.equal(state.state, "no_task");
});

test("parses the three shapes of task.py current --source", () => {
  assert.deepEqual(parseCurrentTaskOutput("Current task: (none)\nSource: none\n"), {
    active: false,
    taskPath: "",
    source: "none",
    stale: false
  });
  assert.deepEqual(parseCurrentTaskOutput(ACTIVE), {
    active: true,
    taskPath: ".trellis/tasks/current",
    source: "session",
    stale: false
  });
  assert.equal(parseCurrentTaskOutput(`${ACTIVE}State: stale\n`).stale, true);
});

test("parses task status defensively", () => {
  assert.equal(parseTaskStatus('{"status":"planning"}'), "planning");
  assert.equal(parseTaskStatus("not json"), null);
  assert.equal(parseTaskStatus('{"no":"status"}'), null);
});

test("readTrellisState maps Trellis state without requiring Python in tests", () => {
  const root = projectCopy();

  // 无 .trellis 时完全不进入 Trellis 分支
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bare-"));
  assert.equal(readTrellisState(bare).present, false);

  // 无活动任务 → no_task
  const idle = readTrellisState(root, {
    run: runReturning("Current task: (none)\nSource: none\n")
  });
  assert.equal(idle.state, "no_task");

  // 活动任务 + status=planning → planning（夹具 task.json 就是 planning）
  const planning = readTrellisState(root, { run: runReturning(ACTIVE) });
  assert.equal(planning.state, "planning");
  assert.equal(planning.status, "planning");

  // status 换成 in_progress → in_progress
  const taskJson = path.join(root, ".trellis", "tasks", "current", "task.json");
  fs.writeFileSync(taskJson, JSON.stringify({ status: "in_progress" }), "utf8");
  assert.equal(readTrellisState(root, { run: runReturning(ACTIVE) }).state, "in_progress");

  // task.py 抛错时只丢这一块，不应影响注入
  const broken = readTrellisState(root, {
    run: () => {
      throw new Error("python missing");
    }
  });
  assert.equal(broken.present, true);
  assert.equal(broken.state, null);
});

test("composeInjection puts Atlas's Chinese action list before the knowledge route", async () => {
  const root = projectCopy();
  const payload = { session_id: "inject-compose" };
  // 用户级凭据路径指向空目录，使测试不受开发机配置影响；
  // 无凭据时注入应退回词法，这正是本用例要覆盖的默认行为。
  const env = { ATLAS_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "atlas-inject-home-")) };

  const composed = await composeInjection({
    root,
    prompt: "帮我测试 consumer 接口",
    payload,
    run: runReturning(ACTIVE),
    env
  });

  assert.match(composed, /<atlas-actions state="planning">/);
  assert.match(composed, /- 1\.1 需求探索/);
  assert.match(composed, /<\/atlas-actions>/);
  assert.ok(
    composed.indexOf("<atlas-actions") < composed.indexOf("[Atlas route"),
    "动作清单应排在知识路由之前"
  );
  assert.match(composed, /consumer-auth-orders\.md/);

  // 无活动任务时动作清单退化为 no_task 那一行
  const idle = await composeInjection({
    root,
    prompt: "帮我测试 consumer 接口",
    payload,
    run: runReturning("Current task: (none)\nSource: none\n"),
    env
  });
  assert.match(idle, /<atlas-actions state="no_task">/);
  assert.match(idle, /- 1\.0 创建任务/);
});

test("claude hook registration is idempotent and preserves unrelated settings", () => {
  const root = projectCopy();
  const settings = path.join(root, ".claude", "settings.json");

  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: "keep-me", hooks: { Stop: [{ hooks: [] }] } }), "utf8");

  const first = installClaudeHook(root);
  assert.equal(first.changed, true);
  const written = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(written.model, "keep-me");
  assert.ok(written.hooks.Stop, "不相关的 hook 配置必须保留");
  assert.equal(
    written.hooks.UserPromptSubmit[0].hooks[0].command,
    DEFAULT_COMMAND
  );
  assert.equal(claudeHookStatus(root).registered, true);

  const second = installClaudeHook(root);
  assert.equal(second.changed, false, "重复安装不应追加第二条");
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.UserPromptSubmit.length, 1);

  assert.equal(uninstallClaudeHook(root).changed, true);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(after.hooks.UserPromptSubmit, undefined);
  assert.ok(after.hooks.Stop, "移除自己时不应连带删掉别人的 hook");
  assert.equal(after.model, "keep-me");
  assert.equal(claudeHookStatus(root).registered, false);
});

test("cli install --claude then hook emits the composed injection", () => withCache(() => {
  const root = projectCopy();

  const installed = spawnSync(process.execPath, [cli, "install", "--claude", root], {
    encoding: "utf8"
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /已注册 Claude Code 钩子/);

  const hook = spawnSync(process.execPath, [cli, "hook"], {
    input: JSON.stringify({ cwd: root, prompt: "帮我测试 consumer 接口", session_id: "cli-inject" }),
    encoding: "utf8"
  });
  assert.equal(hook.status, 0, hook.stderr);

  const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /<atlas-actions/);
  assert.match(context, /consumer-auth-orders\.md/);

  const doctor = spawnSync(process.execPath, [cli, "doctor", root], { encoding: "utf8" });
  assert.match(doctor.stdout, /Claude Code 钩子: 已注册/);
}));
