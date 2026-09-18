import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  actionsFor,
  auditActions,
  formatActions,
  parseWorkflowSteps
} from "../plugins/atlas/lib/actions.mjs";

const fixturePath = path.join(import.meta.dirname, "fixtures", "workflow", "minimal.md");
const fixtureText = fs.readFileSync(fixturePath, "utf8");

// A real project turns this into a live drift check instead of a fixture check.
const liveProject = process.env.ATLAS_VERIFY_PROJECT;

function liveWorkflowText(root) {
  const script = path.join(root, ".trellis", "scripts", "get_context.py");
  const result = spawnSync("python3", [script, "--mode", "phase"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(result.status, 0, `get_context.py failed: ${result.stderr}`);
  return result.stdout;
}

test("parses the workflow step index with phases, tags, and trimmed titles", () => {
  const steps = parseWorkflowSteps(fixtureText);

  assert.equal(steps.length, 13);

  const byId = new Map(steps.map((step) => [step.id, step]));

  assert.deepEqual(
    { title: byId.get("1.0").title, phase: byId.get("1.0").phase, required: byId.get("1.0").required },
    { title: "Create task", phase: 1, required: true }
  );
  assert.equal(byId.get("1.3").title, "Configure context");
  assert.equal(byId.get("2.3").required, false);
  assert.equal(byId.get("2.3").tag, "on demand");
  assert.equal(byId.get("3.4").title, "Commit changes");
  assert.equal(byId.get("1.5").tag, "");
  assert.equal(byId.get("1.5").required, false);
});

test("the enforcement invariant holds: every required step reaches a per-state action list", () => {
  const steps = parseWorkflowSteps(fixtureText);
  const required = steps.filter((step) => step.required);

  assert.equal(required.length, 8, "fixture should carry 8 required steps");

  for (const step of required) {
    const reachable = ["no_task", "planning", "in_progress"].some((state) =>
      actionsFor(state, steps).some((action) => action.id === step.id)
    );
    assert.ok(reachable, `required step ${step.id} ${step.title} is unreachable — it would be silently skipped`);
  }
});

test("auditActions reports no gaps, orphans, untranslated entries, or dead text", () => {
  const audit = auditActions(parseWorkflowSteps(fixtureText));
  assert.deepEqual(audit, { uncovered: [], orphans: [], untranslated: [], deadText: [] });
});

test("each state renders a Chinese action list covering its phase's required steps", () => {
  const steps = parseWorkflowSteps(fixtureText);

  const planning = actionsFor("planning", steps);
  assert.deepEqual(planning.map((action) => action.id), ["1.1", "1.2", "1.3", "1.4", "1.5"]);
  assert.deepEqual(
    planning.filter((action) => action.required).map((action) => action.id),
    ["1.1", "1.3", "1.4"]
  );

  const inProgress = actionsFor("in_progress", steps);
  assert.deepEqual(
    inProgress.filter((action) => action.required).map((action) => action.id),
    ["2.1", "2.2", "3.3", "3.4"]
  );

  assert.deepEqual(actionsFor("no_task", steps).map((action) => action.id), ["1.0"]);

  const rendered = formatActions("in_progress", steps);
  assert.match(rendered, /^- 3\.4 提交变更$/m);
  assert.match(rendered, /^- 3\.3 更新 spec/m);
  assert.equal(formatActions("unknown-state", steps), "");
});

test("live project workflow matches Atlas's action model", { skip: liveProject ? false : "set ATLAS_VERIFY_PROJECT=<project root> to check against a real Trellis install" }, () => {
  const steps = parseWorkflowSteps(liveWorkflowText(liveProject));

  assert.ok(steps.length > 0, "no steps parsed from the live project");

  const audit = auditActions(steps);
  assert.deepEqual(
    audit.uncovered,
    [],
    `required steps missing from Atlas's model: ${audit.uncovered.map((step) => `${step.id} ${step.title}`).join(", ")}`
  );
  assert.deepEqual(audit.orphans, [], `Atlas models steps the workflow no longer defines: ${audit.orphans.join(", ")}`);
  assert.deepEqual(audit.untranslated, [], `modeled steps without Chinese text: ${audit.untranslated.join(", ")}`);
});
