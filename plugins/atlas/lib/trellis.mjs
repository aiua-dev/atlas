import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflowSteps } from "./actions.mjs";

// 只读 Trellis 状态,零写入。
//
// 活动任务是**会话级**的:Trellis 把它存在 .trellis/.runtime/sessions/<platform>_<sid>.json,
// 文件名规则属它的内部实现。所以这里走它自己的 CLI(`task.py current --source`)——那是
// Trellis 文档指定的排障入口,也是唯一稳定的接口面。没有 .trellis 时完全不调用 Python。

const CURRENT_PATTERN = /^Current task:\s*(.*)$/m;
const SOURCE_PATTERN = /^Source:\s*(.*)$/m;
const STALE_PATTERN = /^State:\s*stale\s*$/m;

const TASK_STATUS_TO_STATE = {
  planning: "planning",
  in_progress: "in_progress"
};

export function parseCurrentTaskOutput(stdout) {
  const text = String(stdout ?? "");
  const taskPath = (CURRENT_PATTERN.exec(text)?.[1] ?? "").trim();
  const source = (SOURCE_PATTERN.exec(text)?.[1] ?? "").trim();
  const stale = STALE_PATTERN.test(text);

  if (!taskPath || taskPath === "(none)") return { active: false, taskPath: "", source, stale };
  return { active: true, taskPath, source, stale };
}

export function parseTaskStatus(text) {
  try {
    const status = JSON.parse(String(text ?? "")).status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

export function runCommand(file, args, options) {
  // 不能用 execFileSync:task.py current --source 用退出码 1 表示"没有活动任务",
  // 那是正常结果而不是错误,抛异常会把 no_task 静默降级成"读不到状态"。
  const result = spawnSync(file, args, { ...options, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.stdout ?? "";
}

export function readTrellisState(root, { run = runCommand } = {}) {
  const trellisDir = path.join(root, ".trellis");
  const taskScript = path.join(trellisDir, "scripts", "task.py");
  if (!fs.existsSync(taskScript)) return { present: false, state: null };

  const python = process.env.ATLAS_PYTHON || "python3";
  const options = { cwd: root, timeout: 8000 };

  let active;
  try {
    active = parseCurrentTaskOutput(run(python, [taskScript, "current", "--source"], options));
  } catch (error) {
    // Trellis 侧任何失败都不该让 Atlas 的注入失效,但必须让 doctor 能看见。
    return { present: true, state: null, error: `${python} 调用失败: ${error.message}` };
  }

  if (!active.active) return { present: true, state: "no_task", source: active.source };

  const taskJson = path.isAbsolute(active.taskPath)
    ? path.join(active.taskPath, "task.json")
    : path.join(root, active.taskPath, "task.json");

  let status = null;
  try {
    status = parseTaskStatus(fs.readFileSync(taskJson, "utf8"));
  } catch {
    status = null;
  }

  return {
    present: true,
    state: TASK_STATUS_TO_STATE[status] ?? "in_progress",
    status,
    taskPath: active.taskPath,
    source: active.source,
    stale: active.stale
  };
}

export function readWorkflowSteps(root, { run = runCommand } = {}) {
  const workflow = path.join(root, ".trellis", "workflow.md");
  if (!fs.existsSync(workflow)) return [];
  try {
    return parseWorkflowSteps(fs.readFileSync(workflow, "utf8"));
  } catch {
    return [];
  }
}
