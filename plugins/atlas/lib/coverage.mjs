import { resolveEmbeddingConfig } from "./embed-config.mjs";

/**
 * 无答案检测。
 *
 * 动机：实际使用中「知识库里根本没有这个信息」是常见情况。此前的行为是
 * 返回相似度最高的若干文档，不给任何提示——模型会把不相关的候选当作答案依据。
 * 说「没有」比给一堆错误候选有用得多。
 *
 * 判据基于首名相似度的绝对值。阈值来自实测：用 100 道有答案的题与 20 道
 * 库中确实不存在的题对比，两者的首名相似度分布有明显分离——
 * 有答案题的中位 0.605、最低 0.412；无答案题的中位 0.384、最高 0.533。
 *
 * 实测取舍（阈值 → 召回率 / 误报率）：
 *   0.42 → 99% / 20%      0.48 → 86% / 10%      0.55 → 64% / 0%
 * 默认取 0.48：宁可偶尔对不相关的问题给出候选（可被模型自行判断），
 * 也不要频繁地对有答案的问题说「没有」（那会直接导致漏检）。
 */

const DEFAULT_THRESHOLD = 0.48;
const LOW_CONFIDENCE_RATIO = 0.9;

function envNumber(env, names, fallback) {
  for (const name of names) {
    const raw = env?.[name];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

/**
 * 解析阈值配置。允许按项目覆盖，便于语料差异大的项目自行校准。
 */
export function resolveCoverageConfig({ env = process.env } = {}) {
  const threshold = envNumber(env, ["ATLAS_COVERAGE_THRESHOLD"], DEFAULT_THRESHOLD);
  const disabled = /^(1|true|yes|on)$/i.test(env?.ATLAS_COVERAGE_DISABLED ?? "");
  return { threshold, disabled };
}

/**
 * 判定检索结果是否覆盖了提问。
 *
 * @param {Array<{score:number, document?:object}>} ranked 按相似度降序的候选
 * @param {object} options
 * @returns {{verdict:"covered"|"weak"|"uncovered", topScore:number, threshold:number, reason:string}}
 */
export function assessCoverage(ranked, { threshold = DEFAULT_THRESHOLD, disabled = false } = {}) {
  if (disabled) {
    return { verdict: "covered", topScore: ranked[0]?.score ?? 0, threshold, reason: "检测已关闭" };
  }
  if (!ranked || ranked.length === 0) {
    return { verdict: "uncovered", topScore: 0, threshold, reason: "没有可用的候选" };
  }

  const topScore = ranked[0].score;
  if (topScore >= threshold) {
    return { verdict: "covered", topScore, threshold, reason: "首名超过覆盖阈值" };
  }
  // 接近阈值时给出弱覆盖提示：候选可能相关但不是直接答案，提示模型自行复核。
  if (topScore >= threshold * LOW_CONFIDENCE_RATIO) {
    return {
      verdict: "weak",
      topScore,
      threshold,
      reason: "首名接近阈值，候选可能部分相关"
    };
  }
  return {
    verdict: "uncovered",
    topScore,
    threshold,
    reason: "首名低于覆盖阈值，知识库很可能没有该主题"
  };
}

/**
 * 生成给模型看的覆盖度提示。
 *
 * uncovered 时明确建议停止在本库中检索并转向其他途径；
 * weak 时提示核对而非直接采信。措辞避免绝对化，因为阈值判据是统计性的。
 */
export function formatCoverageNotice(assessment) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  if (assessment.verdict === "covered") return null;
  if (assessment.verdict === "weak") {
    return [
      `[Atlas 覆盖度] 弱：最佳候选相似度 ${pct(assessment.topScore)}，覆盖阈值为 ${pct(assessment.threshold)}。`,
      "候选可能只与提问部分相关，请核对内容后再采信；若明显不符，改用一次聚焦搜索或直接询问用户。"
    ].join("\n");
  }
  return [
    `[Atlas 覆盖度] 未覆盖：最佳候选相似度 ${pct(assessment.topScore)}，低于覆盖阈值 ${pct(assessment.threshold)}。`,
    "知识库很可能没有这个主题的当前事实，以下候选大概率不相关。",
    "不要把它们当成答案依据；应当说明未找到，并转向代码、运行态或向用户确认。"
  ].join("\n");
}

export { DEFAULT_THRESHOLD, LOW_CONFIDENCE_RATIO };
