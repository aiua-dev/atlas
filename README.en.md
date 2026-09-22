# Atlas

[简体中文](README.md) | English

Atlas is a project knowledge router for Codex. Before work starts, it gives the
model only the documents, sections, and read order needed for the current task.
After verification, it reconciles durable findings into their existing source
of truth.

> The npm package has moved to `@aiua/atlas`; the former `@a1ua/atlas` scope is
> no longer used.

It is designed to answer three practical questions instead of injecting more
documentation into every prompt:

- **What should Codex read?** Select the smallest relevant set from docs,
  contracts, runbooks, ADRs, and Trellis artifacts.
- **In what order?** Prefer current sources of truth, then constraints, active
  task intent, and historical evidence.
- **Where should findings go?** Update the maintained owner instead of copying
  facts into Trellis, Memory, or a new parallel directory.

## Quick start

Atlas requires Node.js 20+ and an installed Codex CLI.

```bash
npm install --global @aiua/atlas
atlas install
```

After installing or upgrading, fully quit and reopen Codex Desktop so the
running `app-server` reloads plugin hooks. Creating a new task is not a process
restart. Check Atlas hook enablement and trust in `/hooks`. Then initialize a project:

```bash
cd PROJECT_ROOT
atlas init .                       # Standalone knowledge routing
atlas doctor .
```

For a project that explicitly needs Trellis task tracking, install the Trellis CLI
and run `atlas bootstrap . --platform codex` instead. It fills missing setup,
syncs the integration, and builds the index in both text and JSON modes. Existing
configuration is preserved. `atlas sync .` also refreshes an existing Atlas index;
`--dry-run` changes neither files nor cache.

An existing `.trellis/` does not establish Codex readiness. `bootstrap --platform
codex` checks the core project skills and workflow hook, delegates missing setup
to `trellis init --codex -y`, then checks the result. It does not reset the developer
or task. If the project and CLI versions differ, select the matching official CLI
before adding the platform, or review a full upgrade separately. This avoids
silently mixing execution policies across template versions. `atlas doctor .
--platform codex` checks these local entry points; it does not prove runtime skill
loading or hook trust.

Commit the generated `.atlas/config.json`. The index and session route graph
remain in the user's cache and do not enter the repository. Generated
`.atlas/.gitignore` excludes `.env.local` credentials.

The skill asks the agent to reconcile verified, reusable findings after work, or
report `no durable update`. This is an agent workflow, not background chat capture
or a guarantee that every turn writes a record. Plain `record --claim` initializes
only Atlas when needed and refreshes the index after writing; it does not create
Trellis. Queries and hooks do not initialize projects. Structured decisions require
an existing indexed owner. Automatic setup rejects home, filesystem root, and
directories without project markers.

Trellis owns task state and working evidence; its spec files hold implementation
constraints. Facts, decisions, and rejected alternatives stay in their maintained
owners. `sync` reports mixed spec content but does not migrate it or resolve semantic
conflicts. The agent still needs to check ownership and avoid duplicate truths.

## How it works

Optional decision records live inside existing maintained sources. They preserve
proposed, accepted, rejected, and superseded status, rationale, evidence, and
conditions for reconsideration. The agent maintains the structure from the user's
natural-language intent; ordinary documents need no migration. Unmarked prose is
unclassified, not implicitly accepted. Routes expose status and exact read ranges.

`atlas record --decision-file <JSON> --owner <existing.md>` supports previews,
stable IDs, stale-edit protection, and automatic reindexing. Ordinary fact changes
still edit their owning prose; legacy `record --claim` only appends. See the
[decision contract](plugins/atlas/skills/atlas/references/operating-model.md#structured-decisions).
Run `atlas index .` after upgrading to rebuild the v4 index. Existing sessions
refresh changed decision references from that cache without changing task intent.

Agents can select `context/route --intent current` for accepted decisions or
`--intent history` for rejected/superseded rationale. Default `all` still retrieves
ordinary facts and unclassified documents. A shared optional `topic` prevents
silently adding competing accepted decisions. After reviewing the reported
conflict, use a new decision JSON with `record --supersede OLD_ID --expect HASH`
to replace the old and new blocks together. Topic assignment and semantic
conflict judgment remain the agent's responsibility.

```text
User request
  → UserPromptSubmit hook queries the existing index
  → returns a small set of paths, sections, line ranges, and reasons
  → Codex reads those sources first and performs the task
  → focused discovery happens only when evidence is missing or conflicting
  → verified findings update an existing owner, or report no durable update
```

The prompt hook only reads the existing knowledge index and never scans the
repository. `atlas index` explicitly refreshes it; the default `atlas context`
can also build a missing or incompatible index. `--lexical` reads the cache;
add `--refresh` to build or refresh it explicitly. Indexing reuses unchanged files
by metadata. Trellis archives, runtime state, `node_modules`, and Git data are
excluded by default.

Explicit routes preserve their declared order and sections. An `exclusive`
route neither adds candidates nor requests embeddings. Other queries can use
optional semantic retrieval, with deterministic lexical fallback when credentials
or the service are unavailable; `atlas context --lexical` forces offline lookup.
Similarity and coverage hints do not establish factual correctness. See the
[retrieval evaluation](eval/README.md) for measurements and limitations.

For long conversations, Atlas keeps a lightweight active route graph per Codex
session:

- Continuing in the same domain restores the active branch instead of searching
  the latest sentence.
- Expanding an intent adds only new nodes.
- Switching domains preserves the old branch and creates another.
- Returning to an earlier domain reactivates its branch.

Control replies such as “continue” or “do not create a task” therefore do not
erase useful project context.
This also applies with embeddings enabled: the initial delivered nodes are
stored in the active branch, and follow-up hooks restore them without requesting
new embeddings. Use `atlas route` with the complete intent to cross domains.

## Configure a fixed read chain

When a request always needs the same sources, add an explicit route to
`.atlas/config.json`:

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

Inspect the result:

```bash
atlas context --root . --prompt "test the consumer API"
```

## Commands

| Command | Purpose |
|---|---|
| `atlas skill` / `atlas skill --path` | Read the CLI's bundled skill / resolve its actual path without project configuration or Codex cache assumptions |
| `atlas install` | Register and install the bundled Codex plugin from the npm package |
| `atlas init . --trellis` | Create `.atlas/config.json` with Trellis source adapters |
| `atlas index .` | Incrementally build the project knowledge index |
| `atlas context --root . --prompt "..."` | Preview a stateless route for one request |
| `atlas context --optional --prompt "..."` | Route during daily work; return `not-configured` for a project that has not opted in |
| `atlas route --root . --prompt "..."` | Expand, switch, or reactivate the current session branch |
| `atlas focus --root .` | Show the active branch for the current session |
| `atlas doctor .` | Check configuration, index, Trellis integration, and hook status |

## Boundary with Trellis

Atlas complements Trellis and does not treat `.trellis` as the default source of
truth.

| Layer | Owns | Does not own |
|---|---|---|
| Current code, configuration, schema, and runtime | Verifiable current facts | Cross-session task state |
| Maintained docs, contracts, runbooks, and ADRs | Durable knowledge and procedures | Temporary execution state |
| `.trellis/spec/` | Implementation constraints and project conventions | Every current business fact |
| Active Trellis tasks | Intent, plans, evidence, and resumability | The only home for durable findings |
| Trellis archives, chat, and Memory | Historical evidence | Current truth without verification |

Trellis answers “where is this task now?” Atlas answers “what knowledge should
this task read, and where do verified findings belong?” Their
`UserPromptSubmit` hooks run independently and do not depend on execution order.

## Other installation options

Install directly from the GitHub marketplace:

```bash
codex plugin marketplace add aiua-dev/atlas
codex plugin add atlas@atlas
```

Install the CLI and plugin from source:

```bash
git clone https://github.com/aiua-dev/atlas.git
cd atlas
./install.sh
```

The npm package already contains the CLI, skill, and hook, so cloning the GitHub
repository is not required.

## Upgrade and troubleshooting

Upgrade Atlas:

```bash
npm install --global @aiua/atlas@latest
atlas install
```

Fully restart Codex Desktop after an upgrade. If a new task has no Atlas route:

1. Confirm that `atlas@atlas` is enabled and trusted on Codex `/hooks`.
2. Run `atlas doctor PROJECT_ROOT`.
3. Run `atlas index PROJECT_ROOT` after changing docs or route config.
4. Inspect matching with `atlas context --root PROJECT_ROOT --prompt "REQUEST"`.

Since 0.6.2, load the skill with `atlas skill`, or resolve its file with `atlas skill --path`.
The entry point follows the installed CLI without reconstructing Codex's
marketplace/plugin/version cache path. A failed read of a guessed path does not
establish a broken installation or version drift.

For daily work, `context --optional` returns success when the project has no
configuration, with JSON `{ "root": "...", "status": "not-configured", "results": [] }`.
This means routing has not been set up, rather than a search returning no matches.
It does not initialize the project, even with `--refresh`. Configured projects
retain existing retrieval behavior. Invalid configuration, bad paths, missing
prompts, and invalid decision intents still fail. Omit `--optional` to keep the
original strict checks.

After an explicit route matches, Atlas tells Codex to make the routed files the
first repository-content read, preventing an initial directory walk, broad
search, source scan, or plugin version-path probe.

## Development

```bash
npm test
npm run check
python3 /Users/USER/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/atlas
python3 /Users/USER/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/atlas/skills/atlas
npm pack --dry-run
```

Repository layout:

```text
.agents/plugins/marketplace.json   Codex marketplace
plugins/atlas/                     Self-contained Codex plugin
  .codex-plugin/plugin.json
  hooks/hooks.json
  bin/atlas.mjs
  lib/core.mjs
  skills/atlas/
package.json                       @aiua/atlas npm package
install.sh                         One-command source installer
test/                              node:test tests and fixtures
```

Do not store secrets, tokens, or temporary credentials in `.atlas/config.json`,
the generated index, or route output.

## License

[MIT](LICENSE)
