import fs from "node:fs";
import path from "node:path";
import { inspectTrellisPlatform } from "./trellis-platform.mjs";

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
 * 新项目初始化开发者；已有项目只补目标平台，不更换身份或重建任务。
 * 官方 CLI 负责写入模板，Atlas 负责检查 Codex 的核心入口是否齐全。
 */
export function ensureTrellis(root, { runCommand, platform = "codex", user = null } = {}) {
  const resolved = path.resolve(root);
  if (!looksLikeProjectRoot(resolved)) {
    return { created: false, skipped: true, reason: "该目录不像项目根，未自动初始化 Trellis。" };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(platform)) throw new Error("无效的 Trellis 平台参数。");
  const present = hasTrellis(resolved);
  const before = inspectTrellisPlatform(resolved, platform);
  if (present && before?.ready) return { created: false, present: true, ok: true, platform: before };

  if (typeof runCommand !== "function") {
    return { created: false, present, ok: false, skipped: true, platform: before, reason: "未提供命令执行能力" };
  }

  // Platform templates and project scripts evolve together. Do not silently
  // introduce newer Codex execution policy into an older project. No npm calls
  // here: installing/selecting a different CLI stays an explicit agent operation.
  const versionFile = path.join(resolved, TRELLIS_DIR, ".version");
  if (present && before && fs.existsSync(versionFile)) {
    const projectVersion = fs.readFileSync(versionFile, "utf8").trim();
    const version = runCommand("trellis", ["--version"], resolved);
    const cliVersion = String(version?.stdout ?? "").match(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/m)?.[0];
    if (version?.status !== 0 || !cliVersion || projectVersion !== cliVersion) {
      return { created: false, present, ok: false, platform: before, reason: "trellis-version-mismatch",
        projectVersion, cliVersion: cliVersion ?? null,
        stderr: `项目 Trellis ${projectVersion || "版本未知"} 与本机 CLI ${cliVersion || "版本不可读"} 不一致；请用项目同版本 CLI 执行 trellis init --codex -y 补装，或先审阅升级。未写入平台文件。` };
    }
  }

  let name = user;
  if (!present && !name) {
    const gitUser = runCommand("git", ["config", "user.name"], resolved);
    name = (gitUser?.stdout ?? "").trim() || "developer";
  }

  // -y already preserves existing files. --skip-existing forces Trellis's
  // full-init path and can change project metadata; omit it when adding a platform.
  const args = ["init", `--${platform}`, "-y"];
  if (!present) args.push("-u", name);
  const result = runCommand("trellis", args, resolved);
  const after = inspectTrellisPlatform(resolved, platform);
  const ok = result?.status === 0 && hasTrellis(resolved) && (!after || after.ready);
  let stderr = result?.stderr?.trim() || result?.error?.message || "";
  if (!ok && !stderr) stderr = result?.status === 0
    ? "Trellis CLI 已返回，但初始化或平台接入不完整。"
    : "Trellis CLI 执行失败；请确认已安装 @mindfoldhq/trellis。";
  if (after && !after.ready) stderr += `${stderr ? "\n" : ""}Codex 接入未完成：${[...after.missing, ...after.issues].join("；")}。已有登记可能使 init 跳过；先用 trellis update --dry-run 检查，不要强制覆盖。`;

  return {
    created: !present && hasTrellis(resolved),
    present,
    platformAdded: present && ok,
    platform: after,
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
