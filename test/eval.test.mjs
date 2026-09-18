import assert from "node:assert/strict";
import test from "node:test";
import { ndcgAt, top1Hit } from "../eval/metrics.mjs";

const results = (...paths) => paths.map((path) => ({ path }));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("无关结果占据名次，答案从首位后移必须降低 nDCG", () => {
  close(ndcgAt(results("answer"), ["answer"], 10), 1);
  close(ndcgAt(results("noise", "answer"), ["answer"], 10), 1 / Math.log2(3));
  close(ndcgAt(results("noise", "noise2", "answer"), ["answer"], 10), 0.5);
  assert.equal(ndcgAt(results("noise", "answer"), ["answer"], 1), 0);
});

test("支撑资料按低相关性计分，重复结果不刷分但仍占据位置", () => {
  const ideal = 3 + 1 / Math.log2(3);
  close(ndcgAt(results("answer", "answer", "support"), ["answer", "support"], 10), (3 + 0.5) / ideal);
  close(ndcgAt(results("support", "answer"), ["answer", "support"], 10), (1 + 3 / Math.log2(3)) / ideal);
});

test("glob 每项只认领一次，同一路径不能认领重叠的期望项", () => {
  close(ndcgAt(results("docs/a.md", "docs/b.md"), ["docs/*.md"], 10), 1);
  const expected = ["docs/*.md", "docs/a.md"];
  close(ndcgAt(results("docs/a.md", "docs/a.md"), expected, 10), 3 / (3 + 1 / Math.log2(3)));
});

test("空答案和空返回得零分，Top-1 保留命中任一期望文件的既有口径", () => {
  assert.equal(ndcgAt([], ["answer"], 10), 0);
  assert.equal(ndcgAt(results("answer"), [], 10), 0);
  assert.equal(top1Hit(results("support"), ["answer", "support"]), true);
  assert.equal(top1Hit(results("noise", "answer"), ["answer"]), false);
});
