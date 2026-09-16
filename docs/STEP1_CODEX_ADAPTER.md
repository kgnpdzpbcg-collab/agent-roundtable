# Step 1 — Codex Adapter 设计与代码要求

> 状态：**设计与代码要求已冻结**  
> 范围：只完成最小 TypeScript 工程骨架与 Codex Adapter。  
> 本步骤不实现 UI，不接 Claude Code / DeepSeek，不实现双 Agent Roundtable 编排。

## 1. Step 1 目标

Step 1 只解决一件事：**让 Agent Roundtable 后端能够可靠连接本机 Codex Harness，并以流式方式完成一次真实 Codex 会话。**

必须支持：

1. 检测本机 `codex` 是否可用；
2. 启动并管理 `codex app-server`；
3. 完成 app-server 初始化握手；
4. 创建 Codex thread；
5. 恢复已有 thread；
6. 向 thread 发送一个 turn；
7. 以事件流读取 Codex 输出；
8. 能接收工具、审批、输入请求、usage、warning、turn completion 等事件；
9. 根据 DISCUSS / EXECUTE 模式设置 workspace 权限；
10. 提供最小 smoke test 和基础单元测试，证明 Adapter 主链路可运行。

Codex 仍然是完整 Coding Agent。Roundtable 只作为 Adapter 调用它，**不重写 Codex 的 agent loop、工具系统、登录、模型管理或 workspace 操作能力。**

---

## 2. 已冻结技术选择

- **语言：TypeScript**
- **运行时：Node.js**
- **Codex 接入：`codex app-server`**
- **通信：JSON-RPC**
- **流式接口：`AsyncIterable<AgentEvent>`**
- **内部异步事件桥接：轻量 `AsyncQueue`**

原则：先做最小可工作的 Adapter，不在 Step 1 引入 Web UI、数据库、复杂状态机或额外框架。

---

## 3. Step 1 代码结构

第一阶段采用压平的最小结构，不先搭复杂 monorepo：

```text
agent-roundtable/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ index.ts
│  ├─ core/
│  │  └─ async-queue.ts
│  └─ adapters/
│     └─ codex/
│        ├─ index.ts
│        ├─ types.ts
│        ├─ json-rpc-client.ts
│        └─ codex-adapter.ts
├─ scripts/
│  └─ codex-smoke.ts
├─ tests/
│  └─ async-queue.test.ts
└─ docs/
   ├─ DESIGN_V0.1.md
   └─ STEP1_CODEX_ADAPTER.md
```

### 文件职责

| 文件 | 职责 |
|---|---|
| `src/core/async-queue.ts` | 把 JSON-RPC push events 转换成可消费的异步事件流 |
| `src/adapters/codex/types.ts` | Codex Adapter 对外类型、事件类型、运行模式等 |
| `src/adapters/codex/json-rpc-client.ts` | 负责 app-server 进程、stdin/stdout JSON-RPC、request/response/notification/request-from-server 分发 |
| `src/adapters/codex/codex-adapter.ts` | 封装 Codex session/thread/turn，并把 Codex 原生事件归一化为 `AgentEvent` |
| `src/adapters/codex/index.ts` | Codex Adapter 公共导出 |
| `src/index.ts` | 当前包的最小公共入口 |
| `scripts/codex-smoke.ts` | 连接真实本机 Codex，跑通最小真实链路 |
| `tests/async-queue.test.ts` | 验证异步事件队列的基本行为 |

如果后续进入完整 Roundtable 阶段，再拆分 `apps/web`、`apps/server`、`packages/*`。Step 1 不为未来可能需求提前堆抽象。

---

## 4. Codex app-server 协议范围

### 4.1 初始化

连接建立后完成：

```text
initialize
initialized
```

Adapter 必须等待初始化成功后再执行 thread / turn 操作。

### 4.2 Thread

Step 1 必须支持：

```text
thread/start
thread/resume
```

对上层暴露：

```ts
createSession(workspace: string): Promise<string>
resumeSession(sessionId: string): Promise<void>
```

这里的 `sessionId` 对 Codex Adapter 来说对应 Codex thread id。

### 4.3 Turn

发送用户输入使用：

```text
turn/start
```

对上层使用流式接口：

```ts
send(message: AgentInput): AsyncIterable<AgentEvent>
```

调用方可以边收到事件边更新 UI，而不是等待整个 Codex turn 完成后一次性返回。

---

## 5. AgentInput 与运行模式

Step 1 至少区分：

```ts
type AgentMode = "DISCUSS" | "EXECUTE";

interface AgentInput {
  content: string;
  mode: AgentMode;
}
```

### DISCUSS

用于讨论、分析、Review 前的独立思考。

要求：

- 可以读取 workspace；
- 可以搜索代码；
- 可以运行安全的分析/检查；
- 可以提出修改方案；
- **不得修改 workspace。**

Codex 侧应映射为 read-only sandbox / 等价只读权限。

### EXECUTE

用于用户明确授权某个 Agent 实际修改代码。

要求：

- 允许当前 Writer 修改 workspace；
- 映射为 workspace-write / 等价写权限；
- 后续双 Agent 模式中，同一时刻只能有一个 Writer。

> Step 1 虽然暂时只有 Codex，但权限模型必须从一开始保留这一边界，不能默认所有 turn 都有写权限。

---

## 6. AgentEvent 设计

Adapter 不把 Codex 原生 JSON-RPC 直接泄漏给未来 UI，而是转换成稳定的内部事件。

至少覆盖以下语义：

```ts
type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "item"; item: unknown }
  | { type: "tool"; data: unknown }
  | { type: "approval-request"; data: unknown }
  | { type: "input-request"; data: unknown }
  | { type: "usage"; data: unknown }
  | { type: "warning"; message: string }
  | { type: "completed"; data?: unknown }
  | { type: "error"; error: Error };
```

具体字段可以根据 app-server 实际协议收紧，但**语义边界不要混在一个大而全的 `unknown event` 中**。

### 必须处理的 Codex 事件类别

- assistant response 流式增量；
- item / tool 相关事件；
- turn completed；
- token / usage；
- warning；
- approval request；
- user input request；
- error / process exit。

---

## 7. JSON-RPC Client 要求

`json-rpc-client.ts` 只负责协议与进程通信，不掺杂 Roundtable 业务逻辑。

需要做到：

1. 启动 `codex app-server` 子进程；
2. 逐行读取 stdout JSON；
3. 维护递增 request id；
4. `id -> Promise resolver` 映射；
5. 区分：
   - response；
   - server notification；
   - server -> client request；
6. 将 notification / server request 转发给 Adapter；
7. stderr 不污染 stdout JSON-RPC 通道；
8. 子进程退出时拒绝尚未完成的请求并关闭事件流；
9. 提供明确 `dispose()` / stop 行为，避免残留 app-server 进程。

不要把大量“可能永远用不到”的容错分支提前塞进这一层。只处理当前协议真实存在的失败情况。

---

## 8. Approval / Input Request

Codex 可能主动向客户端发起请求，而不只是单向推送 notification。

Step 1 不能把这类消息当普通日志丢掉。

Adapter 至少要：

- 识别 approval request；
- 识别 user input request；
- 转换成对应 `AgentEvent`；
- 保留 request id / 必要 metadata，方便上层后续返回 response。

Step 1 smoke test 不要求实现完整交互 UI，但底层协议不能把这条能力堵死。

---

## 9. Session / Workspace 原则

- Codex thread 由 Codex Harness 自己管理；
- Roundtable 不直接编辑 `~/.codex/sessions/`；
- 后续 Session Reader 若需要读取历史，只能只读；
- 创建 thread 时必须显式绑定真实 workspace；
- resume 后继续使用原 Codex thread，而不是把历史消息重新拼装成一个新会话；
- Codex 登录态、订阅额度、模型和工具仍完全由 Codex 管理；
- **不要求 OpenAI API Key。**

---

## 10. AsyncQueue 要求

`AsyncQueue<T>` 只解决 producer / consumer 异步桥接问题。

需要支持：

- `push(value)`；
- consumer 通过 `for await ... of` 读取；
- `close()` 正常结束；
- `fail(error)` 让 consumer 收到异常；
- queue 中已有数据按顺序消费；
- close 后不再接受新数据。

保持实现短、小、可读，不做通用消息总线。

---

## 11. Smoke Test

`scripts/codex-smoke.ts` 必须验证真实 Codex 链路，而不是 mock：

```text
检查 codex
   ↓
启动 codex app-server
   ↓
initialize / initialized
   ↓
thread/start
   ↓
turn/start
   ↓
for await 读取 AgentEvent
   ↓
打印 assistant text / completed
   ↓
正常 dispose
```

### Smoke 成功标准

- 本机已有 Codex 登录态时可直接运行；
- 不配置 OpenAI API Key；
- 能创建真实 thread；
- 能收到真实 assistant 流式输出；
- turn 正常完成；
- 脚本退出后不遗留 app-server 子进程。

---

## 12. 基础测试要求

Step 1 不追求大规模测试覆盖，只测试当前自己实现、最容易出错的基础设施。

至少包含 `AsyncQueue`：

1. `push -> consume -> close` 顺序正确；
2. `fail(error)` 能正确传播异常。

测试应快速、确定，不依赖网络。

真实 Codex 集成由 smoke test 验证，不把本机 Codex 登录状态强绑进单元测试。

---

## 13. 代码要求

### 13.1 简洁优先

- 能用简单实现解决的问题，不引入额外 abstraction layer；
- 不写为了“以后也许会用”而存在的接口、Factory、Manager、Registry；
- 不堆大量无意义 fallback / retry / defensive branch；
- 一个模块只承担清楚的一层职责；
- 优先让主链路一眼能读懂。

### 13.2 中文注释

代码必须写**清晰、必要、能帮助阅读实现逻辑的中文注释**，重点解释：

- JSON-RPC request / response 如何配对；
- Codex notification 与 server request 如何区分；
- 为什么需要 AsyncQueue；
- DISCUSS / EXECUTE 权限为什么这样映射；
- Codex 原生事件如何转换为内部 `AgentEvent`。

不要给每一行显而易见的代码写注释，也不要用注释重复代码本身。

### 13.3 错误处理

错误信息必须带足够上下文，例如：

- 找不到 `codex`；
- app-server 启动失败；
- initialize 失败；
- JSON-RPC response error；
- thread/start / resume 失败；
- 子进程异常退出。

错误要显式暴露，不静默吞掉；但不要为了少见边界写复杂恢复系统。

### 13.4 类型边界

- app-server 原始 payload 可以在协议边界处使用 `unknown`；
- 进入 Adapter 公共接口后尽量转换成明确类型；
- 不为了消灭所有 `unknown` 写大批无价值类型声明；
- 禁止整条主链路用 `any` 糊过去。

---

## 14. Step 1 明确不做

本步骤不实现：

- React / assistant-ui；
- Web server / API 路由；
- Claude Code Harness；
- DeepSeek；
- `@Codex / @DeepSeek / @Both`；
- Invite；
- Review / Reverse Review / Parallel / Cross Review；
- 第三个主持人 / 裁判 LLM；
- 自动 Debate；
- Roundtable room 持久化；
- RAG；
- 自己实现 shell / file / search 等 Coding Agent tools；
- 直接读写 Codex session 文件；
- 两个 Agent 并发修改 workspace。

这些都不应混入 Step 1 代码。

---

## 15. Step 1 验收清单

完成 Step 1 时逐项检查：

- [ ] TypeScript 最小工程可正常 build / typecheck；
- [ ] `AsyncQueue` 基础测试通过；
- [ ] 能检测 `codex`；
- [ ] 能启动和关闭 `codex app-server`；
- [ ] `initialize / initialized` 成功；
- [ ] 能 `thread/start`；
- [ ] 能 `thread/resume`；
- [ ] 能 `turn/start`；
- [ ] `send()` 返回 `AsyncIterable<AgentEvent>`；
- [ ] 能收到 assistant 流式文本；
- [ ] 能处理 completed / usage / warning；
- [ ] approval / input request 不会被丢弃；
- [ ] DISCUSS 为只读；
- [ ] EXECUTE 为 workspace-write；
- [ ] smoke test 使用真实 Codex 跑通；
- [ ] 不需要 OpenAI API Key；
- [ ] 不实现本步骤范围外功能；
- [ ] 代码保持简洁，并有清晰中文注释。

Step 1 完成后，下一步再进入 **Claude Code Harness + DeepSeek Adapter**。两端 Adapter 都跑通之后，才开始统一 Roundtable 路由和双 Agent 讨论逻辑。
