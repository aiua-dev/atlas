#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderDecision } from "../plugins/atlas/lib/decisions.mjs";

const coreOption = process.argv.indexOf("--core");
const core = coreOption < 0 ? new URL("../plugins/atlas/lib/core.mjs", import.meta.url)
  : pathToFileURL(path.resolve(process.argv[coreOption + 1]));
const { buildIndex, queryContext } = await import(core.href);
const corpus = JSON.parse(fs.readFileSync(new URL("benchmarks/decision-intent.json", import.meta.url), "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-decision-eval-"));
const priorCache = process.env.ATLAS_CACHE_DIR;
try {
  process.env.ATLAS_CACHE_DIR = path.join(root, "cache");
  fs.mkdirSync(path.join(root, ".atlas"));
  fs.writeFileSync(path.join(root, ".atlas/config.json"), JSON.stringify({ version: 1, entrypoints: [],
    sources: [{ glob: "docs/**/*.md", role: "canonical-doc", authority: 90 }],
    limits: { maxResults: 3, maxRelated: 0 } }));
  fs.mkdirSync(path.join(root, "docs"));
  for (const [file, records] of Object.entries(corpus.owners)) {
    fs.writeFileSync(path.join(root, file), `# 工程决策\n\n${records.map((item) => renderDecision(item)).join("\n\n")}\n`);
  }
  buildIndex(root);
  const rows = corpus.queries.map((item) => {
    const context = queryContext({ projectRoot: root, prompt: item.prompt, decisionIntent: item.intent, cacheOnly: true });
    const selected = context.results.map((result) => result.decisionId ?? null);
    const leakage = context.results.some((result) => {
      const decision = result.decisions?.find((record) => record.id === result.decisionId);
      return item.intent === "current" && (!decision || decision.status !== "accepted");
    });
    return { ...item, returned: selected, pass: item.expected === null ? context.results.length === 0
      : selected[0] === item.expected, wrongStatus: leakage };
  });
  const abstention = rows.filter((item) => item.expected === null);
  const result = { summary: { total: rows.length, passed: rows.filter((row) => row.pass).length,
    wrongStatusQueries: rows.filter((row) => row.wrongStatus).length,
    abstentionPassed: abstention.filter((row) => row.pass).length, abstentionTotal: abstention.length,
    mode: "lexical", limitation: "Synthetic decision-level acceptance corpus, not an estimate of real-world answer accuracy." }, rows };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  if (priorCache === undefined) delete process.env.ATLAS_CACHE_DIR; else process.env.ATLAS_CACHE_DIR = priorCache;
  fs.rmSync(root, { recursive: true, force: true });
}
