# Atlas Context Router

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
atlas-router install
```

After installing or upgrading, fully quit and reopen Codex Desktop so the
running `app-server` reloads plugin hooks. Creating a new task is not a process
restart. Then initialize a project:

```bash
cd PROJECT_ROOT
atlas-router init . --trellis
atlas-router index .
atlas-router doctor .
```

Commit the generated `.atlas/config.json`. The index and session route graph
remain in the user's cache and do not enter the repository.

## How it works

```text
User request
  → UserPromptSubmit hook queries the existing index
  → returns a small set of paths, sections, line ranges, and reasons
  → Codex reads those sources first and performs the task
  → focused discovery happens only when evidence is missing or conflicting
  → verified findings update an existing owner, or report no durable update
```

The prompt hook never scans the repository. Only `atlas-router index` reads the
configured knowledge sources, and subsequent indexing reuses unchanged files by
metadata. Trellis archives, runtime state, `node_modules`, and Git data are
excluded by default.

For long conversations, Atlas keeps a lightweight active route graph per Codex
session:

- Continuing in the same domain restores the active branch instead of searching
  the latest sentence.
- Expanding an intent adds only new nodes.
- Switching domains preserves the old branch and creates another.
- Returning to an earlier domain reactivates its branch.

Control replies such as “continue” or “do not create a task” therefore do not
erase useful project context.

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
atlas-router context --root . --prompt "test the consumer API"
```

## Commands

| Command | Purpose |
|---|---|
| `atlas-router install` | Register and install the bundled Codex plugin from the npm package |
| `atlas-router init . --trellis` | Create `.atlas/config.json` with Trellis source adapters |
| `atlas-router index .` | Incrementally build the project knowledge index |
| `atlas-router context --root . --prompt "..."` | Preview a stateless route for one request |
| `atlas-router route --root . --prompt "..."` | Expand, switch, or reactivate the current session branch |
| `atlas-router focus --root .` | Show the active branch for the current session |
| `atlas-router doctor .` | Check configuration, index, Trellis integration, and hook status |

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
codex plugin marketplace add aiua-dev/atlas-context-router
codex plugin add atlas@atlas-router
```

Install the CLI and plugin from source:

```bash
git clone https://github.com/aiua-dev/atlas-context-router.git
cd atlas-context-router
./install.sh
```

The npm package already contains the CLI, skill, and hook, so cloning the GitHub
repository is not required.

## Upgrade and troubleshooting

Upgrade Atlas:

```bash
npm install --global @aiua/atlas@latest
atlas-router install
```

Fully restart Codex Desktop after an upgrade. If a new task has no Atlas route:

1. Confirm that `atlas@atlas-router` is enabled and trusted on Codex `/hooks`.
2. Run `atlas-router doctor PROJECT_ROOT`.
3. Run `atlas-router index PROJECT_ROOT` after changing docs or route config.
4. Inspect matching with `atlas-router context --root PROJECT_ROOT --prompt "REQUEST"`.

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
  bin/atlas-router.mjs
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
