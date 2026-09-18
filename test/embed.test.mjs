import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveEmbeddingConfig,
  parseEnvFile,
  EMBEDDING_BUILTIN
} from "../plugins/atlas/lib/embed-config.mjs";
import { embeddingText, corpusFingerprint, cosine } from "../plugins/atlas/lib/embed.mjs";

// 本机存在 ~/.atlas/.env.local 时，用户级凭据会参与解析，干扰用例。
// 统一把用户级路径指向空目录，使测试结果不受开发机配置影响。
function isolatedEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-home-"));
  return { ATLAS_HOME: home, ...extra };
}

function makeProject(envContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-embed-"));
  if (envContent !== undefined) {
    fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
    fs.writeFileSync(path.join(root, ".atlas", ".env.local"), envContent, "utf8");
  }
  return root;
}

test(".env 解析支持注释、空行、引号与等号值", () => {
  const parsed = parseEnvFile(
    [
      "# 注释",
      "",
      "PLAIN=value",
      'QUOTED="带 空格"',
      "SINGLE='单引号'",
      "WITH_EQUALS=a=b=c",
      "  SPACED  =  trimmed  "
    ].join("\n")
  );
  assert.equal(parsed.get("PLAIN"), "value");
  assert.equal(parsed.get("QUOTED"), "带 空格");
  assert.equal(parsed.get("SINGLE"), "单引号");
  assert.equal(parsed.get("WITH_EQUALS"), "a=b=c");
  assert.equal(parsed.get("SPACED"), "trimmed");
});

test("无凭据时默认关闭嵌入并给出原因", () => {
  const root = makeProject();
  const config = resolveEmbeddingConfig({ projectRoot: root, env: isolatedEnv() });
  assert.equal(config.enabled, false);
  assert.match(config.reason, /未提供嵌入凭据/);
});

test("项目级 .env.local 提供凭据后启用", () => {
  const root = makeProject("EMBED_API_KEY=sk-test-key\n");
  const config = resolveEmbeddingConfig({ projectRoot: root, env: isolatedEnv() });
  assert.equal(config.enabled, true);
  assert.equal(config.apiKey, "sk-test-key");
  assert.equal(config.source, "project");
});

test("环境变量优先于项目文件", () => {
  const root = makeProject("EMBED_API_KEY=sk-from-file\n");
  const config = resolveEmbeddingConfig({
    projectRoot: root,
    env: isolatedEnv({ EMBED_API_KEY: "sk-from-env" })
  });
  assert.equal(config.apiKey, "sk-from-env");
  assert.equal(config.source, "env");
});

test("内置默认提供 provider 与模型", () => {
  const root = makeProject("EMBED_API_KEY=sk-test\n");
  const config = resolveEmbeddingConfig({ projectRoot: root, env: isolatedEnv() });
  assert.equal(config.endpoint, EMBEDDING_BUILTIN.endpoint);
  assert.equal(config.model, EMBEDDING_BUILTIN.model);
  assert.equal(config.dimensions, EMBEDDING_BUILTIN.dimensions);
});

test("项目配置可覆盖 provider 与模型", () => {
  const root = makeProject(
    ["EMBED_API_KEY=sk-test", "EMBED_ENDPOINT=https://example.com/v1/embeddings", "EMBED_MODEL=custom-model"].join(
      "\n"
    )
  );
  const config = resolveEmbeddingConfig({ projectRoot: root, env: isolatedEnv() });
  assert.equal(config.endpoint, "https://example.com/v1/embeddings");
  assert.equal(config.model, "custom-model");
});

test("显式关闭开关优先于凭据存在", () => {
  const root = makeProject("EMBED_API_KEY=sk-test\nATLAS_EMBED_ENABLED=false\n");
  const config = resolveEmbeddingConfig({ projectRoot: root, env: isolatedEnv() });
  assert.equal(config.enabled, false);
  assert.match(config.reason, /显式关闭/);
});

test("嵌入文本包含路径与标题但不含正文", () => {
  const document = {
    path: "docs/reference/orders.md",
    headings: [{ title: "订单接口" }, { title: "字段说明" }],
    bodyTerms: ["不应出现的内容"]
  };
  const text = embeddingText(document);
  assert.match(text, /orders\.md/);
  assert.match(text, /订单接口/);
  assert.doesNotMatch(text, /不应出现/);
});

test("语料指纹随命名变化而变化", () => {
  const a = [{ path: "a.md", headings: [{ title: "甲" }] }];
  const b = [{ path: "b.md", headings: [{ title: "甲" }] }];
  const c = [{ path: "a.md", headings: [{ title: "乙" }] }];
  assert.notEqual(corpusFingerprint(a), corpusFingerprint(b));
  assert.notEqual(corpusFingerprint(a), corpusFingerprint(c));
  assert.equal(corpusFingerprint(a), corpusFingerprint([...a]));
});

test("余弦相似度边界正确", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});

test("嵌入不可用时混合检索退回词法并标注模式", async () => {
  const { queryContextWithEmbedding } = await import("../plugins/atlas/lib/core.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-fallback-"));
  fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".atlas", "config.json"),
    JSON.stringify({
      version: 1,
      entrypoints: [],
      sources: [{ glob: "docs/**/*.md", role: "canonical-doc", authority: 90 }],
      exclude: [],
      routes: [],
      limits: { maxResults: 6, maxRelated: 2, maxContextChars: 6000, maxBodyTerms: 12000 }
    }),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# 甲\n\n- 内容甲。\n", "utf8");

  const result = await queryContextWithEmbedding({
    projectRoot: root,
    prompt: "内容甲",
    forceRefresh: true,
    env: isolatedEnv()
  });
  assert.equal(result.mode, "lexical");
  assert.equal(result.embedding.enabled, false);
  assert.ok(result.results.length > 0, "降级后仍应返回词法结果");
});

test("插件清单版本与 package.json 保持一致", () => {
  // 两处版本号分散维护，历史上出现过不同步（package 提版后插件仍报旧版本）。
  // 这里锁住一致性，提版时两处一起改。
  const root = path.resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(
    fs.readFileSync(path.join(root, "plugins", "atlas", ".codex-plugin", "plugin.json"), "utf8")
  );
  assert.equal(plugin.version, pkg.version, "plugin.json 的 version 应与 package.json 一致");
});
