import { formatActionsBlock } from "./actions.mjs";
import { formatContext, queryHookContext, queryHookContextWithEmbedding } from "./core.mjs";
import { readTrellisState, readWorkflowSteps } from "./trellis.mjs";

// 合成一次注入:先给"这一回合要做什么"(Atlas 按 Trellis 状态生成的中文动作清单),
// 再给"要读什么"(知识路由)。
//
// 为什么由 Atlas 合成而不是照抄 Trellis 的 breadcrumb:见 README「与 Trellis 的分工」。
// 动作清单是 Atlas 自己的中文表述,与 Trellis 的英文步骤名解耦 —— 只有步骤编号是约定,
// 所以 Trellis 改文案不会让这里失配,而增删必需步骤会被 test/invariant.test.mjs 立刻报出来。
//
// 知识路由默认走混合检索(词法 + 嵌入语义 + 显式路由)。嵌入不可用时
// queryHookContextWithEmbedding 内部退回同步结果,行为与旧版一致。
export async function composeInjection({ root, prompt, payload, run, env = process.env }) {
  const trellis = readTrellisState(root, { run });
  const actions = trellis.state
    ? formatActionsBlock(trellis.state, readWorkflowSteps(root, { run }))
    : "";

  let context;
  try {
    context = await queryHookContextWithEmbedding({ projectRoot: root, prompt, payload, env });
  } catch {
    // 语义路径的任何异常都不应让钩子失效——退回同步词法结果。
    context = queryHookContext({ projectRoot: root, prompt, payload, env });
  }
  const routing = context ? formatContext(context, { hook: true }) : "";

  return [actions, routing].filter(Boolean).join("\n\n");
}
