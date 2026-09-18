#!/usr/bin/env node
/**
 * Atlas 检索质量评测。
 *
 * 评分口径沿用 OCE 的两维度独立打分，便于横向对照：
 * - Top-1：首位结果是否命中期望文件。硬判定，衡量排序链路的技术上限。
 * - nDCG@10：前 10 条整体的可用程度。位置敏感，给部分分。
 *
 * 相关性等级取自 expected_files 的书写顺序：首项 rel=2（真正回答问题），
 * 其余 rel=1（支撑上下文）。每项最多计一次，重复返回同一文件不刷分。
 *
 * 用法：
 *   node eval/run-retrieval-eval.mjs --repo <项目根> [--queries <jsonl>] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex, queryContext } from "../plugins/atlas/lib/core.mjs";
import { ndcgAt, top1Hit } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TOP_K = 10;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readQueries(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function run() {
  const repoRoot = arg("--repo");
  if (!repoRoot) throw new Error("需要 --repo <项目根>");
  const queryFile = path.resolve(
    arg("--queries", path.join(HERE, "benchmarks", "app-manager-retrieval-benchmark.jsonl"))
  );

  const queries = readQueries(queryFile);
  const root = path.resolve(repoRoot);

  // loadProject 通过向上查找 .atlas/config.json 定位项目，节点缓存也按项目路径哈希。
  // 因此必须先切到目标项目，否则会命中当前仓库自己的索引。
  const refresh = process.argv.includes("--refresh");
  const previousCwd = process.cwd();
  process.chdir(root);

  // 与生产路径一致：走真实索引与真实查询，不绕过任何一层。
  const { index } = buildIndex(root);

  const rows = [];
  for (const item of queries) {
    let results = [];
    let error = null;
    try {
      const context = queryContext({
        projectRoot: root,
        prompt: item.query,
        cacheOnly: true,
        forceRefresh: refresh
      });
      // queryContext 返回的 path 已是相对项目根的 POSIX 路径，无需再换算。
      results = (context?.results ?? []).map((entry) => ({
        path: String(entry.path).split(path.sep).join("/"),
        score: entry.score
      }));
    } catch (cause) {
      error = cause.message;
    }

    rows.push({
      id: item.id,
      category: item.category,
      difficulty: item.difficulty,
      query: item.query,
      expected: item.expected_files,
      returned: results.map((entry) => entry.path),
      top1: top1Hit(results, item.expected_files),
      ndcg: ndcgAt(results, item.expected_files, TOP_K),
      error
    });

    if (process.env.ATLAS_EVAL_DEBUG && item.id === "Q01") {
      process.stderr.write(
        `[debug] ${item.id} results=${JSON.stringify(results)}\n` +
        `[debug] expected=${JSON.stringify(item.expected_files)}\n` +
        `[debug] top1=${top1Hit(results, item.expected_files)} ndcg=${ndcgAt(results, item.expected_files, TOP_K)}\n`
      );
    }
  }

  process.chdir(previousCwd);

  const total = rows.length;
  const top1Count = rows.filter((row) => row.top1).length;
  const ndcgSum = rows.reduce((sum, row) => sum + row.ndcg, 0);
  const score = top1Count + ndcgSum;
  const maxScore = total * 2;

  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }

  const byDifficulty = new Map();
  for (const row of rows) {
    if (!byDifficulty.has(row.difficulty)) byDifficulty.set(row.difficulty, []);
    byDifficulty.get(row.difficulty).push(row);
  }

  const summary = {
    repo: root,
    queryFile,
    indexedDocuments: index.stats.documents,
    total,
    top1Count,
    top1Rate: total ? top1Count / total : 0,
    ndcgMean: total ? ndcgSum / total : 0,
    score: Number(score.toFixed(2)),
    maxScore,
    scoreRate: maxScore ? score / maxScore : 0,
    byCategory: [...byCategory.entries()].map(([category, items]) => ({
      category,
      total: items.length,
      top1: items.filter((row) => row.top1).length,
      ndcgMean: Number((items.reduce((sum, row) => sum + row.ndcg, 0) / items.length).toFixed(4))
    })),
    byDifficulty: [...byDifficulty.entries()].map(([difficulty, items]) => ({
      difficulty,
      total: items.length,
      top1: items.filter((row) => row.top1).length,
      ndcgMean: Number((items.reduce((sum, row) => sum + row.ndcg, 0) / items.length).toFixed(4))
    })),
    failures: rows.filter((row) => !row.top1).length
  };

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`Atlas 检索评测 → ${root}`);
  lines.push(`索引文档 ${index.stats.documents} | 题目 ${total} | 满分 ${maxScore}`);
  lines.push("");
  lines.push(`总分 ${summary.score} / ${maxScore}  (${(summary.scoreRate * 100).toFixed(1)}%)`);
  lines.push(`Top-1  ${top1Count} / ${total}  (${(summary.top1Rate * 100).toFixed(1)}%)`);
  lines.push(`nDCG@10 均值 ${summary.ndcgMean.toFixed(4)}`);
  lines.push("");
  lines.push("按类别：");
  for (const item of summary.byCategory) {
    lines.push(
      `  ${pad(item.category, 28)} Top-1 ${pad(`${item.top1}/${item.total}`, 7)} nDCG ${item.ndcgMean.toFixed(3)}`
    );
  }
  lines.push("");
  lines.push("按难度：");
  for (const item of summary.byDifficulty) {
    lines.push(
      `  D${item.difficulty}  Top-1 ${pad(`${item.top1}/${item.total}`, 7)} nDCG ${item.ndcgMean.toFixed(3)}`
    );
  }
  lines.push("");
  lines.push("未命中首位的用例：");
  for (const row of rows.filter((item) => !item.top1)) {
    lines.push(`  ${pad(row.id, 5)} ${row.query}`);
    lines.push(`        期望 ${row.expected.join(" | ")}`);
    lines.push(`        实返 ${row.returned.slice(0, 3).join(" | ") || "(空)"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

run();
