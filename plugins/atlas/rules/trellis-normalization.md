# Atlas × Trellis 知识层修正规范

Atlas 把 Trellis 当作下游的任务状态机保持原样运行，只在它的两个薄弱面做幂等修正：
**知识的书写语言**与**知识的归属边界**。Trellis 的任务状态机、sub-agent 派发、
归档、多平台分发全部保留，Atlas 不接管也不重写。

本文件是 `atlas sync` 的行为依据。规则改在这里，随 Atlas 包分发，所有项目一次生效。

---

## 一、为什么要修正

`trellis init` 会往项目里写入一批模板文件，其中两条规定在实际使用中持续产生损害。
它们不是 bug，是上游为通用场景做的取舍，但对中文项目是负收益。

### 1.1 语言强制

模板 `templates/markdown/spec/backend/index.md.txt` 与 `spec/frontend/index.md.txt`
的末行规定：

```
**Language**: All documentation should be written in **English**.
```

这条规定被写进每个项目的 `.trellis/spec/*/index.md`。模型每次动手前读 spec 都会
看到它，于是后续所有规范内容——包括本该用中文写的实施约束和决策理由——都用英文落笔。

下游后果是知识检索失效：使用者用中文提问，知识用英文存储。字面匹配无从命中，
而项目里最详细的那几份契约文件恰恰是英文的。

### 1.2 事实与约束混放

Trellis 的 spec 模板用固定的七段式结构（`Scope / Trigger` → `Signatures` →
`Contracts` → `Validation & Error Matrix` → `Good/Base/Bad Cases` →
`Tests Required` → `Wrong vs Correct`），并要求任务收尾时把结论写回 spec。
`workflow.md` 的 Phase 3.3 标为 `[required · once]`，且写明即使结论是
「无需更新」也要走一遍判断流程。

这套结构没有区分**约束**与**事实**：

- 约束——必须遵守的规则，如「不要在 dashboard API 上加 appId」。
- 事实——描述系统当前如何运作，如字段单位、表归属、本机 JDK 路径、端口号。

模型倾向于把两者都填进 `Contracts` 段。实测样本中，一份 229 行的 spec
里约 170 行是事实性描述，真正的祈使句约束只有个位数条目。事实被写进 spec 后，
与 `docs/` 下的中文文档形成同一声明的两份副本，且彼此不知道对方存在。

更严重的形态是环境状态泄漏：实测出现过本机绝对路径
（`/Users/<user>/Library/Java/...`）被写入项目规范文件，同一路径重复四次。
这份文件若被他人克隆，得到的是在自己机器上不存在的路径。

---

## 二、修正规则

### 2.1 语言规则

`spec/*/index.md` 中的英文强制规定替换为中文优先规则：

```
**语言**：本目录文档使用中文书写。代码标识符、命令、路径、字段名、枚举值、
协议名与专有名词保留原文，不做翻译。
```

替换后，`index.md` 的其余说明段同样改写为中文。Trellis 的七段式结构名
（`Scope / Trigger`、`Signatures`、`Contracts` 等）保留英文，因为它们是
结构标识，且在 Trellis 的 skill 与 workflow 里被引用。

索引表的表头改为中文，但**既有条目的内容不改写**——那是项目撰写的资产，
语言转换应由项目自行决定，不由工具代劳。

### 2.2 无任务静默

Trellis 的 `inject-workflow-state.py` 在无活动任务时注入
`Status: no_task` 的 breadcrumb，导致每个小请求都要模型询问是否创建任务。

修正方式是**代理调用**而非替换：Atlas 提供一个适配器脚本，它调用 Trellis 的
原始 hook，检查返回值，若为 `no_task` 则不输出任何内容；其余状态原样透传。

Trellis 的原始 hook 文件保持不动。适配器注册在项目配置的 hook 位置上，
不进 `.trellis/`，因此不受 `trellis update` 影响。

### 2.3 事实与约束的判别

判别按行进行，命中即归类，用于**报告**而不自动改写内容。

约束特征（应留在 spec）：

- 祈使语气：`Do not`、`Never`、`Must`、`Prefer`、`Always`、`不得`、`必须`、`禁止`、`优先`
- 条件触发：`When X, do Y`、`如果…则`、`仅当…才`
- 禁止项清单、质量门、验收标准

事实特征（应迁往 `docs/`）：

- 个人绝对路径：`/Users/<name>`、`/Volumes/<name>`、`/home/<name>`、`~/<name>`、`C:\`
- 网络端点：`127.0.0.1`、`localhost`、`0.0.0.0`，可带端口
- 环境标识：`生产环境`、`测试环境`、`线上环境`、`staging`、`production`
- 迁移脚本：`.sql` 文件与 `migrate-*.sql` 命名
- 版本常量：`data_version=v4`、`snapshot v4` 这类快照版本标记

路径规则要求出现用户目录形态，避免命中 `/watchface/api/home/` 这类应用路由。

单行同时命中两类特征时归为**混合行**，不参与归类统计，单独列出供人工判断。

### 2.4 文件膨胀

单份 spec 文件超过阈值时提示拆分。阈值留有余量，只在明显超限时提示，
避免边界值产生噪音：

- 行数超过 400，或
- 字节数超过 48 KB，或
- 含 4 个以上 `### Scenario:` 段落

触发时报告该文件的场景清单与各自行数，供人工决定是拆分为独立文件、
迁出事实部分，还是保留。

---

## 三、执行契约

### 3.1 幂等

`atlas sync` 必须在任意状态下可重复执行且结果一致。第二次运行应当报告
「无需修正」而非重复写入。为此每个动作先检测当前状态，仅在偏离规范时写入。

### 3.2 不覆盖项目资产

修正只触及模板生成的规定性文本与结构。项目自行撰写的内容——索引表条目、
规范正文、任务工件——不在改写范围内。无法安全判定的情形跳过并报告，
不做猜测性修改。

### 3.3 不触碰托管路径

以下路径被 Trellis 的哈希清单管理，`trellis update` 可能覆盖，修正层不直接改写：

- `.trellis/scripts/**`
- `.trellis/agents/**`
- `.trellis/config.yaml`
- `.trellis/workflow.md`
- `.claude/**`、`.codex/**` 下的 Trellis 模板产物

`.trellis/spec/**` 不在托管范围（模板哈希清单对其内容零记录），可安全修正。
`.atlas/` 与 `.codex/hooks/` 下的项目自有文件不受影响。

需要改变托管路径行为的场景，一律采用**代理适配器**方式：保留原始文件不动，
在非托管位置注册一层转发逻辑。

### 3.4 报告优先

除语言替换与适配器安装外，其余动作以报告形式输出，把决定权留给项目。
自动改写仅在判据明确且不触及项目撰写内容时进行。

---

## 四、边界

Atlas 管知识层与注入层，Trellis 管任务状态机。以下属于 Trellis 职责，Atlas 不介入：

- 任务创建、激活、归档的生命周期
- sub-agent 的派发协议
- 会话记录与 journal
- 多平台模板分发
- 代码检索与变更执行

`atlas sync` 不修改 `.trellis/workflow.md`。若项目需要中文 workflow，
使用官方支持的定制通道（`trellis workflow` 命令会主动将非 native 模板从
哈希清单移除，从而豁免后续 update），不通过修正层代劳。
