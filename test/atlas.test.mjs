import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildIndex,
  diagnose,
  formatContext,
  queryContext
} from "../plugins/atlas/lib/core.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(import.meta.dirname, "fixtures", "project");
const cli = path.join(repository, "plugins", "atlas", "bin", "atlas-router.mjs");

function projectCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-router-test-"));
  fs.cpSync(fixture, root, { recursive: true });
  return root;
}

function withCache(callback) {
  const old = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-router-cache-"));
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
  assert.match(formatContext(context), /Trellis 适配/);
}));

test("canonical documentation ranks above Trellis task evidence for generic queries", () => withCache(() => {
  const root = projectCopy();
  const context = queryContext({ projectRoot: root, prompt: "consumer token" });
  const canonical = context.results.findIndex((result) => result.path === "docs/reference/consumer-auth-orders.md");
  const task = context.results.findIndex((result) => result.path === ".trellis/tasks/current/prd.md");
  assert.ok(canonical >= 0);
  assert.ok(task < 0 || canonical < task);
}));

test("hook is silent without opt-in and emits valid bounded context with config", () => withCache(() => {
  const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-router-empty-"));
  const silent = spawnSync(process.execPath, [cli, "hook"], {
    input: JSON.stringify({ cwd: noConfig, prompt: "consumer api" }),
    encoding: "utf8",
    env: process.env
  });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, "");

  const root = projectCopy();
  const routed = spawnSync(process.execPath, [cli, "hook"], {
    input: JSON.stringify({ cwd: root, prompt: "帮我测试 consumer 接口" }),
    encoding: "utf8",
    env: process.env
  });
  assert.equal(routed.status, 0, routed.stderr);
  const payload = JSON.parse(routed.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(payload.hookSpecificOutput.additionalContext, /consumer-auth-orders\.md/);
  assert.ok(payload.hookSpecificOutput.additionalContext.length < 4000);
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
  "plugin list") printf '%s\\n' 'atlas@atlas-router  installed, enabled' ;;
  "plugin marketplace list") printf '%s\\n' 'atlas-router  /old/source' ;;
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
  assert.equal(result.plugin, "atlas@atlas-router");
  assert.equal(result.packageRoot, repository);
  assert.equal(result.legacyDisabled, true);

  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, /plugin remove atlas@atlas-router/);
  assert.match(calls, /plugin marketplace remove atlas-router/);
  assert.match(calls, new RegExp(`plugin marketplace add ${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(calls, /plugin add atlas@atlas-router/);
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /enabled = false/);
});
