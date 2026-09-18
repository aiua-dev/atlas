import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Atlas 的嵌入服务配置。
 *
 * 优先级：环境变量 > 项目级 .atlas/.env.local > 用户级 .env.local > 内置默认值。
 * 内置值让本机开箱即用；.env.local 用于存放不应该进 git 与 npm 包的凭据；
 * 环境变量用于临时切换 provider 或覆盖凭据，适合 CI 与多账号场景。
 *
 * 凭据文件的位置与发布范围：
 * - 用户级：~/.atlas/.env.local（默认位置，不在任何项目仓库内）
 * - 项目级：<项目根>/.atlas/.env.local（需项目自行加入 .gitignore）
 * - 包内默认值不含凭据，凭据一律从上述两处或环境变量读取。
 */

// 用户级凭据路径。允许通过 ATLAS_HOME 覆盖，测试与多环境隔离都依赖这一点。
function userEnvPath(env) {
  const home = env?.ATLAS_HOME;
  return home ? path.join(home, ".env.local") : path.join(os.homedir(), ".atlas", ".env.local");
}
const PROJECT_ENV_RELATIVE = path.join(".atlas", ".env.local");

// 内置默认：provider 与模型固定，凭据留空。
// 模型选自 SiliconFlow 的中文能力较强的嵌入模型，维度 2560。
const BUILTIN = {
  endpoint: "https://api.siliconflow.cn/v1/embeddings",
  model: "Qwen/Qwen3-Embedding-4B",
  dimensions: 2560,
  timeoutMs: 15000
};

const ENV_KEYS = {
  apiKey: ["ATLAS_EMBED_API_KEY", "EMBED_API_KEY"],
  endpoint: ["ATLAS_EMBED_ENDPOINT", "EMBED_ENDPOINT"],
  model: ["ATLAS_EMBED_MODEL", "EMBED_MODEL"],
  dimensions: ["ATLAS_EMBED_DIMENSIONS", "EMBED_DIMENSIONS"],
  enabled: ["ATLAS_EMBED_ENABLED"],
  timeoutMs: ["ATLAS_EMBED_TIMEOUT_MS"]
};

/**
 * 解析 .env 格式的文本。只处理 KEY=VALUE、# 注释与空行，
 * 不引入 dotenv 依赖以保持零运行时依赖。
 */
export function parseEnvFile(text) {
  const out = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

function pick(sources, keyNames) {
  for (const source of sources) {
    for (const name of keyNames) {
      const value = source.get(name);
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

/**
 * 解析出完整的嵌入配置。
 *
 * @param {object} options
 * @param {string} [options.projectRoot] 项目根，用于读取项目级 .env.local
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量来源
 * @returns {{enabled:boolean, apiKey:string, endpoint:string, model:string, dimensions:number,
 *            timeoutMs:number, source:string, reason:string|null}}
 */
export function resolveEmbeddingConfig({ projectRoot, env = process.env } = {}) {
  const envMap = new Map(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const sources = [envMap];

  if (projectRoot) {
    const projectEnv = readEnvFile(path.join(projectRoot, PROJECT_ENV_RELATIVE));
    if (projectEnv.size > 0) sources.push(projectEnv);
  }
  const userEnv = readEnvFile(userEnvPath(env));
  if (userEnv.size > 0) sources.push(userEnv);

  const builtinMap = new Map([
    ["ATLAS_EMBED_ENDPOINT", BUILTIN.endpoint],
    ["ATLAS_EMBED_MODEL", BUILTIN.model],
    ["ATLAS_EMBED_DIMENSIONS", String(BUILTIN.dimensions)],
    ["ATLAS_EMBED_TIMEOUT_MS", String(BUILTIN.timeoutMs)]
  ]);
  sources.push(builtinMap);

  const apiKey = pick(sources.slice(0, 3), ENV_KEYS.apiKey) ?? "";
  const endpoint = pick(sources, ENV_KEYS.endpoint) ?? BUILTIN.endpoint;
  const model = pick(sources, ENV_KEYS.model) ?? BUILTIN.model;
  const dimensions = Number(pick(sources, ENV_KEYS.dimensions) ?? BUILTIN.dimensions);
  const timeoutMs = Number(pick(sources, ENV_KEYS.timeoutMs) ?? BUILTIN.timeoutMs);

  const explicit = pick(sources.slice(0, 3), ENV_KEYS.enabled);
  const enabled =
    explicit !== undefined ? /^(1|true|yes|on)$/i.test(explicit) : apiKey.length > 0;

  let reason = null;
  if (!enabled) {
    reason = explicit !== undefined ? "配置显式关闭" : "未提供嵌入凭据";
  }

  // 记录凭据来源，便于排查「为什么生效/没生效」。
  let source = "none";
  if (envMap.has("ATLAS_EMBED_API_KEY") || envMap.has("EMBED_API_KEY")) source = "env";
  else if (projectRoot && readEnvFile(path.join(projectRoot, PROJECT_ENV_RELATIVE)).has("EMBED_API_KEY")) source = "project";
  else if (userEnv.has("EMBED_API_KEY")) source = "user";
  else if (userEnv.has("ATLAS_EMBED_API_KEY")) source = "user";

  return { enabled, apiKey, endpoint, model, dimensions, timeoutMs, source, reason };
}

export function embeddingPaths(env = process.env) {
  return { user: userEnvPath(env), project: PROJECT_ENV_RELATIVE };
}

export const EMBEDDING_BUILTIN = { ...BUILTIN };
