# 仅模型模式：接入自带 loop 的工具（实验版 v1）

一些工具已经有自己的 Agent loop：它们负责组织上下文、选择并执行工具、检查结果，再决定是否继续调用模型。接入 Botmux 时，这类工具需要的是 CLI 背后的模型能力；如果直接使用普通编程会话，CLI 还会加载自己的工具、项目规则和历史，形成两套同时控制任务的循环。

仅模型模式把这两个职责分开：**调用方掌握 loop，Botmux 提供统一的模型调用和任务管理入口，各 CLI 适配器负责原生登录与推理协议。** 调用方提交输入和期望的 JSON 格式，获得模型回答或工具调用建议，自行执行后再发起下一轮。工具名称、参数和业务流程由调用方定义，Botmux 不替调用方运行工具或拼接历史。

例如：外部工具请求计算 19＋23 → 通过 Botmux 调用模型 → 模型返回加法建议 → 外部工具算出 42 → 再调用模型生成最终回答。换一个 CLI 应当只需要换 Bot 配置，外部 loop 使用的提交、查询、取消和去重契约保持一致。

这是面向所有 CLI 的通用能力，不是 Codex 专用协议。当前接通 7 个 CLI 标识：Codex、Codex App、Claude Code、Pi、MiniMax、Gemini、OpenCode；全部 31 项的核查结果见下表。其余 24 项有明确的验证阻塞或接口缺口，不能把统一接口理解成所有 CLI 已经可用。该接口也不等于任意第三方 SDK 可以直接替换 endpoint：调用方仍需对接本页的 `session invoke` / 签名 IPC 契约。

## 支持范围与前置条件

| 条件 | 本版支持 |
|---|---|
| CLI | 7 个标识，见逐项表格；不设版本号白名单，使用各自原生协议 |
| 模型 | 调用方通过 `model` 指定，无名称白名单；由对应 CLI 解析模型标识 |
| 平台 | macOS、Linux；不支持 Windows |
| Bot | 专用 `apiOnly: true`；Codex / Codex App 另需 `codexAuthSync: isolated` |
| 原生身份 | Bot 专用目录下的原生凭证文件；不主动复制全局或其他 Bot 登录 |
| 包装器/分发变体/自定义环境/启动命令 | 不支持；明确拒绝 |
| 实例池、既有 app-server、触发人身份、显式后端/worker 限额、OS 沙箱配置 | 不支持；拒绝，避免绕过原有执行/身份策略 |
| 其他 CLI | 统一能力发现已覆盖，原生执行适配尚未实现时明确返回不支持；普通交互模式不变 |
| 管理策略 | 存在 managed requirements 或额外非空配置层时拒绝，不能绕过管理员配置 |

首版只开放可信宿主 CLI → 签名 daemon IPC，不提供匿名 HTTP、IM 调用、按请求指定 owner、任意凭证目录或模型 endpoint。`applySessionOwnerEnv` 明确移除两个继承的 owner 变量。IM 用户身份委托、触发人凭证切换、普通会话续聊及 workflow trigger 接入暂不支持。

调用是 headless 命名空间下独立的一次性资源，不是可发布/绑定的交互会话。它不进入普通 PTY/tmux worker 和交互 trigger 队列，不能通过 invocation ID 向普通会话 send/resume/steer。复用宿主 IPC 鉴权、Bot 配置/隔离身份、Bot admission gate、原生凭证 provisioning 和 daemon shutdown；专门的 invocation service 持有原生子进程及结果。进程复用/预热暂不支持。

## 各 CLI 的原生适配

通用服务只管理请求、并发、去重、deadline 和结果，不依赖 Codex 协议。`ModelOnlyAdapter` 定义原生执行、身份准入及专用凭证目录；新增适配器不会改变调用方接口。能力目录从 `ALL_CLI_IDS` 派生，新增 CLI 不会因漏填列表而从发现接口消失。

### Codex / Codex App

每次调用独立 HOME、CODEX_HOME、空工作目录、临时原生线程，既不加载项目目录，也不 resume 历史。只通过已有 `provisionCodexAuth` 整体提供原生凭证文件，不提取 token，不自行调用订阅内部端点。临时刷新不会写回原 Bot 的原生登录，需由原登录目录维护凭证有效性。

独立配置关闭 shell、MCP、apps、联网搜索、浏览器、图片、skills、子 Agent、hooks、记忆、计划与用户询问等能力。`thread/start` 的 `environments: []` 从原生 registry 移除 shell、apply_patch、view_image；`orchestrator.skills/mcp.enabled=false` 关闭非执行环境工具。把选定模型的目录条目复制到本次临时文件，将 `experimental_supported_tools` 清空、`tool_mode` 设为 `direct`，防止模型目录重新启用工具或代码执行器。保留模型标识、上下文和原生传输方式（包括 Responses Lite），不修改来源目录。目录中没有请求的模型时返回 `native_model_not_found`，不会偷偷换成默认模型。

在发起模型请求前检查 config layers、effective features、managed requirements、空 instructionSources 和空 runtimeWorkspaceRoots。任何无法证明的条件都失败，不退回提示词约束、普通会话或自动批准。原生 server→client 工具/审批请求全部拒绝并终止调用。

这些配置依赖原生协议能力，不再通过版本字符串判定兼容性。所需接口或隔离配置不可用时，调用会返回错误；放开版本和模型名称不代表已验证所有组合。管理员应选择可信的原版可执行文件，并在升级时运行下述空工具与恶意调用测试。

### Claude Code

通过原生 `--print --input-format stream-json --output-format stream-json` 执行一次推理，使用 `--tools ""` 关闭宿主工具、`--safe-mode` 关闭定制加载、`--strict-mcp-config` 配合空 MCP 配置，并关闭会话持久化。凭证整体复制到本次临时 `CLAUDE_CONFIG_DIR`，输入通过 stdin 传入，结果用原生 `--json-schema` 与本地校验双重约束。

Claude 使用原生 `--tools ""` 关闭工具的接口见[官方 CLI 参考](https://code.claude.com/docs/en/cli-reference)。

Claude 可能使用内部 `StructuredOutput` 工具完成 JSON 序列化；这不是文件、命令或调用方的业务工具。适配器只允许该内部工具，发现其他原生工具调用会终止任务。初始化中的工具列表及 MCP 列表也会检查。用量来自原生最终 result；缓存读写与未缓存输入合计为 `inputTokens`。

### 原生非交互调用：Pi / MiniMax

Pi 使用 `--no-tools --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --no-session`，通过原生 print/json 协议读取结果。只复制专用 `auth.json`，禁止 `!command` 凭证 helper，不复制模型扩展或其他用户配置。模型由原生目录解析；`model` 可用 `provider/model`，`reasoningEffort:none` 映射为 `off`，`ultra` 明确报不支持。参见 [Pi 官方参数](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#cli-reference)。

MiniMax 使用原生 `mmx text chat --messages-file - --output json`，不传 `--tool`。整体提供专用 `config.json`，由原生 CLI 处理认证、区域和 OAuth 刷新；不抽取 token。当前原生接口没有本契约对应的 `reasoningEffort` 参数，指定时明确报错。参见 [MiniMax 官方 CLI](https://github.com/MiniMax-AI/cli)。

两者使用空工作目录和独立 HOME，stdin 传入内容，返回 JSON 经本地 schema 校验。Pi 原生停止事件和 MiniMax 原生 stop reason 必须表示完整结束；意外工具调用或截断不能被当作成功。

### 原生策略控制：Gemini / OpenCode

Gemini 使用 headless stream-json、空 `tools.core` 和匹配全部工具的 deny policy。原生请求已验证没有函数定义；关闭 hooks、skills、项目上下文，替换系统提示。输入封装为 JSON 数据，避免斜杠命令和 `@file` 处理。生产入口只接 Bot 专用 OAuth 文件，不使用宿主 keychain 或 `.env`；原生合成 API 测试已通过，真实 OAuth 账号尚未验证。`reasoningEffort` 当前明确报不支持。参见 [Gemini 官方策略引擎](https://geminicli.com/docs/reference/policy-engine/)。

OpenCode 使用 `run --pure --format json`，专用 agent 和全局权限均拒绝所有工具。关闭自动标题、摘要及压缩，原生测试确认每次只发出一次模型请求。只复制专用 `auth.json` 中的原生 API/OAuth 记录；拒绝可能加载远端配置的 well-known 身份，不复制用户配置或外部插件。macOS/Linux 系统管理配置存在时拒绝，不覆盖。`actualModel` 保持 null，因为该原生输出没有独立报告实际执行模型。参见 [OpenCode 官方源码](https://github.com/anomalyco/opencode)。

### 全部 CLI 核查表

**7 项已适配，19 项待验证，5 项当前核查存在接口缺口。** “待验证”不表示上游无法实现；具体缺少的程序、认证隔离或协议证据如下。已适配也不代表所有账号和版本已经验收。普通 PTY/tmux 会话的支持范围不受影响。

| CLI | 分组 | 状态 | 验证结果或未适配原因 |
|---|---|---|---|
| `claude-code` | claude-print | 已适配 | 原生 print/stream-json、空 tools、安全模式；原生合成服务测试通过，真实订阅认证待验证。 |
| `seed` | claude-print | 待验证 | 使用独立的 byted-cloud-auth.json；缺少可运行的 Seed，未验证空 tools、安全模式和隔离登录，不能直接继承 Claude 支持。 |
| `relay` | claude-print | 待验证 | Relay 的登录目录和迁移行为不同于 Claude；缺少可运行的 Relay，未验证原生工具关闭及独立身份。 |
| `aiden` | native-print | 待验证 | 原生帮助确认有 --no-tools、--stream-json；原生登录涉及多种 token 文件，尚未完成无配置、无插件的独立认证验证。 |
| `coco` | trae-app-server | 待验证 | 检查到的旧原生接口只有 print/json 和自动批准 allowed-tool；新版与 TraeX 共用实现，但零工具目录和认证适配尚未验证。 |
| `codex` | codex-app-server | 已适配 | 独立 app-server、空工具和临时线程；原生合成服务测试及 Linux 真实订阅外部 loop 通过。 |
| `codex-app` | codex-app-server | 已适配 | 复用同一 Codex 可执行文件和隔离 app-server 通道；独立 IPC 路由测试通过，不连接既有服务或实例池。 |
| `cursor` | native-print | 接口缺口 | 原生 help 的 ask/plan 仍是只读 Agent，print 明确保留工具；本次核查未发现可验证的空工具目录接口。 |
| `gemini` | policy-headless | 已适配 | headless stream-json、空 core 工具和全部拒绝策略；原生合成服务测试通过，OAuth 登录待真实账号验证。 |
| `genius` | claude-print | 待验证 | 使用 Genius 自己的凭证和状态目录；缺少原生程序，未验证 Claude 风格参数是否提供相同隔离保证。 |
| `opencode` | policy-headless | 已适配 | run/json、pure 模式、全部工具拒绝，关闭标题与压缩子调用；原生合成服务测试通过。 |
| `opencode2` | policy-headless | 待验证 | 仓库适配器明确使用 V2 插件、配置和服务接口；缺少 opencode2 原生程序，不能以 OpenCode 的测试替代。 |
| `antigravity` | native-print | 待验证 | 仓库目标是 Agent CLI；本次找到的同名 agy 是编辑器启动器，无法验证目标 Agent 的 print 和工具隔离协议。 |
| `mtr` | policy-headless | 待验证 | 仓库目标是 OpenCode 衍生 Agent；本次找到的同名 mtr 是网络诊断工具，缺少目标程序做原生验证。 |
| `hermes` | native-print | 待验证 | 官方源码有单次调用和 toolsets 入口；未获得可运行的 Hermes 环境，空工具集、认证及 hooks 隔离未完成原生验证。 |
| `mira` | remote-agent | 接口缺口 | 当前接入是云端 chat/completion；tool_list 只体现检索配置，尚无证据证明可禁用整个服务端工具与 Agent loop。 |
| `mir` | native-print | 待验证 | 现有 print runner 依赖原生本地 MCP bridge；缺少 mircli，未验证关闭 bridge 和宿主工具后仍可推理。 |
| `traex` | trae-app-server | 待验证 | 已确认原生 app-server 和工具禁用选项；TRAE_HOME、认证和工具目录与 Codex 不同，尚未证明完整空工具调用。 |
| `pi` | native-print | 已适配 | 原生 --no-tools、禁用扩展与上下文、print/json；原生合成服务测试通过，拒绝可执行凭证 helper。 |
| `copilot` | native-print | 待验证 | 原生帮助有 available-tools；OAuth 优先存入系统凭证库，文件回退混在配置中，尚未证明专用 Bot 认证不会回退宿主身份。 |
| `oh-my-pi` | native-print | 待验证 | 原生 --no-tools 可用，但认证、设置等共存于 agent.db 并支持 auth broker；不能复制整个数据库或直接套用 Pi auth.json。 |
| `ebsd` | service-agent | 待验证 | 仓库使用固定 HOME 下的 service 身份和 botmux 子命令，禁止 per-bot HOME 覆盖；未验证独立身份和零工具协议。 |
| `kimi` | agent-profile | 待验证 | 官方源码提供自定义 agent 文件及 tools 列表；缺少可运行的 Kimi，空列表、OAuth 目录和非交互输出未原生验证。 |
| `grok` | native-print | 接口缺口 | 官方 headless 文档说明工具筛选后仍保留常驻 MCP meta-tools；尚未找到并验证完全关闭这些能力的方法。 |
| `kiro-cli` | agent-profile | 待验证 | 官方 agent 配置区分 tools 与 allowedTools；缺少原生程序，tools 空列表及自动内置能力、认证隔离尚未验证。 |
| `riff` | remote-agent | 接口缺口 | 现有后端提交远端 Agent 任务并使用远端工具；当前接口没有已核实的纯模型、无服务端 loop 契约。 |
| `reasonix` | native-print | 待验证 | 仓库目前接入 TUI 和本地 transcript；缺少原生程序及已验证的非交互零工具入口。 |
| `dsh` | agent-profile | 待验证 | 现有 runner 使用 profile 认证和 ACP session/prompt；缺少 dsh 程序，profile 的空工具和无定制加载未验证。 |
| `dsh-tui` | agent-profile | 待验证 | 这是独立 TUI 入口，配置和登录关联 dsh；未验证可复用的原生 model-only 协议，不能退回 PTY 提示词限制。 |
| `mojo` | remote-agent | 接口缺口 | 现有 CLI 管理后台远端 Agent session；session cancel 能控制任务生命周期，但没有已核实的禁用远端工具和 loop 参数。 |
| `minimax` | native-print | 已适配 | 原生 text chat/json，不传任何 tool；原生合成服务测试通过，使用原生 config.json 维护区域和认证。 |

此表对应 `src/services/constrained-invocation/support-status.ts`；闭合的 `Record<CliId, …>` 和回归测试要求每个新 CLI 都有评估。能力接口返回相同的 `assessment`、机器可读 `reason` 和说明，未通过验证的项目保持 `supported:false`。各 CLI 的亲缘关系仅用于分组，不自动继承兼容性。

Grok 的常驻 meta-tools 依据[官方 headless 文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)；Kiro 的候选适配入口见[官方 agent 配置](https://kiro.dev/docs/custom-agents/configuration-reference/)。其余核查结合仓库现有适配器、已安装 CLI 原生帮助和公开源代码，不能用“允许自动批准”替代“模型不可见工具”。

## 接入

在一个独立 core-only 实例设置以下环境，然后使用仓库正常的 `serve --api-only` 入口。`STATE_DIR` 和 `PORT` 由宿主选择，勿复用已有实例的数据目录和监听端口。

```bash
export BOTMUX_CORE_CLI=codex
export BOTMUX_API_ONLY_BOT=local_reasoner
export BOTMUX_CORE_CODEX_AUTH_SYNC=isolated
export BOTMUX_CORE_STATE_DIR="$STATE_DIR/data"
export BOTMUX_API_PORT="$PORT"
botmux serve --api-only
```

专用原生目录是 `$STATE_DIR/bots/local_reasoner/codex`。先用原生 `CODEX_HOME=... codex login` 完成该目录的登录，并确保其 `models_cache.json` 包含要使用的模型条目。可以用原生 `codex debug models` 写入临时文件后重命名为 `models_cache.json`；不要覆盖正在读取的缓存文件。不会自动复制其他 Bot 的身份。

CLI 通过 `SESSION_DATA_DIR="$STATE_DIR/data"` 查找该实例；凭证仍是同一可信宿主的 daemon IPC secret。

```bash
botmux capabilities --json
botmux session invoke capabilities --bot local_reasoner --json
botmux session invoke start --bot local_reasoner --request-file request.json --wait-ms 30000 --json
botmux session invoke result --bot local_reasoner --request-id round-1 --wait-ms 30000 --json
botmux session invoke cancel --bot local_reasoner --request-id round-1 --json
```

build capability `model_only_invocation_v1` 声明接口存在（保留 `constrained_invocation_v1` 兼容标识）；Bot capability 的 `supported` 声明配置可被准入，`runtimeVerified:false` 提醒尚未探测实际进程。每次 start 都重新检查实际原生运行时，不能仅凭 capability 响应认定订阅可用。

Claude Code 使用同一启动方式，将 `BOTMUX_CORE_CLI` 改为 `claude-code`，在 `$STATE_DIR/bots/local_reasoner/claude` 放置该 Bot 的原生 `.credentials.json` 登录文件，请求中的 `model` 使用 Claude 支持的模型名称。该入口不读取 settings 中的 API key 或执行认证 helper；其他认证来源需要另外适配。

其他已适配 CLI 修改同一 `BOTMUX_CORE_CLI`；专用认证目录如下，文件必须满足宿主凭证安全检查（普通文件、0600），不主动复制其他身份：

| CLI | `$STATE_DIR/bots/local_reasoner/` 下目录 | 原生文件 |
|---|---|---|
| `pi` | `pi` | `auth.json`（API key 或 OAuth；不支持可执行 helper） |
| `minimax` | `minimax` | `config.json`（原生认证和区域） |
| `gemini` | `gemini` | `oauth_creds.json`，可选 `google_accounts.json` |
| `opencode` | `opencode` | `auth.json`（仅 API/OAuth 记录） |

原生刷新只影响本次临时副本，不回写来源登录目录；来源登录需保持有效。Pi / Gemini / OpenCode 不复制自定义模型目录与 provider 插件。模型能力、原生认证以及操作系统管理策略不满足时明确报错。

`capabilities` 的 `mode` 为 `model_only`、`loopOwner` 为 `caller`，`adapters` 列出全部已注册 CLI 的接通状态。`supported:true` 仍不代表已经在线验证当前账号。

`request.json` 示例（更换 CLI 时替换 `model`）：

```json
{
  "requestId": "round-1",
  "prompt": "请返回需要交给外部调用方执行的工具提议。工具 add 接受两个整数。请求 add(19,23)。",
  "model": "gpt-5.5",
  "reasoningEffort": "high",
  "deadlineMs": 120000,
  "outputSchema": {
    "type": "object",
    "properties": {
      "content": {"type": "string"},
      "tool_calls": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "arguments": {"type": "string"}
          },
          "required": ["name", "arguments"],
          "additionalProperties": false
        }
      }
    },
    "required": ["content", "tool_calls"],
    "additionalProperties": false
  }
}
```

外部执行提议后，用**新 requestId** 提交下一轮，并显式提供所需历史/工具结果。框架不认识具体工具名，也不隐式保存或拼接 messages。支持的 JSON Schema 子集为 `type`（单类型）、`properties`、`required`、`additionalProperties:false`、`items`、标量 `enum`、`description`；对象必须列出所有 required 字段。拒绝 `$ref`、组合 schema 等未实现关键词，防止虚假的校验成功。提供原生 schema 参数的 CLI 同时使用原生约束；其他 CLI 使用输出格式提示。所有结果均须通过本地 schema 校验，不合规结果明确失败。

对应签名 IPC：

- `GET /api/headless/invocations/capabilities`
- `POST /api/headless/invocations`，body 为上述请求
- `GET /api/headless/invocations/:requestId`
- `POST /api/headless/invocations/:requestId/cancel`

## 生命周期和结果

同一 Bot 内相同 requestId + 相同规范化请求返回原记录；不同请求复用 ID 返回 409 `idempotency_conflict`。请求在推理前写入保留记录；不同 Bot 分目录。默认每个 Bot 最多 4 个并发，无隐藏排队。最大 deadline 300 秒，从服务接受时计算，包含启动。

`--wait-ms` 到期返回 `running`，不取消后台调用。deadline 或 cancel 会终止整个原生进程组，1 秒后以 SIGKILL 兜底，确认子进程退出并清理临时目录后才写终态。终态为 `completed/failed/cancelled/timed_out`，可反复读取。daemon 正常关闭会取消所有 invocation；daemon 意外退出后的已接受请求标为 `interrupted_unknown_outcome`，不会自动重复推理。Codex 在宿主输入管道关闭后退出；Claude 由独立的 POSIX 进程组守护器检查宿主进程身份，宿主死亡后终止整组进程；SIGKILL 可能留下权限为 0700 的临时目录，应由宿主临时目录保留策略清理。结果记录默认保留，不自动删除；删除记录也会删除该 ID 的幂等保护。

返回指标：

- `configuredModel` / `reasoningEffort`：选定的原生调用配置；可回读时采用初始化值。`actualModel` 仅使用原生独立报告，Codex / OpenCode 未报告时为 null。
- `startupMs`：原生初始化或首个 Agent 开始事件前的实测时间，不同协议的观测点不同；MiniMax 无该事件，返回 null。`durationMs` 包含回收，不将各 CLI 的启动指标当作统一性能基准。
- `usage`：Codex 使用原生 `thread/tokenUsage/updated.total` 快照。每个 invocation 一个新线程，更新时替换，不累加通知；`inputTokens` 包含缓存输入，`cachedInputTokens` 是其中的子集，不能再加一次。
- 未观测用量为 `usage:null`，缓存指标未知为 null，绝不补 0。`usageSource` 区分 Codex 的 `native_thread_total` 与其他适配器的 `native_result`。schema 校验等后期失败保留已观测的用量。

## 可复现验证

```bash
bun run test -- --configLoader runner test/constrained-invocation.test.ts test/ipc-constrained-invocation.test.ts test/model-only-print.test.ts
BOTMUX_CONSTRAINED_CODEX=codex bun x vitest run --project e2e test/constrained-codex.e2e.ts
BOTMUX_MODEL_ONLY_CLAUDE=claude bun x vitest run --project e2e test/model-only-claude.e2e.ts
BOTMUX_MODEL_ONLY_PI=pi BOTMUX_MODEL_ONLY_MINIMAX=mmx bun x vitest run --configLoader runner --project e2e test/model-only-print.e2e.ts
BOTMUX_MODEL_ONLY_GEMINI=gemini bun x vitest run --configLoader runner --project e2e test/model-only-gemini.e2e.ts
BOTMUX_MODEL_ONLY_OPENCODE=opencode bun x vitest run --configLoader runner --project e2e test/model-only-opencode.e2e.ts
bun run build
# 以下明确消耗现有订阅；只用合成加法 fixture，不发送 IM：
BOTMUX_CONSTRAINED_AUTH_HOME="$NATIVE_CODEX_HOME" BOTMUX_CONSTRAINED_MODEL="$MODEL" bun scripts/smoke-constrained-invocation.ts
```

原生 e2e 使用无凭证 loopback fixture provider：覆盖普通 Responses 的 `tools: []` 和 Responses Lite 的空 `additional_tools`；即使模型目录原本声明时钟、用户询问和 code mode，强行注入 shell 调用仍不落盘、外部工具往返、schema 失败、挂起请求取消，以及宿主被强杀后原生 worker 退出。loopback fixture 仅用于测试，不是产品代理服务。

本次以 Codex 0.153.4 / gpt-5.6-luna 配置执行 Linux 独立原生订阅 smoke，两轮均通过：启动 348/346 ms，总耗时 4653/4424 ms，输入 token 818/806，输出 token 54/41，原生缓存计数均为 0。重复提交每轮 ID 未产生重复推理，外部加法结果为 42。此前 gpt-5.5 配置也已完成同一闭环；这些是验证样本，不是版本或模型白名单，也不代表质量评测或性能承诺。真实 daemon IPC 的鉴权与幂等由针对性测试覆盖。

新增 Pi / MiniMax / Gemini / OpenCode 的原生合成 API 测试覆盖零工具请求、恶意工具回包、取消和本地 schema 校验；OpenCode 另检查无标题子调用及缓存/推理 token 归一化。这些通过的是原生 CLI 协议，真实账号登录仍需分别验证，不能与 Codex 的真实订阅 smoke 混同。
