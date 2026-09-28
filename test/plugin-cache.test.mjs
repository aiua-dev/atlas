import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = path.resolve(import.meta.dirname, "..");
const pluginSource = path.join(repository, "plugins/atlas");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginSource, ".codex-plugin/plugin.json"), "utf8"));

function cachedPlugin(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-plugin-only-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plugin = path.join(base, "plugin cache/atlas/atlas", manifest.version);
  // Codex caches only the plugin directory, not the surrounding npm package.
  fs.cpSync(pluginSource, plugin, { recursive: true });
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const env = { ...process.env, PLUGIN_ROOT: plugin, ATLAS_CACHE_DIR: path.join(base, "cache"),
    CODEX_HOME: path.join(base, "codex"), CODEX_SESSION_ID: "plugin-cache-regression",
    ATLAS_HOME: path.join(base, "atlas-home"), ATLAS_EMBED_ENABLED: "0" };
  const run = (...args) => spawnSync(process.execPath, [path.join(plugin, "bin/atlas.mjs"), ...args], {
    cwd: root, env, encoding: "utf8", timeout: 10000
  });
  const hook = JSON.parse(fs.readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8"))
    .hooks.UserPromptSubmit[0].hooks[0];
  const submit = (input) => spawnSync(hook.command, {
    shell: true, cwd: root, env, input, encoding: "utf8", timeout: hook.timeout * 1000
  });
  return { base, plugin, root, run, submit };
}

test("standalone plugin version and skill use files inside the plugin boundary", (t) => {
  const { plugin, root, run } = cachedPlugin(t);
  const npmVersion = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version;
  assert.equal(manifest.version, npmVersion, "npm and plugin versions must agree");
  const version = run("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), npmVersion);
  const skill = path.join(plugin, "skills/atlas/SKILL.md");
  const located = run("skill", "--path");
  assert.equal(located.status, 0, located.stderr);
  assert.equal(located.stdout.trim(), skill);
  const loaded = run("skill");
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.ok(loaded.stdout.endsWith(fs.readFileSync(skill, "utf8")));
  assert.deepEqual(fs.readdirSync(root), []);
});

test("the registered plugin hook succeeds silently for a project without Atlas", (t) => {
  const { root, base, submit } = cachedPlugin(t);
  const result = submit(JSON.stringify({ cwd: root, hook_event_name: "UserPromptSubmit", prompt: "hello" }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(path.join(base, "cache")), false);
});

test("the registered cached hook injects routes and keeps genuine input errors visible", (t) => {
  const { root, run, submit } = cachedPlugin(t);
  fs.cpSync(path.join(import.meta.dirname, "fixtures/project"), root, { recursive: true });
  const indexed = run("index", root);
  assert.equal(indexed.status, 0, indexed.stderr);
  const result = submit(JSON.stringify({ cwd: root, hook_event_name: "UserPromptSubmit",
    session_id: "plugin-cache-regression", prompt: "帮我测试 consumer 接口" }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /consumer-auth-orders\.md/);
  assert.ok(output.additionalContext.length < 4000);
  const invalid = submit("{broken");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /atlas:/);
});
