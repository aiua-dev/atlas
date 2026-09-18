# Atlas

简体中文 | [English](README.en.md)

Atlas 是项目知识路由器，支持 Claude Code 与 Codex：在模型开始工作前，只把当前任务
需要的文档、章节和读取顺序交给它；验证完成后，再把稳定结论归并到已有真源。

> npm 包已迁移到 `@aiua/atlas`；原 `@a1ua/atlas` 作用域已停用。

它解决的不是“把更多文档塞进上下文”，而是三个更具体的问题：

- **读什么**：从 `docs/`、契约、Runbook、ADR 和 Trellis 工件中选择最小相关集。
- **按什么顺序读**：优先当前真源，再读取约束、任务意图和历史证据。
- **结论写到哪里**：更新已有维护者，而不是在 `.trellis`、Memory 或新目录中复制事实。

## 快速开始

需要 Node.js 20+；Codex 插件注册还需要已安装 Codex CLI。

```bash
npm install --global @aiua/atlas
atlas install                         # Codex：注册插件，npm 安装本身不注册
```

安装或升级后完全退出并重开 Codex Desktop，再在 `/hooks` 中检查 Atlas 的启用与信任状态。
插件已安装不代表当前会话已经重新加载。

### 已有项目接入

```bash
cd PROJECT_ROOT
atlas bootstrap .          # 明确接入两者：补齐 Atlas/Trellis、sync、建立索引
atlas doctor .             # 核对状态
```

`bootstrap` 用于明确需要 Trellis 工作流的项目，需先安装 Trellis CLI。
它保留已有配置，幂等可重复执行。Atlas 也能独立使用；只要知识路由时运行
`atlas init .` 即可。已有 Trellis、想分步接入时：

```bash
atlas init . --trellis     # 只建 Atlas
atlas sync .               # 修正知识层 + 装适配器 + 注册钩子
```

已有 `.trellis/` 不代表已接入 Codex。`bootstrap --platform codex` 会检查项目内
`.agents/skills/trellis-*` 的核心技能及 `.codex/` 的工作流 hook；缺失时交给
`trellis init --codex -y` 补装，再复查结果，不重新设置开发者或任务。
若项目与 CLI 版本不同，会先报出版本差异，避免混入不同执行模式的模板。
需要补平台时使用与项目 `.trellis/.version` 一致的官方 CLI；完整升级应单独审阅。
用 `atlas doctor . --platform codex` 可检查这些本地入口。检查通过不代表 Codex
已经加载技能或信任 hook；仍需在 Codex 中确认。

`atlas sync` 一步完成四件事，幂等可重复执行：修正 Trellis 模板写入的英文强制规定、
安装无任务静默适配器、注册注入钩子（Claude 写 `.claude/settings.json`，Codex 追加到
`.codex/hooks.json`）、输出 spec 的事实/约束体检报告。已有 Atlas 配置时也会刷新索引。
先看会改什么用 `--dry-run`，预览不会更新文件或索引。

钩子注册是**追加**而非替换：Trellis 的原始 hook 保留，Atlas 注册为第二条。
两者职责不同——Trellis 注入流程状态，Atlas 注入知识路由。

重开一个 AI 会话即可生效（钩子按会话加载）。Codex 需完全退出并重新打开
Codex Desktop，让运行中的 `app-server` 重新加载插件 hooks；只新建任务不等于重启。

### 全新项目

先在真实项目根目录建立 `README.md`、`package.json` 或版本控制等项目标记。
需要任务跟踪时，AI 可运行 `atlas bootstrap . --platform codex`；它会调用：

```bash
trellis init --codex -y -u <你的名字>
```

完整流程、以及「新项目没有内容可路由」这一实测结论见
[rules/new-project.md](plugins/atlas/rules/new-project.md)。

两种平台都提交项目生成的 `.atlas/config.json`。索引与会话路由图保存在用户缓存目录，
不进入项目仓库。`.atlas/.env.local`（嵌入服务凭据）已在生成的 `.atlas/.gitignore` 中排除。

### 会自动记住什么

启用技能后，AI 应在验证完成时把可复用、稳定、无重复的结论归并到维护中的真源，
没有值得保留的内容则报告 `no durable update`。这是 AI 执行的收尾步骤，hook 本身
只路由，不保存聊天，也不保证每回合都有记录。可以直接说「把这条结论记下来」。

普通 `record --claim` 在项目根补齐 Atlas，写完刷新索引，**不会创建 Trellis**。
查询和 hook 不初始化项目；结构化决策需要已有配置与真源。
只有明确接入 Trellis 或需要任务跟踪时才用 `bootstrap`，JSON 和文本模式效果相同。

Trellis 继续管理任务、阶段和工作证据；`.trellis/spec/` 放实施约束。
项目事实、现行决策和拒绝理由写入各自已有真源。`sync` 会报告混杂情况，不会自动搬走
旧 spec 内容或裁决语义冲突；AI 仍需核对归属，避免把同一事实维护成两份。

## 注入内容

每回合注入一段，由两部分组成：

1. **本回合流程动作** —— Atlas 按 Trellis 状态（`task.py current`）生成的中文动作清单，
   步骤编号对应 `.trellis/workflow.md`。它**不照抄** Trellis 的英文 breadcrumb：只有步骤
   编号是约定，所以 Trellis 改文案不会让 Atlas 失配，而增删必需步骤会被
   `test/invariant.test.mjs` 立刻报出来。没有 `.trellis` 的项目不产生这部分。
2. **知识路由** —— 按相关度排序的路径与章节。

显式路由按配置顺序返回文件与章节；`exclusive: true` 时不追加候选，也不请求嵌入。
其余查询可使用嵌入语义检索，未配凭据或服务失败时退回确定性的词法检索；
`atlas context --lexical` 可强制离线路径。相似度与覆盖度提示都不证明事实正确，
候选偏离意图时应做一次聚焦搜索。实际评测与限制见 [eval/README.md](eval/README.md)。

## 工作方式

Atlas 现在可在已有真源中保存结构化决策：提议、采纳、拒绝、被取代，以及理由、
依据与重访条件。你仍用自然语言表达，由 AI 读取归属文件并调用记录命令；不必
维护另一套笔记目录。查询会给出决策状态和行范围，拒绝与历史决定不会被标作现行。
旧文档无需迁移；没有元数据也不代表已采纳。输入、预览和安全更新契约见
[决策记录](plugins/atlas/skills/atlas/references/operating-model.md#structured-decisions)。

结构化记录使用 `atlas record --decision-file <JSON> --owner <已有文件>`；支持
`--dry-run` 预览、稳定 ID 和旧内容指纹保护，写完自动刷新索引。普通事实仍修改
所属正文；旧的 `record --claim` 是追加工具，不会自动消除矛盾或合并同义内容。
升级后运行一次 `atlas index .` 重建 v4 索引。知识发生变化后，已有会话从缓存
刷新决策状态与行号，保持当前任务意图。

AI 可用 `context/route --intent current` 查已采纳决定，或 `--intent history` 查
拒绝与被取代的理由；默认 `all` 仍检索普通事实和未分类文档。相同 `topic` 下
不能直接新增第二个现行决定：工具先展示冲突供核对，再用
`record --supersede <旧ID> --expect <旧指纹>` 配合新决策 JSON，一次完成取代。
主题标识由 AI 按实际适用范围维护；工具不会自动裁决自然语言中的矛盾。

```text
用户请求
  → UserPromptSubmit hook 查询现有索引
  → 返回少量路径、章节、行号与读取原因
  → Codex 先读取这些真源，再执行任务
  → 只有缺失、冲突或失败时才聚焦扩展
  → 验证后更新既有真源，或报告 no durable update
```

Prompt hook 只读已有知识索引，不会扫描仓库。`atlas index` 显式刷新索引；
默认的 `atlas context` 在缓存缺失或失效时也可建立索引；显式刷新用 `--refresh`
（纯词法 `--lexical` 读取缓存，缺失时也需 `--refresh`）。再次索引时，
未变化文件通过元数据复用。默认排除 Trellis 归档、运行时目录、
`node_modules` 和 Git 数据。

长会话中，Atlas 为每个 Codex 会话维护轻量活动路由图：

- 同一领域继续工作时恢复当前分支，不拿最新一句话重新检索。
- 扩展同一意图时只加入新节点。
- 切换领域时保存旧分支并建立新分支。
- 回到旧领域时重新激活原分支。

因此“继续”“先不创建任务”等控制语句不会清空已经找到的知识上下文。
启用嵌入后也遵守这一规则：首次交给模型的节点存入活动分支，后续 hook 直接恢复，
不再拿最新一句话请求嵌入。跨领域执行仍由模型使用完整意图调用 `atlas route`。

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
atlas context --root . --prompt "帮我测试 consumer 接口"
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `atlas install` | 注册随包提供的 Codex 插件（全局） |
| `atlas install --claude .` | 把钩子注册到项目的 Claude Code 配置（幂等） |
| `atlas uninstall-claude .` | 从项目配置移除 Atlas 钩子，只删自己那条 |
| `atlas init . --trellis` | 创建项目级 `.atlas/config.json`，并启用 Trellis 来源适配 |
| `atlas index .` | 增量构建项目知识索引 |
| `atlas context --root . --prompt "..."` | 无状态查看一次请求会命中哪些资料 |
| `atlas route --root . --prompt "..."` | 在当前会话中扩展、切换或恢复路由分支 |
| `atlas focus --root .` | 查看当前会话的活动分支 |
| `atlas doctor .` | 检查配置、索引、Trellis 状态与适配、钩子注册 |

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
codex plugin marketplace add aiua-dev/atlas
codex plugin add atlas@atlas
```

从源码安装 CLI 和插件：

```bash
git clone https://github.com/aiua-dev/atlas.git
cd atlas
./install.sh
```

npm 包已经包含 CLI、Skill 和 hook，不需要先克隆 GitHub 仓库。

## 升级与排障

升级：

```bash
npm install --global @aiua/atlas@latest
atlas install
```

升级后完全重启 Codex Desktop。若新任务没有出现 Atlas 路由：

1. 在 Codex `/hooks` 页面确认 `atlas@atlas` 已启用并受信任。
2. 运行 `atlas doctor PROJECT_ROOT`。
3. 项目文档或路由配置刚修改时，运行 `atlas index PROJECT_ROOT`。
4. 用 `atlas context --root PROJECT_ROOT --prompt "REQUEST"` 检查匹配结果。

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
  bin/atlas.mjs
  lib/core.mjs
  skills/atlas/
package.json                       @aiua/atlas npm 包
install.sh                         源码一键安装脚本
test/                              node:test 测试与样本
```

不要在 `.atlas/config.json`、生成索引或路由输出中保存密钥、Token 或临时凭据。

## License

[MIT](LICENSE)
