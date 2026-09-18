---
name: atlas
description: Route the model to the smallest relevant project knowledge set before non-trivial work, record durable findings into maintained canonical sources, and bootstrap Atlas plus Trellis when task tracking is requested. Use when a project has distributed docs, Trellis artifacts, stale or conflicting claims, reusable learnings, knowledge entry points, runbooks, contracts, or architectural decisions; also use when the user asks to write something down, or to start task tracking in a project that has not been initialized.
---

# Atlas

Treat project knowledge as a routed source-of-truth graph, not a folder to scan
and not a second task database. Atlas has two modes: **route before work** and
**reconcile after verification**.

## Route before work

If the current model input already contains `[Atlas route]` or `[Atlas focus]`,
this routing step is already complete. Follow the injected paths and ranges directly;
do not rerun `context`, `route`, or `focus` for the same intent, and do not
locate this skill again. Never construct a path inside the Codex plugin cache or
pin a plugin version directory; use the installed `atlas` command for any
later route operation.

1. Find the nearest `.atlas/config.json`.
2. Run the installed router with the current request:

   ```bash
   atlas context --prompt "<current request>"
   ```

3. Make the returned files and line ranges the first repository-content read.
   Do not precede them with `git status`, directory walks, broad grep, or source
   scans. Follow at most the returned one-hop relations unless evidence requires
   broader discovery.
4. Treat the route as a discovery hint, not authority. Re-verify facts that may
   have drifted against current code, schema, tests, configuration, or runtime.
5. If no route is returned, use focused search. Do not compensate by traversing
   all documentation.

The `UserPromptSubmit` hook performs the same lookup when a project opts in.
It injects paths, roles, line ranges, and reasons—not document contents. Atlas
keeps a session-scoped active route graph outside the repository. The hook
restores the current branch instead of semantically searching each latest
sentence, so acknowledgements, refusals, and clarifications cannot replace
useful context.

Before executing a non-trivial operation that the active nodes do not cover,
derive one concise intent from the full conversation and run:

```bash
atlas route --root . --prompt "<complete current execution intent>"
```

Do not call `route` for conversational control replies. The command returns
only newly added nodes when expanding the current branch, creates a preserved
branch for a disjoint domain, and reactivates an existing branch when returning
to it. Use `atlas focus --root .` only when the active branch needs to be
inspected explicitly. `atlas context` remains the stateless lookup.

When the complete task specifically asks for a current decision or historical
trade-offs, use `context` or `route` with `--intent current` or `--intent history`.
These modes select classified decisions only: accepted for current, rejected or
superseded for history. Use the default `all` for facts, procedures, proposals,
and unclassified prose. An empty decision result does not prove there is no
answer: search the ordinary sources with `all`. Explicit read chains always
retain their configured order and states; check each record before using it.

## Source precedence

Use the claim's maintained owner rather than a global directory preference:

1. current code, schema, tests, configuration, and verified runtime;
2. maintained canonical docs, API contracts, runbooks, and ADRs;
3. project instructions and knowledge entry points;
4. `.trellis/spec/` as implementation constraints;
5. active Trellis task artifacts as task intent or working evidence;
6. archived tasks and chat/memory as historical evidence.

Trellis owns resumable task state. Atlas owns knowledge discovery and
canonical-source routing. Neither hook depends on the other's execution order.

## Reconcile after verification

Before preserving anything durable, find the source that already owns the
claim. Do not create a parallel page because the current owner is inconvenient.

1. **Discover** — name the claim and stable identity key; inspect the routed
   sources and focused evidence.
2. **Verify** — prefer current evidence and state what remains unverified.
3. **Reconcile** — minimally update the one maintained owner, resolve conflicts,
   or report `no durable update`.
4. **Structure** — link toward the canonical owner; keep current facts,
   procedures, decisions, task state, and historical evidence in their jobs.
5. **Validate** — re-run the relevant route/search and check changed links.

For a decision with non-obvious trade-offs, preserve the actual alternatives,
costs, evidence, and conditions for reconsideration in its existing owner. Keep
that explanation in the same change as the implementation. Enforce mechanically
checkable promises with focused tests; a document's shape cannot prove its truth.
See [reconciliation patterns](references/operating-model.md#reconcile-before-writing).

Do not persist secrets, transient debugging output, guesses, or duplicated
current facts.

## Bootstrap on first use

A project may have neither Atlas nor Trellis set up. Execute setup for the
authorized scope instead of asking the user to run commands by hand. Knowledge
routing can use Atlas alone (`atlas init .`). Only bootstrap both when the user
requests Trellis integration or resumable task tracking.

```bash
atlas bootstrap . --platform codex      # 补齐两边、sync、建立索引
```

Plain `atlas record --claim` fills missing Atlas configuration, reuses existing
Trellis sources, and refreshes the index. It does not create Trellis. Queries and
hooks do not initialize projects; structured decisions require existing setup.
Automatic setup requires a project marker and refuses the home or filesystem
root. In an empty directory, confirm the intended project before explicit init.
Bootstrap text and JSON modes both sync and index; existing configuration is kept.
No command guarantees that an agent records every finding: carry out the verified
reconciliation step yourself, or report `no durable update`.

## Record a durable finding

When the user says to write something down — a design principle, a decision, an
operational fact — record it instead of leaving it in the conversation:

```bash
atlas record --claim "<the finding>" --title "<short heading>"
```

`record` suggests ownership by lexical overlap in `docs/` and appends a claim.
It does not verify facts, detect contradictions, or replace an outdated fact.
Read and verify the owner before using it; use `--owner` when ownership is known.
Update existing prose directly when correcting a fact instead of appending a
contradictory dated entry.
When nothing matches (typical in a new project) it creates a new document whose
**filename carries the topic** — that naming is what makes the file findable
later, so keep `--title` meaningful rather than generic.

Fingerprinting skips repetitions in the selected owner after normalizing
whitespace and punctuation; it does not detect paraphrases or duplicates in
other files.

For a reusable decision whose status matters, use optional structured records
in the **existing indexed owner**. Prepare temporary JSON with `id`, `title`,
`status`, `claim`, `reason`, and (for a settled decision) `evidence`. Include
`revisit` when there is a meaningful condition for reconsideration. Use the
user's actual choice and verified evidence; never infer acceptance from task
progress. See the [decision contract](references/operating-model.md#structured-decisions).

```bash
atlas record --decision-file /tmp/decision.json --owner <existing-owner.md> --dry-run --json
atlas record --decision-file /tmp/decision.json --owner <existing-owner.md> --json
```

These are agent operations, not a form the user needs to fill in. Read the owner
first. To revise an existing ID, pass its current `fingerprint` from `context
--json` as `--expect HASH`; reread after a conflict. A changed settled conclusion
gets a new ID, then the old record becomes `superseded` with `supersededBy` set to
that ID. Keep the old rationale. The command refreshes the index; confirm the
intended decision and reason are reachable afterward. It does not bootstrap
Trellis or migrate ordinary prose. Plain `--claim` cannot modify these blocks.

For mutually exclusive choices in the same owner and applicability scope, use
the same optional `topic` key (include environment/version when those differ).
Preview before writing and read `reviewCandidates`, including rejected choices.
Two accepted decisions in that topic produce `decision-conflict`, with the old
claim, rationale, evidence, and fingerprint. Verify the actual semantic conflict
against the user's intent and current evidence; similarity or a shared topic
alone cannot tell which choice is correct. For a verified reversal, use a new
accepted ID plus `--supersede OLD_ID --expect OLD_FINGERPRINT` to replace both
blocks atomically. If intent remains unresolved, ask one focused question.
Never invent a different topic to bypass a conflict. Ordinary prose and records
without a topic still require focused semantic review; absence of a warning is
not proof of consistency.

Routes retain decision status in lexical, hybrid, and restored session results.
`proposed`, `rejected`, and `superseded` are not current decisions; `accepted`
still needs checking against current evidence. No metadata means **unclassified**,
not implicitly accepted. Classification is separate from source role and task state.

## Index lifecycle

The index is generated cache outside the repository. `.atlas/config.json` is
the portable, reviewable routing policy.

```bash
atlas init . --trellis
atlas sync .                 # 修正知识层 + 装适配器 + 注册钩子（幂等）
atlas index .
atlas doctor .
atlas context --root . --prompt "test the consumer API"
```

`atlas sync` is the single entry for project setup: it fixes the English-only
rule Trellis templates write into `spec/*/index.md`, installs the no-task
silence adapter, registers the injection hook, and reports where spec content
mixes facts with constraints. It refreshes an existing Atlas index. Run it after
`trellis init` and after any `trellis update`. Preview changes with `--dry-run`,
which leaves files and cache untouched. It does not migrate spec facts or create
a second knowledge owner.

Hook registration appends rather than replaces: the Trellis hook stays, Atlas
adds a second one. They do different jobs — Trellis injects workflow state,
Atlas injects knowledge routes.

Prompt lookup only reads the cache and never starts a repository scan. An
explicit `atlas index` scans only configured knowledge sources and only
rereads changed files. Run it after changing maintained knowledge or route
configuration.

The prompt hook injects three parts: Atlas's Chinese action list for the current
Trellis state, the coverage verdict, then the knowledge route.

Explicit routes preserve the configured reading order and sections. Exclusive
routes bypass embeddings; otherwise semantic retrieval can fill remaining slots.
Literal matching remains the offline fallback. The returned list is a reading
order, not an answer. Follow-up hooks restore the delivered branch without
querying embeddings for the latest sentence.

**Read the coverage verdict before trusting the candidates.** When it says
`未覆盖` the knowledge base very likely has nothing on the topic — say so and
turn to code, runtime state, or the user instead of treating the candidates as
evidence. When it says `弱` the candidates may be only partly relevant; verify
before relying on them.

No coverage line may mean an explicit route, lexical fallback, restored focus,
or a semantic score above the threshold. Its absence is not evidence of coverage.

## Audit and detailed patterns

Use `scripts/atlas_audit.py` for an evidence-only Markdown inventory when links
or discoverability changed. Read
[references/operating-model.md](references/operating-model.md) for source roles,
Trellis coexistence, route design, and reconciliation examples.
