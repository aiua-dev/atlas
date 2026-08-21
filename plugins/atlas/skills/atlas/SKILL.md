---
name: atlas
description: Route Codex to the smallest relevant project knowledge set before non-trivial work, then reconcile durable findings into maintained canonical sources. Use when a project has distributed docs, Trellis artifacts, stale or conflicting claims, reusable learnings, knowledge entry points, runbooks, contracts, or architectural decisions.
---

# Atlas

Treat project knowledge as a routed source-of-truth graph, not a folder to scan
and not a second task database. Atlas has two modes: **route before work** and
**reconcile after verification**.

## Route before work

1. Find the nearest `.atlas/config.json`.
2. Run the installed router with the current request:

   ```bash
   atlas-router context --prompt "<current request>"
   ```

3. Read only the returned files and line ranges first. Follow at most the
   returned one-hop relations unless evidence requires broader discovery.
4. Treat the route as a discovery hint, not authority. Re-verify facts that may
   have drifted against current code, schema, tests, configuration, or runtime.
5. If no route is returned, use focused search. Do not compensate by traversing
   all documentation.

The `UserPromptSubmit` hook performs the same lookup when a project opts in.
It injects paths, roles, line ranges, and reasons—not document contents. The
hook pins the first confident route per Codex session and stays silent on later
turns, so arbitrary acknowledgements, refusals, and clarifications cannot
replace useful context. When a later turn starts a genuinely different
non-trivial task, run `atlas-router context` with the full conversational intent.

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

Do not persist secrets, transient debugging output, guesses, or duplicated
current facts.

## Index lifecycle

The index is generated cache outside the repository. `.atlas/config.json` is
the portable, reviewable routing policy.

```bash
atlas-router init . --trellis
atlas-router index .
atlas-router doctor .
atlas-router context --root . --prompt "test the consumer API"
```

Prompt lookup only reads the cache and never starts a repository scan. An
explicit `atlas-router index` scans only configured knowledge sources and only
rereads changed files. Run it after changing maintained knowledge or route
configuration.

## Audit and detailed patterns

Use `scripts/atlas_audit.py` for an evidence-only Markdown inventory when links
or discoverability changed. Read
[references/operating-model.md](references/operating-model.md) for source roles,
Trellis coexistence, route design, and reconciliation examples.
