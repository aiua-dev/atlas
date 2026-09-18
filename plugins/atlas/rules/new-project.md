# 新项目接入流程

Trellis 提供流程骨架，Atlas 提供知识路由。Atlas 可以独立使用；明确需要 Trellis
工作流时再补齐两边，不因为一次知识记录就创建任务系统。

## 新环境安装

```bash
# 1. 前置：Node.js 20+ 与 npm
node --version

# 2. 安装两个 CLI
npm install -g @aiua/atlas@latest        # 本流程适用于 Atlas 0.6.0 及以上
npm install -g @mindfoldhq/trellis@latest

# 3. 配置嵌入凭据（Atlas 的语义检索需要；不配则自动退化为纯词法）
mkdir -p ~/.atlas
cat > ~/.atlas/.env.local <<'ENV'
EMBED_API_KEY=你的密钥
ENV
chmod 600 ~/.atlas/.env.local

# 4. 验证
atlas --version
trellis --version
atlas doctor /path/to/some/project
```

### 关于凭据

`~/.atlas/.env.local` 是**用户级配置，不属于任何项目**，不进版本库也不随包分发。

优先级为 **环境变量 > 项目级 `.atlas/.env.local` > 用户级 `.env.local` > 内置默认值**。
内置默认提供 provider 与模型（`https://api.siliconflow.cn/v1/embeddings` +
`Qwen/Qwen3-Embedding-4B`），**凭据必须自己提供**——包里不含任何密钥。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EMBED_API_KEY` | 无（必填） | 嵌入服务密钥 |
| `EMBED_ENDPOINT` | `https://api.siliconflow.cn/v1/embeddings` | 可换成任何 OpenAI 兼容端点 |
| `EMBED_MODEL` | `Qwen/Qwen3-Embedding-4B` | 换模型时索引会自动重建 |
| `ATLAS_COVERAGE_THRESHOLD` | `0.48` | 无答案检测阈值，语料差异大时可调 |
| `ATLAS_COVERAGE_DISABLED` | 未设置 | 设为 `1` 关闭无答案检测 |

没有凭据时 Atlas 不会报错，而是**自动退化为纯词法检索**并在 `mode` 字段标注。
首次建立语义索引约需数秒（本机 96 个文档约 1.5 秒、成本约 ¥0.01），之后走缓存；
查询时的额外开销是约 0.3 秒的一次网络往返，稳定后整体约 0.47 秒。

### Codex 平台附加步骤

Codex 走插件机制，装完 CLI 后需要注册一次：

```bash
atlas install
```

它会注册 marketplace 与插件。**之后必须完全退出并重新打开 Codex Desktop**，
让运行中的 `app-server` 重新加载插件 hooks；只新建任务不等于重启。
重启后在 Codex 的 `/hooks` 页面确认一次 Atlas hook 信任。

Codex 还需要在 `~/.codex/config.toml` 里开启 hooks（Trellis 的 `trellis init`
会提示这一点）：

```toml
[features]
hooks = true
```

### 排障：codex plugin 命令报错

若 `codex plugin list` 报 `marketplace root does not contain a supported manifest`，
说明有一个 marketplace 指向了已移动或删除的目录。这会让 `codex plugin` 的
所有子命令一起失败。查明原因：

```bash
grep -B1 -A2 '^\[marketplaces\.' ~/.codex/config.toml
```

逐个核对 `source` 路径是否存在，然后移除失效的段（连同对应的
`[plugins."<name>@<marketplace>"]` 与 `[hooks.state."<name>@<marketplace>..."]`），
再跑一次 `atlas install` 重新注册。

## 零、对话驱动：不需要用户敲命令

实际使用里，用户不会先开终端。常见路径是：跟 AI 聊一会儿理念，然后说「记下来」，
或者说「建个 Trellis 任务」。这两句话都应该直接生效，由 AI 调命令完成初始化。

```bash
# 用户说「把这个记下来」/「记一下我们的理念」
atlas record --claim "<结论原文>" --title "<简短标题>"
# → 缺配置时只初始化 Atlas，然后把核验过的结论落盘并刷新索引

# 用户说「建个 Trellis 任务」/「开始跟踪这个任务」
atlas bootstrap . --platform codex
# → 补齐两边，然后 sync 并建立索引（文本与 --json 相同）
```

已有配置保持不变，重复执行不产生第二份。查询和 hook 不初始化项目，
结构化决策要求已有配置和真源。自动初始化拒绝用户主目录、文件系统根及没有项目
标记的目录；全新空目录先确认项目位置，再显式 `atlas init .`。

AI 依技能在任务验证完成后归并稳定结论，不是 hook 自动保存聊天；未核实、短暂或
重复的内容不应记录。Trellis 的状态与工作证据不能自动升格为现行项目事实。

`record` 在找不到归属文件时会**新建一份文档**，文件名取结论里的主题词。
这条路径是新项目首次记录的常态——此时 `docs/` 还不存在。新建时请给出有意义的
`--title`：文件名承载内容是实测有效的关键，泛泛的名字会让这份文档之后搜不到。

## 一、手动流程（等价，适合脚本化）

### Trellis 初始化

```bash
trellis init --codex -y -u <你的名字>
```

平台参数按实际使用选择（`--claude`、`--codex`、`--cursor` 等，可多个）。

**三个参数都是必需的**，缺一个就会卡在交互提示：

- `--codex` / `--claude` / … 指定要生成哪些平台的配置。不加会问你要哪些。
- `-y` 跳过所有提示。不加会问开发者名字与 spec 模板。
- `-u <名字>` 直接给出开发者身份，用于 `.trellis/workspace/<名字>/`。

生成的结构：

```
.trellis/{agents,config.yaml,scripts,spec,tasks,workflow.md,workspace}
.codex/{agents,config.toml,hooks,hooks.json,skills}
.agents/skills/
AGENTS.md                      含 TRELLIS:START/END 托管块
```

Codex 平台会提示需要 `features.hooks = true`（老版本 `codex_hooks = true`）写在
`~/.codex/config.toml`，并在 Codex 里跑一次 `/hooks` 批准。缺这两步时 Trellis 的
工作流面包屑不会自动注入。

### Atlas 初始化

```bash
atlas init . --trellis     # 生成 .atlas/config.json 并建立索引
atlas sync .               # 修正知识层 + 装适配器 + 注册钩子
```

`init` 的 `--trellis` 会把 `.trellis/spec/**`、`.trellis/tasks/*/{prd,design,implement}.md`
写进数据源。不加这个开关则只索引 `docs/`。

`sync` 一步完成四件事，幂等可重复执行：

| 动作 | 说明 |
|---|---|
| 语言规则修正 | 把 `spec/*/index.md` 里的 `All documentation should be written in English` 换成中文优先规则 |
| 注入适配器 | 安装 `.atlas/hooks/trellis-active-only.py`，过滤 Trellis 无任务时的 breadcrumb |
| 钩子注册 | Claude 写 `.claude/settings.json`，Codex 追加到 `.codex/hooks.json` |
| 体检报告 | 列出 spec 里的事实/约束分布与文件膨胀情况；不自动迁移事实 |

已有 Atlas 配置时 `sync` 还会刷新索引；`--dry-run` 不修改文档或缓存。

钩子注册是**追加**而非替换：Trellis 的原始 hook 保留，Atlas 的注册为第二条。
两者职责不同——Trellis 注入流程状态，Atlas 注入知识路由。

用 `--dry-run` 可以先看会改什么。

## 二、验证

```bash
atlas doctor .                                        # 配置、索引、Trellis 检测、钩子状态
atlas context --root . --prompt "你的问题"             # 手动查一次
atlas context --root . --prompt "你的问题" --lexical   # 纯词法对照
```

钩子按会话加载，**需要重开一个 AI 会话才生效**。

## 三、新项目的现实：没有内容可路由

实测一个刚初始化的项目：索引到 13 个文件，**全部是 Trellis 的模板骨架**——
`spec/frontend/*.md` 内容是 `(To be filled by the team)`，
`spec/guides/*.md` 是 Trellis 自带的跨项目方法论。
唯一的任务工件 `tasks/00-bootstrap-guidelines/prd.md` 被 Atlas 排除在检索之外。

因此新项目里 Atlas 会**正常工作但没有答案**：钩子注入动作清单（来自 Trellis 状态），
知识路由部分为空或只指向 `AGENTS.md`、`README.md` 这两个入口。

这是设计上的正确行为，不是故障。知识路由的价值取决于知识库里有没有东西。

### 让知识库长出内容

按下面的顺序填，每填一批检索就变得可用一分：

1. **`docs/README.md`** —— 文档入口页。列清有哪些主题、各自的真源在哪。
   实测有效的写法是给每个主题一行「主题 + 一句话说明 + 链接」。
2. **`docs/reference/<主题>.md`** —— 每份文档聚焦一个主题。
   **文件名必须承载内容语义**：`watchface-dashboard-api-contract.md` 能被搜到，
   `quality-guidelines.md` 不能——后者实测在同一个文件的 27 道相关查询里，
   排名从第 1 到第 73 不等，只取决于查询词是否恰好匹配到章节标题。
3. **`docs/runbooks/<操作>.md`** —— 可重复执行的操作步骤。
4. **`docs/adr/<编号>-<决策>.md`** —— 有取舍的决策记录。
5. **`.trellis/spec/`** —— 实施约束。运行 `atlas sync .` 会给出事实/约束分布报告，
   帮你判断哪些内容写错了地方（个人绝对路径、端口、迁移脚本名属于事实，应进 `docs/`）。

写完之后跑 `atlas index .` 刷新索引。`atlas sync` 也会顺带刷新。

### 注意事项

- **`.atlas/.env.local` 不要提交**。嵌入服务凭据，已在 `atlas init` 生成的
  `.atlas/.gitignore` 中排除；`atlas sync` 也依赖这一点。
- **`atlas/` 目录会出现在项目里**，其中既有工具产物（`config.json`）也有运行时数据
  （`.atlas/hooks/`）。前者应当提交，后者看团队约定。
- **`.trellis/` 与 `.claude/`、`.codex/` 是 Trellis 的托管范围**。
  改这些目录下的模板文件会被 `trellis update` 覆盖，项目差异应写在 `AGENTS.md`
  托管块**之外**，或放进 `.atlas/`。
