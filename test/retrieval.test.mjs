import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildIndex, queryContext } from "../plugins/atlas/lib/core.mjs";

function withCache(callback) {
  const old = process.env.ATLAS_CACHE_DIR;
  process.env.ATLAS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-retrieval-"));
  try {
    return callback();
  } finally {
    if (old === undefined) delete process.env.ATLAS_CACHE_DIR;
    else process.env.ATLAS_CACHE_DIR = old;
  }
}

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-proj-"));
  fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".atlas", "config.json"),
    JSON.stringify(
      {
        version: 1,
        entrypoints: [],
        sources: [
          { glob: "docs/**/*.md", role: "canonical-doc", authority: 90 },
          { glob: ".trellis/spec/**/*.md", role: "implementation-constraint", authority: 55 },
          { glob: ".trellis/tasks/*/prd.md", role: "task-intent", authority: 35 }
        ],
        exclude: [],
        routes: [],
        limits: { maxResults: 6, maxRelated: 2, maxContextChars: 6000, maxBodyTerms: 12000 }
      },
      null,
      2
    ),
    "utf8"
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

test("围栏代码块内的井号注释不被当作标题", () => {
  const root = makeProject({
    "docs/guide.md": [
      "# 构建指南",
      "",
      "## 环境准备",
      "",
      "```bash",
      "# fails: 无效的目标发行版: 17",
      "mvn compile",
      "```",
      "",
      "## 后续步骤",
      "",
      "- 确认 JDK 版本。",
      ""
    ].join("\n")
  });
  const { index } = buildIndex(root);
  const document = index.documents.find((item) => item.path === "docs/guide.md");
  const titles = document.headings.map((heading) => heading.title);
  assert.equal(titles.includes("fails: 无效的目标发行版: 17"), false);
  assert.deepEqual(titles, ["构建指南", "环境准备", "后续步骤"]);
});

test("波浪号围栏同样被识别", () => {
  const root = makeProject({
    "docs/guide.md": "# 标题\n\n~~~\n# 不是标题\n~~~\n\n## 真标题\n\n- 内容行。\n"
  });
  const { index } = buildIndex(root);
  const document = index.documents.find((item) => item.path === "docs/guide.md");
  assert.deepEqual(document.headings.map((heading) => heading.title), ["标题", "真标题"]);
});

test("章节索引携带完整祖先标题链", () => {
  const root = makeProject({
    "docs/spec.md": [
      "# 质量指南",
      "",
      "## 必需模式",
      "",
      "### Scenario: 看板日快照接口",
      "",
      "#### 3. 契约",
      "",
      "- 快照版本为 v4，读取走日快照表。",
      "- 不得在读取路径上实时聚合。",
      ""
    ].join("\n")
  });
  const { index, } = buildIndex(root);
  const document = index.documents.find((item) => item.path === "docs/spec.md");
  const section = document.sections.find((item) => item.heading === "3. 契约");
  assert.ok(section, "应切出「3. 契约」章节");
  // 子章节标题在同级反复重名，必须靠祖先链获得区分度。
  assert.deepEqual(section.headingPath, ["质量指南", "必需模式", "Scenario: 看板日快照接口", "3. 契约"]);
  assert.ok(section.keyTerms.includes("看板"));
  assert.ok(section.keyTerms.includes("快照"));
});

test("章节命中时能定位到具体行区间", () => {
  const root = makeProject({
    "docs/spec.md": [
      "# 指南",
      "",
      "## 甲章节",
      "",
      "- 与查询无关的内容行一。",
      "- 与查询无关的内容行二。",
      "",
      "## 乙章节",
      "",
      "- 独特标识符 zebra_marker 在此定义。",
      "- 补充说明行。",
      ""
    ].join("\n")
  });
  const context = queryContext({ projectRoot: root, prompt: "zebra_marker 在哪里定义", forceRefresh: true });
  const hit = context.results.find((result) => result.path === "docs/spec.md");
  assert.ok(hit);
  assert.equal(hit.heading, "乙章节");
  assert.ok(hit.line > 1, "行号应指向章节而非文件开头");
});

test("超长章节的结果行区间被截断", () => {
  const body = Array.from({ length: 200 }, (_, i) => `- 内容行 ${i}，用于撑起章节跨度。`).join("\n");
  const root = makeProject({
    "docs/spec.md": `# 指南\n\n## 长章节\n\n${body}\n`
  });
  const context = queryContext({ projectRoot: root, prompt: "内容行 撑起章节跨度", forceRefresh: true });
  const hit = context.results.find((result) => result.path === "docs/spec.md");
  assert.ok(hit);
  assert.ok(hit.endLine - hit.line + 1 <= 60, `跨度应受限，实际 ${hit.endLine - hit.line + 1}`);
});

test("任务工件不进入语义检索候选", () => {
  const root = makeProject({
    "docs/reference/orders.md": "# 订单接口\n\n订单同步的接口约定与字段说明。\n",
    ".trellis/tasks/current/prd.md": "# 订单接口同步\n\n订单接口同步订单接口同步订单接口同步。\n"
  });
  const context = queryContext({
    projectRoot: root,
    prompt: "订单接口同步订单接口同步订单接口同步",
    forceRefresh: true
  });
  const paths = context.results.map((result) => result.path);
  assert.equal(paths.includes(".trellis/tasks/current/prd.md"), false, "任务工件不应被语义检索召回");
  assert.ok(paths.includes("docs/reference/orders.md"));
});

test("结构化标识符的文档频率极低时仍能胜出", () => {
  const root = makeProject({
    "docs/reference/a.md": "# 甲文档\n\n字段 数据 接口 返回 使用 当前 业务 用户 展示 记录 类型 查询。\n",
    "docs/reference/b.md": "# 乙文档\n\n- 唯一标识符 unique_field_name 在此定义。\n"
  });
  const context = queryContext({ projectRoot: root, prompt: "字段 数据 接口 unique_field_name", forceRefresh: true });
  assert.equal(context.results[0].path, "docs/reference/b.md", "标识符命中应压过高频词堆叠");
});

test("索引缓存往返后 IDF 表仍可用", () => {
  const root = makeProject({
    "docs/reference/a.md": "# 甲\n\n甲文档的独有内容 alpha_token 在此。\n",
    "docs/reference/b.md": "# 乙\n\n乙文档的独有内容 beta_token 在此。\n"
  });
  withCache(() => {
    buildIndex(root);
    // 第二次查询走缓存读取路径，IDF 必须被还原为可用结构而非普通对象。
    const context = queryContext({ projectRoot: root, prompt: "beta_token 在哪里", cacheOnly: true });
    assert.equal(context.results[0].path, "docs/reference/b.md");
  });
});

test("刷新、缓存与旧版空 IDF 缓存返回相同排序和分数", () => withCache(() => {
  const root = makeProject({
    "docs/a.md": "# Alpha\n\ncommon common_marker special_token\n",
    "docs/b.md": "# Beta\n\ncommon common_marker\n",
    "docs/c.md": "# Gamma\n\ncommon common_marker\n"
  });
  const options = { projectRoot: root, prompt: "common common_marker special_token" };
  const fresh = queryContext({ ...options, forceRefresh: true });
  const cached = queryContext({ ...options, cacheOnly: true });
  assert.deepEqual(cached.results, fresh.results, "缓存不能改变词权重或章节定位");

  const stored = JSON.parse(fs.readFileSync(fresh.cachePath, "utf8"));
  assert.ok(Object.keys(stored.idf.idf).length > 0, "磁盘必须保存实际词权重");
  // 已发布的 v2 索引把 Map 写成 {}；应仅凭缓存文档修复，不扫描仓库。
  stored.idf.idf = {};
  fs.writeFileSync(fresh.cachePath, JSON.stringify(stored));
  fs.rmSync(path.join(root, "docs"), { recursive: true });
  const migrated = queryContext({ ...options, cacheOnly: true });
  assert.deepEqual(migrated.results, fresh.results);
}));
