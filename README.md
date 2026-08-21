# Atlas Context Router

简体中文 | [English](README.en.md)

Atlas 让项目知识能够**按路由读取**，并按照**当前真源归属**沉淀。它与
Trellis 分工协作，而不是相互替代：

- Trellis 管理活动任务状态、工作流和跨会话恢复。
- Atlas 管理知识发现、来源优先级和长期结论归档。
- `docs/`、代码、Schema、配置和运行态仍是真正的事实来源；
  `.atlas/config.json` 只负责指向它们。

## 为什么高效

Atlas 不会在每轮 Prompt 中注入整棵文档树，也不会读取全部文档。它把生成的
索引存放在仓库之外，先匹配显式意图路由，再对路径和标题进行排序，最多扩展
一跳关系，最终只注入数量受限的路径和行号范围。

只有显式执行 `atlas-router index` 才会扫描配置的知识目录，Prompt hook 不会
触发扫描。未变化的文件通过元数据复用，不会重新读取内容；Trellis 归档和运行
时产物默认排除。

## 安装

```bash
git clone https://github.com/aiua-dev/atlas-context-router.git
cd atlas-context-router
./install.sh
```

安装脚本会完成以下操作：

- 全局安装 `atlas-router` CLI；
- 将当前仓库注册为 Codex marketplace；
- 安装 `atlas@atlas-router` 插件；
- 保留旧的 `~/.codex/skills/atlas`，但将其禁用，避免重复加载。

首次安装后，需要在 Codex 的 `/hooks` 页面确认一次插件 hook 信任。

也可以直接从 GitHub marketplace 安装：

```bash
codex plugin marketplace add aiua-dev/atlas-context-router
codex plugin add atlas@atlas-router
```

npm 包发布后可使用：

```bash
npm install --global @a1ua/atlas
atlas-router --help
```

## 配置项目

```bash
cd PROJECT_ROOT
atlas-router init . --trellis
```

将 `.atlas/config.json` 提交到项目仓库。生成的索引保存在用户缓存目录，不进入
项目仓库。当一种请求始终对应固定读取链时，可以配置显式意图路由：

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

建立索引并检查路由：

```bash
atlas-router index .
atlas-router context --root . --prompt "帮我测试 consumer 接口" --json
atlas-router doctor .
```

维护文档或路由配置变化后，需要重新执行 `atlas-router index`。Prompt hook 只
注入导航上下文，并且与包括 Trellis 在内的其他 `UserPromptSubmit` hooks 独立
运行，不依赖执行顺序。

## 与 Trellis 的边界

| 层 | 负责内容 | 不负责内容 |
|---|---|---|
| Atlas 路由配置 | 来源角色、意图路由、读取优先级和上下文限制 | 业务事实和任务进度 |
| 当前代码、配置和维护文档 | 当前事实、契约、Runbook 和架构决策 | 会话状态 |
| `.trellis/spec/` | 实施约束和项目约定 | 全部当前业务或运行事实 |
| Trellis 活动任务 | 当前意图、计划、工作证据和恢复状态 | 长期结论的唯一真源 |
| Trellis 归档 | 历史证据 | 未经重新核验的当前事实 |

## 仓库结构

```text
.agents/plugins/marketplace.json   Codex marketplace
plugins/atlas/                     独立 Atlas 插件
  .codex-plugin/plugin.json
  hooks/hooks.json
  bin/atlas-router.mjs
  lib/core.mjs
  skills/atlas/
package.json                       npm CLI 包
install.sh                         一键本地安装脚本
test/                              node:test 测试与样本
```

## 开发与验证

```bash
npm test
python3 /Users/USER/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/atlas
python3 /Users/USER/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/atlas/skills/atlas
npm pack --dry-run
```

不要在 `.atlas/config.json`、生成索引或路由输出中保存密钥、Token 等秘密信息。
