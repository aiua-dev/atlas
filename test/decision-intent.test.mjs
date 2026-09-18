import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { recordDecision, parseDecisions, renderDecision } from "../plugins/atlas/lib/decisions.mjs";
import { buildIndex, cachePathFor, diagnose, queryContext, queryContextWithEmbedding,
  queryHookContextWithEmbedding, updateSessionRoute, currentSessionFocus, formatContext
} from "../plugins/atlas/lib/core.mjs";

const CLI = path.resolve(import.meta.dirname, "../plugins/atlas/bin/atlas.mjs");
const old = { id: "local-v1", topic: "routing.storage", title: "Local routing storage",
  status: "accepted", claim: "Use the v1 local cache.", reason: "It works offline.", evidence: "The v1 regression passes." };
const next = { ...old, id: "local-v2", claim: "Use the v2 local cache.", evidence: "The v2 regression passes." };
const rejected = { ...old, id: "remote", title: "Remote routing storage", status: "rejected",
  claim: "Require a remote database.", reason: "It cannot work offline." };

function setup(t, { limit = 2, content = "# Architecture\n\nMaintained prose.\n", files = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-intent-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"));
  const owner = "docs/architecture.md", file = path.join(root, owner);
  fs.writeFileSync(file, content);
  fs.writeFileSync(path.join(root, ".atlas/config.json"), JSON.stringify({ version: 1, entrypoints: [],
    sources: [{ glob: "docs/**/*.md", role: "canonical-doc", authority: 90 }],
    limits: { maxResults: limit, maxRelated: 2 }, routes: [{ id: "explicit", exclusive: true,
      when: { allOfAny: [["explicit"]] }, read: [`${owner}#atlas-decision:remote`] }] }));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, "docs", name), body);
  const prior = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = path.join(base, "cache");
  t.after(() => {
    if (prior === undefined) delete process.env.ATLAS_CACHE_DIR; else process.env.ATLAS_CACHE_DIR = prior;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const write = (input, options = {}) => recordDecision(root, input, { owner, ...options });
  const cli = (input, ...args) => spawnSync(process.execPath, [CLI, "record", "--root", root,
    "--decision-file", "-", "--owner", owner, "--json", ...args], { input: JSON.stringify(input), encoding: "utf8", env: process.env });
  const query = (decisionIntent, prompt = "routing storage") => queryContext({ projectRoot: root, prompt, decisionIntent });
  const env = { ATLAS_HOME: root, ATLAS_EMBED_API_KEY: "fixture", ATLAS_EMBED_ENDPOINT: "https://fixture.invalid/embeddings" };
  return { root, owner, file, write, cli, query, env };
}

test("同主题冲突提供旧结论、理由、依据和指纹，不修改源或缓存", (t) => {
  const { root, file, cli } = setup(t);
  assert.equal(cli(old).status, 0);
  const before = fs.readFileSync(file, "utf8"), cache = fs.readFileSync(cachePathFor(root), "utf8");
  for (const args of [[], ["--dry-run"]]) {
    const result = cli(next, ...args), output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.reason, "decision-conflict");
    assert.equal(output.conflicts[0].claim, old.claim);
    assert.equal(output.conflicts[0].reason, old.reason);
    assert.equal(output.conflicts[0].evidence, old.evidence);
    assert.ok(output.conflicts[0].fingerprint);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.readFileSync(cachePathFor(root), "utf8"), cache);
  }
});

test("原子取代预览两个块，一次替换源文件，重试幂等并保留 CRLF 和拒绝理由", (t) => {
  const { file, write } = setup(t, { content: "# Architecture\r\n\r\nMaintained prose.\r\n" });
  write(rejected);
  const first = write(old);
  const before = fs.readFileSync(file, "utf8");
  const options = { supersede: old.id, expect: first.fingerprint };
  const preview = write(next, { ...options, dryRun: true });
  assert.equal(preview.action, "supersede");
  assert.match(preview.preview, /Status: superseded/);
  assert.match(preview.preview, /Status: accepted/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const rename = fs.renameSync;
  let replacedFiles = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    assert.equal(to, file);
    const pending = parseDecisions(fs.readFileSync(from, "utf8"));
    assert.deepEqual(pending.issues, []);
    assert.equal(pending.decisions.filter((item) => item.status === "accepted").length, 1);
    replacedFiles += 1;
    return rename(from, to);
  });
  assert.equal(write(next, options).action, "supersede");
  assert.equal(write(next, options).reason, "duplicate");
  assert.equal(replacedFiles, 1);
  const text = fs.readFileSync(file, "utf8"), records = parseDecisions(text).decisions;
  assert.equal(/(?<!\r)\n/.test(text), false);
  assert.equal(records.find((item) => item.id === old.id).reason, old.reason);
  assert.equal(records.find((item) => item.id === rejected.id).reason, rejected.reason);
  assert.equal(records.find((item) => item.id === old.id).supersededBy, next.id);
});

test("拒绝过期指纹、错误主题、非现行旧决定和重复使用旧 ID；失败不留下新块", (t) => {
  const { file, write } = setup(t);
  const first = write(old);
  const before = fs.readFileSync(file, "utf8");
  for (const [input, options] of [
    [next, { supersede: old.id, expect: "outdated" }],
    [{ ...next, topic: "different.scope" }, { supersede: old.id, expect: first.fingerprint }],
    [{ ...next, status: "proposed" }, { supersede: old.id, expect: first.fingerprint }],
    [{ ...old, claim: "Changed" }, { supersede: old.id, expect: first.fingerprint }],
    [{ ...old, topic: undefined }, { expect: first.fingerprint }]
  ]) {
    assert.throws(() => write(input, options));
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});

test("不同范围可共存；拒绝与提议是核对候选，不被错误当作互斥的现行决定", (t) => {
  const { write } = setup(t);
  write(old);
  write(rejected);
  assert.equal(write({ ...next, topic: "routing.production-storage" }).recorded, true);
  const preview = write({ ...next, id: "proposal", status: "proposed" }, { dryRun: true });
  assert.deepEqual(preview.reviewCandidates.map((item) => item.id), [old.id, rejected.id]);
  assert.equal(preview.reason, "dry-run");
});

test("现行与历史查询在同一文件选择不同决策，旧方案高词频不会污染现行候选", (t) => {
  const { write, query } = setup(t, { limit: 1 });
  write({ ...rejected, title: "routing storage ".repeat(20) });
  write(old);
  const current = query("current"), history = query("history");
  assert.equal(current.results[0].decisionId, old.id);
  assert.equal(history.results[0].decisionId, rejected.id);
  assert.equal(current.results.length, 1);
  assert.equal(history.results.length, 1);
  assert.notEqual(current.results[0].line, history.results[0].line);
  assert.equal(current.decisionIntent, "current");
});

test("先筛状态再截断，其他文件的历史噪声不能挤掉现行；无现行时明确未找到", (t) => {
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`noise-${i}.md`,
    `# routing storage\n${renderDecision({ ...rejected, id: `remote-${i}` })}\n`]));
  const { root, write, query } = setup(t, { limit: 1, files });
  assert.equal(query("current").results.length, 0);
  assert.match(formatContext(query("current")), /未找到.*不证明不存在/);
  write(old);
  buildIndex(root);
  assert.equal(query("current").results[0].decisionId, old.id);
});

test("新决策意图不猜旧正文状态；默认 all 保持原结果并拒绝无效模式", (t) => {
  const { root, query } = setup(t, { content: "# routing storage\n\nCurrent architecture is described here.\n" });
  assert.equal(query("current").results.length, 0);
  assert.equal(query("history").results.length, 0);
  assert.ok(query("all").results.length > 0);
  assert.deepEqual(query("all").results, queryContext({ projectRoot: root, prompt: "routing storage" }).results);
  assert.throws(() => query("latest"), /all、current 或 history/);
});

test("混合、仅语义和离线降级都不重新带回被拒方案；显式链保留并说明例外", async (t) => {
  const { root, write, env, query } = setup(t, { files: { "remote.md": `# Remote\n${renderDecision(rejected)}\n` } });
  write(old); write(rejected); buildIndex(root);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests += 1;
    return { ok: true, json: async () => ({ data: JSON.parse(options.body).input.map((text, index) =>
      ({ index, embedding: text.startsWith("docs/architecture.md") ? [0.8, 0.6] : [1, 0] })) }) };
  });
  for (const prompt of ["routing storage", "完全不同的中文措辞"]) {
    const result = await queryContextWithEmbedding({ projectRoot: root, env, prompt, decisionIntent: "current" });
    assert.equal(result.mode, "hybrid");
    assert.deepEqual(result.results.map((item) => item.decisionId), [old.id]);
  }
  const count = requests;
  const explicit = await queryContextWithEmbedding({ projectRoot: root, env, prompt: "explicit", decisionIntent: "current" });
  assert.equal(requests, count);
  assert.equal(explicit.results[0].decisionId, rejected.id);
  assert.match(formatContext(explicit), /显式读取链仍按配置保留/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const fallback = await queryContextWithEmbedding({ projectRoot: root, env, prompt: "routing storage", decisionIntent: "current" });
  assert.equal(fallback.mode, "lexical");
  assert.deepEqual(fallback.results, query("current").results);
});

test("同主题现行/历史形成不同分支；控制回复保持意图，回到现行可重新激活", async (t) => {
  const { root, write } = setup(t);
  write(old); write(rejected); buildIndex(root);
  const options = { projectRoot: root, prompt: "routing storage", payload: { session_id: "intent" } };
  const current = updateSessionRoute({ ...options, decisionIntent: "current" });
  const history = updateSessionRoute({ ...options, decisionIntent: "history" });
  assert.notEqual(history.context.routeState.branchId, current.context.routeState.branchId);
  assert.equal(history.context.decisionIntent, "history");
  t.mock.method(globalThis, "fetch", () => assert.fail("恢复不调用网络"));
  const focus = await queryHookContextWithEmbedding({ ...options, prompt: "现在继续" });
  assert.equal(focus.decisionIntent, "history");
  assert.equal(focus.results[0].decisionId, rejected.id);
  const back = updateSessionRoute({ ...options, decisionIntent: "current" });
  assert.equal(back.status, "reactivated");
  assert.equal(back.context.routeState.branchId, current.context.routeState.branchId);
});

test("CLI 原子取代后，现行会话跟随后继，历史查询找到旧理由", async (t) => {
  const { root, cli, query } = setup(t);
  const first = JSON.parse(cli(old).stdout);
  const options = { projectRoot: root, prompt: "routing storage", decisionIntent: "current", payload: { session_id: "replace" } };
  const before = updateSessionRoute(options);
  const result = cli(next, "--supersede", old.id, "--expect", first.fingerprint);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).indexed, true);
  const focus = currentSessionFocus(options);
  assert.equal(focus.results[0].decisionId, next.id);
  assert.equal(focus.routeState.branchId, before.context.routeState.branchId);
  assert.equal(focus.knowledgeChanged, true);
  assert.equal(query("history").results[0].decisionId, old.id);
  const command = spawnSync(process.execPath, [CLI, "context", "--root", root, "--prompt", "routing storage",
    "--intent", "current", "--lexical", "--json"], { encoding: "utf8", env: process.env });
  assert.equal(command.status, 0, command.stderr);
  assert.equal(JSON.parse(command.stdout).results[0].decisionId, next.id);
});

test("手工造成双现行时体检报告冲突，检索不替人挑赢家，显式归并后恢复", (t) => {
  const { root, file, write, query } = setup(t);
  fs.appendFileSync(file, `${renderDecision(old)}\n${renderDecision(next)}\n`);
  buildIndex(root);
  assert.match(diagnose(root).knowledgeIssues[0].message, /多个 accepted/);
  assert.equal(query("current").results.length, 0);
  assert.match(formatContext(query("all")), /校验失败/);
  const fingerprint = parseDecisions(fs.readFileSync(file, "utf8")).decisions[0].fingerprint;
  write({ ...old, status: "superseded", supersededBy: next.id }, { expect: fingerprint });
  buildIndex(root);
  assert.equal(query("current").results[0].decisionId, next.id);
});

test("文件级向量不能任意选中同文件内多个无词面证据的现行决定", async (t) => {
  const { root, write, env } = setup(t);
  write(old);
  write({ ...next, topic: "different.scope", title: "Another subject" });
  buildIndex(root);
  t.mock.method(globalThis, "fetch", () => assert.fail("没有可定位候选时无需网络"));
  const result = await queryContextWithEmbedding({ projectRoot: root, env,
    prompt: "毫无词面重合", decisionIntent: "current" });
  assert.deepEqual(result.results, []);
  assert.match(result.embedding.reason, /topic\/id/);
});
