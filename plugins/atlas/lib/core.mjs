import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDecisions, decisionReference, formatDecisionReference,
  validateDecisionIntent, matchesDecisionIntent, decisionConflictIssues } from "./decisions.mjs";

const CONFIG_RELATIVE_PATH = path.join(".atlas", "config.json");
// 索引结构变更时必须递增，否则旧缓存会按 size/mtime 复用出缺少新字段的文档对象。
const INDEX_VERSION = 4;
const DEFAULT_LIMITS = {
  maxResults: 6,
  maxRelated: 2,
  maxContextChars: 6000,
  maxBodyTerms: 12000
};

// 单条结果返回的最大行跨度。超过此值的章节从起始处截断，避免一次交出整份长章节。
const HEADING_SPAN_LIMIT = 60;

const DEFAULT_CONFIG = {
  version: 1,
  entrypoints: ["AGENTS.md", "CONTEXT.md", "README.md", "docs/README.md"],
  sources: [
    { glob: "docs/**/*.md", role: "canonical-doc", authority: 90 },
    { glob: "docs/**/*.yaml", role: "api-contract", authority: 95 },
    { glob: "docs/**/*.yml", role: "api-contract", authority: 95 },
    { glob: ".trellis/spec/**/*.md", role: "implementation-constraint", authority: 55 },
    { glob: ".trellis/tasks/*/prd.md", role: "task-intent", authority: 35 },
    { glob: ".trellis/tasks/*/design.md", role: "task-intent", authority: 35 },
    { glob: ".trellis/tasks/*/implement.md", role: "task-evidence", authority: 25 }
  ],
  exclude: [
    ".git/**",
    "node_modules/**",
    ".trellis/.runtime/**",
    ".trellis/tasks/archive/**"
  ],
  routes: [],
  limits: DEFAULT_LIMITS
};

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  const result = new Set();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.:/-]*|\p{Script=Han}+/gu)) {
    const token = match[0];
    if (/^\p{Script=Han}+$/u.test(token)) {
      if (token.length <= 16) result.add(token);
      for (let size = 2; size <= Math.min(3, token.length); size += 1) {
        for (let i = 0; i <= token.length - size; i += 1) {
          result.add(token.slice(i, i + size));
        }
      }
    } else if (token.length >= 2 || token === "id") {
      result.add(token);
      for (const part of token.split(/[._:/-]+/)) {
        if (part.length >= 2 || part === "id") result.add(part);
      }
    }
  }
  return [...result];
}

function globToRegExp(glob) {
  const source = String(glob).split(path.sep).join("/");
  let pattern = "^";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "*") {
      if (source[i + 1] === "*") {
        i += 1;
        if (source[i + 1] === "/") {
          i += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

function staticGlobBase(glob) {
  const normalized = String(glob).split(path.sep).join("/");
  const wildcard = normalized.search(/[?*[]/);
  const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  return base === "." ? "" : base;
}

function mergeConfig(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    entrypoints: Array.isArray(raw.entrypoints) ? raw.entrypoints : DEFAULT_CONFIG.entrypoints,
    sources: Array.isArray(raw.sources) ? raw.sources : DEFAULT_CONFIG.sources,
    exclude: Array.isArray(raw.exclude) ? raw.exclude : DEFAULT_CONFIG.exclude,
    routes: Array.isArray(raw.routes) ? raw.routes : [],
    limits: { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) }
  };
}

export function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_RELATIVE_PATH))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) {
    throw new Error(`未找到 Atlas 配置：${configPath}`);
  }
  const raw = readJson(configPath);
  if (raw.version !== 1) throw new Error(`不支持 Atlas 配置版本：${raw.version}`);
  return { root, configPath, config: mergeConfig(raw), rawConfig: raw };
}

export function cachePathFor(projectRoot) {
  const base = process.env.ATLAS_CACHE_DIR
    ? path.resolve(process.env.ATLAS_CACHE_DIR)
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "atlas");
  const key = sha256(fs.realpathSync(projectRoot)).slice(0, 20);
  return path.join(base, key, "index.json");
}

function sourceMatcher(config) {
  const sources = config.sources.map((source) => ({
    ...source,
    regex: globToRegExp(source.glob)
  }));
  return (relative) => {
    const source = sources.find((candidate) => candidate.regex.test(relative));
    if (source) return source;
    if (config.entrypoints.includes(relative)) {
      return { glob: relative, role: "knowledge-entrypoint", authority: 100 };
    }
    return null;
  };
}

function collectFiles(root, config) {
  const excluded = config.exclude.map(globToRegExp);
  const matchesSource = sourceMatcher(config);
  const files = new Map();
  const roots = new Set();

  for (const entry of config.entrypoints) {
    const absolute = path.join(root, entry);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) files.set(entry, matchesSource(entry));
  }
  for (const source of config.sources) {
    const base = staticGlobBase(source.glob);
    const absolute = path.join(root, base);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isFile()) {
      const relative = posixRelative(root, absolute);
      if (globToRegExp(source.glob).test(relative)) files.set(relative, source);
    } else {
      roots.add(absolute);
    }
  }

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = posixRelative(root, absolute);
      if (excluded.some((regex) => regex.test(relative) || regex.test(`${relative}/`))) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const source = matchesSource(relative);
        if (source) files.set(relative, source);
      }
    }
  }
  for (const directory of roots) walk(directory);
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function knowledgeSources(projectRoot) {
  const { root, config } = loadProject(projectRoot);
  return collectFiles(root, config).map(([file, source]) => ({ path: file, role: source.role }));
}

function slugifyHeading(value) {
  return normalizeText(value)
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * 判断一个词是否为「结构化标识符」。
 *
 * 下划线、点号、斜杠、驼峰这类形态在项目知识里指向具体的字段名、表名、
 * 接口路径与类型名。实测这类词的文档频率极低（`tabvisits`、
 * `registration_store_area`、`payment_status` 各自只出现在 1 个文档里），
 * 而自然语言碎片（`字段` 出现在 47% 的文档）几乎没有区分度。
 * 二者混在同一权重下打分，会让精确查询被高频碎片淹没。
 */
function isIdentifier(term) {
  if (term.length < 3) return false;
  if (/[_.:\/-]/.test(term) && /^[a-z0-9_.:\/-]+$/.test(term)) return true;
  if (/^[a-z]+[0-9]+$/.test(term)) return true;
  return false;
}

/**
 * 逆文档频率表。
 *
 * 中文按 2/3-gram 切分会产生大量无区分度的碎片：`字段` 出现在 47% 的文档里，
 * `数据` 出现在 56% 里，命中它们几乎不携带信息；而真正有区分度的标识符
 * （如 `tabvisits`）只出现在个别文档中。不区分这两类词，排序会被高频词主导，
 * 这也是「查询词与文档用词重合却排不出正确答案」的主要成因。
 *
 * IDF 取 log(1 + N / df)，并将出现超过半数文档的词压到接近零权重。
 * 纯统计量，不依赖任何模型，结果确定可复现。
 */
const IDF_MAJORITY_RATIO = 0.5;

function buildIdf(documents) {
  const total = documents.length || 1;
  const documentFrequency = new Map();
  for (const document of documents) {
    const seen = new Set([...document.keyTerms, ...document.bodyTerms]);
    for (const section of document.sections ?? []) {
      for (const term of section.keyTerms) seen.add(term);
      for (const term of section.bodyTerms) seen.add(term);
    }
    for (const term of seen) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map();
  for (const [term, df] of documentFrequency) {
    const ratio = df / total;
    // 过半文档都含有的词不构成区分信号，权重压到最低但不完全归零，
    // 以免长查询里所有词都是高频词时全盘归零而失去排序依据。
    const value = ratio > IDF_MAJORITY_RATIO ? 0.05 : Math.log(1 + total / df);
    idf.set(term, value);
  }
  return { idf, total };
}

function weightOf(idfTable, term) {
  // 未出现在语料中的词（新词、生僻标识符）给予高于平均的权重：
  // 它没被索引到是因为罕见，而不是因为不重要。
  const base = idfTable.idf.get(term) ?? 3;
  // 结构化标识符额外加成：它指向具体实体，命中即是强证据。
  return isIdentifier(term) ? base * 3 : base;
}
/**
 * 扫描 Markdown 标题，跳过围栏代码块内部的行。
 *
 * 代码块里的 `# 注释` 与 Markdown 标题同形。若不排除，一个 shell 注释会被
 * 当成 H1，其后数百行正文全部挂到它下面，标题层级随之失真，章节定位失效。
 * 同时支持 ```` ``` ```` 与 `~~~` 两种围栏，且按围栏字符与长度配对闭合。
 */
function scanHeadings(lines) {
  const headings = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);

    if (fence) {
      // 只有同种字符且不短于开启围栏的行才能闭合。
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2], line: index + 1 });
  }
  return headings;
}

/**
 * 计算每个标题覆盖的行区间与所属章节路径。
 *
 * `endLine` 取下一个「级别不高于自己」的标题之前一行；没有后续标题时到文末。
 * `path` 记录从一级到当前的标题序列，用于把子章节挂到正确的父级下。
 */
function annotateHeadings(headings, totalLines) {
  const stack = [];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    while (stack.length > 0 && stack[stack.length - 1].level >= current.level) stack.pop();
    current.path = stack.map((item) => item.title);
    stack.push(current);

    const next = headings.slice(index + 1).find((item) => item.level <= current.level);
    current.endLine = next ? next.line - 1 : totalLines;
    current.anchor = slugifyHeading(current.title);
  }
  return headings;
}

function parseMarkdownLinks(text, root, relativePath) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(?:[a-z]+:|#)/i.test(href)) continue;
    const [pathname, anchor = ""] = href.split("#", 2);
    const decoded = decodeURIComponent(pathname);
    const absolute = path.resolve(root, path.dirname(relativePath), decoded);
    if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) continue;
    links.push({ path: posixRelative(root, absolute), anchor });
  }
  return links;
}

/**
 * 章节级索引的最小与最大跨度。
 *
 * 下限只排除「标题下没有任何正文」的空壳小节；过高的下限会把真实文档里
 * 三五行就把字段语义写清的短章节一并排除，那恰恰是最有定位价值的单元。
 * 上限用来防止整份长文件被当作单一切片，与短文档竞争时词面密度吃亏。
 */
const SECTION_MIN_LINES = 3;
const SECTION_MAX_LINES = 160;

/**
 * 从标题树中选出可检索的章节单元。
 *
 * 选择规则：层级不低于 2（一级标题即文档本身，由文档级索引承担），
 * 且跨度落在 [SECTION_MIN_LINES, SECTION_MAX_LINES] 之间。
 * 跨度过大的章节向下寻找子标题切分；跨度过小的章节跳过，由父级代表。
 */
function sectionsFromHeadings(headings, lines) {
  const sections = [];
  for (const heading of headings) {
    if (heading.level < 2 || heading.level > 4) continue;
    const span = heading.endLine - heading.line + 1;
    if (span < SECTION_MIN_LINES) continue;

    // 标题下一行起若没有任何非空正文，视为空壳小节，不构成检索单元。
    const bodyLines = lines.slice(heading.line, heading.endLine);
    if (!bodyLines.some((line) => line.trim() !== "")) continue;

    // 跨度过大且有子标题时，交给子标题表达，自身不再作为独立单元。
    const hasChild = headings.some(
      (item) => item.level > heading.level && item.line > heading.line && item.line <= heading.endLine
    );
    if (span > SECTION_MAX_LINES && hasChild) continue;

    const body = lines.slice(heading.line, heading.endLine).join("\n");
    // 打分用的标题词表必须包含完整祖先链。
    // 在七段式模板下，`1. Scope / Trigger`、`3. Contracts` 这类子标题在同级
    // 反复重名，单独看毫无区分度；只有连同父级 Scenario 标题一起构成
    // 「Scenario: X → 3. Contracts」这样的路径，才具备定位能力。
    const titleChain = [...(heading.path ?? []), heading.title];
    sections.push({
      anchor: heading.anchor,
      heading: heading.title,
      headingPath: titleChain,
      level: heading.level,
      line: heading.line,
      endLine: heading.endLine,
      keyTerms: tokenize(
        `${titleChain.join("\n")}\n${titleChain.map((item) => slugifyHeading(item)).join("\n")}`
      ),
      bodyTerms: tokenize(body).slice(0, 4000)
    });
  }
  return sections;
}

function parseDocument(root, relative, source, text, stat, maxBodyTerms) {
  const isMarkdown = /\.md$/i.test(relative);
  const lines = text.split(/\r?\n/);
  const headings = isMarkdown ? annotateHeadings(scanHeadings(lines), lines.length) : [];
  const title = headings.find((heading) => heading.level === 1)?.title || path.basename(relative);
  const keyText = `${relative}\n${title}\n${headings.map((heading) => heading.title).join("\n")}`;
  const knowledge = isMarkdown ? parseDecisions(text) : { decisions: [], issues: [] };
  knowledge.issues.push(...decisionConflictIssues(knowledge.decisions));
  const sections = isMarkdown ? sectionsFromHeadings(headings, lines).filter((section) =>
    !knowledge.decisions.some((item) => section.line >= item.line && section.line <= item.endLine)
  ) : [];
  for (const item of knowledge.decisions) {
    sections.push({
      anchor: `atlas-decision:${item.id}`, heading: item.title,
      headingPath: [title, item.title], level: 3, line: item.line, endLine: item.endLine,
      keyTerms: tokenize(`${title}\n${item.title}\n${item.id}${item.topic ? `\n${item.topic}` : ""}`),
      bodyTerms: tokenize([item.claim, item.reason, item.evidence, item.revisit].filter(Boolean).join("\n"))
    });
  }
  return {
    path: relative,
    role: source.role || "reference",
    authority: Number(source.authority ?? 50),
    sourceGlob: source.glob,
    title,
    headings,
    sections,
    ...(knowledge.decisions.length ? { decisions: knowledge.decisions.map(decisionReference) } : {}),
    ...(knowledge.issues.length ? { knowledgeIssues: knowledge.issues } : {}),
    links: isMarkdown ? parseMarkdownLinks(text, root, relative) : [],
    keyTerms: tokenize(keyText),
    bodyTerms: tokenize(text).slice(0, maxBodyTerms),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

export function buildIndex(projectRoot) {
  const project = loadProject(projectRoot);
  const configText = fs.readFileSync(project.configPath, "utf8");
  const configHash = sha256(configText);
  const cachePath = cachePathFor(project.root);
  let previous = null;
  if (fs.existsSync(cachePath)) {
    try {
      const parsed = readJson(cachePath);
      if (parsed.indexVersion === INDEX_VERSION && parsed.root === project.root && parsed.configHash === configHash) {
        previous = parsed;
      }
    } catch {
      previous = null;
    }  }
  const previousByPath = new Map((previous?.documents ?? []).map((document) => [document.path, document]));
  const documents = [];
  let readCount = 0;
  let reusedCount = 0;
  for (const [relative, source] of collectFiles(project.root, project.config)) {
    const absolute = path.join(project.root, relative);
    const stat = fs.statSync(absolute);
    const old = previousByPath.get(relative);
    if (
      old && old.size === stat.size && old.mtimeMs === stat.mtimeMs &&
      old.role === (source.role || "reference") && old.authority === Number(source.authority ?? 50)
    ) {
      documents.push(old);
      reusedCount += 1;
      continue;
    }
    const text = fs.readFileSync(absolute, "utf8");
    documents.push(parseDocument(project.root, relative, source, text, stat, project.config.limits.maxBodyTerms));
    readCount += 1;
  }
  const index = {
    indexVersion: INDEX_VERSION,
    root: project.root,
    configHash,
    scannedAt: new Date().toISOString(),
    scannedAtMs: Date.now(),
    stats: { documents: documents.length, readCount, reusedCount },
    // IDF 表随索引一起算并缓存：它依赖全量语料，逐次查询重算既慢又不一致。
    idf: buildIdf(documents),
    documents
  };
  writeJsonAtomic(cachePath, {
    ...index,
    idf: { ...index.idf, idf: Object.fromEntries(index.idf.idf) }
  });
  return { index, cachePath, config: project.config };
}

/**
 * 从缓存读出的索引需要修复不可序列化的结构。
 *
 * IDF 显式序列化为对象，在查询前还原 Map。早期 v2 缓存直接序列化
 * Map 导致权重丢成 {}；只用缓存中的词表修复，不重新读取项目文件。
 */
function reviveIndex(index) {
  const idf = index.idf?.idf;
  if (idf && !(idf instanceof Map)) {
    index.idf = Object.keys(idf).length > 0
      ? { idf: new Map(Object.entries(idf)), total: index.idf.total }
      : buildIdf(index.documents);
  }
  return index;
}

function ensureIndex(projectRoot, force = false, cacheOnly = false) {
  const project = loadProject(projectRoot);
  const cachePath = cachePathFor(project.root);
  if (!force && fs.existsSync(cachePath)) {
    try {
      const index = readJson(cachePath);
      const configHash = sha256(fs.readFileSync(project.configPath, "utf8"));
      if (
        index.indexVersion === INDEX_VERSION && index.root === project.root && index.configHash === configHash
      ) {
        return { index: reviveIndex(index), cachePath, config: project.config };
      }
    } catch {
      // Rebuild corrupt or incompatible caches below.
    }
  }
  if (cacheOnly) {
    return {
      index: {
        indexVersion: INDEX_VERSION,
        root: project.root,
        configHash: null,
        scannedAt: null,
        scannedAtMs: null,
        stats: { documents: 0, readCount: 0, reusedCount: 0 },
        documents: []
      },
      cachePath,
      config: project.config
    };
  }
  return buildIndex(project.root);
}

function routeMatches(route, prompt) {
  const groups = route.when?.allOfAny;
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const normalized = normalizeText(prompt);
  return groups.every((group) => Array.isArray(group) && group.some((term) => normalized.includes(normalizeText(term))));
}

function resolveHeading(document, requested) {
  if (requested?.startsWith("atlas-decision:")) {
    const id = requested.slice("atlas-decision:".length);
    const decision = document.decisions?.find((item) => item.id === id);
    if (decision) return { heading: decision.title, line: decision.line, endLine: decision.endLine, decisionId: id };
  }
  if (!requested) {
    const first = document.headings.find((heading) => heading.level === 1);
    return {
      heading: first?.title ?? "",
      line: first?.line ?? 1,
      endLine: Math.min(40, first?.endLine ?? 40)
    };
  }
  const decoded = decodeURIComponent(requested);
  const normalized = slugifyHeading(decoded);
  const heading = document.headings.find((candidate) =>
    candidate.anchor === normalized || normalizeText(candidate.title) === normalizeText(decoded)
  );
  if (heading) {
    // 单次返回的行区间不宜过长：一个 229 行的章节若整段交出，既挤占预算
    // 又淹没了真正相关的那几行。超出上限时从章节起始处截断，由调用方按需再读。
    const span = heading.endLine - heading.line + 1;
    return {
      heading: heading.title,
      line: heading.line,
      endLine: span > HEADING_SPAN_LIMIT ? heading.line + HEADING_SPAN_LIMIT - 1 : heading.endLine
    };
  }
  return { heading: decoded, line: 1, endLine: Math.min(40, document.headings[0]?.endLine ?? 40) };
}

function resultFromDocument(document, reason, score, anchor = "", match = null) {
  return {
    path: document.path,
    role: document.role,
    authority: document.authority,
    score,
    reason,
    ...(document.decisions?.length ? { decisions: document.decisions } : {}),
    ...(document.knowledgeIssues?.length ? { knowledgeIssues: document.knowledgeIssues } : {}),
    ...(document.decisions?.length || document.knowledgeIssues?.length ? { knowledgeAnchor: anchor } : {}),
    ...(match ? { match } : {}),
    ...resolveHeading(document, anchor)
  };
}

/**
 * 档位到排序系数的映射。
 *
 * 用乘法而非加法把权威折算进排序：权威仍然影响名次，但由内容相关性主导，
 * 不再像「tier 作第一排序键」那样让低档文档无论多相关都无法晋升。
 */
function tierWeight(tier) {
  return 1 + tier * 0.10;
}

/**
 * 任务工件不参与语义检索的候选竞争。
 *
 * 任务目录下的 prd.md / design.md / implement.md 是过程材料，其标题与需求
 * 描述往往直接来自用户的同一句话，词面得分天然高出知识文档一个数量级
 * （实测 96.14 对 8.89）。任何系数压制都只是缩小差距，不改变它挤掉真源的结果。
 *
 * 真正的解法是在候选阶段排除：这些材料本就应由显式路由按配置顺序提供，
 * 或由 Trellis 的状态机制注入，而不该靠词面相似度被「搜到」。
 */
function isTaskArtifact(document) {
  return ["task-intent", "task-evidence", "task-design"].includes(document.role);
}

function semanticTier(document) {
  if (["canonical-doc", "api-contract", "runbook", "adr"].includes(document.role)) return 5;
  if (document.role === "knowledge-entrypoint") return 4;
  if (document.role === "implementation-constraint") return 3;
  // 任务工件已在候选阶段排除，此处保留档位定义以维持显式路由的可读性。
  if (["task-intent", "task-evidence", "task-design"].includes(document.role)) return 1;
  return 2;
}

// Intent is chosen by the agent from the full task, never inferred from a short reply.
// Select decision units before limiting results so old content cannot win via its file.
function rankDecisions(index, prompt, intent, { includeUnmatched = false } = {}) {
  const terms = tokenize(prompt);
  const idf = index.idf ?? { idf: new Map(), total: index.documents.length };
  const ranked = [];
  for (const document of index.documents) {
    if (isTaskArtifact(document) || document.knowledgeIssues?.length) continue;
    for (const decision of document.decisions ?? []) {
      if (!matchesDecisionIntent(decision, intent)) continue;
      const section = document.sections.find((item) => item.anchor === `atlas-decision:${decision.id}`);
      if (!section) continue;
      const keys = new Set(section.keyTerms);
      const body = new Set(section.bodyTerms);
      let keyHits = 0, bodyHits = 0, score = 0;
      for (const term of terms) {
        if (keys.has(term)) { keyHits += 1; score += weightOf(idf, term) * 4.5; }
        else if (body.has(term)) { bodyHits += 1; score += weightOf(idf, term) * 1.4; }
      }
      if (!includeUnmatched && keyHits + bodyHits === 0) continue;
      ranked.push(resultFromDocument(document, `决策意图 ${intent}`, score,
        section.anchor, { type: "decision", keyHits, bodyHits }));
    }
  }
  return ranked.sort((a, b) => b.score - a.score || b.authority - a.authority ||
    a.path.localeCompare(b.path) || a.line - b.line);
}

export function queryContext({
  projectRoot,
  prompt,
  forceRefresh = false,
  cacheOnly = false,
  expandExclusive = false,
  decisionIntent = "all"
}) {
  validateDecisionIntent(decisionIntent);
  const { index, cachePath, config } = ensureIndex(projectRoot, forceRefresh, cacheOnly);
  const byPath = new Map(index.documents.map((document) => [document.path, document]));
  const results = [];
  const seen = new Set();
  const matchedRoutes = config.routes.filter((route) => routeMatches(route, prompt));
  const exclusiveRoute = matchedRoutes.some((route) => route.exclusive === true);

  for (const route of matchedRoutes) {
    for (let indexInRoute = 0; indexInRoute < (route.read ?? []).length; indexInRoute += 1) {
      const reference = route.read[indexInRoute];
      const raw = typeof reference === "string" ? reference : reference.path;
      const hashIndex = raw.indexOf("#");
      const relative = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
      const anchor = hashIndex < 0 ? "" : raw.slice(hashIndex + 1);
      let document = byPath.get(relative);
      if (!document && fs.existsSync(path.join(index.root, relative))) {
        const source = sourceMatcher(config)(relative) || { role: "reference", authority: 50 };
        document = {
          path: relative,
          role: source.role || "reference",
          authority: Number(source.authority ?? 50),
          title: path.basename(relative),
          headings: [],
          links: [],
          keyTerms: [],
          bodyTerms: []
        };
      }
      if (!document || seen.has(relative)) continue;
      seen.add(relative);
      results.push(resultFromDocument(
        document,
        `显式路由 ${route.id}`,
        1000 - indexInRoute,
        anchor,
        { type: "explicit", route: route.id }
      ));
    }
  }

  if ((!exclusiveRoute || expandExclusive) && decisionIntent !== "all") {
    for (const result of rankDecisions(index, prompt, decisionIntent)) {
      if (results.length >= config.limits.maxResults) break;
      if (seen.has(result.path)) continue;
      results.push(result);
      seen.add(result.path);
    }
  }
  if ((!exclusiveRoute || expandExclusive) && decisionIntent === "all") {
    const promptTerms = tokenize(prompt);
    const idfTable = index.idf ?? { idf: new Map(), total: index.documents.length };
    const semantic = [];
    for (const document of index.documents) {
      if (seen.has(document.path)) continue;
      if (isTaskArtifact(document)) continue;
      const keyTerms = new Set(document.keyTerms);
      const bodyTerms = new Set(document.bodyTerms);
      let keyScore = 0;
      let bodyScore = 0;
      let keyHits = 0;
      let bodyHits = 0;
      const matched = [];
      for (const term of promptTerms) {
        const weight = weightOf(idfTable, term);
        if (keyTerms.has(term)) {
          keyHits += 1;
          keyScore += weight;
          matched.push(term);
        } else if (bodyTerms.has(term)) {
          bodyHits += 1;
          bodyScore += weight * 0.35;
          matched.push(term);
        }
      }
      if (keyHits + bodyHits === 0) continue;
      // 权重由词的信息量决定，而非命中次数：一个只在本文档出现的标识符
      // 应胜过多个半数文档都有的常用词。
      const score = keyScore * 4 + bodyScore * 4 + document.authority / 20;
      semantic.push({
        kind: "document",
        document,
        section: null,
        score,
        tier: semanticTier(document),
        keyHits,
        bodyHits,
        matched: [...new Set(matched)].slice(0, 5)
      });
    }

    // 章节路：命中定位到具体小节，而不只是文件。
    //
    // 背景：一份 760 行的规范文件被当作单个排序单元时，其词面密度必然低于
    // 一份 50 行的短文档，即使真正答案就在它的某个小节里。章节级打分让
    // 「标题含查询词的小节」单独参与竞争，不再被整份文件的平均值稀释。
    // 权重上让章节的首词命中略高于文档名命中，因为小节标题比文件名更具体。
    for (const document of index.documents) {
      if (seen.has(document.path)) continue;
      if (isTaskArtifact(document)) continue;
      for (const section of document.sections ?? []) {
        const sectionKey = new Set(section.keyTerms);
        const sectionBody = new Set(section.bodyTerms);
        let keyScore = 0;
        let bodyScore = 0;
        let keyHits = 0;
        let bodyHits = 0;
        const matched = [];
        for (const term of promptTerms) {
          const weight = weightOf(idfTable, term);
          if (sectionKey.has(term)) {
            keyHits += 1;
            keyScore += weight;
            matched.push(term);
          } else if (sectionBody.has(term)) {
            bodyHits += 1;
            bodyScore += weight * 0.35;
            matched.push(term);
          }
        }
        if (keyHits + bodyHits === 0) continue;
        // 章节标题链路比文档名更具体，权重略高于文档路。
        const score = keyScore * 4.5 + bodyScore * 4 + document.authority / 20;
        semantic.push({
          kind: "section",
          document,
          section,
          score,
          tier: semanticTier(document),
          keyHits,
          bodyHits,
          matched: [...new Set(matched)].slice(0, 5)
        });
      }
    }

    // 同一文档的多个章节只保留得分最高的一个，避免单文件霸占结果位。
    const bestPerDocument = new Map();
    for (const candidate of semantic) {
      const key = candidate.document.path;
      const existing = bestPerDocument.get(key);
      if (
        !existing ||
        candidate.score > existing.score ||
        (candidate.score === existing.score && candidate.kind === "section" && existing.kind === "document")
      ) {
        bestPerDocument.set(key, candidate);
      }
    }

    // tier 曾经是第一排序键，使 implementation-constraint 类文档（全部 spec）
    // 结构性排在 canonical-doc / runbook 之后，无论内容多相关都无法晋升。
    // 实测中一个 39.41 分的 spec 章节被 36.90 分的 runbook 文档压在下面，
    // 仅因 tier 差两档。改为把 tier 折算成系数：权威仍然重要，但由相关性主导；
    // 任务工件用乘法压制，避免其重复查询词的词面优势抵消掉档位差距。
    const rankScore = (candidate) => candidate.score * tierWeight(candidate.tier);
    const ranked = [...bestPerDocument.values()].sort((left, right) =>
      rankScore(right) - rankScore(left) ||
      right.score - left.score ||
      right.document.authority - left.document.authority
    );

    for (const candidate of ranked) {
      if (results.length >= config.limits.maxResults) break;
      seen.add(candidate.document.path);
      results.push(resultFromDocument(
        candidate.document,
        `命中 ${candidate.matched.join("、")}`,
        candidate.score,
        candidate.section?.anchor ?? "",
        {
          type: "semantic",
          keyHits: candidate.keyHits,
          bodyHits: candidate.bodyHits,
          section: candidate.section?.heading ?? null
        }
      ));
    }
  }

  let relatedCount = 0;
  if (decisionIntent === "all" && (!exclusiveRoute || expandExclusive) && results.length < config.limits.maxResults) {
    for (const result of [...results]) {
      const document = byPath.get(result.path);
      for (const link of document?.links ?? []) {
        if (relatedCount >= config.limits.maxRelated || results.length >= config.limits.maxResults) break;
        const related = byPath.get(link.path);
        if (!related || seen.has(related.path)) continue;
        seen.add(related.path);
        relatedCount += 1;
        results.push(resultFromDocument(related, `由 ${document.path} 一跳关联`, result.score - 1, link.anchor));
      }
      if (relatedCount >= config.limits.maxRelated) break;
    }
  }

  return {
    root: index.root,
    cachePath,
    scannedAt: index.scannedAt,
    stats: index.stats,
    matchedRoutes: matchedRoutes.map((route) => route.id),
    trellis: fs.existsSync(path.join(index.root, ".trellis")),
    maxContextChars: config.limits.maxContextChars,
    ...(decisionIntent !== "all" ? { decisionIntent } : {}),
    results
  };
}

function lookupSessionValue(data, keys) {
  if (!data || typeof data !== "object") return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["input", "properties", "event", "hook_input", "hookInput"]) {
    const value = lookupSessionValue(data[key], keys);
    if (value) return value;
  }
  return null;
}

export function resolveHookSessionKey(payload = {}, env = process.env) {
  const payloadValue = lookupSessionValue(payload, [
    "session_id", "sessionId", "sessionID",
    "conversation_id", "conversationId", "conversationID",
    "thread_id", "threadId", "threadID",
    "transcript_path", "transcriptPath", "transcript"
  ]);
  const environmentValue = env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || env.CODEX_TRANSCRIPT_PATH;
  const value = payloadValue || environmentValue;
  return value ? sha256(String(value)).slice(0, 24) : null;
}

function sessionRoutePath(projectRoot, sessionKey) {
  return path.join(path.dirname(cachePathFor(projectRoot)), "sessions", `${sessionKey}.json`);
}

function routeSignature(context) {
  return sha256(JSON.stringify({
    ...(context.decisionIntent ? { decisionIntent: context.decisionIntent } : {}),
    matchedRoutes: context.matchedRoutes,
    results: context.results.map((result) => ({
      path: result.path,
      heading: result.heading,
      line: result.line,
      endLine: result.endLine
    }))
  }));
}

function sanitizeRouteResult(result) {
  return {
    path: result.path,
    role: result.role ?? "reference",
    authority: Number(result.authority ?? 50),
    score: Number(result.score ?? 0),
    reason: result.reason ?? "会话活动路由",
    heading: result.heading ?? "",
    line: Number(result.line ?? 1),
    endLine: Number(result.endLine ?? 40),
    ...(result.decisionId ? { decisionId: result.decisionId } : {}),
    ...(result.decisions ? { decisions: result.decisions } : {}),
    ...(result.knowledgeIssues ? { knowledgeIssues: result.knowledgeIssues } : {}),
    ...(result.knowledgeAnchor !== undefined ? { knowledgeAnchor: result.knowledgeAnchor } : {}),
    ...(result.match ? { match: result.match } : {})
  };
}

function routeNodeKey(result) {
  return `${result.path}#${result.decisionId ? `atlas-decision:${result.decisionId}` : result.heading || `${result.line}-${result.endLine}`}`;
}

// Refresh known decision references from the cache, never from the latest prompt.
// Reindexing can change a decision's status and line range without changing intent.
function refreshDecisionNodes(projectRoot, nodes, decisionIntent = "all") {
  const { index } = ensureIndex(projectRoot, false, true);
  const byPath = new Map(index.documents.map((document) => [document.path, document]));
  const refreshedNodes = nodes.map((node) => {
    const document = byPath.get(node.path);
    if (!node.decisions && !node.knowledgeIssues && !document?.decisions && !document?.knowledgeIssues) return node;
    if (!document) return { ...node, knowledgeIssues: [{ line: node.line,
      message: "当前索引中没有该决策来源；重新索引并核对真源后再使用。" }] };
    let anchor = node.knowledgeAnchor ?? (node.decisionId ? `atlas-decision:${node.decisionId}` : node.heading);
    if (decisionIntent !== "all" && node.match?.type !== "explicit") {
      let decision = document.decisions?.find((item) => item.id === node.decisionId);
      const visited = new Set();
      while (decisionIntent === "current" && decision?.status === "superseded" && !visited.has(decision.id)) {
        visited.add(decision.id);
        decision = document.decisions.find((item) => item.id === decision.supersededBy);
      }
      if (!decision || !matchesDecisionIntent(decision, decisionIntent) || document.knowledgeIssues?.length) return null;
      anchor = `atlas-decision:${decision.id}`;
    }
    const refreshed = resultFromDocument(document, node.reason, node.score, anchor, node.match);
    if (node.decisionId && !refreshed.decisionId) {
      refreshed.decisionId = node.decisionId;
      refreshed.knowledgeIssues = [...(refreshed.knowledgeIssues ?? []), { line: refreshed.line,
        message: `决策 ${node.decisionId} 已不在真源中；不得沿用旧状态。` }];
    }
    return sanitizeRouteResult(refreshed);
  }).filter(Boolean);
  return [...new Map(refreshedNodes.map((node) => [routeNodeKey(node), node])).values()];
}

function newSessionGraph(projectRoot) {
  return {
    version: 2,
    root: path.resolve(projectRoot),
    activeBranchId: null,
    updatedAt: new Date().toISOString(),
    branches: []
  };
}

function migrateSessionGraph(projectRoot, state) {
  if (state?.version === 2 && Array.isArray(state.branches)) return state;
  if (state?.route && Array.isArray(state.route.results)) {
    const branchId = `branch-${String(state.signature || sha256(JSON.stringify(state.route))).slice(0, 12)}`;
    return {
      version: 2,
      root: path.resolve(projectRoot),
      activeBranchId: branchId,
      updatedAt: state.updatedAt || new Date().toISOString(),
      branches: [{
        id: branchId,
        createdAt: state.updatedAt || new Date().toISOString(),
        updatedAt: state.updatedAt || new Date().toISOString(),
        matchedRoutes: Array.isArray(state.route.matchedRoutes) ? state.route.matchedRoutes : [],
        nodes: state.route.results.map(sanitizeRouteResult)
      }]
    };
  }
  return newSessionGraph(projectRoot);
}

function readSessionGraph(projectRoot, sessionKey) {
  if (!sessionKey) return null;
  const file = sessionRoutePath(projectRoot, sessionKey);
  if (!fs.existsSync(file)) return null;
  try {
    const state = readJson(file);
    if (state?.root !== path.resolve(projectRoot)) return null;
    return migrateSessionGraph(projectRoot, state);
  } catch {
    return null;
  }
}

function writeSessionGraph(projectRoot, sessionKey, graph) {
  if (!sessionKey) return;
  writeJsonAtomic(sessionRoutePath(projectRoot, sessionKey), graph);
}

function confidentInitialRoute(context) {
  if (context.matchedRoutes.length > 0) return true;
  const top = context.results[0]?.match;
  const keyHits = Number(top?.keyHits ?? 0);
  const bodyHits = Number(top?.bodyHits ?? 0);
  return keyHits >= 2 || (keyHits >= 1 && bodyHits >= 1);
}

function graphSummary(graph) {
  return {
    activeBranchId: graph?.activeBranchId ?? null,
    branchCount: graph?.branches?.length ?? 0,
    branches: (graph?.branches ?? []).map((branch) => ({
      id: branch.id,
      active: branch.id === graph.activeBranchId,
      matchedRoutes: branch.matchedRoutes,
      nodeCount: branch.nodes.length
    }))
  };
}

function contextWithState(context, routeState, results = context.results) {
  return {
    ...context,
    results,
    routeState
  };
}

function contextFromBranch(projectRoot, branch, graph, mode, results = branch.nodes) {
  const project = loadProject(projectRoot);
  return {
    root: project.root,
    cachePath: cachePathFor(project.root),
    scannedAt: null,
    stats: null,
    matchedRoutes: branch.matchedRoutes,
    trellis: fs.existsSync(path.join(project.root, ".trellis")),
    maxContextChars: project.config.limits.maxContextChars,
    ...(branch.decisionIntent ? { decisionIntent: branch.decisionIntent } : {}),
    results: results.slice(0, project.config.limits.maxResults),
    routeState: {
      mode,
      branchId: branch.id,
      branchCount: graph.branches.length,
      nodeCount: branch.nodes.length
    }
  };
}

function createBranch(context, now) {
  const signature = routeSignature(context);
  return {
    id: `branch-${signature.slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    matchedRoutes: [...new Set(context.matchedRoutes)],
    ...(context.decisionIntent ? { decisionIntent: context.decisionIntent } : {}),
    nodes: context.results.map(sanitizeRouteResult)
  };
}

export function updateSessionRoute({
  projectRoot,
  prompt,
  payload = {},
  env = process.env,
  forceRefresh = false,
  expandExclusive = false,
  decisionIntent = "all"
}) {
  validateDecisionIntent(decisionIntent);
  const sessionKey = resolveHookSessionKey(payload, env);
  const existingGraph = readSessionGraph(projectRoot, sessionKey);
  let context = queryContext({
    projectRoot,
    prompt,
    forceRefresh,
    decisionIntent,
    cacheOnly: !forceRefresh
  });
  if (expandExclusive && context.matchedRoutes.length > 0) {
    const reactivatesExisting = existingGraph?.branches.some((branch) =>
      branch.id !== existingGraph.activeBranchId &&
      (branch.decisionIntent ?? "all") === decisionIntent &&
      branch.matchedRoutes.some((routeId) => context.matchedRoutes.includes(routeId))
    );
    if (!reactivatesExisting) {
      context = queryContext({
        projectRoot,
        prompt,
        forceRefresh,
        decisionIntent,
        cacheOnly: !forceRefresh,
        expandExclusive: true
      });
    }
  }

  if (!confidentInitialRoute(context)) {
    return {
      status: "no-match",
      context: null,
      graph: graphSummary(existingGraph)
    };
  }
  if (!sessionKey) {
    return {
      status: "unscoped",
      context: contextWithState(context, { mode: "unscoped", branchId: null, branchCount: 0 }),
      graph: graphSummary(null)
    };
  }

  const graph = existingGraph ?? newSessionGraph(projectRoot);
  const now = new Date().toISOString();
  const candidateNodes = context.results.map(sanitizeRouteResult);
  const activeBefore = graph.activeBranchId;

  let branch = null;
  if (context.matchedRoutes.length > 0) {
    branch = graph.branches.find((existing) =>
      (existing.decisionIntent ?? "all") === decisionIntent &&
      existing.matchedRoutes.some((routeId) => context.matchedRoutes.includes(routeId))
    ) ?? null;
  } else {
    const primaryPath = candidateNodes[0]?.path ?? null;
    const matching = primaryPath
      ? graph.branches.filter((existing) =>
        (existing.decisionIntent ?? "all") === decisionIntent &&
        existing.nodes.some((node) => node.path === primaryPath)
      )
      : [];
    branch = matching.find((existing) => existing.id === graph.activeBranchId) ?? matching[0] ?? null;
  }

  let status;
  let outputResults;
  if (!branch) {
    branch = createBranch(context, now);
    const collision = graph.branches.find((existing) => existing.id === branch.id);
    if (collision) branch.id = `${branch.id}-${graph.branches.length + 1}`;
    graph.branches.push(branch);
    status = graph.branches.length === 1 ? "created" : "branched";
    outputResults = branch.nodes;
  } else {
    const existingNodes = new Map(branch.nodes.map((node) => [routeNodeKey(node), node]));
    const existingKeys = new Set(branch.nodes.map(routeNodeKey));
    const added = candidateNodes.filter((node) => !existingKeys.has(routeNodeKey(node)));
    const changed = candidateNodes.filter((node) => {
      const old = existingNodes.get(routeNodeKey(node));
      return old && (node.decisions || old.decisions || node.knowledgeIssues || old.knowledgeIssues) &&
        JSON.stringify([node.decisions, node.knowledgeIssues]) !== JSON.stringify([old.decisions, old.knowledgeIssues]);
    });
    const merged = [];
    const seen = new Set();
    for (const node of [...candidateNodes, ...branch.nodes]) {
      const key = routeNodeKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(node);
    }
    branch.nodes = merged;
    branch.matchedRoutes = [...new Set([...context.matchedRoutes, ...branch.matchedRoutes])];
    branch.updatedAt = now;
    if (branch.id !== activeBefore) {
      status = added.length > 0 ? "reactivated-expanded" : "reactivated";
      outputResults = branch.nodes;
    } else if (added.length > 0) {
      status = "expanded";
      outputResults = [...added, ...changed];
    } else if (changed.length > 0) {
      status = "refreshed";
      outputResults = changed;
    } else {
      status = "unchanged";
      outputResults = [];
    }
  }

  const refreshed = refreshDecisionNodes(projectRoot, branch.nodes, branch.decisionIntent);
  const changed = refreshed.filter((node, index) => JSON.stringify(node) !== JSON.stringify(branch.nodes[index]));
  branch.nodes = refreshed;
  outputResults = outputResults.map((node) => refreshed.find((item) => routeNodeKey(item) === routeNodeKey(node)) ?? node);
  if (status === "unchanged" && changed.length) { status = "refreshed"; outputResults = changed; }

  graph.activeBranchId = branch.id;
  graph.updatedAt = now;
  writeSessionGraph(projectRoot, sessionKey, graph);

  return {
    status,
    context: contextFromBranch(projectRoot, branch, graph, status, outputResults),
    graph: graphSummary(graph)
  };
}

export function currentSessionFocus({ projectRoot, payload = {}, env = process.env }) {
  const sessionKey = resolveHookSessionKey(payload, env);
  const graph = readSessionGraph(projectRoot, sessionKey);
  if (!graph) return null;
  const branch = graph.branches.find((candidate) => candidate.id === graph.activeBranchId);
  if (!branch) return null;
  const refreshed = refreshDecisionNodes(projectRoot, branch.nodes, branch.decisionIntent);
  const knowledgeChanged = JSON.stringify(refreshed) !== JSON.stringify(branch.nodes);
  if (knowledgeChanged) {
    branch.nodes = refreshed;
    writeSessionGraph(projectRoot, sessionKey, graph);
  }
  const context = contextFromBranch(projectRoot, branch, graph, "focus");
  return knowledgeChanged ? { ...context, knowledgeChanged: true } : context;
}

export function queryHookContext({ projectRoot, prompt, payload = {}, env = process.env }) {
  const focus = currentSessionFocus({ projectRoot, payload, env });
  if (focus) return focus;
  return updateSessionRoute({ projectRoot, prompt, payload, env }).context;
}

export function formatContext(context, { hook = false } = {}) {
  const mode = context.routeState?.mode ?? "route";
  if (mode === "unchanged") {
    return `[Atlas route] unchanged; branch=${context.routeState.branchId}; ` +
      "当前知识节点已覆盖完整任务意图，无需重复读取。";
  }
  if (context.results.length === 0) return context.decisionIntent
    ? `[Atlas 决策] 未找到符合 ${context.decisionIntent} 的已分类决定；这不证明不存在。用默认 all 检索未分类文档，并核对代码与当前证据。`
    : "";
  const stateSuffix = context.routeState?.branchId
    ? `; branch=${context.routeState.branchId}; branches=${context.routeState.branchCount}`
    : "";
  const header = mode === "focus"
    ? `[Atlas focus] project=${context.root}; branch=${context.routeState.branchId}; branches=${context.routeState.branchCount}`
    : `[Atlas route${mode === "route" || mode === "created" || mode === "unscoped" ? "" : `:${mode}`}] project=${context.root}${stateSuffix}`;
  // 检索融合显式路由、语义向量与词面匹配。语义路能覆盖"措辞不同但语义相同"的请求，
  // 而词法证据强度与正确性无关(实测:0/6 命中过、0/5 也失败过),所以无法用置信度门控
  // 判断自己是否错了。诚实的做法是把这条限制说明白,把语义判断留给模型,而不是替它下结论。
  const instruction = context.knowledgeChanged || mode === "refreshed"
    ? "Atlas 已从更新后的索引刷新决策状态与行号，任务意图保持不变；请重新读取以下真源中的决策。提议、拒绝和被取代的内容均不是现行方案。"
    : mode === "focus"
    ? `${hook ? "Atlas hook 已恢复" : "已恢复"}当前活动分支；继续使用以下知识节点，不要因当前一句话重新检索、重复读取或再次加载 Atlas skill。准备执行超出这些节点的新非平凡操作前，才使用完整会话意图运行 atlas route。`
    : mode === "expanded"
      ? "当前分支已扩展；只读取以下新增节点，旧节点保持有效。不要为同一意图再次运行 context/route/focus，也不要探测插件缓存或 Atlas skill 的版本路径。"
      : `${hook ? "Atlas hook 已在模型开始工作前完成路由。" : "Atlas 路由已完成。"}以下路径/章节按相关度排序，融合了人工配置的显式路由、语义相似度与词面匹配三种信号。先按顺序读取；若它们与你的意图明显不符，直接做一次聚焦搜索（rg/find 一次即可），不要从候选里硬凑。不要为同一意图再次运行 context/route/focus，也不要探测插件缓存或 Atlas skill 的版本路径；易漂移事实仍以当前配置或运行态复核：`;
  const lines = [header];
  if (context.decisionIntent) lines.push(
    `[Atlas 决策意图] ${context.decisionIntent}：自动候选仅包含${context.decisionIntent === "current" ? " accepted" : " rejected/superseded"} 决策。` +
    "显式读取链仍按配置保留，可能包含其他状态；未分类文档请另用 all 检索。"
  );
  // 覆盖度提示紧跟在 header 之后、指令之前。
  // 这样即使总预算极小导致尾部截断，最先丢掉的也是冗长的指令与候选，
  // 而「知识库是否覆盖该提问」这一决策信息始终保留。
  if (context.coverage && context.coverage.verdict !== "covered") {
    const pct = (value) => `${(value * 100).toFixed(1)}%`;
    if (context.coverage.verdict === "weak") {
      lines.push(
        `[Atlas 覆盖度] 弱：最佳候选相似度 ${pct(context.coverage.topScore)}，阈值 ${pct(context.coverage.threshold)}。` +
        "候选可能只与提问部分相关，请核对后再采信；若明显不符，改用一次聚焦搜索或直接向用户确认。"
      );
    } else {
      lines.push(
        `[Atlas 覆盖度] 未覆盖：最佳候选相似度 ${pct(context.coverage.topScore)}，低于阈值 ${pct(context.coverage.threshold)}。` +
        "知识库很可能没有这个主题的当前事实，以下候选大概率不相关。" +
        "不要把它们当作答案依据；应说明未找到，并转向代码、运行态或向用户确认。"
      );
    }
  }
  lines.push(instruction);
  // 逐条加入候选并把总长度控制在预算内。覆盖度提示与指令位于 lines 前部，
  // 因此截断只会丢掉末尾的候选，而不会丢掉「是否覆盖」这一决策信息。
  const budget = context.maxContextChars || DEFAULT_LIMITS.maxContextChars;
  let used = lines.join("\n").length;
  for (let index = 0; index < context.results.length; index += 1) {
    const result = context.results[index];
    const section = result.heading ? `#${result.heading}` : "";
    const selected = result.decisions?.find((item) => item.id === result.decisionId);
    const knowledge = result.knowledgeIssues?.length
      ? "; 决策校验失败，先核对真源，勿作为现行依据"
      : selected ? `; ${formatDecisionReference(selected)}`
        : result.decisions?.length ? "; 含决策，须按各条状态区分现行与历史" : "";
    const entry =
      `${index + 1}. ${path.join(context.root, result.path)}${section} ` +
      `(lines ${result.line}-${result.endLine}; ${result.role}; ${result.reason}${knowledge})`;
    if (used + entry.length + 1 > budget) break;
    lines.push(entry);
    used += entry.length + 1;
    const relatedDecisions = (result.decisions ?? []).filter((item) => item.id !== selected?.id);
    // A large decision log must not consume the entire budget ahead of other owners.
    // Put a selected decision's successor first; JSON retains every reference.
    if (selected?.supersededBy) relatedDecisions.sort((a, b) =>
      Number(b.id === selected.supersededBy) - Number(a.id === selected.supersededBy));
    for (const decision of relatedDecisions.slice(0, 3)) {
      const reference = `   决策 ${formatDecisionReference(decision)}`;
      if (used + reference.length + 1 > budget) break;
      lines.push(reference);
      used += reference.length + 1;
    }
  }
  if (context.trellis) {
    lines.push("Trellis 适配：.trellis 仅提供任务意图、实施约束和历史证据，不覆盖 docs/代码/配置中的当前真源。");
  }
  return lines.join("\n").slice(0, context.maxContextChars || DEFAULT_LIMITS.maxContextChars);
}

export function initProject(target, { trellis = false } = {}) {
  const root = path.resolve(target);
  fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (fs.existsSync(configPath)) throw new Error(`Atlas 配置已存在：${configPath}`);
  const config = structuredClone(DEFAULT_CONFIG);
  if (!trellis) {
    config.sources = config.sources.filter((source) => !source.glob.startsWith(".trellis/"));
  }
  writeJsonAtomic(configPath, config);
  const ignorePath = path.join(root, ".atlas", ".gitignore");
  const previousIgnore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  const missingIgnores = ["runtime/", "*.tmp", ".env.local"].filter((entry) =>
    !previousIgnore.split(/\r?\n/).includes(entry));
  if (missingIgnores.length) fs.writeFileSync(ignorePath,
    `${previousIgnore}${previousIgnore && !previousIgnore.endsWith("\n") ? "\n" : ""}${missingIgnores.join("\n")}\n`, "utf8");
  return configPath;
}

export function diagnose(projectRoot) {
  const project = loadProject(projectRoot);
  const cachePath = cachePathFor(project.root);
  const cache = fs.existsSync(cachePath) ? readJson(cachePath) : null;
  const projectHook = path.join(project.root, ".codex", "hooks.json");
  const trellis = fs.existsSync(path.join(project.root, ".trellis"));
  return {
    root: project.root,
    configPath: project.configPath,
    configValid: true,
    sources: project.config.sources.length,
    routes: project.config.routes.length,
    cachePath,
    cachePresent: Boolean(cache),
    indexedDocuments: cache?.documents?.length ?? 0,
    lastScan: cache?.scannedAt ?? null,
    knowledgeIssues: (cache?.documents ?? []).flatMap((document) =>
      (document.knowledgeIssues ?? []).map((issue) => ({ path: document.path, ...issue }))),
    trellis,
    trellisSpecSources: project.config.sources.filter((source) => source.glob.startsWith(".trellis/spec/")).length,
    archiveExcluded: project.config.exclude.some((glob) => glob.startsWith(".trellis/tasks/archive")),
    projectHook: fs.existsSync(projectHook) ? projectHook : null,
    hookContract: "Atlas 与其他 UserPromptSubmit hooks 独立运行，不依赖执行顺序。"
  };
}

export function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

/**
 * 带嵌入语义的混合检索。
 *
 * 设计约束：
 * - 不改变同步的 queryContext，避免破坏现有调用方与离线可用性。
 * - 嵌入不可用（未配凭据、网络失败、服务报错）时整体退化为词法结果，
 *   并在返回值里标注实际使用的模式，而不是静默地给出一个未经语义排序的结果。
 * - 显式路由的优先级最高：它由人配置，不参与语义重排。
 *
 * 显式读取链保持顺序和章节；非排他路由的剩余名额使用排名融合。
 */
export async function queryContextWithEmbedding({
  projectRoot,
  prompt,
  forceRefresh = false,
  env = process.env,
  decisionIntent = "all",
  // 保留既有默认权重；早期权重扫描的评分口径有误，不能作为普适结论。
  // 重新调参需固定语料与向量，使用 eval/README.md 的修正口径。
  semanticWeight = 1.0,
  routedWeight = 1.0,
  lexicalWeight = 0
} = {}) {
  // 词法路径不走 cacheOnly：它是降级时的唯一来源，缓存缺失时必须能自建索引，
  // 否则降级会返回空结果而不是可用的词法结果。
  const lexical = queryContext({ projectRoot, prompt, forceRefresh, decisionIntent });
  const { index, config } = ensureIndex(projectRoot, false, true);
  return enrichContextWithEmbedding(lexical, index, config, {
    projectRoot, prompt, env, semanticWeight, routedWeight, lexicalWeight
  });
}

// CLI 与首轮 hook 共用排序规则；调用方决定能否扫描知识来源。
async function enrichContextWithEmbedding(lexical, index, config, {
  projectRoot, prompt, env, semanticWeight = 1, routedWeight = 1, lexicalWeight = 0
}) {
  if (config.routes.some((route) => route.exclusive && lexical.matchedRoutes.includes(route.id))) {
    return { ...lexical, mode: "explicit" };
  }
  if (index.documents.length === 0) {
    return { ...lexical, mode: "lexical", embedding: { enabled: false, reason: "索引为空" } };
  }

  const routed = lexical.results.filter((item) => item.match?.type === "explicit");
  const routedRank = new Map(routed.map((item, position) => [item.path, position + 1]));
  const routedPaths = new Set(routed.map((item) => item.path));
  const decisionChoices = new Map();
  if (lexical.decisionIntent) {
    const rankedDecisions = rankDecisions(index, prompt, lexical.decisionIntent, { includeUnmatched: true });
    const counts = new Map();
    for (const result of rankedDecisions) counts.set(result.path, (counts.get(result.path) ?? 0) + 1);
    for (const result of rankedDecisions) {
      // Embeddings describe the whole file. With no lexical evidence they cannot
      // select one of several eligible decisions inside it; do not guess a block.
      if (result.score === 0 && counts.get(result.path) > 1) continue;
      if (!decisionChoices.has(result.path)) decisionChoices.set(result.path, result);
    }
    if (decisionChoices.size === 0) return { ...lexical, mode: "lexical",
      embedding: { enabled: false, reason: "没有可定位的已分类决定；可用 topic/id 缩小查询，或用 all 检索未分类正文" } };
  }

  const { ensureEmbeddingIndex, semanticRank } = await import("./embed.mjs");
  const prepared = await ensureEmbeddingIndex(index, { projectRoot, env });
  if (!prepared.ok) {
    return {
      ...lexical,
      mode: "lexical",
      embedding: { enabled: false, reason: prepared.reason, source: prepared.config?.source ?? "none" }
    };
  }

  const ranked = await semanticRank(index, prepared.vectors, prompt, prepared.config);
  if (!ranked.ok) {
    return {
      ...lexical,
      mode: "lexical",
      embedding: { enabled: false, reason: ranked.reason, source: prepared.config.source }
    };
  }

  // 候选数量遵守项目预算；完整显式读取链由配置维护者控制。
  const limit = config.limits.maxResults;

  // 词法名次表：用于融合，未命中的文档给一个大于列表长度的名次。
  const lexicalRank = new Map();
  lexical.results.forEach((item, position) => {
    if (!lexicalRank.has(item.path)) lexicalRank.set(item.path, position + 1);
  });
  // 语义排名必须在排除任务工件之后重新编号。
  // 任务工件（prd.md/design.md）会把查询词原样复读，语义相似度虚高，
  // 若先编号再过滤，真实候选的名次会被它们无谓地推后（实测推后 10 位以上）。
  const semanticAllowed = ranked.scored
    .filter((item) => !isTaskArtifact(item.document) &&
      (!lexical.decisionIntent || decisionChoices.has(item.document.path)))
    .map((item) => item.document.path);
  const semanticRankMap = new Map(semanticAllowed.map((p, i) => [p, i + 1]));
  const candidates = new Set([
    ...routedPaths,
    ...lexicalRank.keys(),
    ...semanticAllowed.slice(0, 40)
  ]);
  const fused = [];
  const rrfK = 60;
  // 显式节点已固定在前；权重仅影响后续补充候选。
  for (const candidatePath of candidates) {
    const route = routedRank.get(candidatePath);
    const lex = lexicalRank.get(candidatePath);
    const sem = semanticRankMap.get(candidatePath);
    const score =
      (route ? routedWeight / (rrfK + route) : 0) +
      (lex ? lexicalWeight / (rrfK + lex) : 0) +
      (sem ? semanticWeight / (rrfK + sem) : 0);
    fused.push({ path: candidatePath, score, route, lex, sem });
  }
  fused.sort((left, right) =>
    (left.route ?? Infinity) - (right.route ?? Infinity) || right.score - left.score
  );

  const byPath = new Map(index.documents.map((item) => [item.path, item]));
  // 人工读取链是流程约束，不因相似度、缓存缺项或候选数预算丢掉。
  const results = [...routed];
  for (const item of fused) {
    if (results.length >= limit) break;
    if (results.some((existing) => existing.path === item.path)) continue;
    const document = byPath.get(item.path);
    if (!document) continue;
    const lexicalEntry = lexical.results.find((entry) => entry.path === item.path);
    const reason = lexicalEntry?.reason ?? "语义匹配";
    const result = lexicalEntry ?? decisionChoices.get(item.path) ?? resultFromDocument(document, reason, item.score);
    results.push({
      ...result,
      score: item.score,
      match: {
        type: "hybrid",
        lexicalRank: item.lex ?? null,
        semanticRank: item.sem ?? null
      }
    });
  }

  // 覆盖度判定：基于语义首名相似度判断知识库是否真的涵盖该提问。
  const { assessCoverage, resolveCoverageConfig } = await import("./coverage.mjs");
  const coverageConfig = resolveCoverageConfig({ env });
  const coverage = assessCoverage(ranked.scored.filter((item) => !isTaskArtifact(item.document) &&
    (!lexical.decisionIntent || decisionChoices.has(item.document.path))), coverageConfig);

  return {
    ...lexical,
    results,
    mode: "hybrid",
    coverage,
    embedding: {
      enabled: true,
      source: prepared.config.source,
      model: prepared.config.model,
      cached: Boolean(prepared.cached)
    }
  };
}

/**
 * 带语义与覆盖度的钩子入口。
 *
 * 活动分支直接恢复，不对控制回复请求嵌入。首轮增强后的实际节点写入
 * 同一个会话图；只有显式 route 操作才能扩展或切换已有分支。
 */
export async function queryHookContextWithEmbedding({
  projectRoot,
  prompt,
  payload = {},
  env = process.env
}) {
  const base = queryHookContext({ projectRoot, prompt, payload, env });

  if (["focus", "unchanged"].includes(base?.routeState?.mode)) return base;

  const sessionKey = resolveHookSessionKey(payload, env);
  const initialGraph = readSessionGraph(projectRoot, sessionKey);
  const { index, config, cachePath } = ensureIndex(projectRoot, false, true);
  const context = await enrichContextWithEmbedding(base ?? {
    root: index.root, cachePath, scannedAt: index.scannedAt, stats: index.stats,
    matchedRoutes: [], results: [],
    trellis: fs.existsSync(path.join(index.root, ".trellis")),
    maxContextChars: config.limits.maxContextChars
  }, index, config, { projectRoot, prompt, env });
  if (!base && context.mode !== "hybrid") return null;
  if (context.mode !== "hybrid" || context.results.length === 0) return context;

  // 未覆盖的语义候选仍可作为提示，但不能建立一个以后只恢复、不再检索的分支。
  if (!base && context.coverage.verdict !== "covered") return context;
  if (!sessionKey) return context;
  const latestGraph = readSessionGraph(projectRoot, sessionKey);
  // 网络等待期间若另一个 route 已扩展或切换分支，以更新后的意图为准。
  if (JSON.stringify(latestGraph) !== JSON.stringify(initialGraph)) {
    return currentSessionFocus({ projectRoot, payload, env }) ?? context;
  }
  const graph = latestGraph ?? newSessionGraph(projectRoot);
  let branch = graph.branches.find((item) => item.id === graph.activeBranchId);
  if (branch) branch.nodes = context.results.map(sanitizeRouteResult);
  else {
    branch = createBranch(context, new Date().toISOString());
    graph.branches.push(branch);
    graph.activeBranchId = branch.id;
  }
  writeSessionGraph(projectRoot, sessionKey, graph);
  return contextWithState(context, {
    mode: base?.routeState?.mode ?? "created", branchId: branch.id,
    branchCount: graph.branches.length, nodeCount: branch.nodes.length
  });
}
