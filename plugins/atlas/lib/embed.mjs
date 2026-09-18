import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveEmbeddingConfig } from "./embed-config.mjs";

/**
 * 嵌入语义检索。
 *
 * 与词法检索的关系：词法是保底（零依赖、毫秒级、离线可用），
 * 嵌入是补充（语义匹配，对「按概念提问但知识用实体名存储」的断层有效）。
 * 实测在 app-manager 语料上，嵌入把总分从 49.0% 提到 63.5%。
 *
 * 索引策略：只嵌入「文件路径 + 标题 + 章节标题」，不嵌入全文。
 * 理由是实测证明检索失败的主因是文件名不承载内容语义，而非正文缺失；
 * 只嵌入标题层使索引规模从 88 万字符降到 2 万字符，成本与时延都可忽略。
 */

const VECTOR_CACHE_VERSION = 1;

/**
 * 构造用于嵌入的文档文本。
 *
 * 包含路径与标题层级：路径本身承载命名语义（实测新文件名让命中率大幅提升），
 * 标题链承载章节语义。正文不参与，避免长文档的向量被均值稀释。
 */
export function embeddingText(document) {
  const headings = (document.headings ?? []).map((item) => item.title).slice(0, 40);
  return [document.path, ...headings].join("\n").slice(0, 2000);
}

async function postJson(url, body, { apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`嵌入服务返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量取向量。按批切分以避免单请求过大被服务端拒绝。
 */
async function embedBatch(texts, config, batchSize = 64) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const chunk = texts.slice(start, start + batchSize);
    const payload = await postJson(
      config.endpoint,
      { model: config.model, input: chunk, encoding_format: "float" },
      config
    );
    const data = Array.isArray(payload?.data) ? payload.data : [];
    if (data.length !== chunk.length) {
      throw new Error(`嵌入返回条数不符：期望 ${chunk.length}，实得 ${data.length}`);
    }
    for (const item of data) {
      vectors.push(item.embedding);
    }
  }
  return vectors;
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 文档指纹：文档集合或命名变化时必须重算向量。
 * 用路径 + 标题链的组合哈希，而非文件 mtime——重命名不改内容但改语义，必须重建。
 */
export function corpusFingerprint(documents) {
  const hash = crypto.createHash("sha256");
  for (const document of [...documents].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(document.path);
    hash.update("\u0000");
    hash.update((document.headings ?? []).map((item) => item.title).join("|"));
    hash.update("\u0001");
  }
  return hash.digest("hex").slice(0, 32);
}

function vectorCachePath(index, config) {
  const key = crypto.createHash("sha256")
    .update(`${index.root}\u0000${config.model}\u0000${config.dimensions}`)
    .digest("hex")
    .slice(0, 20);
  const base = process.env.ATLAS_CACHE_DIR
    ? path.resolve(process.env.ATLAS_CACHE_DIR)
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "atlas");
  return path.join(base, key, "embeddings.json");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temp, file);
}

/**
 * 确保向量索引可用。
 *
 * 返回 {ok, vectors, reason}。失败时不抛错——调用方据此降级到词法。
 */
export async function ensureEmbeddingIndex(index, { projectRoot, env = process.env } = {}) {
  const config = resolveEmbeddingConfig({ projectRoot: projectRoot ?? index.root, env });
  if (!config.enabled || !config.apiKey) {
    return { ok: false, reason: config.reason ?? "未启用嵌入", config };
  }

  const fingerprint = corpusFingerprint(index.documents);
  const cachePath = vectorCachePath(index, config);
  const cached = readJsonSafe(cachePath);
  if (
    cached &&
    cached.version === VECTOR_CACHE_VERSION &&
    cached.fingerprint === fingerprint &&
    Array.isArray(cached.vectors) &&
    cached.vectors.length === index.documents.length
  ) {
    return { ok: true, vectors: cached.vectors, config, cachePath, cached: true };
  }

  const texts = index.documents.map((document) => embeddingText(document));
  try {
    const vectors = await embedBatch(texts, config);
    writeJsonAtomic(cachePath, {
      version: VECTOR_CACHE_VERSION,
      fingerprint,
      model: config.model,
      vectors
    });
    return { ok: true, vectors, config, cachePath, cached: false };
  } catch (error) {
    return { ok: false, reason: `嵌入索引构建失败：${error.message}`, config };
  }
}

/**
 * 语义排序。返回按相似度降序的 [文档, 分数] 列表。
 */
export async function semanticRank(index, vectors, prompt, config) {
  let queryVector;
  try {
    [queryVector] = await embedBatch([prompt], config);
  } catch (error) {
    return { ok: false, reason: `查询嵌入失败：${error.message}` };
  }
  const scored = index.documents.map((document, position) => ({
    document,
    score: cosine(queryVector, vectors[position])
  }));
  scored.sort((left, right) => right.score - left.score);
  return { ok: true, scored };
}

export { cosine };
