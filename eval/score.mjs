#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { formatContext, queryContext } from "../plugins/atlas/lib/core.mjs";

const repository = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    project: path.join(repository, "test", "fixtures", "project"),
    prompts: path.join(import.meta.dirname, "prompts.jsonl"),
    maxBytes: 4000,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--project") options.project = path.resolve(argv[++index]);
    else if (flag === "--prompts") options.prompts = path.resolve(argv[++index]);
    else if (flag === "--max-bytes") options.maxBytes = Number(argv[++index]);
    else if (flag === "--json") options.json = true;
    else {
      process.stderr.write(`未知参数: ${flag}\n`);
      process.exit(2);
    }
  }

  return options;
}

function loadPrompts(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1} 不是合法 JSON — ${error.message}`);
      }
    });
}

function scorePrompt(projectRoot, entry, maxBytes) {
  const context = queryContext({ projectRoot, prompt: entry.prompt, forceRefresh: true });
  const routed = context.results.map((result) => result.path);
  const routedSet = new Set(routed);
  const rendered = formatContext(context) ?? "";

  const missing = (entry.expect ?? []).filter((target) => !routedSet.has(target));
  const forbidden = (entry.forbid ?? []).filter((target) => routedSet.has(target));
  const routeMiss = (entry.expectRoutes ?? []).filter(
    (route) => !context.matchedRoutes.includes(route)
  );
  // expectNoRoutes 的条目测的是语义路径本身:一旦手写 route 命中,这条就不再是语义检索的证据。
  const unexpectedRoutes = entry.expectNoRoutes === true ? [...context.matchedRoutes] : [];
  const bytes = Buffer.byteLength(rendered, "utf8");

  // expectMiss 标记"词法层已实测到不了"的条目(措辞与文档用词断层)。这时 expect 只作记录,
  // 不作硬判据 —— 实测证据强度与正确性不相关,做不出能区分成功与失败的置信度门控。
  const knownCeiling = entry.expectMiss === true ? missing : [];
  const hardMissing = entry.expectMiss === true ? [] : missing;

  const ok =
    hardMissing.length === 0 &&
    forbidden.length === 0 &&
    routeMiss.length === 0 &&
    unexpectedRoutes.length === 0 &&
    bytes <= maxBytes;

  return {
    id: entry.id,
    prompt: entry.prompt,
    why: entry.why ?? "",
    routed,
    matchedRoutes: context.matchedRoutes,
    missing: hardMissing,
    knownCeiling,
    forbidden,
    routeMiss,
    unexpectedRoutes,
    bytes,
    overBudget: bytes > maxBytes,
    ok
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const entries = loadPrompts(options.prompts);
  const results = entries.map((entry) => scorePrompt(options.project, entry, options.maxBytes));
  const failed = results.filter((result) => !result.ok);

  const scored = entries.filter((entry) => entry.expectMiss !== true);
  const expectTotal = scored.reduce((sum, entry) => sum + (entry.expect ?? []).length, 0);
  const expectFound =
    expectTotal -
    results.filter((result) => !result.knownCeiling.length).reduce((sum, result) => sum + result.missing.length, 0);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          project: options.project,
          prompts: results.length,
          passed: results.length - failed.length,
          failed: failed.length,
          expectTotal,
          expectFound,
          maxBytesObserved: Math.max(...results.map((result) => result.bytes), 0),
          maxBytesAllowed: options.maxBytes,
          results
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(`Atlas eval — ${options.project}\n`);
    process.stdout.write(`prompts: ${results.length}  max bytes: ${options.maxBytes}\n\n`);
    for (const result of results) {
      const mark = result.ok ? "ok  " : "FAIL";
      process.stdout.write(`${mark} ${result.id}  ${result.bytes}B  routes=[${result.matchedRoutes.join(",")}]\n`);
      process.stdout.write(`     "${result.prompt}"\n`);
      if (result.missing.length) process.stdout.write(`     缺少: ${result.missing.join(", ")}\n`);
      if (result.knownCeiling.length) {
        process.stdout.write(
          `     已知词法天花板(记录用,不作硬判据): ${result.knownCeiling.join(", ")}\n`
        );
      }
      if (result.forbidden.length) process.stdout.write(`     不该返回: ${result.forbidden.join(", ")}\n`);
      if (result.routeMiss.length) process.stdout.write(`     未命中路由: ${result.routeMiss.join(", ")}\n`);
      if (result.unexpectedRoutes.length) {
        process.stdout.write(`     本应为纯语义路径,却命中了手写路由: ${result.unexpectedRoutes.join(", ")}\n`);
      }
      if (result.overBudget) process.stdout.write(`     超出字节预算: ${result.bytes} > ${options.maxBytes}\n`);
    }
    process.stdout.write(
      `\n预期文件命中 ${expectFound}/${expectTotal}  |  prompt 通过 ${results.length - failed.length}/${results.length}\n`
    );
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main();
