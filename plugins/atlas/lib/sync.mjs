import fs from "node:fs";
import path from "node:path";

import { claudeHookStatus, installClaudeHook } from "./claude-install.mjs";
import { codexHookStatus, installCodexHook } from "./codex-hook.mjs";

// Trellis 的模板在 spec/<layer>/index.md 末行写下英文强制规定。
// 这条规定决定后续所有规范内容的书写语言，是本修正层的首要目标。
const LANGUAGE_PATTERN =
  /^\s*\*\*Language\*\*:\s*All documentation should be written in \*\*English\*\*\.\s*$/;

const LANGUAGE_REPLACEMENT =
  "**语言**：本目录文档使用中文书写。代码标识符、命令、路径、字段名、枚举值、协议名与专有名词保留原文，不做翻译。";

// 约束特征：祈使语气、条件触发、质量门。命中应留在 spec。
const CONSTRAINT_PATTERNS = [
  /\b(Do not|Don't|Never|Must|Should not|Prefer|Always|Avoid)\b/i,
  /\bWhen\b.{2,60}\b(do|use|read|run|prefer|reject)\b/i,
  /(不得|禁止|必须|应当|优先|切勿)/,
  /(如果|若|仅当|只在).{1,40}(则|就|才|请)/
];

// 事实特征：环境状态、端点、清单式罗列。命中应迁往 docs/。
//
// 路径规则必须区分「系统用户目录」与「应用路由」。本项目存在
// /watchface/api/home/... 这类路由，其 /home/ 段与 Linux 用户目录同名。
// 因此要求路径首段前是行首、空白、引号、括号或赋值符，且首段后必须
// 跟一个目录分隔，使 `/Users/<name>/` 命中而 `/home/iosHomeList` 不命中。
const PATH_PREFIX = String.raw`(?<=^|[\s\`'"(=])`;
const FACT_PATTERNS = [
  {
    name: "个人绝对路径",
    pattern: new RegExp(
      `${PATH_PREFIX}(/(?:Users|Volumes|home)/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]*|~\/[A-Za-z0-9._-]+/|[A-Z]:\\\\)`
    )
  },
  { name: "网络端点", pattern: /(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d{2,5})?\b/ },
  { name: "环境标识", pattern: /(生产环境|测试环境|线上环境|预发环境|staging\b|production\b)/i },
  { name: "迁移脚本", pattern: /\.sql\b|migrate-[\w-]+\.sql/i },
  { name: "版本常量", pattern: /(`data_version`?\s*=\s*v?\d|版本[:：]\s*v?\d|snapshot\s+v\d\b)/i }
];

const SCENARIO_PATTERN = /^###\s+Scenario\s*[:：]\s*(.+)$/;

// 阈值留出余量：边界值报「膨胀」会产生大量噪音，只在明显超限时提示。
const BLOAT_LIMITS = {
  maxLines: 400,
  maxBytes: 48 * 1024,
  maxScenarios: 4
};

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function findSpecIndexFiles(root) {
  const specRoot = path.join(root, ".trellis", "spec");
  if (!fs.existsSync(specRoot)) return [];
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "index.md") {
        found.push(full);
      }
    }
  };
  walk(specRoot);
  return found.sort();
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * 修正 spec/<layer>/index.md 的英文强制规定。
 * 只替换末行的规定本身；索引表条目与正文由项目所有，不改写。
 */
function normalizeLanguageRule(root, { apply = true } = {}) {
  const changes = [];
  for (const file of findSpecIndexFiles(root)) {
    const content = readIfExists(file);
    if (content === null) continue;
    const lines = content.split("\n");
    const hitIndex = lines.findIndex((line) => LANGUAGE_PATTERN.test(line));
    if (hitIndex === -1) continue;
    const rel = relative(root, file);
    changes.push({
      path: rel,
      line: hitIndex + 1,
      from: lines[hitIndex].trim(),
      to: LANGUAGE_REPLACEMENT
    });
    if (apply) {
      lines[hitIndex] = LANGUAGE_REPLACEMENT;
      fs.writeFileSync(file, lines.join("\n"), "utf8");
    }
  }
  return changes;
}

/**
 * 按行判别约束与事实。单行同时命中两类时归为混合，不计入归类统计。
 */
export function classifySpecLine(line) {
  const text = line.trim();
  if (!text || text.startsWith("#") || text.startsWith("<!--")) return null;
  const isConstraint = CONSTRAINT_PATTERNS.some((pattern) => pattern.test(text));
  const factKinds = FACT_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => item.name);
  if (isConstraint && factKinds.length > 0) return null;
  if (isConstraint) return { kind: "constraint" };
  if (factKinds.length > 0) return { kind: "fact", reasons: factKinds };
  return null;
}

/**
 * 扫描 spec 文件的事实/约束成分与膨胀情况，只报告不自动改写。
 */
function inspectSpecFiles(root) {
  const specRoot = path.join(root, ".trellis", "spec");
  const reports = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name === "index.md") continue;
      const content = readIfExists(full);
      if (content === null) continue;

      const lines = content.split("\n");
      const bytes = Buffer.byteLength(content, "utf8");
      const scenarios = [];
      for (const line of lines) {
        const match = SCENARIO_PATTERN.exec(line.trim());
        if (match) scenarios.push(match[1].trim());
      }

      let constraintCount = 0;
      let factCount = 0;
      const factReasons = new Map();
      for (const line of lines) {
        const verdict = classifySpecLine(line);
        if (!verdict) continue;
        if (verdict.kind === "constraint") {
          constraintCount += 1;
          continue;
        }
        factCount += 1;
        for (const reason of verdict.reasons) {
          factReasons.set(reason, (factReasons.get(reason) ?? 0) + 1);
        }
      }

      const bloatReasons = [];
      if (lines.length > BLOAT_LIMITS.maxLines) bloatReasons.push(`${lines.length} 行`);
      if (bytes > BLOAT_LIMITS.maxBytes) bloatReasons.push(`${Math.round(bytes / 1024)} KB`);
      if (scenarios.length > BLOAT_LIMITS.maxScenarios) bloatReasons.push(`${scenarios.length} 个 Scenario`);

      const report = {
        path: relative(root, full),
        lines: lines.length,
        bytes,
        scenarios,
        constraintCount,
        factCount,
        factReasons: [...factReasons.entries()].sort((a, b) => b[1] - a[1]),
        bloat: bloatReasons
      };
      if (factCount > 0 || bloatReasons.length > 0) reports.push(report);
    }
  };
  if (fs.existsSync(specRoot)) walk(specRoot);
  return reports;
}

// 适配器安装到项目自有位置（.atlas/hooks/），不入 .trellis/，故不受 trellis update 影响。
const ADAPTER_DIR = path.join(".atlas", "hooks");
const ADAPTER_NAME = "trellis-active-only.py";

function adapterSourcePath() {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", ADAPTER_NAME);
}

function installAdapter(root, { apply = true } = {}) {
  const target = path.join(root, ADAPTER_DIR, ADAPTER_NAME);
  if (fs.existsSync(target)) {
    return { path: relative(root, target), status: "present" };
  }
  if (!apply) {
    return { path: relative(root, target), status: "pending" };
  }
  const source = adapterSourcePath();
  const content = readIfExists(source);
  if (content === null) {
    return { path: relative(root, target), status: "source-missing" };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o755 });
  return { path: relative(root, target), status: "installed" };
}

/**
 * 识别项目使用的平台，决定钩子往哪注册。
 *
 * 判据是各平台配置目录的存在性：`.claude/` 对应 Claude Code，
 * `.codex/` 对应 Codex（Codex 走插件 marketplace，钩子由插件提供，
 * 项目内只需安装无任务静默适配器）。
 * 两个都存在时都注册——多平台并存是常见情况，重复注册是幂等的。
 */
function detectPlatforms(root) {
  const platforms = [];
  if (fs.existsSync(path.join(root, ".claude"))) platforms.push("claude");
  if (fs.existsSync(path.join(root, ".codex"))) platforms.push("codex");
  return platforms;
}

export function syncTrellis(
  target,
  { apply = true, installAdapter: withAdapter = true, registerHooks = true } = {}
) {
  const root = path.resolve(target);
  const trellisPresent = fs.existsSync(path.join(root, ".trellis"));
  if (!trellisPresent) {
    return { root, trellisPresent: false, language: [], specReports: [], adapter: null, hooks: [] };
  }
  const language = normalizeLanguageRule(root, { apply });
  const specReports = inspectSpecFiles(root);
  const adapter = withAdapter ? installAdapter(root, { apply }) : null;

  // 钩子注册默认开启：让 `atlas sync` 一步完成项目接入，
  // 不需要用户再记住第二条命令。已注册时幂等跳过。
  const hooks = [];
  if (registerHooks && apply) {
    for (const platform of detectPlatforms(root)) {
      // 两个平台的注册位置与判定函数不同，但都幂等，且都只追加自己的那一条。
      const [status, install] =
        platform === "claude"
          ? [claudeHookStatus, installClaudeHook]
          : [codexHookStatus, installCodexHook];
      const before = status(root);
      if (before.registered) {
        hooks.push({ platform, status: "present", file: before.file });
        continue;
      }
      const result = install(root);
      hooks.push({ platform, status: "installed", file: result.file });
    }
  }

  return { root, trellisPresent: true, language, specReports, adapter, hooks };
}

export function formatSyncReport(result, { applied = true } = {}) {
  const lines = [];
  lines.push(`Atlas sync → ${result.root}`);
  if (!result.trellisPresent) {
    lines.push("未检测到 .trellis，无需修正。");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("## 语言规则");
  if (result.language.length === 0) {
    lines.push("已符合规范，无需修正。");
  } else {
    for (const change of result.language) {
      lines.push(`- ${change.path}:${change.line} ${applied ? "已替换" : "待替换"}英文强制规定`);
    }
  }

  lines.push("");
  lines.push("## 注入适配器");
  if (!result.adapter) {
    lines.push("已跳过。");
  } else if (result.adapter.status === "present") {
    lines.push(`- ${result.adapter.path} 已存在，保持不变。`);
  } else if (result.adapter.status === "installed") {
    lines.push(`- ${result.adapter.path} 已安装（无任务静默）。`);
  } else if (result.adapter.status === "pending") {
    lines.push(`- ${result.adapter.path} 待安装（dry-run）。`);
  } else {
    lines.push(`- ${result.adapter.path} 未安装：源文件缺失。`);
  }

  lines.push("");
  lines.push("## 钩子注册");
  if (!result.hooks || result.hooks.length === 0) {
    const platforms = [];
    if (fs.existsSync(path.join(result.root, ".claude"))) platforms.push("claude");
    lines.push(platforms.length === 0 ? "未识别到需要注册钩子的平台。" : "已跳过。");
  } else {
    for (const hook of result.hooks) {
      const label = hook.platform === "claude" ? "Claude Code" : hook.platform;
      const text =
        hook.status === "installed"
          ? "已注册"
          : hook.status === "present"
            ? "已存在，保持不变"
            : hook.status;
      lines.push(`- ${label}：${text}（${hook.file}）`);
    }
  }

  lines.push("");
  lines.push("## 事实与约束分布");
  if (result.specReports.length === 0) {
    lines.push("未发现需要关注的 spec 文件。");
  } else {
    for (const report of result.specReports) {
      const flags = [];
      if (report.factCount > 0) {
        const top = report.factReasons.slice(0, 3).map(([k, v]) => `${k}×${v}`).join("、");
        flags.push(`事实行 ${report.factCount}（${top}）`);
      }
      if (report.bloat.length > 0) flags.push(`膨胀：${report.bloat.join(" / ")}`);
      lines.push(`- ${report.path} — ${report.lines} 行，约束行 ${report.constraintCount}，${flags.join("；")}`);
      if (report.scenarios.length > 1) {
        lines.push(`  场景：${report.scenarios.join(" / ")}`);
      }
    }
  }
  return lines.join("\n");
}
