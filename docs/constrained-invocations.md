# 程序调用 Codex 后台推理任务（实验版 v1）

程序可以通过 `botmux session invoke` 提交一个问题，让 Codex 在后台思考并按指定 JSON 格式交回答案。程序可以查询结果、取消任务，也可以让 Codex 返回工具调用建议：例如 Codex 提议做加法，调用方执行加法，再把结果交给下一次推理。Codex 不直接操作宿主文件或执行命令。

调用使用已有 Codex 原生登录。返回的 `tool_calls` 是调用方定义的数据，Botmux 不执行它们；这是通过原生 Agent 协议提供的调用入口。

## 支持范围与前置条件

| 条件 | 本版支持 |
|---|---|
| CLI | 原版 Codex；不设版本号白名单，运行时检查所需协议和隔离配置 |
| 模型 | 调用方通过 `model` 指定，无名称白名单；从原生目录选择对应条目，保留原生传输方式并在本次调用中关闭工具 |
| 平台 | macOS、Linux；不支持 Windows |
| Bot | 专用 `apiOnly: true`、`cliId: codex`、`codexAuthSync: isolated` |
| 原生身份 | 专用 Bot 的原生 `auth.json`；不回退到全局或其他 Bot 登录 |
| 包装器/分发变体/自定义环境/启动命令 | 不支持；明确拒绝 |
| 实例池、既有 app-server、触发人身份、显式后端/worker 限额、OS 沙箱配置 | 不支持；拒绝，避免绕过原有执行/身份策略 |
| 其他 CLI | 暂未接入；普通交互模式不变 |
| 管理策略 | 存在 managed requirements 或额外非空配置层时拒绝，不能绕过管理员配置 |

首版只开放可信宿主 CLI → 签名 daemon IPC，不提供匿名 HTTP、IM 调用、按请求指定 owner、任意凭证目录或模型 endpoint。`applySessionOwnerEnv` 明确移除两个继承的 owner 变量。IM 用户身份委托、触发人凭证切换、普通会话续聊及 workflow trigger 接入暂不支持。

调用是 headless 命名空间下独立的一次性资源，不是可发布/绑定的交互会话。它不进入普通 PTY/tmux worker 和交互 trigger 队列，不能通过 invocation ID 向普通会话 send/resume/steer。复用宿主 IPC 鉴权、Bot 配置/隔离身份、Bot admission gate、原生凭证 provisioning 和 daemon shutdown；专门的 invocation service 持有原生子进程及结果。进程复用/预热暂不支持。

## 原生约束

每次调用独立 HOME、CODEX_HOME、空工作目录、临时原生线程，既不加载项目目录，也不 resume 历史。只通过已有 `provisionCodexAuth` 整体提供原生凭证文件，不提取 token，不自行调用订阅内部端点。临时刷新不会写回原 Bot 的原生登录，需由原登录目录维护凭证有效性。

独立配置关闭 shell、MCP、apps、联网搜索、浏览器、图片、skills、子 Agent、hooks、记忆、计划与用户询问等能力。`thread/start` 的 `environments: []` 从原生 registry 移除 shell、apply_patch、view_image；`orchestrator.skills/mcp.enabled=false` 关闭非执行环境工具。把选定模型的目录条目复制到本次临时文件，将 `experimental_supported_tools` 清空、`tool_mode` 设为 `direct`，防止模型目录重新启用工具或代码执行器。保留模型标识、上下文和原生传输方式（包括 Responses Lite），不修改来源目录。目录中没有请求的模型时返回 `native_model_not_found`，不会偷偷换成默认模型。

在发起模型请求前检查 config layers、effective features、managed requirements、空 instructionSources 和空 runtimeWorkspaceRoots。任何无法证明的条件都失败，不退回提示词约束、普通会话或自动批准。原生 server→client 工具/审批请求全部拒绝并终止调用。

这些配置依赖原生协议能力，不再通过版本字符串判定兼容性。所需接口或隔离配置不可用时，调用会返回错误；放开版本和模型名称不代表已验证所有组合。管理员应选择可信的原版可执行文件，并在升级时运行下述空工具与恶意调用测试。

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

build capability `constrained_invocation_v1` 声明接口存在；Bot capability 的 `supported` 声明配置可被准入，`runtimeVerified:false` 提醒尚未探测实际进程。每次 start 都重新检查实际原生运行时，不能仅凭 capability 响应认定订阅可用。

`request.json` 示例（`model` 可替换为原生目录中的其他模型名称）：

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

`--wait-ms` 到期返回 `running`，不取消后台调用。deadline 或 cancel 会终止整个原生进程组，1 秒后以 SIGKILL 兜底，确认子进程退出并清理临时目录后才写终态。终态为 `completed/failed/cancelled/timed_out`，可反复读取。daemon 正常关闭会取消所有 invocation；daemon 意外退出后的已接受请求标为 `interrupted_unknown_outcome`，不会自动重复推理。原生 stdio 在宿主进程死亡时关闭，原生进程退出；SIGKILL 可能留下权限为 0700 的临时目录，应由宿主临时目录保留策略清理。结果记录默认保留，不自动删除；删除记录也会删除该 ID 的幂等保护。

返回指标：

- `configuredModel` / `reasoningEffort`：原生 thread/start 回读；`actualModel:null` 表示协议未提供独立的实际执行模型证明。
- `startupMs`：准备目录、启动进程及 thread/start 的总时间；`durationMs` 包含回收。均为实测，没有估计值。
- `usage`：原生 `thread/tokenUsage/updated.total` 快照。每个 invocation 一个新线程，更新时替换，不累加通知；`inputTokens` 包含缓存输入，`cachedInputTokens` 是其中的子集，不能再加一次。
- 未观测用量为 `usage:null`，缓存指标未知为 null，绝不补 0。`usageSource` 明确标为 `native_thread_total`。schema 校验等后期失败保留已观测的用量。

## 可复现验证

```bash
bun run test -- test/constrained-invocation.test.ts test/ipc-constrained-invocation.test.ts
BOTMUX_CONSTRAINED_CODEX=codex bun x vitest run --project e2e test/constrained-codex.e2e.ts
bun run build
# 以下明确消耗现有订阅；只用合成加法 fixture，不发送 IM：
BOTMUX_CONSTRAINED_AUTH_HOME="$NATIVE_CODEX_HOME" BOTMUX_CONSTRAINED_MODEL="$MODEL" bun scripts/smoke-constrained-invocation.ts
```

原生 e2e 使用无凭证 loopback fixture provider：覆盖普通 Responses 的 `tools: []` 和 Responses Lite 的空 `additional_tools`；即使模型目录原本声明时钟、用户询问和 code mode，强行注入 shell 调用仍不落盘、外部工具往返、schema 失败、挂起请求取消，以及宿主被强杀后原生 worker 退出。loopback fixture 仅用于测试，不是产品代理服务。

本次以 Codex 0.153.4 / gpt-5.6-luna 配置执行 Linux 独立原生订阅 smoke，两轮均通过：启动 348/346 ms，总耗时 4653/4424 ms，输入 token 818/806，输出 token 54/41，原生缓存计数均为 0。重复提交每轮 ID 未产生重复推理，外部加法结果为 42。此前 gpt-5.5 配置也已完成同一闭环；这些是验证样本，不是版本或模型白名单，也不代表质量评测或性能承诺。真实 daemon IPC 的鉴权与幂等由针对性测试覆盖。
