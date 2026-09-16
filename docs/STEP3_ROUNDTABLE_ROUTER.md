# Step 3 — Roundtable Router

> 状态：**首版实现已完成**  
> 范围：统一 Codex 与 Claude Code 两个 Adapter 的会话和路由层。  
> 本步骤不实现 Web UI，不实现 Review / Reverse Review / Cross Review。

## 1. Step 3 目标

在两个 Harness Adapter 已经独立可用之后，增加一个最小 Router，让上层不再直接操作 Codex / Claude Code 的协议细节。

Step 3 负责：

1. 维护当前 workspace；
2. 管理 active Agent；
3. 按需 Invite Agent；
4. 记录两个 Harness 各自的原生 session id；
5. 支持 `@Codex / @DeepSeek / @Both`；
6. 支持显式 `target`；
7. `@Both` 时并行、独立调用两个 Agent；
8. 把两个事件流统一包装为 `RoutedAgentEvent`；
9. 把审批 / 用户输入请求路由回正确 Agent；
10. 强制执行“同一时刻只能有一个 Writer”。

Router 不负责：

- 模型推理；
- 工具调用实现；
- MCP 实现；
- peer review prompt；
- 自动辩论；
- Web UI；
- Room 持久化。

---

## 2. 新增结构

```text
src/
├─ core/
│  ├─ agent-types.ts
│  └─ async-queue.ts
├─ adapters/
│  ├─ codex/
│  └─ claude-code/
└─ router/
   ├─ index.ts
   ├─ types.ts
   └─ roundtable-router.ts

tests/
├─ async-queue.test.ts
└─ roundtable-router.test.ts
```

---

## 3. Router 对外协议

### Agent 标识

```ts
type AgentId = "codex" | "claude-deepseek";
type RouteTarget = AgentId | "both";
```

### Router 输入

```ts
interface RoundtableSendInput extends AgentInput {
  target?: RouteTarget;
}
```

### Router 输出

```ts
interface RoutedAgentEvent {
  agent: AgentId;
  event: AgentEvent;
}
```

每个事件都明确带 `agent`，未来 UI 不需要根据颜色或文本猜测来源。

---

## 4. Room 与 Session

当前 `RoundtableRouter` 管理一个打开的 room：

```ts
router.openRoom(workspace)
```

Room 只记录：

- `workspace`
- `activeAgent`
- invited agents
- Codex thread id
- Claude Code session id

两个 Agent 必须绑定到**同一个真实 workspace**，但继续使用各自 Harness 的原生 session/context。

Router 不复制、重建或合并 Harness 内部历史。

---

## 5. Lazy Invite

`openRoom()` 不会立即启动两个 Agent。

只有发生以下情况时才真正初始化对应 Harness：

```ts
await router.invite("codex")
await router.invite("claude-deepseek")
```

或者消息第一次路由到该 Agent 时自动 Invite。

这样用户只想单独和一个 Agent 聊时，不需要无意义地启动另一个 Harness。

Invite 是幂等的，同一个 Agent 已经存在 session 时不会重复创建。

---

## 6. 路由规则

优先级：

```text
显式 target
    ↓
消息开头 @Codex / @DeepSeek / @Both
    ↓
当前 activeAgent
```

示例：

```text
hello
```

发给当前 active Agent。

```text
@Codex inspect this function
```

路由到 Codex，并把 `@Codex` 前缀从实际 prompt 中移除。

```text
@DeepSeek review this design
```

路由到 Claude Code + DeepSeek。

```text
@Both analyze this bug
```

同一条用户消息分别交给两个 Agent 独立处理。

---

## 7. Parallel

`@Both` 的实现原则：

```text
             -> Codex native session
User message |
             -> Claude Code native session
```

两边在首轮执行前互相看不到答案。

Router 同时消费两个 `AsyncIterable<AgentEvent>`，并把事件按实际到达顺序合并：

```ts
{
  agent: "codex",
  event: { ... }
}

{
  agent: "claude-deepseek",
  event: { ... }
}
```

如果其中一个流失败，Router 只给该 Agent 产生 `error` 事件，另一个 Agent 可以继续完成。

---

## 8. Writer 约束

### DISCUSS

允许：

```text
@Both + DISCUSS
```

因为两个 Adapter 都处于只读分析模式。

### EXECUTE

禁止：

```text
@Both + EXECUTE
```

Router 会直接抛错：

> 同一时刻只能有一个 Agent 写入 workspace

执行修改时必须明确选择：

```text
Codex + EXECUTE
```

或者：

```text
Claude Code + DeepSeek + EXECUTE
```

这条约束在 Router 层统一执行，不依赖 UI 自觉遵守。

---

## 9. Approval / Input Request

Router 对上层统一暴露：

```ts
router.respondToRequest(agent, requestId, result)
```

由 `agent` 决定把响应送回：

- Codex app-server request；
- Claude Agent SDK `canUseTool` request。

因此未来 UI 只需要处理一套审批交互，不需要知道两个 Harness 的底层协议区别。

---

## 10. Active Agent

单 Agent 消息发送成功后，该 Agent 成为新的 `activeAgent`。

也可以显式：

```ts
await router.setActiveAgent("codex")
await router.setActiveAgent("claude-deepseek")
```

`setActiveAgent()` 会确保该 Agent 已被 Invite。

`@Both` 不改变 active Agent。

---

## 11. 当前测试

新增 `tests/roundtable-router.test.ts`，覆盖：

1. 默认 active Agent 路由；
2. `@DeepSeek` 路由与前缀移除；
3. `@Both` 同时发送到两个独立 Agent；
4. `@Both + EXECUTE` 被拒绝；
5. Invite 幂等；
6. 两个 Agent 使用同一个 workspace。

测试使用 Fake Adapter，不依赖 Codex / DeepSeek 网络或登录状态。

---

## 12. Step 3 明确不做

当前还不实现：

- Review；
- Reverse Review；
- Cross Review；
- `<peer_message>`；
- Agent 间观点搬运；
- 自动下一轮 Debate；
- React / assistant-ui；
- Room 数据库持久化；
- trace/replay UI。

这些属于下一阶段。

---

## 13. Step 3 验收标准

- [x] 两个 Adapter 使用统一 `RoundtableAgentAdapter` 语义；
- [x] Router 管理一个共享 workspace；
- [x] Agent session 独立保存；
- [x] 支持 lazy Invite；
- [x] Invite 幂等；
- [x] 支持 active Agent；
- [x] 支持 `@Codex`；
- [x] 支持 `@DeepSeek`；
- [x] 支持 `@Both`；
- [x] `@Both` 两边独立首轮；
- [x] 合并两个异步事件流且保留 Agent 来源；
- [x] 禁止 `@Both + EXECUTE`；
- [x] 审批 / input request 可以按 Agent 路由回原 Harness；
- [x] Router 单元行为已用 Fake Adapter 验证；
- [x] 不提前实现 Review / UI。

下一步进入 **Step 4 — Review / Reverse Review / Cross Review 与 peer message 编排**。
