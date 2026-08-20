# Atlas Context Router

Atlas makes project knowledge **readable by route** and **writable by canonical
ownership**. It complements Trellis instead of competing with it:

- Trellis owns active task state, workflow, and resumability.
- Atlas owns knowledge discovery, source precedence, and durable reconciliation.
- `docs/`, code, schema, configuration, and runtime remain the actual sources of
  truth; `.atlas/config.json` only points to them.

## Why it is fast

Atlas does not inject a documentation tree or read every file for each prompt.
It stores a generated index outside the repository, matches explicit intent
routes first, ranks paths/headings second, follows at most one link hop, and
injects only a bounded list of paths and line ranges.

Only the explicit `atlas-router index` command scans configured knowledge
roots. Prompt hooks never initiate that scan. Unchanged files are reused by
metadata; their contents are not reread. Trellis archives and runtime artifacts
are excluded by default.

## Install

```bash
git clone GITHUB_REPOSITORY_URL atlas-context-router
cd atlas-context-router
./install.sh
```

The script installs the `atlas-router` npm CLI, registers this repository as a
Codex marketplace, installs `atlas@atlas-router`, and disables an older
standalone `~/.codex/skills/atlas` entry without deleting it. Review `/hooks` in
Codex once before trusting the plugin hook.

As an npm package after publication:

```bash
npm install --global atlas-context-router
atlas-router --help
```

As a GitHub-backed Codex marketplace:

```bash
codex plugin marketplace add GITHUB_OWNER/GITHUB_REPOSITORY
codex plugin add atlas@atlas-router
```

## Configure a project

```bash
cd PROJECT_ROOT
atlas-router init . --trellis
```

Commit `.atlas/config.json`. The generated index stays under the user's cache,
not in the repository. Edit explicit intent routes when a request always needs
the same read chain:

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

Then build and inspect the route:

```bash
atlas-router index .
atlas-router context --root . --prompt "帮我测试 consumer 接口" --json
atlas-router doctor .
```

Run `atlas-router index` after maintained knowledge or routing configuration
changes. The prompt hook only emits navigation context and is independent of
other `UserPromptSubmit` hooks, including Trellis.

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
test/                              node:test fixtures
```

## Development

```bash
npm test
python3 /Users/USER/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/atlas
python3 /Users/USER/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/atlas/skills/atlas
npm pack --dry-run
```

No secrets belong in `.atlas/config.json`, the generated index, or route output.
