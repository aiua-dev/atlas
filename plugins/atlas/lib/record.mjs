import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveOwnerPath } from "./owner-path.mjs";
import { parseDecisions } from "./decisions.mjs";

// 记录的目标目录：项目事实写进维护中的真源，不复制到 .trellis。
// 归属文件的候选顺序即权威优先级，与 .atlas/config.json 的 sources 保持一致。
const FACT_ROOTS = ["docs"];

// 一次性分析产物与历史归档不是「维护中的真源」，不参与归属判定。
// 它们体积大、术语重合度高，若参与打分必然压过 reference/ 下的常驻文档。
const OWNER_EXCLUDE_SEGMENTS = new Set(["analytics", "archive", "archives", "reports"]);

// 单条结论的篇幅上限，超出说明这不是一条「事实」而是一份文档，应走人工。
const MAX_CLAIM_CHARS = 2000;

// 归属判定的相对优势要求。绝对分数随文档规模浮动，无法定固定门槛；
// 改为要求首选明显优于次选，否则说明存在多个势均力敌的候选，应人工指定。
const OWNER_ADVANTAGE_RATIO = 1.5;

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/**
 * 中文没有词边界，按空格切分会把整句当成一个 token 而永远匹配不上。
 * 因此中日韩文段按二元字组切分，拉丁文段按词切分，两类结果合并。
 */
export function claimTerms(text) {
  const terms = new Set();
  const value = String(text ?? "").toLowerCase();
  for (const run of value.match(CJK_RUN_PATTERN) ?? []) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  const latin = value.replace(CJK_RUN_PATTERN, " ");
  for (const term of latin.split(/[^\p{L}\p{N}_-]+/u)) {
    if (term.length >= 2) terms.add(term);
  }
  return terms;
}

export function isCjk(text) {
  return CJK_PATTERN.test(text);
}

/**
 * 结论指纹用于幂等：同一结论重复提交时不重复写入。
 * 归一化空白与标点后再哈希，使措辞微调不会产生新条目。
 */
function claimFingerprint(claim) {
  const normalized = claim
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，。；：、,.;:!?！？"'"'（）()【】\[\]]/g, "")
    .toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function collectMarkdownFiles(root, dirs) {
  const found = [];
  for (const dir of dirs) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (current) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          if (OWNER_EXCLUDE_SEGMENTS.has(entry.name.toLowerCase())) continue;
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          found.push(full);
        }
      }
    };
    walk(base);
  }
  return found.sort();
}

/**
 * 按标题与正文的词面重合度为结论挑选归属文件。
 * 与检索层保持一致：确定性、可解释，不做语义推断；无法判定时报告而非猜测。
 */
export function resolveOwner(root, claim, { explicit } = {}) {
  if (explicit) {
    return { path: resolveOwnerPath(root, explicit), score: Number.POSITIVE_INFINITY, explicit: true };
  }

  const terms = claimTerms(claim);
  if (terms.size === 0) return null;

  let best = null;
  let runnerUp = 0;
  for (const file of collectMarkdownFiles(root, FACT_ROOTS)) {
    const content = readIfExists(file);
    if (content === null) continue;
    const lower = content.toLowerCase();
    const heading = headingTerms(content);
    let score = 0;
    for (const term of terms) {
      if (heading.has(term)) score += 8;
      if (lower.includes(term)) score += 2;
    }
    if (score === 0) continue;
    if (!best || score > best.score) {
      if (best) runnerUp = best.score;
      best = { path: relative(root, file), score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best) return null;
  // 存在势均力敌的候选时不猜，交回人工指定。
  if (runnerUp > 0 && best.score < runnerUp * OWNER_ADVANTAGE_RATIO) {
    return { ...best, ambiguous: runnerUp };
  }
  return best;
}

function headingTerms(content) {
  const terms = new Set();
  for (const line of content.split("\n")) {
    const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    for (const term of claimTerms(match[1])) terms.add(term);
  }
  return terms;
}

function sectionFor(root, ownerPath, claim) {
  const content = readIfExists(path.join(root, ownerPath)) ?? "";
  const lines = content.split("\n");
  const claimTermsSet = claimTerms(claim);
  let best = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{2,4})\s+(.+)$/.exec(lines[index].trim());
    if (!match) continue;
    const heading = match[2].toLowerCase();
    let score = 0;
    for (const term of claimTermsSet) {
      if (heading.includes(term)) score += 4;
    }
    // 末尾章节更可能是待追加位置，给同等相关度一个稳定偏好。
    const positionBias = index / lines.length;
    if (!best || score > best.score || (score === best.score && positionBias > best.positionBias)) {
      best = { line: index, title: match[2].trim(), level: match[1].length, score, positionBias };
    }
  }
  return best;
}

/**
 * 为找不到归属的结论创建一份新文档。
 *
 * 新项目里首次记录必然找不到归属：`docs/` 还不存在，或只有入口页。
 * 此时按结论的主题生成一个文件名承载内容语义的新文档——
 * 文件名承载内容是实测有效的关键，随机拼凑的名字会让这份文档之后搜不到。
 *
 * 命名规则：从结论里取出最长的拉丁标识符作为主词，取不到时用日期兜底。
 * 这不追求完美的命名，追求的是「有名字且名字与内容有关」，
 * 后续可由人改名或并入已有文档。
 */
function createOwnerFor(root, claim, { title } = {}) {
  const docsDir = path.join(root, "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  const heading = String(title ?? "").trim() || deriveHeading(claim);
  const slug = slugify(heading) || `note-${new Date().toISOString().slice(0, 10)}`;
  let candidate = path.join(docsDir, `${slug}.md`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(docsDir, `${slug}-${suffix}.md`);
    suffix += 1;
  }

  const body = [
    `# ${heading}`,
    "",
    "> 本文件由 Atlas 在记录项目理念时创建。请按需补充上下文，或并入已有的维护文档。",
    "",
    "---",
    "",
    "## 记录",
    ""
  ].join("\n");
  fs.writeFileSync(candidate, body, "utf8");
  return { path: path.relative(root, candidate).split(path.sep).join("/"), heading };
}

/** 从结论里提炼一个可读标题：优先用最长的拉丁词串，否则取前若干汉字。 */
function deriveHeading(claim) {
  const latin = [...String(claim).matchAll(/[A-Za-z][A-Za-z0-9_.:/-]{3,}/g)]
    .map((match) => match[0])
    .sort((left, right) => right.length - left.length);
  if (latin.length > 0) return latin[0].replace(/[_.:/-]+/g, "-").toLowerCase();

  const cjk = String(claim).replace(/[^\p{Script=Han}]/gu, "").slice(0, 12);
  return cjk || "项目记录";
}

function slugify(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

export function recordClaim(target, claim, { owner, date, createMissing = true, title } = {}) {
  const root = path.resolve(target);
  const text = String(claim ?? "").trim();
  if (!text) throw new Error("结论内容为空。");
  if (text.length > MAX_CLAIM_CHARS) {
    throw new Error(`结论超过 ${MAX_CLAIM_CHARS} 字，应作为独立文档人工撰写。`);
  }

  let resolved = resolveOwner(root, text, { explicit: owner });
  let createdOwner = null;
  // 无归属时新建文档而非拒绝：新项目首次记录必然如此，
  // 拒绝写入会让「聊完理念记下来」这条路径走不通。
  if (!resolved && createMissing) {
    createdOwner = createOwnerFor(root, text, { title });
    resolved = { path: createdOwner.path, score: 0, explicit: true };
  }
  if (!resolved) {
    return { root, recorded: false, reason: "no-owner", claim: text };
  }
  // 显式新建的文档不必再判歧义——它是为这条结论专门建的。
  if (!createdOwner && resolved.ambiguous) {
    return {
      root,
      recorded: false,
      reason: "ambiguous-owner",
      owner: resolved.path,
      runnerUp: resolved.ambiguous
    };
  }

  const ownerPath = path.join(root, resolved.path);
  const existing = readIfExists(ownerPath);
  if (existing === null) {
    return { root, recorded: false, reason: "owner-missing", owner: resolved.path };
  }

  const fingerprint = claimFingerprint(text);
  if (existing.includes(fingerprint)) {
    return { root, recorded: false, reason: "duplicate", owner: resolved.path, fingerprint };
  }

  const anchor = sectionFor(root, resolved.path, text);
  const knowledge = parseDecisions(existing);
  const inDecision = (line) => knowledge.decisions.some((item) => line >= item.line && line <= item.endLine);
  if (knowledge.issues.length || (anchor && inDecision(anchor.line + 1))) {
    return { root, recorded: false, reason: "decision-boundary", owner: resolved.path };
  }
  const stamp = date ?? new Date().toISOString().slice(0, 10);
  const entry = [`<!-- atlas:${fingerprint} -->`, `- ${text}`, `  （记录于 ${stamp}）`].join("\n");

  let updated;
  if (anchor) {
    const lines = existing.split("\n");
    // 找到该章节的正文结束位置：下一个同级或更高级标题之前。
    let insertAt = lines.length;
    for (let index = anchor.line + 1; index < lines.length; index += 1) {
      const match = /^(#{1,6})\s+/.exec(lines[index].trim());
      if (match && match[1].length <= anchor.level) {
        insertAt = index;
        break;
      }
    }
    while (insertAt > anchor.line + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    if (inDecision(insertAt + 1)) {
      return { root, recorded: false, reason: "decision-boundary", owner: resolved.path };
    }
    lines.splice(insertAt, 0, "", entry);
    updated = lines.join("\n");
  } else {
    updated = `${existing.replace(/\n+$/, "")}\n\n${entry}\n`;
  }

  fs.writeFileSync(ownerPath, updated, "utf8");
  return {
    root,
    recorded: true,
    owner: resolved.path,
    createdOwner,
    anchor: anchor?.title ?? null,
    fingerprint
  };
}

export function formatRecordResult(result) {
  if (result.reason === "decision-boundary") {
    return `未写入：${result.owner} 的目标位置属于决策块或存在无效决策。决策使用 --decision-file 更新；普通事实直接修改所属正文。`;
  }
  if (result.recorded) {
    return [
      `已记录到 ${result.owner}`,
      result.anchor ? `  章节：${result.anchor}` : "  追加至文末",
      `  指纹：${result.fingerprint}`
    ].join("\n");
  }
  if (result.reason === "no-owner") {
    return [
      "未找到归属文件，未写入。",
      "该结论不匹配 docs/ 下任何维护中的文档。",
      "若确属项目事实，请用 --owner 指定归属文件，或先建立对应文档。"
    ].join("\n");
  }
  if (result.reason === "ambiguous-owner") {
    return [
      `归属存在歧义，未写入。候选：${result.owner}（${result.runnerUp} 分另有接近者）。`,
      "请用 --owner 指定归属文件。"
    ].join("\n");
  }
  if (result.reason === "duplicate") {
    return `已存在相同结论，跳过：${result.owner}（指纹 ${result.fingerprint}）`;
  }
  return `归属文件不存在：${result.owner}`;
}
