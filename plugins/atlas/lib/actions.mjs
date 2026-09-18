const PHASE_PATTERN = /^###\s+Phase\s+(\d+)\s*[:：]\s*(.*)$/;
const STEP_PATTERN = /^-\s+(\d+\.\d+)\s+(.*)$/;
const TAG_PATTERN = /`\[([^\]]+)\]`/;

// Atlas 自己的动作清单,按 Trellis 的状态分组。
// 连接键是步骤 id(1.0 / 3.4 …),不是 Trellis 的英文措辞:改文案不会让这里失配,
// 而新增或删除必需步骤会被 auditActions 立刻报出来。
const STATE_STEPS = {
  no_task: ["1.0"],
  planning: ["1.1", "1.2", "1.3", "1.4", "1.5"],
  in_progress: ["2.1", "2.2", "2.3", "3.2", "3.3", "3.4"]
};

const STEP_TEXT = {
  "1.0": "创建任务(必须先取得同意)",
  "1.1": "需求探索:写 prd.md;复杂任务补齐 design.md 与 implement.md",
  "1.2": "研究:仅在需要时进行",
  "1.3": "配置上下文:声明本任务开工前要读哪些 spec 与研究材料",
  "1.4": "激活任务:过评审门后置为进行中",
  "1.5": "完成标准:明确本任务的验收标准",
  "2.1": "实现:按执行计划推进",
  "2.2": "质量检查:对照契约与验收标准",
  "2.3": "回滚:仅在需要时",
  "3.2": "调试回顾:仅在需要时",
  "3.3": "更新 spec:把本次结论归位到已有真源,或判定无需更新",
  "3.4": "提交变更"
};

function tidyTitle(value) {
  return value
    .replace(/\s+[—–]\s+.*$/, "")
    .replace(/\s*\(.*?\)\s*$/, "")
    .trim();
}

export function parseWorkflowSteps(text) {
  const steps = [];
  let phase = null;

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();

    const phaseMatch = PHASE_PATTERN.exec(line);
    if (phaseMatch) {
      phase = { number: Number(phaseMatch[1]), name: phaseMatch[2].trim() };
      continue;
    }

    const stepMatch = STEP_PATTERN.exec(line);
    if (!stepMatch) continue;

    const [, id, rest] = stepMatch;
    const tagMatch = TAG_PATTERN.exec(rest);
    const tag = tagMatch ? tagMatch[1].trim() : "";
    const head = tagMatch ? rest.slice(0, tagMatch.index) : rest;

    steps.push({
      id,
      phase: phase ? phase.number : null,
      title: tidyTitle(head),
      tag,
      required: tag.startsWith("required"),
      once: tag.includes("once")
    });
  }

  return steps;
}

export function actionsFor(state, steps) {
  const wanted = STATE_STEPS[state] ?? [];
  const byId = new Map(steps.map((step) => [step.id, step]));

  return wanted.map((id) => ({
    id,
    zh: STEP_TEXT[id] ?? "",
    title: byId.get(id)?.title ?? "",
    required: byId.get(id)?.required ?? false
  }));
}

export function formatActions(state, steps) {
  const actions = actionsFor(state, steps);
  if (actions.length === 0) return "";
  return actions
    .map((action) => `- ${action.id} ${action.zh}`)
    .join("\n");
}

export function formatActionsBlock(state, steps) {
  const body = formatActions(state, steps);
  if (!body) return "";
  return [
    `<atlas-actions state="${state}">`,
    "本回合流程动作(Atlas 按 Trellis 状态生成,步骤编号对应 .trellis/workflow.md):",
    body,
    "</atlas-actions>"
  ].join("\n");
}

export function auditActions(steps) {
  const modeled = Object.values(STATE_STEPS).flat();
  const modeledSet = new Set(modeled);
  const known = new Set(steps.map((step) => step.id));

  return {
    uncovered: steps
      .filter((step) => step.required && !modeledSet.has(step.id))
      .map((step) => ({ id: step.id, title: step.title })),
    orphans: modeled.filter((id) => !known.has(id)),
    untranslated: modeled.filter((id) => !STEP_TEXT[id]),
    deadText: Object.keys(STEP_TEXT).filter((id) => !modeledSet.has(id))
  };
}
