import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDecisions, recordDecision, renderDecision } from "../plugins/atlas/lib/decisions.mjs";
import { recordClaim } from "../plugins/atlas/lib/record.mjs";
import { buildIndex, cachePathFor, currentSessionFocus, diagnose, formatContext,
  queryContext, queryContextWithEmbedding, queryHookContextWithEmbedding, updateSessionRoute
} from "../plugins/atlas/lib/core.mjs";

const CLI = path.resolve(import.meta.dirname, "../plugins/atlas/bin/atlas.mjs");
const rejected = { id: "remote-index", title: "Remote index for offline routing", status: "rejected",
  claim: "Use a mandatory remote database for the routing index.",
  reason: "A required network service would prevent offline lookup.",
  evidence: "The project requires deterministic offline fallback.", revisit: "If offline lookup stops being a requirement." };
const accepted = { id: "local-index", title: "Local index for offline routing", status: "accepted",
  claim: "Keep the routing index in a local cache.", reason: "Local reads remain available without a network.",
  evidence: "Offline retrieval regression passes." };

function setup(t, content = "# Architecture\n\nExisting maintained prose.\n") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-decisions-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
  fs.mkdirSync(path.join(root, "knowledge"));
  const owner = "knowledge/architecture.md";
  const file = path.join(root, owner);
  fs.writeFileSync(file, content);
  fs.writeFileSync(path.join(root, ".atlas/config.json"), JSON.stringify({ version: 1,
    entrypoints: [], sources: [{ glob: "knowledge/**/*.md", role: "canonical-doc", authority: 90 }],
    limits: { maxResults: 3, maxContextChars: 4000 }, routes: [{ id: "decision",
      exclusive: true, when: { allOfAny: [["explicit"]] }, read: [`${owner}#atlas-decision:remote-index`] }] }));
  const oldCache = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = path.join(base, "cache");
  t.after(() => {
    if (oldCache === undefined) delete process.env.ATLAS_CACHE_DIR;
    else process.env.ATLAS_CACHE_DIR = oldCache;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const write = (input, options = {}) => recordDecision(root, input, { owner, ...options });
  const cli = (input, ...options) => spawnSync(process.execPath, [CLI, "record", "--root", root,
    "--decision-file", "-", "--owner", owner, "--json", ...options], {
    encoding: "utf8", input: JSON.stringify(input), env: process.env
  });
  return { base, root, owner, file, write, cli };
}

test("决策拒绝空理由、缺少依据、未知状态和字段，不把模板当有效内容", (t) => {
  const { file, write } = setup(t);
  const before = fs.readFileSync(file, "utf8");
  for (const overrides of [{ reason: " " }, { evidence: "" }, { status: "implemented" },
    { id: "../escape" }, { reason: "line one\nline two" }, { evidence: "<!-- /atlas:decision -->" },
    { reasonn: "typo" }]) {
    assert.throws(() => write({ ...rejected, ...overrides }));
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("决策预览零写入，重复记录幂等，CRLF 与原有正文保持原样", (t) => {
  const content = "# Owner\r\n\r\nKeep this prose unchanged.\r\n";
  const { file, write } = setup(t, content);
  const preview = write(rejected, { dryRun: true });
  assert.equal(preview.reason, "dry-run");
  assert.match(preview.preview, /Rationale: A required network/);
  assert.equal(fs.readFileSync(file, "utf8"), content);
  const first = write(rejected);
  assert.equal(write(rejected).reason, "duplicate");
  const stored = fs.readFileSync(file, "utf8");
  assert.ok(stored.startsWith(content));
  assert.equal(/(?<!\r)\n/.test(stored), false);
  assert.equal(parseDecisions(stored).decisions[0].fingerprint, first.fingerprint);
});

test("更新同一 ID 需当前指纹，拒绝过期覆盖，并保留块外的新编辑", (t) => {
  const { file, write } = setup(t);
  const first = write({ ...rejected, status: "proposed" });
  assert.throws(() => write(rejected), /--expect/);
  fs.appendFileSync(file, "\nHuman edit outside the decision.\n");
  const second = write(rejected, { expect: first.fingerprint });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Human edit outside/);
  assert.equal(parseDecisions(text).decisions.length, 1);
  assert.equal(parseDecisions(text).decisions[0].status, "rejected");
  assert.throws(() => write({ ...rejected, reason: "Updated explanation." }, { expect: first.fingerprint }), /--expect/);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test("定案后保留原结论，只能用新 ID 取代；断链和循环均拒绝", (t) => {
  const { file, write } = setup(t);
  const old = write(accepted);
  assert.throws(() => write({ ...accepted, claim: "Use a remote service instead." }, { expect: old.fingerprint }), /新 id/);
  assert.throws(() => write({ ...accepted, status: "rejected" }, { expect: old.fingerprint }), /新建决策 id/);
  const successor = { ...accepted, id: "local-index-v2", title: "Local index v2", claim: "Use version two of the local cache." };
  assert.throws(() => write({ ...accepted, status: "superseded", supersededBy: successor.id }, { expect: old.fingerprint }), /取代链/);
  const next = write(successor);
  const changed = write({ ...accepted, status: "superseded", supersededBy: successor.id }, { expect: old.fingerprint });
  assert.equal(changed.recorded, true);
  assert.throws(() => write({ ...successor, status: "superseded", supersededBy: accepted.id }, { expect: next.fingerprint }), /取代链/);
  const records = parseDecisions(fs.readFileSync(file, "utf8")).decisions;
  assert.equal(records[0].claim, accepted.claim);
  assert.equal(records[0].reason, accepted.reason);
  assert.deepEqual(records.map((item) => item.status), ["superseded", "accepted"]);
});

test("前缀相似的兄弟目录与外部符号链接不能作为 owner", (t) => {
  const { base, root, write } = setup(t);
  const outside = path.join(base, "project-other.md");
  fs.writeFileSync(outside, "# Do not change\n");
  fs.symlinkSync(outside, path.join(root, "knowledge/outside.md"));
  for (const owner of ["../project-other.md", "knowledge/outside.md"]) {
    assert.throws(() => write(rejected, { owner }), /必须位于项目内/);
    assert.throws(() => recordClaim(root, "escape", { owner }), /必须位于项目内/);
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "# Do not change\n");
});

test("代码围栏示例不变成知识；嵌套、未闭合与重复 ID 会报告", () => {
  const block = renderDecision(rejected);
  assert.deepEqual(parseDecisions(`\x60\x60\x60md\n${block}\n\x60\x60\x60\n~~~md\n${block}\n~~~`), { decisions: [], issues: [] });
  for (const text of [`${block}\n${block}`, block.replace("<!-- /atlas:decision -->", ""),
    `<!-- atlas:decision outer -->\n${block}`, block.replace("rejected", "unknown")]) {
    assert.ok(parseDecisions(text).issues.length > 0);
  }
});

test("CLI 按配置写入自定义知识目录，预览不建缓存，写完即可被新会话检索", (t) => {
  const { root, owner, file, cli } = setup(t);
  const preview = cli(rejected, "--dry-run");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).reason, "dry-run");
  assert.equal(fs.existsSync(cachePathFor(root)), false);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /atlas:decision/);
  const result = cli(rejected);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).indexed, true);
  assert.equal(fs.existsSync(path.join(root, ".trellis")), false);
  const newSession = updateSessionRoute({ projectRoot: root, prompt: "remote-index offline",
    payload: { session_id: "fresh-session" } }).context;
  assert.equal(newSession.results[0].path, owner);
  assert.equal(newSession.results[0].decisions[0].status, "rejected");
  assert.match(formatContext(newSession), /已拒绝/);
});

test("CLI 不向未索引或任务来源写入，也不会隐式自举", (t) => {
  const { root, file, cli } = setup(t);
  const config = path.join(root, ".atlas/config.json");
  for (const source of [{ glob: "docs/**/*.md", role: "canonical-doc" },
    { glob: "knowledge/**/*.md", role: "task-intent" }]) {
    fs.writeFileSync(config, JSON.stringify({ version: 1, entrypoints: [], sources: [source] }));
    const result = cli(rejected);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /维护中文档/);
  }
  fs.rmSync(config);
  assert.equal(cli(rejected).status, 1);
  assert.equal(fs.existsSync(path.join(root, ".trellis")), false);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /atlas:decision/);
});

test("词法、混合、显式路径都返回拒绝状态与包含理由的精确行范围", async (t) => {
  const { root, file, write } = setup(t, `# Architecture\n\n${"Unrelated introduction.\n".repeat(75)}\n`);
  write(rejected);
  write(accepted);
  buildIndex(root);
  const options = { projectRoot: root, prompt: "remote-index offline", env: {
    ATLAS_HOME: root, ATLAS_EMBED_API_KEY: "fixture", ATLAS_EMBED_ENDPOINT: "https://fixture.invalid/embeddings" } };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests += 1;
    return { ok: true, json: async () => ({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0] })) }) };
  });
  for (const context of [queryContext(options), await queryContextWithEmbedding(options),
    await queryContextWithEmbedding({ ...options, prompt: "explicit" })]) {
    const hit = context.results[0];
    const decision = hit.decisions.find((item) => item.id === rejected.id);
    assert.equal(decision.status, "rejected");
    const body = fs.readFileSync(file, "utf8").split("\n").slice(decision.line - 1, decision.endLine).join("\n");
    assert.match(body, /prevent offline lookup/);
    assert.equal(hit.decisionId, rejected.id, "查询应定位到决策块，而非只返回文档前 40 行");
    assert.ok(hit.line > 75);
    assert.match(formatContext(context), /已拒绝.*勿作为现行方案/);
  }
  assert.equal(requests, 2, "显式路由不请求嵌入");
});

test("已打开会话在重索引后刷新决策状态，保持分支且不扫描或请求嵌入", async (t) => {
  const { root, file, write } = setup(t);
  const first = write({ ...rejected, status: "proposed" });
  buildIndex(root);
  const options = { projectRoot: root, prompt: "explicit", payload: { session_id: "existing" } };
  const initial = await queryHookContextWithEmbedding(options);
  write(rejected, { expect: first.fingerprint });
  buildIndex(root);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    assert.notEqual(String(target), file, "focus 只能读取缓存");
    return read(target, ...args);
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("focus 不能请求嵌入"));
  const focus = await queryHookContextWithEmbedding({ ...options, prompt: "继续" });
  assert.equal(focus.routeState.branchId, initial.routeState.branchId);
  assert.equal(focus.results[0].decisions[0].status, "rejected");
  assert.equal(focus.knowledgeChanged, true);
  assert.match(formatContext(focus), /请重新读取/);
  assert.equal(currentSessionFocus(options).knowledgeChanged, undefined, "刷新一次后不重复要求读取");
});

test("显式 route 更新同一决策时返回 refreshed，而非误报 unchanged", (t) => {
  const { root, write } = setup(t);
  const first = write({ ...rejected, status: "proposed" });
  buildIndex(root);
  const options = { projectRoot: root, prompt: "explicit", payload: { session_id: "route-refresh" } };
  updateSessionRoute(options);
  write(rejected, { expect: first.fingerprint });
  buildIndex(root);
  const updated = updateSessionRoute(options);
  assert.equal(updated.status, "refreshed");
  assert.equal(updated.context.results[0].decisions[0].status, "rejected");
});

test("坏决策在 doctor 与路由中可见，不能继续被 record 覆盖", (t) => {
  const { root, file, write } = setup(t);
  fs.appendFileSync(file, renderDecision(rejected).replace("- Rationale: A required network service would prevent offline lookup.\n", ""));
  buildIndex(root);
  assert.ok(diagnose(root).knowledgeIssues.length > 0);
  const context = queryContext({ projectRoot: root, prompt: "remote offline" });
  assert.match(formatContext(context), /决策校验失败/);
  assert.throws(() => write(accepted), /无效决策/);
  for (const command of ["index", "doctor"]) {
    const result = spawnSync(process.execPath, [CLI, command, root, "--json"], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 1, `${command} 必须向机械校验暴露失败`);
    assert.equal(JSON.parse(result.stdout).knowledgeIssues[0].path, "knowledge/architecture.md");
  }
});

test("旧 --claim 不会把普通条目插入决策块或下一条决策的标记内", (t) => {
  const { root, owner, file, write } = setup(t);
  write(rejected);
  write(accepted);
  const before = fs.readFileSync(file, "utf8");
  const result = recordClaim(root, "Remote index for offline routing has another claim", { owner });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "decision-boundary");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("仅语义召回也暴露决策状态，离线失败后状态完整保留", async (t) => {
  const { root, write } = setup(t, `# Architecture\n\n${"Introduction.\n".repeat(75)}`);
  write(rejected);
  buildIndex(root);
  const options = { projectRoot: root, env: { ATLAS_HOME: root, ATLAS_EMBED_API_KEY: "fixture",
    ATLAS_EMBED_ENDPOINT: "https://fixture.invalid/embeddings" } };
  t.mock.method(globalThis, "fetch", async (_url, options) => ({ ok: true,
    json: async () => ({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0] })) }) }));
  const semantic = await queryContextWithEmbedding({ ...options, prompt: "毫无词面重合" });
  assert.equal(semantic.mode, "hybrid");
  assert.match(formatContext(semantic), /remote-index: rejected/);
  const session = { ...options, prompt: "毫无词面重合", payload: { session_id: "semantic-only" } };
  const first = await queryHookContextWithEmbedding(session);
  const restored = currentSessionFocus(session);
  assert.deepEqual(restored.results, first.results, "无源变更时不应把默认 40 行误刷新成标题的 60 行");
  assert.equal(restored.knowledgeChanged, undefined);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const request = { ...options, prompt: "remote-index offline" };
  const fallback = await queryContextWithEmbedding(request);
  assert.equal(fallback.mode, "lexical");
  assert.deepEqual(fallback.results, queryContext(request).results);
});
