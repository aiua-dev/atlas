import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = path.resolve(import.meta.dirname, "..");
const cli = path.join(repository, "plugins/atlas/bin/atlas.mjs");

function workspace(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-entry-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const env = { ...process.env, ATLAS_CACHE_DIR: path.join(base, "cache"), CODEX_HOME: path.join(base, "codex") };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
  return { base, root, env, run };
}

test("skill loads from a relocated package through a CLI symlink, without a Codex cache or project config", (t) => {
  const { base, root, env } = workspace(t);
  const pkg = path.join(base, "node_modules/@aiua/atlas");
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(path.join(repository, "package.json"), path.join(pkg, "package.json"));
  fs.cpSync(path.join(repository, "plugins"), path.join(pkg, "plugins"), { recursive: true });
  const bin = path.join(base, "atlas");
  fs.symlinkSync(path.join(pkg, "plugins/atlas/bin/atlas.mjs"), bin);
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8" });
  const resolved = run("skill", "--path");
  assert.equal(resolved.status, 0, resolved.stderr);
  const skill = fs.realpathSync(path.join(pkg, "plugins/atlas/skills/atlas/SKILL.md"));
  assert.equal(resolved.stdout.trim(), skill);
  const loaded = run("skill");
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.ok(loaded.stdout.includes(skill));
  assert.ok(loaded.stdout.endsWith(fs.readFileSync(skill, "utf8")));
  assert.ok(fs.existsSync(path.join(path.dirname(skill), "references/operating-model.md")));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(env.CODEX_HOME), false);
  assert.equal(fs.existsSync(env.ATLAS_CACHE_DIR), false);

  // A genuinely incomplete package must still fail, rather than report success.
  fs.unlinkSync(skill);
  assert.notEqual(run("skill").status, 0);
  assert.notEqual(run("skill", "--path").status, 0);
});

test("optional context distinguishes an unconfigured project without initializing or caching", (t) => {
  const { root, env, run } = workspace(t);
  for (const options of [[], ["--root", root], ["--root", root, "--refresh"]]) {
    const result = run("context", "--optional", "--prompt", "widget rendering", "--json", ...options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { root, status: "not-configured", results: [] });
  }
  const text = run("context", "--optional", "--prompt", "widget rendering");
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.trim());
  assert.equal(text.stderr, "");
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(env.ATLAS_CACHE_DIR), false);
  assert.equal(fs.existsSync(env.CODEX_HOME), false);

  for (const options of [[], ["--root", root]]) {
    const strict = run("context", "--prompt", "widget rendering", ...options);
    assert.notEqual(strict.status, 0);
    assert.equal(strict.stdout, "");
    assert.match(strict.stderr, /config\.json/);
  }
});

test("optional context does not suppress invalid input, bad paths, or broken configuration", (t) => {
  const { root, run } = workspace(t);
  const reject = (args) => {
    const result = run("context", "--optional", "--json", ...args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.trim());
  };
  reject([]);
  reject(["--prompt", "widget", "--intent", "typo"]);
  reject(["--prompt", "widget", "--root", path.join(root, "missing")]);
  const file = path.join(root, "file");
  fs.writeFileSync(file, "not a directory");
  reject(["--prompt", "widget", "--root", file]);
  fs.mkdirSync(path.join(root, ".atlas"));
  const config = path.join(root, ".atlas/config.json");
  for (const content of ["{broken", '{"version": 999}']) {
    fs.writeFileSync(config, content);
    reject(["--prompt", "widget", "--root", root]);
    reject(["--prompt", "widget"]);
  }
  fs.unlinkSync(config);
  fs.symlinkSync(path.join(root, "missing-config.json"), config);
  reject(["--prompt", "widget", "--root", root]);
});

test("optional context preserves configured routes, including parent lookup and decision intent", (t) => {
  const { root, env, run } = workspace(t);
  fs.cpSync(path.join(import.meta.dirname, "fixtures/project"), root, { recursive: true });
  const indexed = run("index", root);
  assert.equal(indexed.status, 0, indexed.stderr);
  const child = path.join(root, "src/nested");
  fs.mkdirSync(child, { recursive: true });
  for (const intent of ["all", "current", "history"]) {
    const args = ["context", "--prompt", "帮我测试 consumer 接口", "--lexical", "--intent", intent, "--json"];
    const strict = run(...args, "--root", root);
    const optional = spawnSync(process.execPath, [cli, ...args, "--optional"], {
      cwd: child, env, encoding: "utf8"
    });
    assert.equal(strict.status, 0, strict.stderr);
    assert.equal(optional.status, 0, optional.stderr);
    assert.deepEqual(JSON.parse(optional.stdout), JSON.parse(strict.stdout));
    assert.ok(JSON.parse(optional.stdout).results.length > 0);
  }
});
