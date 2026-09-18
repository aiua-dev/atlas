import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bootstrapProject, ensureTrellis } from "../plugins/atlas/lib/bootstrap.mjs";

const CLI = path.resolve(import.meta.dirname, "../plugins/atlas/bin/atlas.mjs");

function setup(t, { marker = true, failTrellis = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bootstrap-"));
  const root = path.join(base, "project"), bin = path.join(base, "bin");
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  if (marker) fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  const calls = path.join(base, "trellis-calls");
  fs.writeFileSync(path.join(bin, "trellis"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${failTrellis}) { process.stderr.write('fixture init failure'); process.exit(1); }
fs.mkdirSync('.trellis/spec/backend', { recursive: true });
fs.mkdirSync('.codex', { recursive: true });
fs.writeFileSync('.trellis/spec/backend/index.md', '# Backend\\n\\n**Language**: All documentation should be written in **English**.\\n');
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
