import fs from "node:fs";
import path from "node:path";

/**
 * Atlas 与 Trellis 的自举。
 *
 * 设计目标：用户不需要记住「先建哪个、跑哪条命令」。
 * 显式 bootstrap 补齐两边；普通 record 只补 Atlas。
 * 查询与 hook 不初始化项目。Trellis 的任务流程按需接入。
 *
 * 安全约束：
 * - 只在项目根目录操作，不向上越界，也不在用户主目录里凭空生成。
 * - 已有配置一律不动，本模块只做「缺失补齐」。
 * - Trellis 的初始化交给官方 CLI，不自己拼装它的目录结构。
 */

const ATLAS_DIR = ".atlas";
const ATLAS_CONFIG = path.join(ATLAS_DIR, "config.json");
const TRELLIS_DIR = ".trellis";

function hasAtlas(root) {
  return fs.existsSync(path.join(root, ATLAS_CONFIG));
}

function hasTrellis(root) {
  return fs.existsSync(path.join(root, TRELLIS_DIR));
}

/**
 * 判断目录是否可以作为一个项目的根。
 *
 * 拒绝在系统目录或用户主目录直接建项目，避免误操作在错误的 cwd 下
 * 生成一堆配置文件。判据是「有版本控制目录或已有项目特征文件」。
 */
export function looksLikeProjectRoot(root) {
  let resolved;
  try { resolved = fs.realpathSync(root); } catch { return false; }
  const home = process.env.HOME || "";
  if (home && (resolved === path.resolve(home) ||
    (fs.existsSync(home) && resolved === fs.realpathSync(home)))) return false;
  if (resolved === path.parse(resolved).root) return false;

  const markers = [
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "AGENTS.md",
    "README.md",
    TRELLIS_DIR,
    ATLAS_DIR
  ];
  return markers.some((marker) => fs.existsSync(path.join(resolved, marker)));
}

/**
 * 初始化 Atlas。
 *
 * 与 CLI 的 `atlas init` 行为一致，但以函数形式提供，
 * 使 record 能在需要时自动补建，而不必让用户先跑一条命令。
 * Trellis 存在时自动带上其数据源。
 */
export function ensureAtlas(root, { initProject, trellis = null } = {}) {
  const resolved = path.resolve(root);
  if (!looksLikeProjectRoot(resolved)) {
    return { created: false, skipped: true, reason: "该目录不像项目根，未自动初始化。请显式运行 atlas init ." };
  }
  if (hasAtlas(resolved)) {
    return { created: false, present: true, configPath: path.join(resolved, ATLAS_CONFIG) };
  }
  try {
    const configPath = initProject(resolved, { trellis: trellis === null ? hasTrellis(resolved) : trellis });
    return { created: true, configPath };
  } catch (error) {
    return { created: false, error: error.message };
  }
}

/**
 * 初始化 Trellis。
 *
 * 交给官方 CLI，参数缺一个都会卡在交互提示，因此三个都给全。
 * 开发者名字取 git 配置，取不到时用一个中性默认值。
 */
export function ensureTrellis(root, { runCommand, platform = "codex", user = null } = {}) {
  const resolved = path.resolve(root);
  if (!looksLikeProjectRoot(resolved)) {
    return { created: false, skipped: true, reason: "该目录不像项目根，未自动初始化 Trellis。" };
  }
  // 已存在时明确标记 present，避免调用方把「已存在」误报成「未初始化」。
  if (hasTrellis(resolved)) return { created: false, present: true };

  if (typeof runCommand !== "function") {
    return { created: false, skipped: true, reason: "未提供命令执行能力" };
  }

  let name = user;
  if (!name) {
    const gitUser = runCommand("git", ["config", "user.name"], resolved);
    name = (gitUser?.stdout ?? "").trim() || "developer";
  }

  const result = runCommand("trellis", ["init", `--${platform}`, "-y", "-u", name], resolved);
  const ok = result?.status === 0;
  let stderr = result?.stderr ?? "";
  // 命令不存在时 stderr 为空但 status 非 0，给出可操作的提示。
  if (!ok && !stderr.trim()) stderr = "trellis 命令未找到，请先 npm install -g @mindfoldhq/trellis";

  return {
    created: fs.existsSync(path.join(resolved, TRELLIS_DIR)),
    ok,
    user: name,
    stderr: stderr.trim()
  };
}

/**
 * 一次补齐两边。
 *
 * 顺序是「先 Trellis 后 Atlas」：Atlas 的数据源配置依赖 `.trellis` 是否存在，
 * 反过来的话 Atlas 会以「无 Trellis」的默认配置建出来，之后需要再 sync 一次才能接入。
 */
export function bootstrapProject(root, { initProject, runCommand, platform, user } = {}) {
  const resolved = path.resolve(root);
  if (!looksLikeProjectRoot(resolved)) throw new Error("该目录不像项目根，未初始化 Atlas 或 Trellis。请先确认项目路径。");
  const steps = [];

  const trellis = ensureTrellis(resolved, { runCommand, platform, user });
  steps.push({ name: "trellis", ...trellis });

  const atlas = ensureAtlas(resolved, { initProject, trellis: hasTrellis(resolved) });
  steps.push({ name: "atlas", ...atlas });

  return {
    root: resolved,
    trellis: hasTrellis(resolved),
    atlas: hasAtlas(resolved),
    steps
  };
}

export { hasAtlas, hasTrellis };
