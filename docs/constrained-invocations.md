# 受约束的后台 Agent 调用（实验版 v1）

外部 orchestrator 可以通过 `botmux session invoke` 使用已有 Codex 原生登录，提交一次独立的结构化推理。模型返回的 `tool_calls` 是调用方定义的数据，由外部 orchestrator 执行；Botmux 不执行它们。这是 Agent 协议适配，不等价于原始模型 completion，也不是 OpenAI 代理服务。

## 支持范围与前置条件

| 条件 | 本版支持 |
|---|---|
| CLI | 原版 Codex **0.153.4**，显式版本门禁 |
| 模型 | **gpt-5.5**，原生目录必须没有 `experimental_supported_tools`，且不使用 Responses Lite |
| 平台 | macOS、Linux；不支持 Windows |
| Bot | 专用 `apiOnly: true`、`cliId: codex`、`codexAuthSync: isolated` |
| 原生身份 | 专用 Bot 的原生 `auth.json`；不回退到全局或其他 Bot 登录 |
| 包装器/分发变体/自定义环境/启动命令 | 不支持；明确拒绝 |
| 实例池、既有 app-server、触发人身份、显式后端/worker 限额、OS 沙箱配置 | 不支持；拒绝，避免绕过原有执行/身份策略 |
| 其他 CLI、其他版本、其他模型 | 明确拒绝；普通交互模式不变 |
| 管理策略 | 存在 managed requirements 或额外非空配置层时拒绝，不能绕过管理员配置 |

首版只开放可信宿主 CLI → 签名 daemon IPC，不提供匿名 HTTP、IM 调用、按请求指定 owner、任意凭证目录或模型 endpoint。`applySessionOwnerEnv` 明确移除两个继承的 owner 变量。IM 用户身份委托、触发人凭证切换、普通会话续聊及 workflow trigger 接入暂不支持。

调用是 headless 命名空间下独立的一次性资源，不是可发布/绑定的交互会话。它不进入普通 PTY/tmux worker 和交互 trigger 队列，不能通过 invocation ID 向普通会话 send/resume/steer。复用宿主 IPC 鉴权、Bot 配置/隔离身份、Bot admission gate、原生凭证 provisioning 和 daemon shutdown；专门的 invocation service 持有原生子进程及结果。进程复用/预热暂不支持。

## 原生约束

每次调用独立 HOME、CODEX_HOME、空工作目录、临时原生线程，既不加载项目目录，也不 resume 历史。只通过已有 `provisionCodexAuth` 整体提供原生凭证文件，不提取 token，不自行调用订阅内部端点。临时刷新不会写回原 Bot 的原生登录，需由原登录目录维护凭证有效性。

版本化配置关闭 shell、MCP、apps、联网搜索、浏览器、图片、skills、子 Agent、hooks、记忆、计划与用户询问等能力。`thread/start` 的 `environments: []` 从原生 registry 移除 shell、apply_patch、view_image；`orchestrator.skills/mcp.enabled=false` 关闭非执行环境工具。将选定的原生模型目录条目原样固定到本次临时文件，防止后台目录刷新添加模型自带工具。

在发起模型请求前检查原生版本、config layers、effective features、managed requirements、空 instructionSources 和空 runtimeWorkspaceRoots。任何无法证明的条件都失败，不退回提示词约束、普通会话或自动批准。原生 server→client 工具/审批请求全部拒绝并终止调用。

固定配置依赖实验协议，不能把版本字符串当成供应链签名：管理员仍必须选择可信的原版可执行文件。升级 CLI 或模型目录后需要重新跑原生空工具/恶意调用测试并显式更新支持矩阵。

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

专用原生目录是 `$STATE_DIR/bots/local_reasoner/codex`。先用原生 `CODEX_HOME=... codex login` 完成该目录的登录，并确保其 `models_cache.json` 有当前 gpt-5.5 目录。可以用原生 `codex debug models` 写入临时文件后重命名为 `models_cache.json`；不要覆盖正在读取的缓存文件。不会自动复制其他 Bot 的身份。

CLI 通过 `SESSION_DATA_DIR="$STATE_DIR/data"` 查找该实例；凭证仍是同一可信宿主的 daemon IPC secret。

```bash
botmux capabilities --json
botmux session invoke capabilities --bot local_reasoner --json
botmux session invoke start --bot local_reasoner --request-file request.json --wait-ms 30000 --json
botmux session invoke result --bot local_reasoner --request-id round-1 --wait-ms 30000 --json
botmux session invoke cancel --bot local_reasoner --request-id round-1 --json
```

build capability `constrained_invocation_v1` 声明接口存在；Bot capability 的 `supported` 声明配置可被准入，`runtimeVerified:false` 提醒尚未探测实际进程。每次 start 都重新检查实际原生运行时，不能仅凭 capability 响应认定订阅可用。

`request.json` 示例：

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
- `startupMs`：版本检查、准备目录、启动进程及 thread/start 的总时间；`durationMs` 包含回收。均为实测，没有估计值。
- `usage`：原生 `thread/tokenUsage/updated.total` 快照。每个 invocation 一个新线程，更新时替换，不累加通知；`inputTokens` 包含缓存输入，`cachedInputTokens` 是其中的子集，不能再加一次。
- 未观测用量为 `usage:null`，缓存指标未知为 null，绝不补 0。`usageSource` 明确标为 `native_thread_total`。schema 校验等后期失败保留已观测的用量。

## 可复现验证

```bash
bun run test -- test/constrained-invocation.test.ts test/ipc-constrained-invocation.test.ts
BOTMUX_CONSTRAINED_CODEX=codex bun x vitest run --project e2e test/constrained-codex.e2e.ts
bun run build
# 以下明确消耗现有订阅；只用合成加法 fixture，不发送 IM：
BOTMUX_CONSTRAINED_AUTH_HOME="$NATIVE_CODEX_HOME" bun scripts/smoke-constrained-invocation.ts
```

原生 e2e 使用无凭证 loopback fixture provider：观察实际 `tools: []`、强行注入 shell 调用仍不落盘、外部工具往返、schema 失败、挂起请求取消，以及宿主被强杀后原生 worker 退出。loopback fixture 仅用于测试，不是产品代理服务。

本次 Linux 独立原生订阅 smoke 两轮均通过：启动 409/398 ms，总耗时 5213/4127 ms，输入 token 1366/1353，输出 token 79/19，原生缓存计数均为 0。重复提交每轮 ID 未产生重复推理。这里只验证机制，不代表质量评测或性能承诺；真实 daemon IPC 的鉴权与幂等由针对性测试覆盖。
