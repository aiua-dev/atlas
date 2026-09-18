import test from "node:test";
import assert from "node:assert/strict";

import {
  assessCoverage,
  resolveCoverageConfig,
  DEFAULT_THRESHOLD
} from "../plugins/atlas/lib/coverage.mjs";

// 阈值来自实测：有答案题的首名相似度中位 0.605、最低 0.412；
// 库中确实不存在的题中位 0.384、最高 0.533。用例取两侧的代表值。
const ANSWERABLE = [0.83, 0.71, 0.605, 0.52, 0.49];
// 0.53 是实测中无答案题的最高值，落在阈值之上，属边界外的少数；
// 这里用明显低于阈值的样本，以测「未覆盖」这一主路径。
const UNANSWERABLE = [0.45, 0.40, 0.384, 0.33, 0.315];
// 唯一的越界样本，单独用于验证误报率上限。
const UNANSWERABLE_OUTLIER = 0.53;

test("默认阈值与实测结论一致", () => {
  assert.equal(DEFAULT_THRESHOLD, 0.48);
});

test("首名超过阈值判为已覆盖", () => {
  const result = assessCoverage(ANSWERABLE.map((score) => ({ score })));
  assert.equal(result.verdict, "covered");
  assert.equal(result.topScore, 0.83);
});

test("首名明显低于阈值判为未覆盖", () => {
  // 取明确低于「弱覆盖下界」(阈值 * 0.9 = 0.432) 的样本。
  const clearlyLow = UNANSWERABLE.filter((score) => score < DEFAULT_THRESHOLD * 0.9);
  assert.ok(clearlyLow.length > 0);
  for (const score of clearlyLow) {
    assert.equal(assessCoverage([{ score }]).verdict, "uncovered", `相似度 ${score} 应判为未覆盖`);
  }
});

test("首名接近阈值判为弱覆盖", () => {
  // 阈值 * 0.9 = 0.432，取 0.45 落在弱覆盖区间。
  const result = assessCoverage([{ score: 0.45 }, { score: 0.4 }]);
  assert.equal(result.verdict, "weak");
});

test("空候选判为未覆盖", () => {
  assert.equal(assessCoverage([]).verdict, "uncovered");
  assert.equal(assessCoverage(null).verdict, "uncovered");
});

test("关闭开关时始终判为已覆盖", () => {
  const result = assessCoverage([{ score: 0.1 }], { disabled: true });
  assert.equal(result.verdict, "covered");
  assert.match(result.reason, /已关闭/);
});

test("阈值可通过环境变量覆盖", () => {
  const config = resolveCoverageConfig({ env: { ATLAS_COVERAGE_THRESHOLD: "0.6" } });
  assert.equal(config.threshold, 0.6);
  const fallback = resolveCoverageConfig({ env: {} });
  assert.equal(fallback.threshold, DEFAULT_THRESHOLD);
});

test("非法阈值回退到默认值", () => {
  const config = resolveCoverageConfig({ env: { ATLAS_COVERAGE_THRESHOLD: "abc" } });
  assert.equal(config.threshold, DEFAULT_THRESHOLD);
});

test("可关闭覆盖度检测", () => {
  const config = resolveCoverageConfig({ env: { ATLAS_COVERAGE_DISABLED: "true" } });
  assert.equal(config.disabled, true);
});

test("实测分布下未覆盖判定不误伤多数有答案的题", () => {
  // 阈值 0.48：有答案题召回 86%，无答案题误报 10%（见 coverage.mjs 注释）。
  const covered = ANSWERABLE.filter((score) => assessCoverage([{ score }]).verdict !== "uncovered");
  assert.ok(covered.length / ANSWERABLE.length >= 0.8, "有答案的题应多数被判为覆盖或弱覆盖");
  const samples = [...UNANSWERABLE, UNANSWERABLE_OUTLIER];
  const falsePositive = samples.filter(
    (score) => assessCoverage([{ score }]).verdict === "covered"
  );
  assert.ok(falsePositive.length / samples.length <= 0.2, "无答案的题不应频繁被判为覆盖");
});
