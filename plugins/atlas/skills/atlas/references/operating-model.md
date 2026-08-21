# Atlas Operating Model

## Separate task state from durable knowledge

| Layer | Owns | Does not own |
|---|---|---|
| Atlas route config | Knowledge source roles, intent routes, precedence, discovery limits | Business facts or task progress |
| Maintained docs/code/config | Current facts, contracts, runbooks, decisions | Session state |
| Trellis spec | Implementation constraints and project conventions | All current business/operational truth |
| Trellis task | Active intent, plans, working evidence, resumable state | Canonical long-term conclusions |
| Trellis archive | Historical evidence | Current truth without fresh verification |
| Generated Atlas cache | Search terms, headings, links, file metadata | A tracked or human-maintained artifact |

Atlas and Trellis can both use `UserPromptSubmit`. Each hook must be independent:
do not assume order, shared files, or another hook's output. Atlas only injects
knowledge paths and sections; Trellis may inject task/workflow state.

## Keep long sessions routed incrementally

Atlas stores a session-scoped active route graph in the generated cache, never
in project knowledge. The raw prompt and raw session identifier are not stored.
The session identity is hashed, and branches contain only routed paths,
sections, roles, and timestamps.

- The prompt hook restores the active branch; it does not infer a new semantic
  intent from every latest sentence.
- The `route` command may use a deterministic explicit route to activate or add
  a branch.
- Before a new non-trivial execution boundary, the model summarizes the full
  conversational intent and calls `atlas-router route`.
- An overlapping route expands the current branch with delta nodes.
- A disjoint route creates another preserved branch.
- Routing back to an existing owner reactivates that branch.
- `atlas-router focus` reports the current branch without scanning the project.

This makes intent classification conservative: uncertainty keeps the current
focus instead of replacing it. The model decides when execution crosses a
boundary; Atlas deterministically merges and retrieves paths.

## Route without full reads

Prompt handling uses progressive disclosure:

1. locate the nearest `.atlas/config.json`;
2. read the generated index outside the project;
3. apply deterministic intent routes first;
4. rank heading/path/body terms second;
5. expand at most one link hop;
6. return a bounded list of paths and exact sections.

Only an explicit index refresh enumerates configured knowledge roots. It reuses
entries whose size and modification time have not changed, so unchanged
documents are not reread. A prompt neither triggers that enumeration nor loads
matched document contents into context.

## Choose a source by its job

| Claim type | Typical canonical source | Supporting evidence |
|---|---|---|
| Current architecture, terminology, or contract | Reference or architecture document | Code, schema, tests, runtime configuration |
| Repeatable release, recovery, or support action | Runbook, script, or registry | Successful rehearsal or live verification |
| Significant trade-off | Decision record | Options, constraints, decision evidence |
| Active implementation intent | Trellis task/spec | Current request, plan, code changes |
| Completed investigation or release | Archived task, issue, or release record | Logs, commands, snapshots |

An archived record explains why a current source changed. It does not state the
current fact unless fresh evidence re-verifies it.

## Design intent routes

Use an explicit route when the same request requires a stable read chain. Each
`allOfAny` group is mandatory; terms within a group are alternatives:

```json
{
  "id": "consumer-api-test",
  "exclusive": true,
  "when": {
    "allOfAny": [
      ["接口测试", "测试接口", "测试", "request api"],
      ["consumer", "watchface", "token", "设备号"]
    ]
  },
  "read": [
    "docs/reference/consumer-auth-orders.md#iOS 测试会话",
    "docs/reference/deployment-topology.md",
    "docs/openapi.yaml"
  ]
}
```

Keep routes narrow enough to avoid injecting unrelated context. Point to an
existing source; never copy the source content into configuration. Do not put
secrets in route terms or reasons. Set `exclusive: true` when the declared read
chain is complete and semantic supplements would add noise.

## Reconcile before writing

Use a stable identity key to search before editing, for example:

```text
deployment fact: environment + service + host/alias
API contract: bounded context + endpoint/message + version
configuration: service + profile + configuration key
decision: system + decision subject
```

Classify matching sources privately as canonical current source, supporting
source, duplicate, historical evidence, or unresolved conflict. Write only
after the intended maintained owner is clear.

## Validation checklist

- The prompt route returns the intended source before Trellis task evidence.
- Archive paths are excluded from current routing.
- An unchanged second index reports reused files and zero rereads.
- Changed source or routing config becomes visible after reindex.
- Relative links point toward the canonical source rather than another copy.
- Delivery states the canonical source, evidence, lifecycle change, or
  `no durable update`.
