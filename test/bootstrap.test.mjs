import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bootstrapProject, ensureTrellis } from "../plugins/atlas/lib/bootstrap.mjs";

const CLI = path.resolve(import.meta.dirname, "../plugins/atlas/bin/atlas.mjs");

function setup(t, { marker = true, failTrellis = false, skipCodex = false, trellisVersion = "0.6.5" } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bootstrap-"));
  const root = path.join(base, "project"), bin = path.join(base, "bin");
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  if (marker) fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  const calls = path.join(base, "trellis-calls");
  fs.writeFileSync(path.join(bin, "trellis"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(trellisVersion)} + '\\n'); process.exit(0); }
if (${failTrellis}) { process.stderr.write('fixture init failure'); process.exit(1); }
fs.mkdirSync('.trellis/spec/backend', { recursive: true });
function missing(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}
missing('.trellis/spec/backend/index.md', '# Backend\\n\\n**Language**: All documentation should be written in **English**.\\n');
if (!${skipCodex} && process.argv.includes('--codex')) {
  for (const name of ['start', 'brainstorm', 'before-dev', 'check', 'update-spec', 'finish-work']) {
    missing('.agents/skills/trellis-' + name + '/SKILL.md', '---\\nname: trellis-' + name + '\\ndescription: Fixture workflow skill.\\n---\\n');
  }
  missing('.codex/config.toml', '# Existing platform config\\n');
  missing('.codex/hooks/inject-workflow-state.py', '# Fixture workflow hook\\n');
  missing('.codex/hooks.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 -X utf8 .codex/hooks/inject-workflow-state.py' }] }] } }));
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    ATLAS_CACHE_DIR: path.join(base, "cache"), ATLAS_HOME: path.join(base, "atlas-home"), ATLAS_EMBED_ENABLED: "0" };
  const run = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args],
    { cwd: root, env, encoding: "utf8", ...options });
  const json = (...args) => {
    const result = run([...args, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, base, env, calls, run, json };
}

for (const asJson of [false, true]) test(`bootstrap ${asJson ? "JSON" : "文本"} 完成同步和首次索引，重复调用不重建配置`, (t) => {
  const { root, run, json, calls } = setup(t);
  const args = ["bootstrap", ".", "--user", "fixture", ...(asJson ? ["--json"] : [])];
  const first = run(args);
  assert.equal(first.status, 0, first.stderr);
  if (asJson) {
    const result = JSON.parse(first.stdout);
    assert.equal(result.indexed, true);
    assert.equal(result.sync.trellisPresent, true);
  } else assert.match(first.stdout, /索引已刷新/);
  const config = fs.readFileSync(path.join(root, ".atlas/config.json"), "utf8");
  const spec = fs.readFileSync(path.join(root, ".trellis/spec/backend/index.md"), "utf8");
  assert.doesNotMatch(spec, /All documentation should be written/);
  assert.ok(fs.existsSync(path.join(root, ".atlas/hooks/trellis-active-only.py")));
  const hooksPath = path.join(root, ".codex/hooks.json");
  const hooks = fs.readFileSync(hooksPath, "utf8");
  assert.match(hooks, /atlas hook/);
  const diagnosis = json("doctor", ".");
  assert.equal(diagnosis.cachePresent, true);
  assert.ok(diagnosis.indexedDocuments > 0);
  assert.equal(run(args).status, 0);
  assert.equal(fs.readFileSync(path.join(root, ".atlas/config.json"), "utf8"), config);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), hooks);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
});

test("不安全根在外部命令、配置或记录写入之前拒绝", (t) => {
  const { root, base, run, env, calls } = setup(t, { marker: false });
  let invoked = false;
  assert.throws(() => bootstrapProject(root, { runCommand() { invoked = true; } }), /项目根/);
  assert.equal(ensureTrellis(root, { runCommand() { invoked = true; } }).skipped, true);
  assert.equal(invoked, false);
  for (const args of [["bootstrap", ".", "--json"], ["record", "--claim", "durable finding"]]) {
    assert.equal(run(args).status, 1);
    assert.deepEqual(fs.readdirSync(root), []);
  }
  fs.writeFileSync(path.join(root, "README.md"), "# Home marker\n");
  const alias = path.join(base, "home-alias");
  fs.symlinkSync(root, alias, "dir");
  assert.equal(run(["bootstrap", alias], { env: { ...env, HOME: root } }).status, 1);
  assert.deepEqual(fs.readdirSync(root), ["README.md"]);
  assert.equal(fs.existsSync(calls), false);
});

test("Trellis 初始化失败返回非零，Atlas 仍可单独建立索引", (t) => {
  const { run } = setup(t, { failTrellis: true });
  const result = run(["bootstrap", ".", "--json", "--user", "fixture"]);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.trellis, false);
  assert.equal(output.atlas, true);
  assert.equal(output.indexed, true);
  assert.match(output.steps[0].stderr, /fixture init failure/);
});

test("普通记录只补 Atlas，写入立即可检索，子目录复用同一配置", (t) => {
  const { root, json, calls, run } = setup(t);
  const args = ["record", "--claim", "Cobalt storage persists route graphs offline.", "--title", "Cobalt storage"];
  const result = json(...args);
  assert.equal(result.recorded, true);
  assert.equal(result.indexed, true);
  assert.equal(result.bootstrap.atlas, true);
  assert.equal(result.bootstrap.trellis, false);
  assert.equal(fs.existsSync(calls), false);
  assert.equal(fs.existsSync(path.join(root, ".trellis")), false);
  const query = json("context", "--prompt", "Cobalt storage", "--lexical");
  assert.ok(query.results.some((item) => item.path === result.owner));
  const nested = path.join(root, "src");
  fs.mkdirSync(nested);
  const repeat = run([...args, "--json"], { cwd: nested });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).recorded, false);
  assert.equal(fs.existsSync(path.join(nested, ".atlas")), false);
});

test("普通记录 dry-run 不被静默忽略，不产生初始化或文档", (t) => {
  const { root, run } = setup(t);
  assert.equal(run(["record", "--claim", "finding", "--dry-run"]).status, 1);
  assert.deepEqual(fs.readdirSync(root), ["README.md"]);
});

test("sync 刷新现有 Atlas 索引；dry-run 保持缓存和文档不变", (t) => {
  const { root, json } = setup(t);
  json("record", "--claim", "Cobalt storage persists route graphs offline.", "--title", "Cobalt storage");
  const cache = json("doctor", ".").cachePath;
  const before = fs.readFileSync(cache, "utf8");
  fs.writeFileSync(path.join(root, "docs", "quartz.md"), "# Quartz transport\n\nQuartz transport retries transient failures.\n");
  const preview = json("sync", ".", "--dry-run");
  assert.equal(preview.indexed, undefined);
  assert.equal(fs.readFileSync(cache, "utf8"), before);
  const result = json("sync", ".");
  assert.equal(result.indexed, true);
  assert.ok(json("context", "--prompt", "Quartz transport", "--lexical").results.some((item) => item.path === "docs/quartz.md"));
});

test("生成凭据排除规则时保留已有 gitignore 内容", (t) => {
  const { root, run } = setup(t);
  fs.mkdirSync(path.join(root, ".atlas"));
  fs.writeFileSync(path.join(root, ".atlas", ".gitignore"), "custom-cache/");
  assert.equal(run(["init", "."]).status, 0);
  const ignore = fs.readFileSync(path.join(root, ".atlas/.gitignore"), "utf8");
  assert.match(ignore, /^custom-cache\/\n/m);
  assert.match(ignore, /^\.env\.local$/m);
});

test("已有 Trellis 和原生 Codex 目录仍补装技能，保留开发者、任务、规范与用户配置", (t) => {
  const { root, json, calls } = setup(t);
  const originals = {
    ".trellis/.developer": "original-developer\n",
    ".trellis/tasks/active/task.json": '{"status":"in_progress"}\n',
    ".trellis/workflow.md": "# Custom workflow\n",
    ".trellis/spec/backend/index.md": "# Maintained constraints\n",
    ".codex/config.toml": '# User-owned settings\nmodel = "custom-model"\n'
  };
  for (const [name, body] of Object.entries(originals)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  const result = json("bootstrap", ".", "--platform", "codex", "--user", "should-not-replace");
  const step = result.steps.find((step) => step.name === "trellis");
  assert.equal(step.created, false);
  assert.equal(step.present, true);
  assert.equal(step.platformAdded, true);
  assert.equal(step.platform.ready, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, "utf8").trim()), ["init", "--codex", "-y"]);
  for (const [name, body] of Object.entries(originals)) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), body);
  assert.equal(json("doctor", ".", "--platform", "codex").trellisPlatform.ready, true);
  json("bootstrap", ".", "--platform", "codex");
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
});

for (const asJson of [false, true]) test(`CLI 返回成功但缺少 Codex 入口时 ${asJson ? "JSON" : "文本"} 模式报错且不 sync`, (t) => {
  const { root, run } = setup(t, { skipCodex: true });
  fs.mkdirSync(path.join(root, ".trellis"));
  fs.mkdirSync(path.join(root, ".codex"));
  const result = run(["bootstrap", ".", ...(asJson ? ["--json"] : [])]);
  assert.equal(result.status, 1);
  if (asJson) {
    const data = JSON.parse(result.stdout);
    assert.equal(data.steps[0].ok, false);
    assert.equal(data.steps[0].platform.ready, false);
    assert.ok(data.steps[0].platform.missing.includes(".agents/skills/trellis-brainstorm/SKILL.md"));
    assert.equal(data.sync, undefined);
  } else assert.match(result.stdout, /接入未完成/);
  assert.equal(fs.existsSync(path.join(root, ".codex/hooks.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".atlas/hooks")), false);
  const doctor = run(["doctor", ".", "--platform", "codex", "--json"]);
  assert.equal(doctor.status, 1);
  assert.equal(JSON.parse(doctor.stdout).trellisPlatform.ready, false);
});

test("无关或无效 hooks 配置不冒充 Trellis 已接入，也不覆盖用户文件", (t) => {
  const { root, json, run } = setup(t);
  json("bootstrap", ".");
  const hookPath = path.join(root, ".codex/hooks.json");
  for (const content of ["{invalid", JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "atlas hook" }] }] } })]) {
    fs.writeFileSync(hookPath, content);
    const result = run(["bootstrap", ".", "--json"]);
    assert.equal(result.status, 1);
    const probe = JSON.parse(result.stdout).steps[0].platform;
    assert.equal(probe.ready, false);
    assert.equal(probe.issues.length, 1);
    assert.equal(fs.readFileSync(hookPath, "utf8"), content);
  }
});

test("已存在的 Atlas Trellis 代理仍可作为工作流 hook，检查不触发重装", (t) => {
  const { root, json, calls } = setup(t);
  json("bootstrap", ".");
  fs.writeFileSync(path.join(root, ".codex/hooks.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: 'python3 -X utf8 "./.atlas/hooks/trellis-active-only.py"' }] }]
  } }));
  const before = fs.readFileSync(calls, "utf8");
  assert.equal(json("doctor", ".", "--platform", "codex").trellisPlatform.ready, true);
  json("bootstrap", ".");
  assert.equal(fs.readFileSync(calls, "utf8"), before);
});

test("补装前拦截跨版本模板，CLI 与项目同版本时才添加 Codex 平台", (t) => {
  const { root, run, calls } = setup(t, { trellisVersion: "0.6.17" });
  fs.mkdirSync(path.join(root, ".trellis"));
  const versionFile = path.join(root, ".trellis/.version");
  fs.writeFileSync(versionFile, "0.6.5\n");
  const result = run(["bootstrap", ".", "--json"]);
  assert.equal(result.status, 1);
  const data = JSON.parse(result.stdout);
  assert.equal(data.steps[0].reason, "trellis-version-mismatch");
  assert.equal(data.steps[0].projectVersion, "0.6.5");
  assert.equal(data.steps[0].cliVersion, "0.6.17");
  assert.equal(data.sync, undefined);
  assert.equal(fs.existsSync(path.join(root, ".agents")), false);
  assert.equal(fs.readFileSync(versionFile, "utf8"), "0.6.5\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, "utf8").trim()), ["--version"]);
  fs.writeFileSync(versionFile, "0.6.17\n");
  const repaired = run(["bootstrap", ".", "--json"]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).steps[0].platform.ready, true);
});

test("已登记平台丢失技能且官方 init 跳过时返回具体缺项", (t) => {
  const { root, json } = setup(t);
  json("bootstrap", ".");
  const missing = ".agents/skills/trellis-brainstorm/SKILL.md";
  fs.unlinkSync(path.join(root, missing));
  const invocations = [];
  const result = ensureTrellis(root, { runCommand(command, args) {
    invocations.push({ command, args });
    return { status: 0, stdout: "Already configured, skipping", stderr: "" };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.deepEqual(result.platform.missing, [missing]);
  assert.match(result.stderr, /trellis update --dry-run/);
  assert.deepEqual(invocations, [{ command: "trellis", args: ["init", "--codex", "-y"] }]);
});
