# Atlas Context Router

简体中文 | [English](README.en.md)

Atlas 是面向 Codex 的项目知识路由器：在开始工作前，只把当前任务需要的
文档、章节和读取顺序交给模型；验证完成后，再把稳定结论归并到已有真源。

> npm 包已迁移到 `@aiua/atlas`；原 `@a1ua/atlas` 作用域已停用。

它解决的不是“把更多文档塞进上下文”，而是三个更具体的问题：

- **读什么**：从 `docs/`、契约、Runbook、ADR 和 Trellis 工件中选择最小相关集。
- **按什么顺序读**：优先当前真源，再读取约束、任务意图和历史证据。
- **结论写到哪里**：更新已有维护者，而不是在 `.trellis`、Memory 或新目录中复制事实。

## 快速开始

需要 Node.js 20+ 和已安装的 Codex CLI。

```bash
npm install --global @aiua/atlas
atlas-router install
```

安装或升级后，完全退出并重新打开 Codex Desktop，让运行中的 `app-server`
重新加载插件 hooks；只新建任务不等于重启。然后在目标项目中初始化：

```bash
cd PROJECT_ROOT
atlas-router init . --trellis
atlas-router index .
atlas-router doctor .
```

提交项目生成的 `.atlas/config.json`。索引和会话路由图保存在用户缓存目录，不进入
项目仓库。

## 工作方式

```text
用户请求
  → UserPromptSubmit hook 查询现有索引
  → 返回少量路径、章节、行号与读取原因
  → Codex 先读取这些真源，再执行任务
  → 只有缺失、冲突或失败时才聚焦扩展
  → 验证后更新既有真源，或报告 no durable update
```

Prompt hook 不会扫描仓库。只有显式执行 `atlas-router index` 才会读取配置的知识
来源；再次索引时，未变化文件通过元数据复用。默认排除 Trellis 归档、运行时目录、
`node_modules` 和 Git 数据。

长会话中，Atlas 为每个 Codex 会话维护轻量活动路由图：

- 同一领域继续工作时恢复当前分支，不拿最新一句话重新检索。
- 扩展同一意图时只加入新节点。
- 切换领域时保存旧分支并建立新分支。
- 回到旧领域时重新激活原分支。

因此“继续”“先不创建任务”等控制语句不会清空已经找到的知识上下文。

## 配置固定读取链

当一种请求总是需要同一组资料时，在 `.atlas/config.json` 中添加显式路由：

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

检查匹配结果：

```bash
atlas-router context --root . --prompt "帮我测试 consumer 接口"
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `atlas-router install` | 从 npm 包注册并安装随包提供的 Codex 插件 |
| `atlas-router init . --trellis` | 创建项目级 `.atlas/config.json`，并启用 Trellis 来源适配 |
| `atlas-router index .` | 增量构建项目知识索引 |
| `atlas-router context --root . --prompt "..."` | 无状态查看一次请求会命中哪些资料 |
| `atlas-router route --root . --prompt "..."` | 在当前 Codex 会话中扩展、切换或恢复路由分支 |
| `atlas-router focus --root .` | 查看当前会话的活动分支 |
| `atlas-router doctor .` | 检查配置、索引、Trellis 适配和 hook 状态 |

## 与 Trellis 的分工

Atlas 不替代 Trellis，也不把 `.trellis` 当作默认真源。

| 层 | 负责内容 | 不负责内容 |
|---|---|---|
| 当前代码、配置、Schema 和运行态 | 当前可验证事实 | 跨会话任务管理 |
| 维护中的文档、契约、Runbook 和 ADR | 长期知识与操作流程 | 临时执行状态 |
| `.trellis/spec/` | 实施约束和项目约定 | 全部当前业务事实 |
| Trellis 活动任务 | 任务意图、计划、证据和恢复状态 | 长期结论的唯一真源 |
| Trellis 归档、聊天和 Memory | 历史证据 | 未经复核的当前事实 |

Trellis 管理“这项工作做到哪里”；Atlas 管理“这项工作现在应该读取哪些知识，
验证后的结论属于哪里”。两个 `UserPromptSubmit` hooks 独立运行，不依赖执行顺序。

## 其他安装方式

直接从 GitHub marketplace 安装：

```bash
codex plugin marketplace add aiua-dev/atlas-context-router
codex plugin add atlas@atlas-router
```

从源码安装 CLI 和插件：

```bash
git clone https://github.com/aiua-dev/atlas-context-router.git
cd atlas-context-router
./install.sh
```

npm 包已经包含 CLI、Skill 和 hook，不需要先克隆 GitHub 仓库。

## 升级与排障

升级：

```bash
npm install --global @aiua/atlas@latest
atlas-router install
```

升级后完全重启 Codex Desktop。若新任务没有出现 Atlas 路由：

1. 在 Codex `/hooks` 页面确认 `atlas@atlas-router` 已启用并受信任。
2. 运行 `atlas-router doctor PROJECT_ROOT`。
3. 项目文档或路由配置刚修改时，运行 `atlas-router index PROJECT_ROOT`。
4. 用 `atlas-router context --root PROJECT_ROOT --prompt "REQUEST"` 检查匹配结果。

Atlas 命中显式路由后，会要求 Codex 把路由文件作为第一项仓库内容读取，避免先做
目录遍历、全项目搜索、源码扫描或插件版本路径探测。

## 开发与验证

```bash
npm test
npm run check
python3 /Users/USER/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/atlas
python3 /Users/USER/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/atlas/skills/atlas
npm pack --dry-run
```

仓库结构：

```text
.agents/plugins/marketplace.json   Codex marketplace
plugins/atlas/                     自包含 Codex 插件
  .codex-plugin/plugin.json
  hooks/hooks.json
  bin/atlas-router.mjs
  lib/core.mjs
  skills/atlas/
package.json                       @aiua/atlas npm 包
install.sh                         源码一键安装脚本
test/                              node:test 测试与样本
```

不要在 `.atlas/config.json`、生成索引或路由输出中保存密钥、Token 或临时凭据。

## License

[MIT](LICENSE)
