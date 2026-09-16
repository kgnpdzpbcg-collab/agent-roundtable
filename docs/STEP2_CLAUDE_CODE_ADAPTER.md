# Step 2 — Claude Code + DeepSeek Adapter

> 状态：**首版实现已完成，真实本机 smoke 待验证**  
> 范围：只完成 Claude Code Harness Adapter，不实现 Web UI，不实现双 Agent Roundtable 编排。

## 1. Step 2 目标

Step 2 只解决一件事：**让 Agent Roundtable 能够通过 Claude Code Harness 调用用户现有的 DeepSeek 配置，并把 Claude Code 的会话、工具调用和流式输出统一转换为 Roundtable 的 `AgentEvent`。**

核心原则：

```text
Roundtable -> Claude Code Harness -> DeepSeek
```

而不是：

```text
Roundtable -> DeepSeek API
```

Roundtable 不直接管理 DeepSeek API Key、模型 endpoint、agent loop、MCP 或工具执行；这些仍由 Claude Code Harness 管理。

---

## 2. 接入方式

Step 2 使用官方 TypeScript 包：

```text
@anthropic-ai/claude-agent-sdk
```

当前固定版本：

```text
0.3.273
```

使用 Agent SDK 的 `query()` 启动 Claude Code Harness，并显式加载：

```ts
settingSources: ["user", "project", "local"]
```

因此会继续读取用户已有的：

- `~/.claude/settings.json`；
- 项目 `.claude/` 配置；
- local settings；
- 当前进程环境变量。

Adapter **不设置 `model`**，避免覆盖 Claude Code 中已经配置好的 DeepSeek provider / model。

如需强制指定本机 Claude Code executable，可使用：

```text
CLAUDE_CODE_BIN
```

或 `ClaudeCodeAdapterOptions.pathToClaudeCodeExecutable`。

---

## 3. 新增代码结构

```text
src/
├─ core/
│  ├─ agent-types.ts
│  └─ async-queue.ts
└─ adapters/
   ├─ codex/
   │  └─ ...
   └─ claude-code/
      ├─ index.ts
      ├─ types.ts
      └─ claude-code-adapter.ts

scripts/
├─ codex-smoke.ts
└─ claude-code-smoke.ts
```

### 文件职责

| 文件 | 职责 |
|---|---|
| `src/core/agent-types.ts` | Codex 与 Claude Code 共用的 `AgentInput / AgentEvent / AgentRequest` 类型 |
| `src/adapters/claude-code/types.ts` | Claude Code Adapter 配置类型 |
| `src/adapters/claude-code/claude-code-adapter.ts` | session、query、权限、流式事件和 SDK 消息归一化 |
| `src/adapters/claude-code/index.ts` | Claude Code Adapter 公共导出 |
| `scripts/claude-code-smoke.ts` | 使用本机真实 Claude Code / DeepSeek 配置跑最小链路 |

Step 2 同时把 Step 1 中原本位于 Codex Adapter 内的通用 Agent 类型移动到 `src/core/agent-types.ts`，避免两个 Adapter 各自定义一套事件协议。

---

## 4. Session 设计

对上层保持与 Codex 类似的接口：

```ts
initialize(): Promise<void>
createSession(workspace: string): Promise<string>
resumeSession(sessionId: string, workspace: string): Promise<void>
send(message: AgentInput): AsyncIterable<AgentEvent>
dispose(): Promise<void>
```

### createSession

`createSession()` 先分配 session id；真正的 Claude Code session 在第一次 `send()` 时通过 SDK 的 `sessionId` 创建。

### resumeSession

后续恢复已有 Claude Code session 时使用 SDK 的：

```ts
resume: sessionId
```

不重新把完整历史消息手动拼接进 prompt。

### 并发限制

Step 2 暂时规定：**同一个 Claude Code Adapter / session 同时只能运行一个 turn。**

这样可以避免同一个上下文被两个 query 并发修改。未来 Roundtable 的并行模式会通过两个独立 Agent session 实现，而不是让同一 session 并发执行多个 turn。

---

## 5. DISCUSS / EXECUTE 权限

继续沿用 Step 1 定义：

```ts
type AgentMode = "DISCUSS" | "EXECUTE";
```

### DISCUSS

映射为：

```ts
permissionMode: "plan"
```

目标：

- 可以阅读代码；
- 可以搜索 workspace；
- 可以分析问题；
- 可以提出修改方案；
- **不能实际修改 workspace。**

### EXECUTE

映射为：

```ts
permissionMode: "default"
```

同时预批准纯读取工具：

```ts
allowedTools: ["Read", "Glob", "Grep"]
```

其余需要批准的工具通过 `canUseTool` 进入 Roundtable 事件流。

这样不会把 Claude Code 的工具系统重新实现一遍，也不会默认给所有写操作无条件放行。

---

## 6. Approval / User Input

当 Claude Code Harness 需要用户批准工具调用时，Adapter 生成：

```ts
{
  type: "approval-request",
  request: {
    requestId,
    method: toolName,
    params
  }
}
```

当 Claude Code 使用 `AskUserQuestion` 时，生成：

```ts
{
  type: "input-request",
  request: {...}
}
```

上层通过：

```ts
respondToRequest(requestId, result)
```

恢复 query。

批准：

```ts
{
  behavior: "allow"
}
```

如需要修改工具输入：

```ts
{
  behavior: "allow",
  updatedInput: {...}
}
```

拒绝：

```ts
{
  behavior: "deny",
  message: "...",
  interrupt: true
}
```

Adapter 销毁、turn 异常终止或调用方提前停止消费事件流时，会终止当前 query，并清理尚未完成的 approval / input request，避免 Claude Code 进程悬挂。

---

## 7. AgentEvent 映射

Claude Agent SDK 的原始消息不会直接泄漏给未来 UI，而是转换成当前统一协议。

### 文本

SDK `stream_event -> content_block_delta -> text_delta`：

```text
AgentEvent.text-delta
```

如果没有 partial event，则从完整 assistant message / result 中补齐文本。

### 工具

Claude Code `tool_use` / `tool_progress`：

```text
AgentEvent.tool
```

### 初始化信息

SDK `system/init`：

```text
AgentEvent.item(method="system/init")
```

保留：

- session id；
- cwd；
- model；
- Claude Code version；
- permission mode；
- MCP server 信息。

其中 `model` 字段可用于 smoke test 检查当前实际使用的是否是用户预期的 DeepSeek 配置。

### Usage

SDK result 中的：

- usage；
- modelUsage；
- total cost；
- num turns；
- duration；

转换为：

```text
AgentEvent.usage
```

### 完成 / 错误

成功：

```text
AgentEvent.completed
```

SDK result error：

```text
AgentEvent.error
```

rate limit / permission denied 等非终止信息：

```text
AgentEvent.warning
```

---

## 8. DeepSeek 配置原则

Agent Roundtable 不新增第二套 DeepSeek 配置。

如果用户当前 Claude Code 已经可以正常使用 DeepSeek，那么 Roundtable 应复用同样的：

- provider；
- endpoint；
- API Key；
- model alias；
- MCP；
- CLAUDE.md；
- Skills / commands；
- Claude Code settings。

Adapter 不应该：

- 在源码中写 DeepSeek URL；
- 在源码中写 API Key；
- 直接 import DeepSeek SDK；
- 直接调用 OpenAI-compatible endpoint；
- 自己重新实现 Claude Code tools / MCP loop。

这样才能保证 UI 中的 DeepSeek 仍然是 **Claude Code Harness + DeepSeek**，而不是一个普通 DeepSeek chat completion。

---

## 9. Smoke Test

运行：

```bash
npm install
npm run smoke:claude -- /path/to/workspace
```

Smoke test 使用：

```text
DISCUSS
```

因此不得修改 workspace。

它会：

```text
创建 Claude Code session
        ↓
加载 user/project/local settings
        ↓
发送 "Reply with exactly: pong"
        ↓
读取 system/init
        ↓
输出当前 model / Claude Code version
        ↓
流式输出 assistant text
        ↓
等待 result/completed
        ↓
dispose
```

### Smoke 验收

需要在用户真实本机环境确认：

- [ ] Claude Code Harness 正常启动；
- [ ] 使用现有 DeepSeek provider 配置；
- [ ] `system/init.model` 与预期配置一致；
- [ ] workspace 正确；
- [ ] DISCUSS 不修改文件；
- [ ] 能收到流式文本；
- [ ] session id 可用于下一轮 resume；
- [ ] query 结束后不残留进程或 pending approval。

---

## 10. Step 2 明确不做

本步骤不实现：

- React / assistant-ui；
- Roundtable Web server；
- `@Codex / @DeepSeek / @Both`；
- Invite；
- Parallel；
- Review / Reverse Review / Cross Review；
- peer message；
- Writer lock；
- room 持久化；
- 自动 Debate；
- 第三个裁判模型。

这些属于两个 Adapter 都验证通过之后的下一阶段。

---

## 11. Step 2 完成标准

代码层当前已经具备：

- [x] 官方 Claude Agent SDK 接入；
- [x] 不直接调用 DeepSeek API；
- [x] 加载 Claude Code user / project / local settings；
- [x] 不覆盖用户已有 model / provider；
- [x] session 创建 / resume 接口；
- [x] `AsyncIterable<AgentEvent>` 流式输出；
- [x] DISCUSS -> plan；
- [x] EXECUTE -> default + approval；
- [x] `AskUserQuestion` -> input request；
- [x] tool / usage / warning / completed / error 映射；
- [x] abort / dispose / pending request 清理；
- [x] 真实 smoke 脚本；
- [ ] 用户本机 Claude Code + DeepSeek smoke 验证。

完成最后一项后，下一阶段进入 **统一 Roundtable Router / 双 Agent 路由**。
