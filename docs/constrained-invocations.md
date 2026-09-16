# 仅模型模式：接入自带 loop 的工具（实验版 v1）

一些工具已经有自己的 Agent loop：它们负责组织上下文、选择并执行工具、检查结果，再决定是否继续调用模型。接入 Botmux 时，这类工具需要的是 CLI 背后的模型能力；如果直接使用普通编程会话，CLI 还会加载自己的工具、项目规则和历史，形成两套同时控制任务的循环。

仅模型模式把这两个职责分开：**调用方掌握 loop，Botmux 提供统一的模型调用和任务管理入口，各 CLI 适配器负责原生登录与推理协议。** 调用方提交输入和期望的 JSON 格式，获得模型回答或工具调用建议，自行执行后再发起下一轮。工具名称、参数和业务流程由调用方定义，Botmux 不替调用方运行工具或拼接历史。

例如：外部工具请求计算 19＋23 → 通过 Botmux 调用模型 → 模型返回加法建议 → 外部工具算出 42 → 再调用模型生成最终回答。换一个 CLI 应当只需要换 Bot 配置，外部 loop 使用的提交、查询、取消和去重契约保持一致。

这是面向所有 CLI 的通用能力，不是 Codex 专用协议。当前实际实现了 Codex 与 Claude Code；能力查询会列出仓库全部 CLI，并明确标记其他适配器尚未实现，不能把统一接口理解成所有 CLI 已经可用。该接口也不等于任意第三方 SDK 可以直接替换 endpoint：调用方仍需对接本页的 `session invoke` / 签名 IPC 契约。

## 支持范围与前置条件

| 条件 | 本版支持 |
|---|---|
| CLI | Codex、Claude Code；不设版本号白名单，使用各自原生协议 |
| 模型 | 调用方通过 `model` 指定，无名称白名单；由对应 CLI 解析模型标识 |
| 平台 | macOS、Linux；不支持 Windows |
| Bot | 专用 `apiOnly: true`；Codex 另需 `codexAuthSync: isolated` |
| 原生身份 | Bot 专用目录下的原生凭证文件；不主动复制全局或其他 Bot 登录 |
| 包装器/分发变体/自定义环境/启动命令 | 不支持；明确拒绝 |
| 实例池、既有 app-server、触发人身份、显式后端/worker 限额、OS 沙箱配置 | 不支持；拒绝，避免绕过原有执行/身份策略 |
| 其他 CLI | 统一能力发现已覆盖，原生执行适配尚未实现时明确返回不支持；普通交互模式不变 |
| 管理策略 | 存在 managed requirements 或额外非空配置层时拒绝，不能绕过管理员配置 |

首版只开放可信宿主 CLI → 签名 daemon IPC，不提供匿名 HTTP、IM 调用、按请求指定 owner、任意凭证目录或模型 endpoint。`applySessionOwnerEnv` 明确移除两个继承的 owner 变量。IM 用户身份委托、触发人凭证切换、普通会话续聊及 workflow trigger 接入暂不支持。

调用是 headless 命名空间下独立的一次性资源，不是可发布/绑定的交互会话。它不进入普通 PTY/tmux worker 和交互 trigger 队列，不能通过 invocation ID 向普通会话 send/resume/steer。复用宿主 IPC 鉴权、Bot 配置/隔离身份、Bot admission gate、原生凭证 provisioning 和 daemon shutdown；专门的 invocation service 持有原生子进程及结果。进程复用/预热暂不支持。

## 各 CLI 的原生适配

通用服务只管理请求、并发、去重、deadline 和结果，不依赖 Codex 协议。`ModelOnlyAdapter` 定义原生执行、身份准入及专用凭证目录；新增适配器不会改变调用方接口。能力目录从 `ALL_CLI_IDS` 派生，新增 CLI 不会因漏填列表而从发现接口消失。

### Codex

每次调用独立 HOME、CODEX_HOME、空工作目录、临时原生线程，既不加载项目目录，也不 resume 历史。只通过已有 `provisionCodexAuth` 整体提供原生凭证文件，不提取 token，不自行调用订阅内部端点。临时刷新不会写回原 Bot 的原生登录，需由原登录目录维护凭证有效性。

独立配置关闭 shell、MCP、apps、联网搜索、浏览器、图片、skills、子 Agent、hooks、记忆、计划与用户询问等能力。`thread/start` 的 `environments: []` 从原生 registry 移除 shell、apply_patch、view_image；`orchestrator.skills/mcp.enabled=false` 关闭非执行环境工具。把选定模型的目录条目复制到本次临时文件，将 `experimental_supported_tools` 清空、`tool_mode` 设为 `direct`，防止模型目录重新启用工具或代码执行器。保留模型标识、上下文和原生传输方式（包括 Responses Lite），不修改来源目录。目录中没有请求的模型时返回 `native_model_not_found`，不会偷偷换成默认模型。

在发起模型请求前检查 config layers、effective features、managed requirements、空 instructionSources 和空 runtimeWorkspaceRoots。任何无法证明的条件都失败，不退回提示词约束、普通会话或自动批准。原生 server→client 工具/审批请求全部拒绝并终止调用。

这些配置依赖原生协议能力，不再通过版本字符串判定兼容性。所需接口或隔离配置不可用时，调用会返回错误；放开版本和模型名称不代表已验证所有组合。管理员应选择可信的原版可执行文件，并在升级时运行下述空工具与恶意调用测试。

### Claude Code

通过原生 `--print --input-format stream-json --output-format stream-json` 执行一次推理，使用 `--tools ""` 关闭宿主工具、`--safe-mode` 关闭定制加载、`--strict-mcp-config` 配合空 MCP 配置，并关闭会话持久化。凭证整体复制到本次临时 `CLAUDE_CONFIG_DIR`，输入通过 stdin 传入，结果用原生 `--json-schema` 与本地校验双重约束。

Claude 使用原生 `--tools ""` 关闭工具的接口见[官方 CLI 参考](https://code.claude.com/docs/en/cli-reference)。

Claude 可能使用内部 `StructuredOutput` 工具完成 JSON 序列化；这不是文件、命令或调用方的业务工具。适配器只允许该内部工具，发现其他原生工具调用会终止任务。初始化中的工具列表及 MCP 列表也会检查。用量来自原生最终 result；缓存读写与未缓存输入合计为 `inputTokens`。

### 其他 CLI

所有已注册 CLI 使用同一能力发现接口；未实现原生适配的条目返回 `supported:false` 与 `native_model_only_adapter_not_implemented`。Claude 的 fork、Codex 的 fork、远端 Agent 服务和纯 TUI 不能仅凭血缘或相似参数自动标为支持：它们的登录、协议及工具开关需要分别验证。接入时实现 `ModelOnlyAdapter` 并增加原生工具隔离、输出校验与取消测试，生命周期和 IPC 不需要复制。

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

外部执行提议后，用**新 requestId** 提交下一轮，并显式提供所需历史/工具结果。框架不认识具体工具名，也不隐式保存或拼接 messages。支持的 JSON Schema 子集为 `type`（单类型）、`properties`、`required`、`additionalProperties:false`、`items`、标量 `enum`、`description`；对象必须列出所有 required 字段。拒绝 `$ref`、组合 schema 等未实现关键词，防止虚假的校验成功。原生 outputSchema 约束后仍有本地结果校验。

对应签名 IPC：

- `GET /api/headless/invocations/capabilities`
- `POST /api/headless/invocations`，body 为上述请求
- `GET /api/headless/invocations/:requestId`
- `POST /api/headless/invocations/:requestId/cancel`

## 生命周期和结果

同一 Bot 内相同 requestId + 相同规范化请求返回原记录；不同请求复用 ID 返回 409 `idempotency_conflict`。请求在推理前写入保留记录；不同 Bot 分目录。默认每个 Bot 最多 4 个并发，无隐藏排队。最大 deadline 300 秒，从服务接受时计算，包含启动。

`--wait-ms` 到期返回 `running`，不取消后台调用。deadline 或 cancel 会终止整个原生进程组，1 秒后以 SIGKILL 兜底，确认子进程退出并清理临时目录后才写终态。终态为 `completed/failed/cancelled/timed_out`，可反复读取。daemon 正常关闭会取消所有 invocation；daemon 意外退出后的已接受请求标为 `interrupted_unknown_outcome`，不会自动重复推理。Codex 在宿主输入管道关闭后退出；Claude 由独立的 POSIX 进程组守护器检查宿主进程身份，宿主死亡后终止整组进程；SIGKILL 可能留下权限为 0700 的临时目录，应由宿主临时目录保留策略清理。结果记录默认保留，不自动删除；删除记录也会删除该 ID 的幂等保护。

返回指标：

- `configuredModel` / `reasoningEffort`：原生初始化回读；Codex 的 `actualModel:null` 表示协议未提供独立的实际执行模型证明，Claude 从原生 assistant 事件读取执行模型。
- `startupMs`：准备目录、启动进程及原生初始化的总时间；`durationMs` 包含回收。均为实测，没有估计值。
- `usage`：Codex 使用原生 `thread/tokenUsage/updated.total` 快照。每个 invocation 一个新线程，更新时替换，不累加通知；`inputTokens` 包含缓存输入，`cachedInputTokens` 是其中的子集，不能再加一次。
- 未观测用量为 `usage:null`，缓存指标未知为 null，绝不补 0。`usageSource` 区分 Codex 的 `native_thread_total` 与 Claude 的 `native_result`。schema 校验等后期失败保留已观测的用量。

## 可复现验证

```bash
bun run test -- test/constrained-invocation.test.ts test/ipc-constrained-invocation.test.ts
BOTMUX_CONSTRAINED_CODEX=codex bun x vitest run --project e2e test/constrained-codex.e2e.ts
BOTMUX_MODEL_ONLY_CLAUDE=claude bun x vitest run --project e2e test/model-only-claude.e2e.ts
bun run build
# 以下明确消耗现有订阅；只用合成加法 fixture，不发送 IM：
BOTMUX_CONSTRAINED_AUTH_HOME="$NATIVE_CODEX_HOME" BOTMUX_CONSTRAINED_MODEL="$MODEL" bun scripts/smoke-constrained-invocation.ts
```

原生 e2e 使用无凭证 loopback fixture provider：覆盖普通 Responses 的 `tools: []` 和 Responses Lite 的空 `additional_tools`；即使模型目录原本声明时钟、用户询问和 code mode，强行注入 shell 调用仍不落盘、外部工具往返、schema 失败、挂起请求取消，以及宿主被强杀后原生 worker 退出。loopback fixture 仅用于测试，不是产品代理服务。

本次以 Codex 0.153.4 / gpt-5.6-luna 配置执行 Linux 独立原生订阅 smoke，两轮均通过：启动 348/346 ms，总耗时 4653/4424 ms，输入 token 818/806，输出 token 54/41，原生缓存计数均为 0。重复提交每轮 ID 未产生重复推理，外部加法结果为 42。此前 gpt-5.5 配置也已完成同一闭环；这些是验证样本，不是版本或模型白名单，也不代表质量评测或性能承诺。真实 daemon IPC 的鉴权与幂等由针对性测试覆盖。
