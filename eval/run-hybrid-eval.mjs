#!/usr/bin/env node
/**
 * 混合检索评测：走产线同一条 queryContextWithEmbedding 链路。
 *
 * 与 run-retrieval-eval.mjs 的区别：
 * - 本脚本测的是**混合路径**（显式路由 + 语义 + 词法融合），会调用嵌入服务。
 * - run-retrieval-eval.mjs 测的是纯词法路径，离线可用，用于对照。
 *
 * 评分口径与 run-retrieval-eval.mjs 一致（Top-1 + nDCG@10），保证两者可比。
 *
 * 用法：
 *   node eval/run-hybrid-eval.mjs --repo <项目根> [--queries <jsonl>] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ndcgAt, top1Hit } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, "..", "plugins", "atlas", "lib", "core.mjs");

const TOP_K = 10;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const repoRoot = arg("--repo");
  if (!repoRoot) throw new Error("需要 --repo <项目根>");
  const queryFile = path.resolve(
    arg("--queries", path.join(HERE, "benchmarks", "app-manager-retrieval-benchmark.jsonl"))
  );
  const root = path.resolve(repoRoot);

  const { queryContextWithEmbedding } = await import(CORE);

  const queries = fs
    .readFileSync(queryFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  const rows = [];
  const modeCount = {};
  for (const item of queries) {
    const result = await queryContextWithEmbedding({ projectRoot: root, prompt: item.query });
    modeCount[result.mode] = (modeCount[result.mode] ?? 0) + 1;
    const returned = (result.results ?? []).map((entry) => ({
      path: String(entry.path).split(path.sep).join("/")
    }));
    rows.push({
      id: item.id,
      category: item.category,
      difficulty: item.difficulty,
      query: item.query,
      expected: item.expected_files,
      returned: returned.map((entry) => entry.path),
      top1: top1Hit(returned, item.expected_files),
      ndcg: ndcgAt(returned, item.expected_files, TOP_K),
      verdict: result.coverage?.verdict ?? null
    });
  }

  const total = rows.length;
  const top1 = rows.filter((row) => row.top1).length;
  const ndcgSum = rows.reduce((sum, row) => sum + row.ndcg, 0);
  const score = top1 + ndcgSum;

  const byCategory = {};
  for (const row of rows) {
    const bucket = (byCategory[row.category] ??= { total: 0, top1: 0, ndcg: 0 });
    bucket.total += 1;
    bucket.top1 += row.top1 ? 1 : 0;
    bucket.ndcg += row.ndcg;
  }

  const summary = {
    engine: "hybrid (routes + semantic + lexical)",
    repo: root,
    total,
    modes: modeCount,
    top1,
    top1Rate: Number((top1 / total).toFixed(4)),
    ndcgMean: Number((ndcgSum / total).toFixed(4)),
    score: Number(score.toFixed(2)),
    maxScore: total * 2,
    scoreRate: Number((score / (total * 2)).toFixed(4)),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([name, value]) => [
        name,
        {
          total: value.total,
          top1: value.top1,
          ndcgMean: Number((value.ndcg / value.total).toFixed(4))
        }
      ])
    ),
    failures: rows.filter((row) => !row.top1).map((row) => row.id)
  };

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`Atlas 混合检索评测 → ${root}`);
  lines.push(`题目 ${total} | 满分 ${total * 2} | 模式 ${JSON.stringify(modeCount)}`);
  lines.push("");
  lines.push(`总分 ${summary.score} / ${total * 2}  (${(summary.scoreRate * 100).toFixed(1)}%)`);
  lines.push(`Top-1  ${top1} / ${total}  (${(summary.top1Rate * 100).toFixed(1)}%)`);
  lines.push(`nDCG@10 均值 ${summary.ndcgMean}`);
  lines.push("");
  lines.push("按类别：");
  for (const [name, value] of Object.entries(summary.byCategory).sort(
    (left, right) => right[1].top1 - left[1].top1
  )) {
    lines.push(
      `  ${name.padEnd(28)} Top-1 ${`${value.top1}/${value.total}`.padEnd(7)} nDCG ${value.ndcgMean.toFixed(3)}`
    );
  }
  lines.push("");
  lines.push(`未命中首位 ${summary.failures.length} 题：${summary.failures.slice(0, 20).join(" ")}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
