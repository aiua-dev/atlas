# Atlas Context Router

[简体中文](README.md) | English

Atlas makes project knowledge **readable by route** and **writable by canonical
ownership**. It complements Trellis instead of competing with it:

- Trellis owns active task state, workflow, and resumability.
- Atlas owns knowledge discovery, source precedence, and durable reconciliation.
- `docs/`, code, schemas, configuration, and runtime remain the actual sources
  of truth; `.atlas/config.json` only points to them.

## Why it is fast

Atlas does not inject a documentation tree or read every file for each prompt.
It stores a generated index outside the repository, matches explicit intent
routes first, ranks paths and headings second, follows at most one link hop, and
injects only a bounded list of paths and line ranges.

Only the explicit `atlas-router index` command scans configured knowledge
roots. Prompt hooks never initiate that scan. Unchanged files are reused by
metadata and their contents are not reread. Trellis archives and runtime
artifacts are excluded by default.

## Install

```bash
git clone https://github.com/aiua-dev/atlas-context-router.git
cd atlas-context-router
./install.sh
```

The installer:

- installs the `atlas-router` CLI globally;
- registers the repository as a Codex marketplace;
- installs the `atlas@atlas-router` plugin;
- preserves but disables an older `~/.codex/skills/atlas` installation to avoid
  duplicate loading.

After the first installation, review `/hooks` in Codex once to trust the plugin
hook.

You can also install directly from the GitHub marketplace:

```bash
codex plugin marketplace add aiua-dev/atlas-context-router
codex plugin add atlas@atlas-router
```

The npm package installs both the CLI and the bundled Codex plugin without
cloning the GitHub repository:

```bash
npm install --global @a1ua/atlas
atlas-router install
atlas-router --help
```

`atlas-router install` registers the marketplace from the global npm package,
installs `atlas@atlas-router`, and handles the legacy standalone Skill. It does
not download the GitHub repository again.

## Configure a project

```bash
cd PROJECT_ROOT
atlas-router init . --trellis
```

Commit `.atlas/config.json`. The generated index stays in the user's cache and
does not enter the project repository. Add an explicit intent route when the
same request always requires the same read chain:

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

Build the index and inspect the route:

```bash
atlas-router index .
atlas-router context --root . --prompt "帮我测试 consumer 接口" --json
atlas-router doctor .
```

Run `atlas-router index` again after maintained knowledge or route configuration
changes. The prompt hook only injects navigation context and runs independently
from other `UserPromptSubmit` hooks, including Trellis.

## Boundary with Trellis

| Layer | Owns | Does not own |
|---|---|---|
| Atlas route config | Source roles, intent routes, precedence, and context limits | Business facts or task progress |
| Current code, config, and maintained docs | Current facts, contracts, runbooks, and architectural decisions | Session state |
| `.trellis/spec/` | Implementation constraints and project conventions | All current business or operational truth |
| Active Trellis task | Current intent, plans, working evidence, and resumability | The canonical home of durable conclusions |
| Trellis archive | Historical evidence | Current truth without fresh verification |

## Repository layout

```text
.agents/plugins/marketplace.json   Codex marketplace
plugins/atlas/                     self-contained Atlas plugin
  .codex-plugin/plugin.json
  hooks/hooks.json
  bin/atlas-router.mjs
  lib/core.mjs
  skills/atlas/
package.json                       npm CLI package
install.sh                         one-command local installer
test/                              node:test tests and fixtures
```

## Development and validation

```bash
npm test
python3 /Users/USER/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/atlas
python3 /Users/USER/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/atlas/skills/atlas
npm pack --dry-run
```

Do not store secrets in `.atlas/config.json`, the generated index, or route
output.
