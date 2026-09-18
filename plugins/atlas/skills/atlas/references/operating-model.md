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

- The prompt hook restores the active branch without requesting embeddings;
  it does not infer a new semantic intent from every latest sentence.
- The initial hybrid route persists the nodes actually delivered to the model.
  Semantic-only candidates establish a branch only when coverage is `covered`.
- The `route` command may use a deterministic explicit route to activate or add
  a branch.
- Before a new non-trivial execution boundary, the model summarizes the full
  conversational intent and calls `atlas route`.
- An overlapping route expands the current branch with delta nodes.
- A disjoint route creates another preserved branch.
- Routing back to an existing owner reactivates that branch.
- `atlas focus` reports the current branch without scanning the project.

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

An explicit index refresh enumerates configured knowledge roots. The default
`context` command can also build a missing or incompatible index. Indexing reuses
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

Explicit routes retain their configured order and sections in both lexical and
hybrid queries. Exclusive routes do not request embeddings. Non-exclusive routes
allow ranked supplements after the declared chain. This can lower answer-first
Top-1 when a route deliberately places prerequisites before the answer; change
an overly broad route in project config rather than overriding its order in the
retriever. Reconsider this boundary only with an explicit configuration contract
for unordered candidates. Tests in `test/hybrid.test.mjs` enforce these behaviors.

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

Preserve reasoning only when it helps a later maintainer avoid a plausible wrong
choice: the problem, actual alternatives and their strongest reasons, the chosen
trade-off, verification limits, and what would justify reconsideration. Follow the
owner's existing format; do not impose a second note tree, mandatory categories,
or archive seals. Keep rationale and implementation in the same change.

Fact corrections update the owning prose in place. When a decision reverses,
make the current owner unambiguous and preserve still-useful old reasoning in an
existing ADR or historical record with a successor link. Archive immutability
proves unchanged bytes, not current validity. The legacy `record --claim` command
only appends claims and cannot perform this reconciliation automatically.
Structured decisions support explicit identity-based updates as described below;
neither mode detects semantic contradictions or verifies a claim's truth.

The approach borrows decision rationale and enforceable invariants from
[write-notes-like-deepseek](https://github.com/czm15053/write-notes-like-deepseek/tree/a6073d3933a919b5407213ab94e8122f17c4210c).
Its fixed lifecycle/class tree and mandatory note format are not Atlas policy.
Decision acceptance, rejection, and supersession belong to knowledge lifecycle;
they are distinct from the task state Trellis owns. Maintained project sources
continue to own the facts and rationale.
Retaining those owners avoids another migration, index, and synchronization duty.

## Structured decisions

The product goal is continuity with little upkeep: a new session can find the
maintained owner, distinguish current choices from rejected or superseded ones,
read their rationale, and update the same record after verification. Atlas
provides deterministic references and write boundaries; the agent owns semantic
judgment. This is a testable direction, not a claim of globally optimal retrieval.

Ordinary facts and procedures keep their existing format. Opt in only when a
decision's identity and lifecycle help future work. Source roles describe where
knowledge comes from; `kind: decision` and its status describe how to use it.
Unmarked prose is unclassified, not automatically accepted.

Write temporary JSON input (or use `--decision-file -` for stdin):

```json
{
  "id": "remote-routing-index",
  "title": "Remote routing index",
  "status": "rejected",
  "topic": "routing.storage.offline",
  "claim": "Require a remote database for every route lookup.",
  "reason": "A mandatory network service prevents offline routing.",
  "evidence": "The product's offline fallback requirement.",
  "revisit": "If offline operation is no longer required."
}
```

Use `atlas record --decision-file /tmp/decision.json --owner <existing.md>`.
The owner must already be in configured knowledge sources, including custom
directories, and cannot be a task artifact. This mode never initializes Atlas
or Trellis. `--dry-run --json` previews the exact block without writing a file or
cache. Normal execution refreshes the index; refresh failures are reported
separately from a successful source write.

- Required fields: `id`, `title`, `status`, `claim`, `reason`; settled decisions
  also require `evidence`. Optional `revisit` states when to reconsider.
- Optional `topic` uses the ID format and groups mutually exclusive choices in
  the same owner and applicability scope. Include environment/version where
  relevant; different scopes may coexist. The agent assigns the key after
  reading the actual decisions, never from similarity alone.
- IDs are owner-local, 1–80 lowercase letters/digits/`.`/`_`/`-`, starting with
  a letter or digit. Values are single-line summaries of at most 2000 characters;
  evidence can contain Markdown links. Unknown fields are rejected.
- Status is `proposed`, `accepted`, `rejected`, or `superseded`. Acceptance is a
  decision, not proof of implementation or factual correctness.
- Retrying identical content does nothing. Updating the same ID requires
  `--expect` with the current block's SHA-256 fingerprint (returned by writes
  and `context --json`). This guards against stale edits; it is not an archive seal.
- A settled claim stays intact. Reversal uses a new ID and changes the old status
  to `superseded`, with `supersededBy` pointing to an accepted successor in the
  same owner. Missing targets and cycles are rejected. Cross-owner supersession
  is unsupported in this first increment; use ordinary maintained ADR links
  when needed instead of duplicating a decision to fit the tool.
- With a shared `topic`, attempting to add another accepted decision returns
  `decision-conflict` without source or cache writes. It includes the existing
  claim, rationale, evidence, line range, and fingerprint. Preview also returns
  other same-topic records as `reviewCandidates`; rejected/proposed alternatives
  are context for review, not automatic conflicts. Untagged records and ordinary
  prose still need semantic review, and cross-owner conflicts are not detected.
- After verifying a reversal, write the new accepted ID with `--supersede OLD_ID
  --expect OLD_FINGERPRINT`. Preview shows both blocks; a single file replacement
  marks the old decision superseded and inserts the new one. Old rationale and
  evidence remain intact. An outdated fingerprint stops the write; an identical
  retry is idempotent. This mode requires the same topic and an accepted old
  decision. A settled topic cannot be silently changed or removed.
- The readable block is bounded by `<!-- atlas:decision ID -->` and
  `<!-- /atlas:decision -->`. Its title and fields appear once in Markdown.
  Only that block is replaced; surrounding prose and line endings are retained.
  Fenced examples are ignored. Legacy `--claim` cannot modify a decision block.

Index version 4 adds topic terms to decision references and searches. Run `atlas index`
after upgrading or editing knowledge directly; a hook never rebuilds the index.
Both `index` and `doctor` report invalid blocks with owner and line number and
exit nonzero (`doctor` inspects the last indexed snapshot). Routing marks invalid
decision sources as requiring repair before use. Session focus refreshes changed
decision references from the cache, without reinterpreting a control reply.

Retrieval exposes status and exact rationale ranges in lexical, hybrid, and
explicit routes. Default `all` preserves general retrieval. The agent can select
`--intent current` (accepted) or `--intent history` (rejected/superseded) in
`context` and `route`. These are decision-only views, not classifications of all
project facts; proposals and unclassified prose remain discoverable with `all`.
Eligible decision sections compete before the result limit and document
deduplication, so matching old text elsewhere in a file cannot masquerade as a
current decision. Explicit chains still preserve the configured read order and
states, with an exception notice in the output. Empty results mean no matching
classified decision was found, not proof that no answer exists.

Hybrid retrieval filters document candidates by the same eligible decisions and
retains the selected section. File-level embeddings cannot distinguish several
eligible decisions with zero lexical evidence in one file; that file is omitted
from this specialized view until a more specific topic/ID query or an `all` lookup
resolves it. No prompt heuristic or additional model service classifies intent.
Current/history routes keep separate session branches; control replies retain
the chosen intent. After reindexing, a current branch follows a known supersession
chain to its accepted successor. Manually introduced multiple accepted decisions
for one topic are reported by index/doctor and withheld from specialized views
until reconciled; default/explicit routes expose the validation warning.

Text output includes the selected decision
and at most three additional references per owner (a direct successor first);
JSON retains all references. This keeps long decision logs within routing budgets.

The design follows the rationale and supersession principle in
[Michael Nygard's ADR article](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
[LongMemEval](https://arxiv.org/abs/2410.10813) distinguishes knowledge updates
and abstention from simple recall; its results are not Atlas measurements.
The local evidence is the end-to-end contract suites in `test/decisions.test.mjs`
and `test/decision-intent.test.mjs`, the synthetic decision-level benchmark, and
the existing retrieval benchmark. None proves an AI will always use the
returned knowledge correctly.

## Validation checklist

- The prompt route returns the intended source before Trellis task evidence.
- Archive paths are excluded from current routing.
- An unchanged second index reports reused files and zero rereads.
- Changed source or routing config becomes visible after reindex.
- Relative links point toward the canonical source rather than another copy.
- Delivery states the canonical source, evidence, lifecycle change, or
  `no durable update`.
