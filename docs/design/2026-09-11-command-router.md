# 命令路由器：统一解析、会话相位与头部 worktree

把飞书消息进入 daemon 之后的命令处理收敛成一条链：**分类 → 解析 → 计划 → 执行**。分类决定"这条消息是转发给 coding agent，还是 botmux 要响应"；解析把标题、指令、透传命令、正文一次拣出；计划按会话相位把每一项绑定到生命周期里正确的时间点；执行只做效果。本设计是 [话题指令头](./2026-09-10-topic-directive-header.md)（`#1361`）的延续：保留它的声明式执行模型，去掉"每条指令只吃一个 token"的限制，把散在十余层里的路由判定与参数解析收进一份命令 schema。

直接动因：`/t /repo wt botmux ci/temp_split /model sonnet[1m] 任务` 这一行今天被 `repo_worktree_unsupported` 拒绝。根因不是缺一个 `wt` 分支，而是 `#1361` 的 D2（空白不敏感）与 D4（参数单 token）绑在一起后，解析器只能靠固定 arity 找正文起点，可选参数（`[分支]`）无解。

代码位置以 `origin/master` `7de08289` 为准；行号只是定位线索，实现时以当时代码为准。本文的现状断言（§3、§5、§6、§8、§9）已逐条对照该基线源码核过一遍，核对中修正过的地方在正文里直接写成核对后的结论。

## 1. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| R1 | 四段式：**分类 → 解析 → 计划 → 执行**，前三段是纯函数 | 今天一条消息要过 11 层判定、至少 4 个独立参数解析器（§3）。把"是不是命令、命令是什么、什么时候做"从"怎么做"里拆出来，前三段可以表驱动单测与差分测试，执行层只消费一张效果列表 |
| R2 | 分类规则：**一个命令 token 都没有 → 短路转发**（拼 `<user_message>` 给 agent）；透传命令（`/compact` `/clear` `/model`）**是命令**，进解析与计划，只是执行效果是"逐字送给 CLI" | 透传不是转发：它有时机、要参与排序。"有没有命令"的判定需要 bot 配置（自定义透传集）、adapter 能力（有无 raw 输入面；已有会话按**冻结的** `session.cliLaunchSnapshot.cliId` 而非 live 配置，后端同理按冻结的 `initConfig?.backendType ?? session.backendType`）、会话相位三样输入——今天这些散在各层各取各的，收进分类器是这一层的价值。注意"有命令 token"不等于"以 `/` 开头"：新话题语境下标题写在 `/t` 之前，`修复登录 /t /repo x 干活` 不以 `/` 开头却是命令（`#1361` D3） |
| R3 | 消息形状：`[标题] 命令块 正文`。命令**只在行首认**；命令块是从 `/t`（新话题）或第一个命令 token（会话内）起的**连续前缀块**；**头部命令块内一行可放多条指令；会话内一行一条、尾参吃到行尾**（今天的语义）；从第一条不以命令开头的行起全是正文，**不再回头认命令** | 与 `#1361` 的形状一致，只是把"指令"推广为"命令行"。同时覆盖三类误触：`关于 /t 这个命令`（不在行首）、长文第 40 行的 `/t`（前缀块早已结束）、正文第二段里的 `/close`（前缀块已结束）。会话内不做"一行多条"：今天 `/cd` `/rename` `/quote` 裸 `/repo` 等都是整行吃到尾（`src/core/command-handler.ts:1901` `:1985` `:2022` `:4757`），拆 token 是收窄；而单行多命令的驱动用例（本文动因）全在头部相位。代价是"正文之后再写命令"不支持——`#1361` 今天同样不支持，维持 |
| R4 | **命令 schema 是唯一事实源**：名字、别名、子命令、参数类型与 arity、尾参是否贪婪（form 级）、允许的相位、help 键。三处消费：头部/会话内解析器、`/help` 与用法串生成、文档同步守卫 | 今天 `/repo wt` 的用法串与帮助行已经互相矛盾，且 zh/en 两套都矛盾（`src/i18n/zh.ts:389` `cmd.repo.worktree_usage` 写 `<编号\|项目名\|路径>`，`:738` `help.repo_wt` 写 `<编号\|项目名>`；en 同形）。`test/slash-commands-doc-sync.test.ts` 的注释原话是"把漂移从人眼审查变成红灯"，而它自己承认手抄名单又过期了一次。schema 是这条思路的自然下一步：用法串从 `forms` 生成，漂移在机制上消失 |
| R5 | 可选参数两条规则：①只在下一个 token **匹配该参数类型的模式**时才吃；②**不跨行**（`#1361` D2 收窄为 D2′：换行仍等价于空格，唯一例外是行尾终止当前指令的可选参数）。**不引入 `--` 之类的终止符** | 分支名的**消费模式**是粗模式（latin/数字开头、`[\w./-]`、无 `..`、无 CJK），中文正文永远不匹配，单行最常见写法无歧义；多行写法一行一指令，一眼确定。合法性由 §8 的 `check-ref-format` 严校验兜底，两者不同层：不匹配粗模式的 token 是正文，匹配粗模式但 git 拒绝的 token 是错误。终止符是为"单行 + latin 正文 + 不给分支"一个角落发明的语法，所有人都得学，撤掉。残余角落（`/repo wt botmux fix login bug` 单行）行为确定：`fix` 是分支名，用法串写明"latin 正文请换行" |
| R6 | 定义 `SessionPhase`，**由现有状态推导，不新增持久化字段**；命令合法性 = `phase × command` 矩阵 | 推导输入有两层：内存 `DaemonSession` 上的运行旗标（`worker`、`pendingRepo`、`pendingRepoCommitInFlight`、`worktreeCreating`，`src/core/types.ts:57-204`）与**持久化** `Session` 上刻意落盘以扛 daemon 重启的状态（`initialUserTurnPending` `src/types.ts:405`、`pendingRepoSetup` `:385`、`queued`/`queuedPrompt` `:346-352`、`status`）。"ready" 这一格今天 daemon 侧没有可读旗标，需新增一个**内存态** `ds.cliReady`（§5）。矩阵是数据，能测、能生成文档；它取代 `SESSIONLESS_DAEMON_COMMANDS` / `EXISTING_SESSION_ONLY_DAEMON_COMMANDS` / `isInitialSessionPassthrough` / `topicHeaderDeclaresSpec` 以及路由里为了不产生幽灵会话而前置的特判。矩阵**首版每一格都填今天的行为**（PR-2 零语义变化），不动持久化 ⟹ 回滚免费 |
| R7 | 计划：**跨相位按生命周期定序**（pre-spawn → spawn-args → post-ready → runtime），与文本顺序无关；**runtime 相位内按书写顺序，逐条等 CLI 空闲**（仅级联，即一条消息里 ≥ 2 条 runtime 项；单条透传行为不变） | 这是 `#1361` D1 与"级联"的和解：启动期声明、运行期级联，分界就是 CLI 提示符就绪。worker 侧有两个按 `isPromptReady` 门控的队列——`pendingRawInputs`（`raw_input` 在 backend 未起 / 写入闸命中时入队，flush 时 `isPromptReady` 门控，写入即 `isPromptReady=false` + `idleDetector.reset()`）与 `pendingInjections`（`inject_command`，无 turn 记账、TUI-only、唯一发送方是 dashboard `/slash`）——但**没有一个以"级联在飞"为入队条件**：正常情况下 `raw_input` 刻意 busy delivery（`/btw` 类 steering 要在忙时也能进）。级联因此在 **daemon 侧**定序（§6）：每条仍走今天的 `raw_input`，只在两条之间等 worker 的 `prompt_ready`。选 daemon 侧的原因：定序、超时、后端拒绝、每条的 turn 标识本来都在 daemon；若改在 worker 侧复用 `pendingRawInputs`，还得给正文的 type-ahead 旁路（`flushPending` 在 `!isPromptReady` 时先排空 `pendingMessages`）加一把新闸，否则正文会插到未发的透传前面 |
| R8 | 透传命令的参数**首版一律整行**（`freeText`，今天的契约）；**行是唯一分隔符**。按 CLI 声明 `none` / `token` 形状留作后续扩展，且只在有实测证据的 CLI 上开 | CLI 自己的斜杠命令吃不吃参数是它的交互语义，探测不了；仓库内证据也不足以填表：`/effort max please` 今天就是整行透传（`test/effort-confirm-dialog.test.ts:20` 钉着确认框只对单 token 形式 arm），改成 `token` 反而是行为变化；Codex `/model` 是否为不吃参数的交互选择器，仓库里没有证据。整行 + 按行级联已经覆盖 §4 的三个示例，而且对"今天已接受的单行输入"零变化，与 R10 一致 |
| R9 | 头部 `/repo wt <目标> [分支]` 复用现有 **pre-fork auto-worktree 路径**（`startAutoWorktreePending` → `runAutoWorktreeCommit` → card-handler 导出的 `commitRepoSelection`），只把 git 腿从 `maybeCreateDefaultWorktree` 换成显式 `{ repoPath, branch? }` 并改为 fail closed；`#1361` D5 只在 **git 运行期失败**一处放宽 | 这条入口今天已经是 4 处 spawn 路径共用的"话题建好 → 建 worktree → 提交选仓 → fork"，且自带 `worktreeCreating` 去重、pending 行公告、代际复检。会话内 `/repo wt` 用的是 `handleCommand` `/repo` case 里的**闭包** `commitRepoSelection`（`src/core/command-handler.ts:2187`，与 card-handler 的导出同名不同物），它连着 IM 回复语义，不抽。能提前查的（目标可解析、分支名合法、目标目录不存在）全部 fail closed；git 侧最长一步是 `worktree add`（60s）只能在话题建好后跑，失败时会话停在 `pendingRepo` 并回错误——与今天会话内 `/repo wt` 失败留下的是同一个状态，用户在话题内重发即可 |
| R10 | 兼容原则：**严格扩宽**——老路径接受的每条输入，新路径产生相同效果；新路径只在老路径拒绝的地方增加行为。做不到的地方**显式列出**（§9） | 这是差分测试能直接断言的性质，不靠感觉。头部 `wt` 今天被拒 ⟹ R5 两条规则影响的输入集合为空 |
| R11 | 验证不依赖线上观测：老解析器逐字冻结为**测试内 oracle**，对小字母表**穷举**差分；发布走既有 canary 通道 + 本机 fleet dogfood | botmux 是装在用户机器上的 npm 包，没有上报通道，影子模式/黄金语料/分命令切流在这里是空话。老路由的全部行为在源码里，有限且可读，现有 22 个路由层测试文件（其中 11 个跑真 `handleNewTopic` / `handleThreadReply`）就是兼容契约 |
| R12 | **一刀切**：线上不并存新老路径、无开关；风险按三个各自完整的 PR 分序（§12） | 并存意味着两套语义要同时维护、同时测；开关意味着矩阵翻倍。PR-1 先解决头部 `wt`，不碰路由层；PR-2 换路由器并删老层，但**不改**任何"今天已接受输入"的语义；PR-3 才引入 runtime 级联这唯一一处语义变化 |

## 2. 两个切面：改动住在哪里、什么能测

整个系统是 `飞书 ↔ [切面 1] ↔ botmux 运行时（daemon + worker）↔ [切面 2] ↔ coding agent`。本设计改的是**切面 1 之后、切面 2 之前**的流转逻辑，且没有触碰任何一个切面的协议本身：切面 1 的输入仍是飞书事件（文本、mentions、发送者、群类型）+ bot 配置；切面 2 的输出仍是那几种既有效果——`forkWorker` 的启动参数与 cwd、`sendWorkerInput`（正文）、`raw_input`（透传）、飞书回复/卡片。

这决定了测试边界：

| 段 | 输入 → 输出 | 怎么测 | 覆盖度 |
|---|---|---|---|
| 分类 + 解析 + 计划（纯函数） | `(文本, bot 配置, adapter 能力, 相位)` → 效果列表 | 表驱动单测；legacy oracle 差分穷举（§10） | **完全**：确定、可枚举、无 I/O |
| 执行（daemon 侧） | 效果列表 → IPC / fork 参数 / 飞书回复 | 现有 daemon 级基座：真 `handleNewTopic` / `handleThreadReply`，只替身飞书副作用、下载、`forkWorker`、`sendWorkerInput`（`test/topic-directive-header.test.ts` 的 mocks 形状；级联用例再补 `sendWorkerSessionInput` 的替身以拦 `raw_input`），断言**送到切面 2 的序列**（fork 的 cwd/model、`raw_input` 与正文的先后、每条之间是否等到 `prompt_ready`） | **完全**：切面 2 是 IPC 边界，`prompt_ready` 可以由假 worker 事件驱动 |
| worker 侧空闲判定 | PTY 输出 → `prompt_ready` | `idle-detector`、`inject-queue-policy`、`pending-input-queue` 已有纯函数单测 | 机制可测；**真实 CLI 的空闲时刻**是经验值 |
| 切面 2 之外（CLI 收到 `/compact 只留登录上下文` 之后做什么） | — | 不可在进程内测；是 adapter 声明的契约 + 手动/dogfood | 契约，不是测试 |

所以对"这次重整能不能有充分测试保障"的回答是：**能，而且比今天强得多**——前三段今天散在 11 层里、只能靠每层各自的用例覆盖，收成纯函数后可以穷举；执行段沿用已有基座。真正测不到的只有 CLI 自身对透传命令的反应，这也是 R8 首版不猜参数形状、只按行级联的原因。顺带一个今天的短板要在 PR-2 里修掉：`startInitialPassthroughSession` 这类 daemon.ts 闭包没导出，现有测试只能 **grep 源码**钉行为（`test/initial-passthrough-ownership.test.ts` 的注释自述"by asserting on the source"）；路由器成为可导出的纯函数后，这类源码级守卫应替换成真实用例。

## 3. 现状：十一层判定与四个解析器

一条新话题消息进 daemon 后按序经过（thread 路径有对应的孪生分支）：

| # | 层 | 位置 | 判"是不是我的"的方式 | 参数怎么解析 |
|---|---|---|---|---|
| 1 | `/summary` 正则 | `src/im/lark/event-dispatcher.ts:3007`；同一正则在 `summary-command.ts:25` 又抄一份、`:265` 再内联第三份 | `^/summary(\s\|$)` | — |
| 2 | 免@ 命令触发 `matchCommandTrigger` | `src/services/command-trigger.ts` | chat 白名单 ∩ 配置命令 ∩ `reservedCommandKind` 兜底 | 第 3 种解析：`commandTriggerArgs` 剥首 token |
| 3 | 话题指令头 `parseTopicHeader` | `src/core/topic-header.ts`，`src/daemon.ts` 两条入口 | 首 token 为 `/t` `/topic`，标题护栏 | 表驱动，参数单 token |
| 4 | commandTrigger 模板渲染 | `src/daemon.ts:18208-18226` | — | 改写 `parsed.content` **但不改** `cmdContent`（两条平行文本 lane；刻意的，防 `/solve /clear` 绕过保留命令闸） |
| 5 | messageListener | `src/services/message-listener.ts` | 配置 | 两条 lane 一起整体覆盖 |
| 6 | v3 saved workflow | `src/im/lark/v3-saved-workflow-command.ts` | 自带 `^/workflow` 正则 | 自带 token 切分与每子命令 arity（`cancel` 要 2 个、`list` 要 1 个、`show` 拼尾、`save` 嗅 `--` 旗标）；首 token `toLowerCase` |
| 7 | workflow grill / 旧模板 | `src/im/lark/workflow-slash-command.ts` | **再抄一遍** `/workflow` 正则并重列保留动词（内容同、顺序不同，且大小写敏感） | — |
| 8 | `parseSlashCommandInvocation` | `src/core/command-handler.ts:335` | 首 token 为 `/` 开头；**首行含 `<…>` 占位符拒绝**（`test/command-handler.test.ts:1533`）；多行仅 `MULTILINE_COMMANDS` 豁免 | 只取**首 token** 为 cmd，`content` 是整条原文 |
| 9 | 路由内前置特判 | `src/daemon.ts` | 新话题路径在透传闸（`:18485`）之前依次 `/sessions` `/vc-auth` `/card` `/cot` `/term` 五条；thread 路径透传闸（`:20120`）前**只有** `/sessions` `/vc-auth` 两条，`/term` 挪到 `DAEMON_COMMANDS` 块内，`/card` `/cot` 走 `handleCommand` 的 switch | 各自 |
| 10 | 透传 `resolvePassthroughCommands` | `src/core/command-handler.ts:252`、`src/core/passthrough-commands.ts` | 基础集 ∪ adapter `defaultPassthroughCommands` ∪ bot `customPassthroughCommands`；无 raw 面的 CLI 为空集（路由与 `/list-slash-command` 调 `cliHasNoRawPassthroughSurface` 时**不传** `dshRuntime`，故 `dsh` 含 `dshRuntime:'tui'` 在内一律空集；只有卡片侧传了）；透传集与 `DAEMON_COMMANDS` 恒不相交（`passthrough-commands.ts:126` 过滤遮蔽项）；thread 路径按冻结的 `cliLaunchSnapshot.cliId` 求值 | 不解析，整行 `raw_input` 逐字送 |
| 11 | `DAEMON_COMMANDS` → `handleCommand` 大 `switch` | `src/core/command-handler.ts:1543` 起 | 集合成员 | **38 个 `case` 标签 / 35 个命令**；19 处 `replace(/^\/cmd\s*/)` 剥命令名后再各自 trim / split / 子解析 |

命令的"注册"只有五个裸集合：`DAEMON_COMMANDS`、`PASSTHROUGH_COMMANDS`、`SESSIONLESS_DAEMON_COMMANDS`、`EXISTING_SESSION_ONLY_DAEMON_COMMANDS`、`FORCE_TOPIC_COMMANDS`，外加 `MULTILINE_COMMANDS`。没有任何一处声明 arity 或子命令。`/help` 是 ~60 个手写 `t('help.*')` 按固定顺序拼的，只有透传节是算出来的。

同一件事写了两遍的例子：`/repo` 的目标解析（编号 → `lastRepoScan`；否则 `resolveRepoSelection`）在 `wt` 分支与普通分支各实现一次（`src/core/command-handler.ts:2385-2400` 与 `:2500-2515`）。同一个命令的两个 form 尾参贪婪性也不同：裸 `/repo <参数>` 整行吃到尾（`:2022`），`/repo wt` 却按空白切、超过 2 个 token 直接报用法错（`:2375`）——所以贪婪是 **form 级**属性，不是命令级。

"会话规格"也有三份并行类型：`TopicSpec`（`src/core/topic-spec.ts`）、`ScheduleModelOverride`（`src/core/schedule-model-override.ts`）、`TriggerRequest.options`（`src/services/trigger-types.ts`；`workingDir` 还不是请求字段，由 `resolveWorkingDir` 另算）。

## 4. 语法

单行：

```text
botmux 日常运维 /t /repo wt botmux ci/temp_split /model sonnet[1m] 简单确认下当前依赖的 bun 的版本号
```

多行（等价）：

```text
botmux 日常运维
/t
/repo wt botmux ci/temp_split
/model sonnet[1m]

简单确认下当前依赖的 bun 的版本号
```

会话内（runtime 级联，PR-3）：

```text
/model opus
/clear
接下来看一下 PR #1361 的评审意见
```

形式化：

```text
message   := [title] command-block body
title     := 仅新话题语境；不含 "/" 开头 token 的文字，≤ 3 行，归一化后 ≤ SESSION_TITLE_MAX
command-block := header-block | runtime-block
header-block  := SENTINEL (command)* ；一行可多条，body 从第一个未被消费 token 的原始偏移起（同 #1361）
runtime-block := command-line+          ；一行一条，body 从第一条非命令行起
command-line  := command EOL            ；schema 命令：尾参按 form 的 greedyTail 决定吃到行尾还是按 token 切
               | passthrough-line EOL   ；透传命令：整行归 CLI（R8）
command   := name [sub] arg*            （name/sub/arg 的 arity 与类型来自 schema）
arg       := token | '"' … '"'
```

解析规则：

1. 剥掉对本 bot 的所有 @（沿用 `stripBotMentions`）。
2. 新话题语境：找 `/t` `/topic` 分隔符，之前是标题（护栏不满足 → 不是指令头，整条按普通消息）。会话内语境：无标题，命令块从消息开头起。
3. 头部块：分隔符之后逐 token 读，命中 schema 命令 → 按 `forms` 消费子命令与参数（最长匹配优先），余下 token 继续尝试下一条命令；第一个既不是命令也未被消费的 token 起是正文。会话内块：逐行读，行首 token 命中 schema 命令 → 按 form 消费，`greedyTail` 的 form 把该行余下全部当尾参（今天 `/cd` `/rename` 裸 `/repo` 的语义），非贪婪 form 按空白切并校验 arity（今天 `/repo wt` 的语义，超出即用法错）；命中透传命令 → 整行为该命令的字面内容（R8）。
4. **必选参数**无条件吃；**可选参数**只在下一个 token 匹配其类型模式时吃，且不跨行（R5）。§8 的分支名合法性校验只作用于**已被消费**的 token。
5. 行首 token 不是命令 → 命令块结束，从该行原始偏移起为正文。**会话内 lane** 另有承接自今天的守卫：首行含 `<…>` 占位符 → 整条不认命令（那是命令示例/讨论，`test/command-handler.test.ts:1533`）；头部 lane 今天就没有这条守卫，不施加——`/t /repo botmux 修一下 <div> 的问题` 必须照常开话题。
6. 命令块内出现未知 `/xxx`：新话题且已写标题/指令 → 拒绝（`#1361` §3 的"宁可报错不猜"）；裸 `/t` 后紧跟未知 `/xxx` → 正文（D9 兼容，`/t /goal 干活` 落到冷启动路径）。

schema 形状（示意）：

```ts
{
  name: 'repo',
  forms: [
    { args: [] },                                                          // 裸 /repo：默认目录直接开 / 选仓卡
    { args: [{ kind: 'repoTarget' }], greedyTail: true },                  // 会话内 `/repo <带空格路径>` 整行当路径（#1361 D7；头部相位仍按 token）
    { sub: 'wt', args: [{ kind: 'repoTarget' }, { kind: 'branchName', optional: true }] },   // 非贪婪，与今天 :2375 一致
  ],
  help: 'help.repo',
}
```

`greedyTail` 是 **form 级**、只在 runtime 相位生效；未声明的 form 在 runtime 相位默认也贪婪（今天 19 处 `replace(/^\/cmd\s*/)` 的语义），只有像 `/repo wt`、`/issue <子命令>` 这类今天就切 token 的 form 才显式声明为非贪婪。头部相位一律按 token（否则单行 `/t /repo wt botmux ci/temp_split /model sonnet[1m] 正文` 切不出正文）。

参数类型与模式：`repoTarget`（路径/项目名/编号，编号仅 runtime）、`branchName`（消费用粗模式，R5）、`modelToken`（`MODEL_TOKEN_RE`，≤ 64）、`effortLevel`（枚举）、`path`。

## 5. 会话相位与合法性矩阵

```ts
type SessionPhase =
  | 'none'              // 无会话（新话题第一条）
  | 'pendingRepo'       // 等选仓/建 worktree，worker 未起（ds.pendingRepo；持久化镜像 Session.pendingRepoSetup）
  | 'worktreeCreating'  // ds.worktreeCreating || ds.pendingRepoCommitInFlight（会话内 /repo wt 在无 pendingRepo 时也会置位）
  | 'queued'            // 停起态（Session.queued，worker:null，等 dashboard「开始」或群里第一条消息激活）
  | 'spawning'          // worker 已起、CLI 提示符未就绪（ds.worker && !ds.cliReady）
  | 'ready'             // 提示符就绪、首轮未发（ds.cliReady && session.initialUserTurnPending）
  | 'running'           // 正常运行
  | 'closed';           // 持久化 status = closed
```

推导自现有状态（R6），唯一新增的是内存态 `ds.cliReady`：

- 置位点是 worker 的 **`prompt_ready`** IPC（`src/worker.ts:10828`，`markPromptReady()` 的唯一出口；daemon 侧 `src/core/worker-pool.ts:12155` 今天收到后只用来送 `pendingRawInput`，不落任何可读旗标）。**不能**用 worker 的 `ready` IPC（`:19795`）——那只表示 worker init 完成 / 后端已 spawn（`ds.workerReady`），而且 `prompt_ready` 经常**先于** `ready` 到达：riff/mojo 的首次 `markPromptReady()` 在 `spawnCli` 内部同步合成，快启的 TUI 在 Herdr 下也会（`src/worker.ts:19784` 注释原文）。
- 清零点：spawn / restart / `claude_exit`，**不含** `ready`（否则上面那类会话刚置位就被抹掉，相位机永远看不到它们 ready）。
- 也不能拿 `ds.lastScreenStatus` 当代理：采样器在 `awaitingFirstPrompt` 期间整体短路，且 `promptReady===false` 时默认投影就是 `'working'`。
- 后端差异：PTY / tmux / adopt 走 `idle-detector` 的屏幕证据；`codexRpcInput` / codex-app 走 `fireIdle()` 的外部证据；**riff / mojo 根本不创建 idle-detector**，首次 `prompt_ready` 是 spawn 内合成、无证据，此后由 `backend.onTaskDone` 给出的是**远端 task** 的边界——在这两个后端上 `ready`/`running` 相位只用于合法性判定，runtime 级联（§6）一律拒绝。

矩阵**首版每一格填今天的行为**（实现时逐格补齐，每格一条用例）：

| 命令 | none | pendingRepo | worktreeCreating | queued | spawning | ready / running | closed |
|---|---|---|---|---|---|---|---|
| 标题、`/t` 指令头 | 声明 | 拒（`#1361` D6） | 拒 | 拒 | 拒 | 落在原话题且会话存在时：写错的头部拒；解析成功的按 `topicHeaderDeclaresSpec`——带指令或"有标题且正文为空"拒，其余（裸 `/t`、`/t 文案`、`标题 /t 正文`）原样转发为正文（`test/topic-directive-header.test.ts:580/589`）；chat-scope 的 `/t` 翻话题在 dispatcher 上游，不受本格约束 | 拒 |
| `/repo X`、`/repo wt …` | pre-spawn 钉目录（PR-1 起含 `wt`） | 提交选仓（今天的 `commitRepoSelection`） | 带参 `/repo*` 或已 `pendingRepo` → 拒回 `cmd.repo.worktree_in_progress`；无参且无 `pendingRepo` 的裸 `/repo` 放行到选仓卡 | 今天语义 | close + refork（今天语义） | close + refork（今天语义） | 拒 |
| `/model` `/effort` | spawn-args | 拒（今天 `cmd_needs_active_cli`；放宽为 spawn-args 见 §14） | 拒 | 拒 | 透传，时机沿今天：worker 有 backend → 立即 `raw_input`（busy delivery）；backend 未起 / bare-shell hold → worker 侧已入队至 `isPromptReady` | 透传（整行，R8） | 拒 |
| 透传其它（`/compact` `/clear` …） | 拒（无进程；`/goal` 类冷启动例外按 adapter `defaultPassthroughCommands`，今天只有 claude-code 与 codex 声明） | 冷启动透传排队至 ready（今天 `pendingRawInput` + `prompt_ready`，`worker-pool.ts:12169`）；其它拒 | 拒 | 拒（`cmd_needs_active_cli`） | 同上一行 spawning 格 | 透传 | 拒 |
| 正文 | 首轮 | 缓冲（`pendingFollowUps`） | 缓冲 | 激活：`queuedPrompt` + 本条作首轮 fork | 缓冲至 ready | 送 | 拒 |
| `/sessions` `/card` `/cot` `/term` `/vc-auth` | 允许，**不建会话** | 允许 | 允许 | 允许 | 允许 | 允许 | 允许 |
| `/rename` `/role` `/cd` … | 按今天 `SESSIONLESS_*` / `EXISTING_SESSION_ONLY_*` 归入 | | | | | | |

矩阵一旦成文，路由里的前置特判（含两条路径今天的不一致，§3 第 9 层）、`isInitialSessionPassthrough`、`topicHeaderDeclaresSpec` 都由它替代。

## 6. 计划与执行

解析结果（AST）经 planner 变成有序效果列表：

| 相位 | 效果 | 复用机制 |
|---|---|---|
| pre-spawn | 钉 `workingDir`；建 worktree | `resolveRepoSelection`、`startAutoWorktreePending` → `runAutoWorktreeCommit` → `commitRepoSelection`（card-handler 导出版）的 `pendingRepo` 分支 |
| spawn-args | 启动模型、推理档位、原生会话名 | `ds.spawnModelOverride`、`session.reasoningEffort`、`updateSessionTitle(…, 'user')`（顺序要求见 `#1361` §4） |
| post-ready | 首轮正文 | `pendingPrompt` + `buildNewTopicCliInput`，`markInitialUserTurnPending` |
| runtime（单条） | 一条透传或一段正文 | 今天的路径原样：`deliverPassthroughToExistingSession` → `raw_input`；`sendWorkerInput` |
| runtime（级联，PR-3） | ≥ 2 条 runtime 项，**按书写顺序逐条**，每条等 CLI 空闲 | 每条仍走上一行的路径；**新增** daemon 侧定序器：发下一条之前等 `ds.cliReady` 的**下一次**置位（按代际计数，不能只看布尔——`raw_input` 在忙时会被 CLI 收进 composer 排队，紧随其后的 `prompt_ready` 是上一轮结束、不是本条执行完） |

跨相位顺序由相位决定，文本里 `/model` 写在 `/repo` 前后无关。runtime 相位内 `/model opus ⏎ /clear ⏎ 正文` = 等空闲 → 送 `/model opus` → 等下一次空闲 → 送 `/clear` → 等下一次空闲 → 送正文。

定序器的边界：

- **turn 标识**：级联第 2..N 条不能复用飞书 `messageId` 当 `turnId`——worker 的 `InputTurnDeduper` 按 `turnId` 去重，重复的 id 会被当成重投递丢弃。定序器给每条派生一个独立 turn 标识（新增字段，不复用专指 durable 重投递次数的 `dispatchAttempt`），并按它注册回复目标/卡片血缘；`quoteTargetId` 仍指向真实 `messageId`。`prompt_ready` 不带 turnId，不受此影响。
- 等待有上限（建议 120s）。超时按今天的 busy delivery 语义把剩余条目立即送出并在话题里提示一句，不无限持有——与 `session-turn-queue.ts` 头注释的原则一致："人等待的东西是会话状态，不可拿队列去等"。
- **拒绝级联**（fail closed，回一句"该后端不支持多条命令级联，请分条发送"；单条透传行为不变）：① `isRemoteBackendSession(ds)`（riff / mojo，按冻结后端判，`src/core/persistent-backend.ts:172`）——这两个后端上一条透传是两次 write（文本 + `\r`），riff 因此产生两个远端 task、两次 `prompt_ready`，mojo 的 `\r` 被判空拒收，turn 边界与写入命令不是 1:1，代际计数无从成立；② adopt 会话（`ds.adoptedFrom || ds.initConfig?.adoptMode`）——人机输入交错，与 `/suspend` `/restart` `inject_command` 同款排除。
- 无 raw 面的 CLI（codex-app / mira / mir / dsh（路由不传 `dshRuntime`，见 §3 第 10 层）/ ebsd）：透传集为空 → `/compact ⏎ 正文` 整条是正文，与今天一致。
- 被拒绝的方案：改用 worker 的 `pendingInjections`（`inject_command`）——它已按空闲逐条写入，但没有 turn 记账（`/compact` 的流式卡片会消失）、拒绝 riff/mojo/adopt、且写入路径与 `raw_input` 不同，等于给透传开第二条语义；改用 worker 的 `pendingRawInputs` 则需要新增"级联在飞"入队条件并给正文 type-ahead 旁路加闸（R7）。`runStartupCommands`（`src/worker.ts:2548`）的"逐条 + 等静默"是最接近的样板，但只在 spawn 期、用 PTY 静默而非 idle-detector。

## 7. 透传命令与参数形状

首版（R8）：透传命令整行归 CLI，行是唯一分隔符。adapter 上今天已声明的能力照旧参与分类（`defaultPassthroughCommands`、有无 raw 面、`/fast` 的后端限制 `fastToggleUnsupportedBackend`——排除 riff / mojo / `codexRpcInput`，**不是** `backend: ['pty']`，tmux/herdr/zellij/zmx 同样可用）。

后续扩展（不在本设计三个 PR 内）：按 CLI 声明 `none` / `token` 形状，让 `/model opus 然后继续修` 单行也能拆。前提是逐个 CLI 实测填表，且守住两条今天被测试钉住的不变量：`/fast` 与 `/effort` 留在全局 `PASSTHROUGH_COMMANDS`（`test/command-handler.test.ts:1485`、`:1491`），不能收窄成某个 adapter 的声明；`/effort <档位>` 单 token 才 arm 确认框、多 token 整行透传（`effort-confirm-dialog.test.ts:20`）。

`/model` 同名两相位：头部是 `--model` 启动参数（能力门 `launch-model-capability.ts`，riff 一律否），会话内是透传键入；schema 按相位区分，两处各声明。

## 8. 头部 `/repo wt` 的落地

1. `resolveTopicSpec` 新增 `worktree?: { repoPath, branch? }`。前置校验 fail closed：目标可解析（`resolveRepoSelection`，编号形式仍拒）、**分支名合法**（新增：仓库今天没有任何分支名校验，非法名要到 `git worktree add -b` 才被 git 拒；用 `git check-ref-format --branch <名>` 前置到话题创建之前）、目标目录不存在。目标目录的算法必须与 `createRepoWorktree` 一致：给了分支 → `<主 checkout 同级>/<repo>-<dirSuffixForBranch(分支)>`（非 `[A-Za-z0-9._-]` 折成 `-`，如 `ci/temp_split` → `botmux-ci-temp_split`，**没有** `wt-` 前缀）；未给分支 → 自动 `wt/<slug>`（冲突递增 `-2`…）或 `wt/N`，遇到已存在目录是换下一个候选而不是报错，因此**不需要**前置查目录。"主 checkout 同级"要先把 `resolveRepoSelection` 返回的目录归一到主 checkout（它可能本身是个 linked worktree，`git worktree list --porcelain`），这一步不是 `stat`：`resolveTopicSpec` 因此改为 async（它唯一的生产调用点 `src/daemon.ts:18267` 已在 async 上下文），仍在改 scope、建话题之前完成，零副作用不变。
2. worktree 的**创建**不放在 `resolveTopicSpec`（它是校验器），放在 daemon 新话题路径的 quota 闸（`src/daemon.ts:18665` 附近）之后：钉目录 → 注册 `pendingRepo`（`stageClaimedPendingRepoSetup`，**仍按 `mode: 'picker'` 落盘**——不给 `PendingRepoSetup` 加新形状；daemon 若在 ≤ 60s 的创建窗口内重启，restore 后回到选仓卡，与今天会话内 `/repo wt` 中途重启的结果相同，已建好的 worktree 用 `/repo <路径>` 选即可）→ `startAutoWorktreePending` 的变体，把 `maybeCreateDefaultWorktree` 换成显式 `createRepoWorktree(repoPath, { branch, slug })` → riff 后端推分支 → `commitRepoSelection`（card-handler 导出版）→ fork。失败时 **fail closed**（auto-worktree 那条"降级到 baseDir 照常起会话"的策略不适用：用户明确点名了分支）。`pinnedFromBotDefault=false` 沿用 `#1361`，不会与 auto-worktree 重复建。
3. 无分支时 slug 由头部的标题/正文推导（`worktreeSlugFromContextAI(title, prompt)`，内部全捕获、从不抛），且可能落空：两者都缺（`/t /repo wt botmux`），或文本无 latin/digit token（纯中文）且 AI slugger 未开启（`worktreeSlugAI` 需 `enabled + baseUrl + apiKey + model` 齐全，默认关）→ 回落 `wt/N`。
4. 真正会失败的 git 步骤（核对结论）：`rev-parse --git-dir`（非仓库，10s）、显式分支/显式路径的目标目录已存在、`wt/*` 槽位耗尽（上限 1000）、`mkdirSync`、`git worktree add`（60s；含"分支已被别的 worktree 检出"）。**fetch 失败不算**：两处 `fetch origin`（30s）都只 warn 并降级——base ref 预取失败用本地 ref；显式分支预取失败则找本地 `origin/<branch>`，找不到就从 base ref 新建一个不 track 远端的分支。这些运行期失败让会话停在 `pendingRepo` 并回 `cmd.repo.worktree_failed`，与今天会话内 `/repo wt` 失败留下的状态相同。
5. 会话内 `/repo wt` 在 PR-1 **不动**。若后续要消掉 `/repo` 两处重复的目标解析，只抽"目标解析"这一小段；把会话内路径切到导出版 `commitRepoSelection` 会带来 turnId / `sessionBackendType` / `riffRepoDirs` 印记 / 确认回复抑制 / 卡片撤回时机几处语义差异，必须进 §9 的有意变化表，本设计不做。

## 9. 兼容性

**严格扩宽**（R10）。按构造保留的老行为，及各自今天的测试锚点：

| 行为 | 今天的测试锚点 |
|---|---|
| `#1361` D7：会话内 `/repo …` 尾参贪婪、`/repo wt` 非贪婪 | `test/command-handler.test.ts:3664` `keeps an explicit branch instead of auto semantic naming`（`/repo wt 1 feat/manual` 跑真 handler）。**缺**"裸 `/repo` 路径含空格"、"`/cd` 路径含空格"、"`/rename` 标题含空格"三条实例，PR-2 补 |
| D9：`/t /goal 修一下` 落到冷启动路径 | `test/topic-directive-header.test.ts:439` |
| D6：已有会话里 `关于 /t 这个命令` 放行给 CLI | `test/topic-directive-header.test.ts:580`、`:589` |
| 会话内首行含 `<…>` 占位符不认命令 | `test/command-handler.test.ts:1533` |
| commandTrigger 双 lane（模板不进命令解析） | `test/command-trigger-prompt-route.test.ts:236` |
| 前置特判命令在 `none` 相位不建会话 | `test/daemon-rename-route.test.ts:705`（`/sessions` 双入口跑真路由、`createSession` 未调用）；`/card` `/cot` `/term` `/vc-auth` **缺** daemon 级用例，PR-2 按同形状补 |
| 透传集与 `DAEMON_COMMANDS` 不相交（顺序因此不可观测） | `test/command-handler.test.ts:1420`、`:2874`、`test/bot-config-store.test.ts:806`；PR-2 保留 `passthrough-commands.ts:126` 的遮蔽过滤并补一条不变量断言 |
| `MULTILINE_COMMANDS`（`/schedule` `/role` `/fork`）多行豁免 | `test/command-handler.test.ts:1547`（`/schedule`）、`:1555`（`/fork`）；**`/role` 缺**，PR-2 补 |
| `botAcceptsSlashFromBots` | `test/daemon-rename-route.test.ts:3091` / `:3130`（bot 发送者的 `/repo` 走真两条入口） |
| `dsh` 透传集：路由不传 `dshRuntime`，`dsh-tui` 与 headless 一样空集（与卡片侧不一致） | 分类器沿用不传，零变化；对齐卡片见 §14 |
| `reservedCommandKind` 兜底、v3 workflow 在 `/t` 剥离之后运行 | `test/command-trigger-reserved-commands.test.ts`、`test/v3-saved-workflow-command.test.ts` |

路由器还要**显式输出两条 lane**（`promptText` / `commandText`），取代今天原地改写 `parsed.content` 的做法。

**有意变化**（必须写进 PR 描述，按 PR 归属）：

| 变化 | 今天 | 之后 | 理由 | PR |
|---|---|---|---|---|
| 头部 `/repo wt <目标> [分支]` | 拒（`repo_worktree_unsupported`） | 可用 | 直接动因 | PR-1 |
| `/repo wt` 用法串与帮助行不一致（zh/en） | 两条互相矛盾 | 由 schema 生成一条 | 自相矛盾的东西修好必然改掉一条 | PR-2 |
| thread 路径 `/card` `/cot` 的前置特判 | 与新话题路径不一致（§3 第 9 层） | 两条路径同一张矩阵 | 收敛；行为上 `/card`/`/cot` 在 thread 里本就不需要会话 | PR-2 |
| 会话内"命令行 ⏎ 正文" | `parseSlashCommandInvocation` 因多行拒掉，整条当纯文本转发，`/xxx` 成为 prompt 里的字面文字 | 逐行排队（§6 级联） | 今天的行为几乎不可能是用户意图；这是唯一一处对"今天已接受输入"的语义变化 | PR-3 |

## 10. 验证

- **legacy oracle 差分**：把 `parseSlashCommandInvocation`、`parseTopicHeader`、`resolvePassthroughCommands`、`matchCommandTrigger`、`parseV3SavedWorkflowCommand`、`parseWorkflowGrillTrigger` 逐字拷到 `test/legacy-oracle/`（只进测试，不进 dist；`resolvePassthroughCommands` / `matchCommandTrigger` 读 `getBot`，夹具里按配置各解析一次后复用）。对四元组 `(文本, bot 配置, adapter, 相位)` 断言新路由决策 == oracle 决策：哪层认领、cmd、args、转发还是命令、两条 lane。
- **输入穷举而非语料**，规模写死成能跑完的：`/t` 固定前缀 + 可变 token ≤ 4 的**全交叉**（含重复），子字母表 `{/repo, wt, /model, /effort, /goal, /foo, /cd, /rename, "带引号", 中文词, latin 词, <占位>, 换行, @bot}`（14 符号，14⁴ ≈ 3.8 万串）× 8 相位 × bot 配置 2×2（有/无自定义透传 × 有/无 commandTrigger，触发词绑到 `/foo`）× CLI 轴 `{claude-code, codex, dsh official, dsh tui, codex-app}` ≈ 6×10⁶ 次纯函数求值，秒到分钟级。会话内语境去掉 `/t` 前缀同样跑一遍。`/workflow` 家族单列一组定向夹具（`/workflow` × {空, new, run, save, list, show, cancel, resume, 未知动词} × 大小写），不进全局字母表。§4 与 §13 的 6–8 token 长形状作为**定向手写用例**单列，并写明这就是覆盖上限。确定、可复现；仓库没有 fast-check，也不加。
- **严格扩宽断言**：对穷举集中 oracle 接受的每条输入，新路由效果相同；oracle 拒绝而新路由接受的输入必须落在 §9 有意变化表内，否则红灯。PR-2 阶段"命令行 ⏎ 正文"仍在拒绝集里（有意变化表按 PR 归属）。
- 现有 22 个路由层测试文件不改语义直接跑；11 个 daemon 级用例作为基座扩展：头部 `wt` 后 `workingDir` 真落到新 worktree（`createRepoWorktree` 替身返回固定路径，断言 fork 的 cwd）、拒绝路径零副作用；runtime 级联三条输入按序送达（`sendWorkerSessionInput` 替身记录 `raw_input` 序列与各自 turn 标识）、每条之间等到假 worker 发出的 `prompt_ready`，超时分支按 busy delivery 放行，riff/mojo/adopt 拒绝。
- 命令 schema、`/help` 与 `slash-commands.md` / i18n 的对齐进 doc-sync 守卫；§9 里标"缺"的用例先补。
- 发布：`-canary.N` tag → `npm i -g botmux@canary` → 本机 fleet dogfood → latest。不动持久化，回滚 = 装回上一版。
- 手动（飞书内）：§4 三个示例各发一条；在一个非 Claude 的 CLI（codex）上验证头部与 runtime 级联；riff 后端验证头部 `/model` 仍按能力门拒绝、级联被拒绝；`/compact` 级联在真实 CLI 上确认第二条确实等到压缩完成后才送出（这是唯一要靠肉眼看的时序）。

## 11. 影响面

- **共用层**：`daemon.ts` 两条入口、`command-handler.ts` 解析面、`event-dispatcher.ts` 路由判定、`command-trigger.ts`——所有 20+ 个 CLI 都经过。透传形状首版零变化。
- **后端**：PTY / tmux / herdr 家族 vs riff / mojo / codex-app RPC：透传集为空的 CLI 不受 runtime 级联影响；riff / mojo 级联拒绝；头部 `/model` 的能力门不变。
- **会话类型**：普通群 `/t` 开出的 thread、话题群、p2p、手动转话题后的第一条；adopt（级联拒绝）/ restore（`ds.cliReady` 由重新 spawn 的 `prompt_ready` 置位）/ queued 只经过相位推导，不改语义。
- **不改**：`ready`/`running` 相位下单发的 `/repo` `/rename` `/model` `/effort` 单条行为一律不变；`commandTrigger` 模板结果不进解析器（`#1361` §8 的安全说明）。

## 12. 分期

三个 PR 各自完整、无开关、线上不并存：

- **PR-1 头部 `wt`**（小，先解痛点）：`topic-header.ts` 支持 `/repo` 的 `wt` 子形式与可选参数两条规则；`topic-spec.ts` 加 `worktree`、分支名校验、改 async；daemon 新话题路径接 §8 第 2 步。文案：`daemon.topic_header_repo_worktree`（zh:1128 / en:1130，删）、`daemon.topic_header_usage`（zh:1122 / en:1124，补 `wt` 形式与"latin 正文请换行"、注明可选参数不跨行）、`help.topic`（zh:733 / en:735 的"只吃一个 token"句）、docs-site zh/en `slash-commands.md` 的用法行与"建 worktree 不能写进头部"那条边界；**不动** `cmd.repo.worktree_usage`（只由会话内路径发出）。严格扩宽，不碰路由层。验证：`#1361` §3 边界表 + 本文 §13 的 PR-1 行；daemon 级用例断言 worktree 落点与 fail closed 零副作用。
- **PR-2 统一路由器**：`command-schema.ts`（含 form 级 `greedyTail`）、`SessionPhase` 推导（含 `ds.cliReady` 的置位/清零）与矩阵、纯函数路由器（分类 + 解析 + 计划）、两条 lane 显式化、legacy oracle 差分穷举、`/help` 与用法串由 schema 生成、删除 §3 里被取代的层、把源码级守卫替换成真实用例、补 §9 标"缺"的用例。**不改任何今天已接受输入的语义**："命令行 ⏎ 正文"仍按今天拒绝。
- **PR-3 runtime 级联**：§6 的 daemon 侧定序器（`prompt_ready` 代际等待、派生 turn 标识、上限、riff/mojo/adopt 拒绝），放开"命令行 ⏎ 正文"。这是唯一的语义变化，单独一个 PR 单独 canary。

PR-1 独立有价值；PR-2 若延期，PR-1 不受影响；PR-3 依赖 PR-2 的相位与 `ds.cliReady`。

## 13. 边界表（在 `#1361` §3 之上新增）

| 输入 | 结果 | PR |
|---|---|---|
| `/t /repo wt botmux ci/temp_split 简单确认…`（单行，中文正文） | `ci/temp_split` 匹配分支模式 → 分支；正文从 `简单确认` 起；目标目录 `botmux-ci-temp_split` | 1 |
| `/t /repo wt botmux 简单确认…`（无分支） | `简单确认` 不匹配 → 无分支；AI slugger 开启时语义命名，否则纯中文落 `wt/N`；正文从 `简单确认` 起 | 1 |
| `/t /repo wt botmux`（无标题无正文） | 无分支、无 slug 来源 → `wt/N`；CLI 空跑等下一条 | 1 |
| `/t /repo wt botmux fix login bug`（单行 latin 正文） | `fix` 匹配分支模式 → 分支 `fix`，正文 `login bug`。行为确定，用法串提示"latin 正文请换行" | 1 |
| `/t ⏎ /repo wt botmux ⏎ fix login bug` | 可选参数不跨行 → 无分支；正文 `fix login bug` | 1 |
| `/t /repo wt`（缺目标） | 拒：缺参数 | 1 |
| `/t /repo wt 2 x` | 拒：编号形式只对卡片有意义 | 1 |
| `/t /repo wt botmux a.lock`（或 `feat/`、`HEAD`） | 匹配粗模式被消费，`check-ref-format` 拒 → 拒：分支名不合法（前置校验，零副作用） | 1 |
| `/t /repo wt botmux -bad..name` | 不匹配粗模式 → 无分支、slug 自动推导，正文 `-bad..name` | 1 |
| `/t /repo wt botmux ci/temp_split /repo other` | 拒：重复指令 | 1 |
| `/t /repo wt botmux ci/temp_split`，`botmux-ci-temp_split` 已存在 | 拒（前置校验），零副作用 | 1 |
| 同上，`git worktree add` 失败（如分支已被别的 worktree 检出） | 话题已建，会话停 `pendingRepo` 并回错误；话题内重发 `/repo wt …` | 1 |
| 同上，`git fetch` 失败 | 不是错误：降级到本地 ref 继续 | 1 |
| 同上，创建窗口内 daemon 重启 | restore 后回到选仓卡（`pendingRepoSetup.mode = 'picker'`）；已建好的 worktree 用 `/repo <路径>` 选 | 1 |
| 会话内 `/cd /Users/foo bar`、`/rename 含 空格 的标题` | 尾参贪婪，整行当参数（与今天一致） | — |
| 会话内 `/model opus 然后继续修`（单行） | 整行逐字送 CLI（与今天一致；R8） | — |
| 会话内 `/compact 只留登录上下文` | 整行逐字送 | — |
| 会话内 `/adopt <pane>`（首行含占位符） | 不认命令，整条当讨论文本（与今天一致） | — |
| 会话内 `/model opus ⏎ /clear ⏎ 接下来看 PR` | 等空闲送 `/model opus`，等空闲送 `/clear`，等空闲送第三行；三条各自独立 turn 标识 | 3 |
| 同上，在 riff / mojo 后端或 adopt 会话 | 拒：该后端/会话不支持级联，请分条发送 | 3 |
| 同上，第二条之后 CLI 120s 内未空闲 | 剩余条目立即送出（busy delivery）并提示 | 3 |
| 会话内 `帮我看看 ⏎ /compact` | `/compact` 不在前缀块 → 整条为正文（与今天一致） | — |
| 会话内 `/foo 干活`（未注册） | 无命令 token → 短路转发（与今天一致） | — |
| 无 raw 面的 CLI 收到 `/compact ⏎ 正文` | 透传集为空 → 整条为正文（与今天一致） | — |

## 14. 未决

- `pendingRepo` 相位接受 `/model` `/effort` 作为 spawn-args（今天拒）：是严格扩宽，但不在三个 PR 的驱动用例里，矩阵首版保持今天的拒绝；要开时进 §9 有意变化表。
- `dsh-tui` 的打字透传与卡片按钮对齐（分类器传 `dshRuntime`）：属有意变化，需单独指定 PR；本设计沿用不传。
- `ds.cliReady` 在 `prompt_ready` 早于 `ready` 的后端上（riff / mojo / 快启 TUI）只作合法性判定用；riff/mojo 已有的是按远端 task 边界的信号，缺的是按写入命令逐条的边界，若后续要让它们也支持级联需要 worker 侧新信号，本设计不做。
- 透传参数形状（`none` / `token`）按 CLI 实测后再开，首版整行；`/effort` 与 `/fast` 的全局透传不变量不动。
- 头部 git 运行期失败留下的 `pendingRepo` 状态，是否需要一条"取消并关闭话题"的快捷命令，用一阵再看。
- 预设别名（`#1361` §8）在 schema 就位后成为"结构化展开"的自然扩展，本设计不做。

## 15. 执行记录

按分期在 `feat/command_op` 上实施时的决策与拿不准的点，供事后追溯。每期以一个标题含「收口」的 commit 作为分界，中间可以有多次提交。

### PR-1 头部 `/repo wt`（2026-09-11 夜）

落地形状与 §8 一致，实施中定下的细节：

- **解析层**（`src/core/topic-header.ts`）：`TopicHeader` 新增 `worktree?: { target, branch? }`，与 `directives.repo` 互斥（两者都算写了 `/repo`，重复即 `duplicate_directive`）。可选分支的两条规则用 token 的 `end` 偏移判"同一行"；粗模式 `BRANCH_TOKEN_RE` 导出供 PR-2 的 schema 参数类型复用。引号包裹的 `"wt"` 是字面量仓库名。新增错误种类 `missing_worktree_target`（`/t /repo wt`、`/t /repo wt /model x`）。
- **语义层**（`src/core/topic-spec.ts`）：`resolveTopicSpec` 改为 **async**——唯一原因是两次本地 git 查询（`check-ref-format --branch`、`worktree list --porcelain` 归一主 checkout），毫秒级、不联网。新增错误 `repo_not_git` / `branch_invalid` / `worktree_target_exists`，删除 `repo_worktree_unsupported` 及其 i18n。目标目录算法抽成 `resolveWorktreePathForBranch`（`src/services/git-worktree.ts`），并用一条测试钉住它与 `createRepoWorktree` 显式分支分支逐字一致（`test/git-worktree-header-helpers.test.ts`）。
- **执行层**：`runAutoWorktreeCommit` 加可选 `explicitWorktree`，git 腿走新的 `createExplicitWorktree`（`src/services/default-worktree.ts`，失败即抛）；失败时回 `cmd.repo.worktree_failed`、会话停在 `pendingRepo`、不 fork、不退回基目录。daemon 新话题路径：`pinnedWorkingDir` 先钉成仓库、`pinnedFromBotDefault=false`、`autoWt` 强制为真、`stageClaimedPendingRepoSetup` 按 **`picker`** 落盘（不加 `PendingRepoSetup` 新形状；创建窗口内重启回到选仓卡）。`/t /repo wt X`（无正文）与 `/t /repo X` 同样走 pending → 空跑等下一条。
- **没做 / 拿不准**：
  - 头部 `wt` 目前只在**新话题**入口生效；thread 入口只用 `topicHeaderDeclaresSpec` 判"是不是在声明规格"（已含 `worktree`），已有会话里发头部 `wt` 按 D6 拒绝，与其它头部指令一致。
  - 会话内 `/repo wt` 未动（§8 第 5 条），两处目标解析仍各一份，留给 PR-2 的 schema 消化。
  - `worktree_target_exists` 只对显式分支查；自动命名的冲突由 `createRepoWorktree` 换下一个候选。
  - `isValidBranchName` 通过 spawn `git check-ref-format` 实现而不是手写正则：git 的规则有十几条（`.lock` 结尾、`@{`、控制字符…），手抄必然漂移。
  - 测试环境：本 worktree 的 `node_modules` 按仓库规范 symlink 到 canonical checkout（锁文件逐字一致，未跑 install）。
