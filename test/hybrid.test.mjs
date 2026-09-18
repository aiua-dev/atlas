import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildIndex, currentSessionFocus, queryContext, queryContextWithEmbedding,
  queryHookContextWithEmbedding, updateSessionRoute
} from "../plugins/atlas/lib/core.mjs";

function setup(t, { exclusive = false, routes = true, maxResults = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-hybrid-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-hybrid-cache-"));
  const oldCache = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = cache;
  t.after(() => {
    if (oldCache === undefined) delete process.env.ATLAS_CACHE_DIR;
    else process.env.ATLAS_CACHE_DIR = oldCache;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".atlas"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, ".atlas/config.json"), JSON.stringify({
    version: 1, entrypoints: [],
    sources: [{ glob: "docs/**/*.md", role: "canonical-doc", authority: 90 }],
    routes: routes ? [{ id: "ordered", exclusive, when: { allOfAny: [["route"]] },
      read: ["docs/a.md#Details", "docs/b.md"] }] : [],
    limits: { maxResults, maxRelated: 0, maxContextChars: 800 }
  }));
  fs.writeFileSync(path.join(root, "docs/a.md"), "# Alpha\n\n## Details\n\nunique_marker alpha contract\n");
  fs.writeFileSync(path.join(root, "docs/b.md"), "# Beta\n\nbeta contract\n");
  fs.writeFileSync(path.join(root, "docs/c.md"), "# Gamma\n\ngamma contract\n");
  buildIndex(root);
  const inputs = [];
  // Query vectors favor c > b > a, deliberately opposing the declared route.
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { input } = JSON.parse(options.body);
    inputs.push(input);
    return { ok: true, json: async () => ({ data: input.map((text, index) => ({
      index,
      embedding: text.startsWith("docs/a.md\n") ? [0, 1]
        : text.startsWith("docs/b.md\n") ? [0.6, 0.8] : [1, 0]
    })) }) };
  });
  const env = { ATLAS_HOME: root, ATLAS_EMBED_API_KEY: "fixture-only",
    ATLAS_EMBED_ENDPOINT: "https://fixture.invalid/embeddings" };
  return { root, inputs, options: { projectRoot: root, env } };
}

test("排他路由保持读取顺序、章节和集合，且无需请求嵌入", async (t) => {
  const { options, inputs } = setup(t, { exclusive: true });
  const request = { ...options, prompt: "route" };
  const lexical = queryContext(request);
  const hybrid = await queryContextWithEmbedding(request);
  const hook = await queryHookContextWithEmbedding({ ...request, payload: { session_id: "exclusive" } });
  assert.deepEqual(hybrid.results, lexical.results);
  assert.deepEqual(hook.results, lexical.results);
  assert.equal(inputs.length, 0);
});

test("非排他路由先读声明的章节，语义只补充剩余名额", async (t) => {
  const { options } = setup(t);
  const lexical = queryContext({ ...options, prompt: "route" });
  const hybrid = await queryContextWithEmbedding({ ...options, prompt: "route" });
  assert.equal(hybrid.mode, "hybrid");
  assert.deepEqual(hybrid.results.slice(0, 2), lexical.results);
  assert.equal(hybrid.results[2].path, "docs/c.md");
  assert.equal(hybrid.results.length, 3);
});

test("混合检索保留词法定位的具体章节并遵守结果数量", async (t) => {
  const { options } = setup(t, { routes: false, maxResults: 2 });
  const result = await queryContextWithEmbedding({ ...options, prompt: "unique_marker", lexicalWeight: 10 });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].path, "docs/a.md");
  assert.equal(result.results[0].heading, "Details");
  assert.equal(result.results[0].line, 3);
});

test("语义首轮与活动分支一致，控制回复只恢复分支且不再请求嵌入", async (t) => {
  const { options, inputs } = setup(t, { routes: false });
  const request = { ...options, payload: { session_id: "semantic" } };
  // No lexical match: the first route must be supplied and retained by semantics.
  const first = await queryHookContextWithEmbedding({ ...request, prompt: "unrelated wording" });
  assert.equal(first.mode, "hybrid");
  assert.equal(first.maxContextChars, 800);
  const focus = currentSessionFocus(request);
  assert.ok(focus, "实际注入的语义路由必须能在下一回合恢复");
  assert.deepEqual(focus.results, first.results);
  const count = inputs.length;
  for (const prompt of ["先算了", "继续", "另一个主题"]) {
    const followUp = await queryHookContextWithEmbedding({ ...request, prompt });
    assert.equal(followUp.routeState.mode, "focus");
    assert.deepEqual(followUp.results, first.results);
  }
  assert.equal(inputs.length, count, "恢复分支不应对最新一句话做语义查询");
});

test("词法首轮经语义补充后，focus 恢复实际交给模型的同一组节点", async (t) => {
  const { options } = setup(t, { routes: false });
  const request = { ...options, payload: { session_id: "lexical" } };
  const first = await queryHookContextWithEmbedding({ ...request, prompt: "alpha contract" });
  assert.equal(first.results[0].path, "docs/c.md");
  assert.deepEqual(currentSessionFocus(request).results, first.results);
});

test("嵌入服务失败时完整保留词法结果", async (t) => {
  const { options } = setup(t, { routes: false });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const request = { ...options, prompt: "alpha contract" };
  const expected = queryContext(request);
  const actual = await queryContextWithEmbedding(request);
  assert.equal(actual.mode, "lexical");
  assert.deepEqual(actual.results, expected.results);
});

test("空缓存的 hook 不扫描知识文件，也不因 base 为空而抛错", async (t) => {
  const { options, root } = setup(t, { routes: false });
  const built = buildIndex(root);
  fs.rmSync(built.cachePath);
  const context = await queryHookContextWithEmbedding({ ...options, prompt: "alpha contract" });
  assert.ok(context === null || context.results.length === 0);
  assert.equal(fs.existsSync(built.cachePath), false);
});

test("嵌入等待期间的显式切换不被迟到的首轮结果覆盖", async (t) => {
  const { options } = setup(t, { routes: false });
  const request = { ...options, payload: { session_id: "concurrent-route" } };
  const fetch = globalThis.fetch;
  let switched;
  t.mock.method(globalThis, "fetch", async (url, args) => {
    if (JSON.parse(args.body).input[0] === "unrelated wording") {
      switched = updateSessionRoute({ ...request, prompt: "beta contract" }).context;
    }
    return fetch(url, args);
  });
  const delivered = await queryHookContextWithEmbedding({ ...request, prompt: "unrelated wording" });
  assert.ok(switched);
  assert.deepEqual(delivered.results, switched.results);
  assert.deepEqual(currentSessionFocus(request).results, switched.results);
});
