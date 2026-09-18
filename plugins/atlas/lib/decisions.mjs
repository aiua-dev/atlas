import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOwnerPath } from "./owner-path.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const STATUSES = new Set(["proposed", "accepted", "rejected", "superseded"]);
const FIELDS = {
  status: "Status", topic: "Topic", claim: "Decision", reason: "Rationale", evidence: "Evidence",
  revisit: "Revisit when", supersededBy: "Superseded by"
};

export function validateDecision(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("决策必须是 JSON 对象。");
  for (const key of Object.keys(input)) {
    if (!["id", "title", ...Object.keys(FIELDS)].includes(key)) throw new Error(`未知决策字段：${key}`);
  }
  const value = {};
  for (const key of ["id", "title", ...Object.keys(FIELDS)]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") throw new Error(`决策字段 ${key} 必须是字符串。`);
    value[key] = input[key].trim();
    if (/[\r\n]|<!--|-->/.test(value[key]) || value[key].length > 2000) {
      throw new Error(`决策字段 ${key} 必须是至多 2000 字的单行文本，不能包含 HTML 注释。`);
    }
  }
  if (!ID.test(value.id ?? "")) throw new Error("决策 id 必须是 1–80 位小写字母、数字、点、下划线或连字符。");
  if (value.topic !== undefined && !ID.test(value.topic)) throw new Error("决策 topic 使用与 id 相同的格式，表示同一 owner 中同一适用范围下的互斥选择。");
  if (!STATUSES.has(value.status)) throw new Error("决策 status 必须是 proposed、accepted、rejected 或 superseded。");
  for (const key of ["title", "claim", "reason"]) {
    if (!value[key]) throw new Error(`决策缺少 ${key}。`);
  }
  if (value.status !== "proposed" && !value.evidence) throw new Error("已定案的决策必须提供 evidence；它只记录依据，不证明内容正确。");
  if (value.status === "superseded") {
    if (!ID.test(value.supersededBy ?? "") || value.supersededBy === value.id) {
      throw new Error("superseded 决策必须用 supersededBy 指向同一 owner 中另一条决策 id。");
    }
  } else if (value.supersededBy) throw new Error("只有 superseded 决策可以设置 supersededBy。");
  return value;
}

export function renderDecision(input, newline = "\n") {
  const value = validateDecision(input);
  return [
    `<!-- atlas:decision ${value.id} -->`,
    `### ${value.title}`,
    "",
    ...Object.entries(FIELDS).filter(([key]) => value[key]).map(([key, label]) => `- ${label}: ${value[key]}`),
    "<!-- /atlas:decision -->"
  ].join(newline);
}

// Only explicit, paired blocks opt in. Fenced examples never become decisions.
// Prose remains the source: the fields appear once, as readable Markdown.
export function parseDecisions(text) {
  const lines = text.split(/\r?\n/);
  const decisions = [];
  const issues = [];
  let fence = null;
  let start = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (line.startsWith("<!-- atlas:decision")) {
      if (start !== null) issues.push({ line: i + 1, message: "决策块不能嵌套。" });
      else start = i;
      continue;
    }
    if (line !== "<!-- /atlas:decision -->") continue;
    if (start === null) { issues.push({ line: i + 1, message: "决策块缺少开始标记。" }); continue; }
    try {
      const id = /^<!-- atlas:decision ([^ ]+) -->$/.exec(lines[start])?.[1];
      const input = { id, title: /^### (.+)$/.exec(lines[start + 1] ?? "")?.[1] };
      for (const body of lines.slice(start + 2, i).filter((item) => item.trim())) {
        const field = Object.entries(FIELDS).find(([, label]) => body.startsWith(`- ${label}: `));
        if (!field || input[field[0]] !== undefined) throw new Error("决策块含未知内容或重复字段；请保留完整字段格式。");
        input[field[0]] = body.slice(field[1].length + 4);
      }
      const value = validateDecision(input);
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      const block = lines.slice(start, i + 1).join(newline);
      decisions.push({ ...value, kind: "decision", line: start + 1, endLine: i + 1,
        fingerprint: crypto.createHash("sha256").update(block).digest("hex") });
    } catch (error) { issues.push({ line: start + 1, message: error.message }); }
    start = null;
  }
  if (start !== null) issues.push({ line: start + 1, message: "决策块未闭合。" });
  const ids = new Set();
  for (const item of decisions) {
    if (ids.has(item.id)) issues.push({ line: item.line, message: `重复决策 id：${item.id}` });
    ids.add(item.id);
    if (item.status === "superseded") {
      const seen = new Set([item.id]);
      let next = item;
      while (next?.status === "superseded" && !seen.has(next.supersededBy)) {
        seen.add(next.supersededBy);
        next = decisions.find((entry) => entry.id === next.supersededBy);
      }
      if (next?.status !== "accepted") issues.push({ line: item.line,
        message: `决策 ${item.id} 的取代链必须在同一 owner 中终止于 accepted 决策。` });
    }
  }
  return { decisions, issues };
}

export function recordDecision(target, input, { owner, expect, supersede, dryRun = false } = {}) {
  const value = validateDecision(input);
  if (!owner) throw new Error("结构化决策需要 --owner：先读取并确认已有真源，不按词面猜测归属。");
  const root = path.resolve(target);
  const resolved = { path: resolveOwnerPath(root, owner) };
  if (!/\.md$/i.test(resolved.path)) throw new Error("决策 owner 必须是 Markdown 文件。");
  const file = path.join(root, resolved.path);
  const existing = fs.readFileSync(file, "utf8");
  const parsed = parseDecisions(existing);
  if (parsed.issues.length) throw new Error(`owner 中存在无效决策：${parsed.issues[0].message}`);
  const previous = parsed.decisions.find((item) => item.id === value.id);
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = renderDecision(value, newline);
  const fingerprint = crypto.createHash("sha256").update(block).digest("hex");
  const result = { root, owner: resolved.path, id: value.id, status: value.status, fingerprint };
  const reviewCandidates = value.topic ? parsed.decisions.filter((item) =>
    item.id !== value.id && item.topic === value.topic && item.status !== "superseded") : [];
  const conflicts = value.status === "accepted" ? reviewCandidates.filter((item) =>
    item.status === "accepted" && item.id !== supersede) : [];
  if (conflicts.length) return { ...result, recorded: false, reason: "decision-conflict", conflicts, reviewCandidates };
  const replaced = supersede ? parsed.decisions.find((item) => item.id === supersede) : null;
  const retry = previous?.fingerprint === fingerprint && replaced?.status === "superseded" && replaced.supersededBy === value.id;
  if (supersede && !retry) {
    if (previous || !replaced || replaced.status !== "accepted" || value.status !== "accepted" ||
        !value.topic || value.topic !== replaced.topic) {
      throw new Error("--supersede 需要同一 topic 下已采纳的旧决定，以及使用新 id 的 accepted 决定。");
    }
    if (expect !== replaced.fingerprint) throw new Error("旧决定已变化或缺少指纹：读取旧决定后用 --expect 提供其 fingerprint。");
  }
  if (previous?.fingerprint === fingerprint) return { ...result, recorded: false, reason: "duplicate" };
  if (previous && expect !== previous.fingerprint) throw new Error("决策已存在或已变化：读取当前块，并用 --expect 提供其 fingerprint 后再更新。");
  if (!previous && expect && !supersede) throw new Error("--expect 对应的决策不存在，未写入。");
  if (previous?.topic && previous.status !== "proposed" && value.topic !== previous.topic) {
    throw new Error("已定案决策的 topic 不能更换或移除；不同范围的决定使用新 id。");
  }
  if (previous && previous.status !== "proposed" && previous.claim !== value.claim) {
    throw new Error("已定案决策的结论必须保留；使用新 id 记录新结论，再取代旧决定。");
  }
  if (previous && previous.status !== "proposed" && value.status !== previous.status && value.status !== "superseded") {
    throw new Error("已定案决策不能改写为另一个结论；新建决策 id，再将旧决定标记 superseded。");
  }
  if (previous?.status === "superseded" && value.status !== "superseded") throw new Error("被取代的决策不能重新激活。");
  let updated;
  if (previous) {
    const lines = existing.split(/\r?\n/);
    lines.splice(previous.line - 1, previous.endLine - previous.line + 1, block);
    updated = lines.join(newline);
  } else {
    updated = `${existing}${existing.endsWith(newline) ? "" : newline}${newline}${block}${newline}`;
  }
  let replacedBlock;
  if (replaced) {
    const oldInput = Object.fromEntries(["id", "title", ...Object.keys(FIELDS)]
      .filter((key) => replaced[key] !== undefined).map((key) => [key, replaced[key]]));
    replacedBlock = renderDecision({ ...oldInput, status: "superseded", supersededBy: value.id }, newline);
    const lines = updated.split(/\r?\n/);
    lines.splice(replaced.line - 1, replaced.endLine - replaced.line + 1, replacedBlock);
    updated = lines.join(newline);
  }
  const checked = parseDecisions(updated);
  if (checked.issues.length) throw new Error(checked.issues[0].message);
  const action = replaced ? "supersede" : previous ? "update" : "insert";
  if (dryRun) return { ...result, recorded: false, reason: "dry-run", action,
    reviewCandidates, preview: [replacedBlock, block].filter(Boolean).join(newline + newline) };
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, updated, { encoding: "utf8", flag: "wx", mode: fs.statSync(file).mode });
    if (fs.readFileSync(file, "utf8") !== existing) throw new Error("owner 在写入前发生变化，未覆盖；请重新读取。");
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { ...result, recorded: true, action, ...(replaced ? { superseded: replaced.id } : {}) };
}

export function decisionReference(item) {
  const { id, title, status, topic, line, endLine, fingerprint, supersededBy } = item;
  return { id, title, kind: "decision", status, line, endLine, fingerprint,
    ...(topic ? { topic } : {}), ...(supersededBy ? { supersededBy } : {}) };
}

export function validateDecisionIntent(intent = "all") {
  if (!["all", "current", "history"].includes(intent)) throw new Error("决策意图必须是 all、current 或 history。");
  return intent;
}

export function matchesDecisionIntent(item, intent) {
  return intent === "all" || (intent === "current" ? item.status === "accepted"
    : ["rejected", "superseded"].includes(item.status));
}

export function decisionConflictIssues(decisions) {
  const topics = new Map();
  for (const item of decisions) {
    if (item.topic && item.status === "accepted") {
      if (!topics.has(item.topic)) topics.set(item.topic, []);
      topics.get(item.topic).push(item);
    }
  }
  return [...topics].filter(([, items]) => items.length > 1).map(([topic, items]) => ({
    line: items[0].line, message: `同一 topic ${topic} 有多个 accepted 决定：${items.map((item) => item.id).join("、")}；先核对并归并，不能自动选定现行结论。`
  }));
}

export function formatDecisionReference(item) {
  const usage = { proposed: "待议，不是现行决定", accepted: "已采纳，仍需核对当前证据",
    rejected: "已拒绝，读取理由，勿作为现行方案", superseded: `已被 ${item.supersededBy} 取代，勿作为现行方案` };
  return `${item.id}: ${item.status}（${usage[item.status]}；lines ${item.line}-${item.endLine}）`;
}
