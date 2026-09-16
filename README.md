# Agent Roundtable

一个本地双 Agent 讨论界面，用于把两个现成 Coding Agent Harness 放到同一个 Roundtable 中协作：

- **Codex Harness + GPT**
- **Claude Code Harness + DeepSeek**

两端共享同一个真实 workspace。Agent Roundtable 本身只负责 **UI、会话、路由、上下文搬运和双 Agent Review 编排**，不重新实现 Coding Agent，也不引入第三个裁判 LLM。

## V0.1 核心交互

- 可以长期只与 Codex 单独讨论；
- 可以长期只与 Claude Code + DeepSeek 单独讨论；
- 需要时通过 `Invite` 让另一 Agent 加入；
- 支持 `@Codex`、`@DeepSeek`、`@Both`；
- `@Both` 默认并行独立回答，首轮互相不可见；
- 支持 `Manual / Review / Reverse Review / Parallel / Cross Review`；
- UI 明确区分 `You`、`Codex · GPT`、`Claude Code · DeepSeek`；
- Agent 间信息使用显式 `peer_message` 传递，并要求 Reviewer 基于真实 workspace 自行验证。

## 接入方式

```text
Roundtable -> Codex app-server -> GPT
Roundtable -> Claude Code Harness -> DeepSeek
```

Codex 继续使用本机 ChatGPT / Codex 登录态与订阅额度，不要求 OpenAI API Key；DeepSeek 运行在 Claude Code Harness 内，由 Claude Code 继续管理 session、context、tools、MCP 和 agent loop。

## 当前进度

- **V0.1 总体方案：已冻结**
- **Step 1 — Codex Adapter：首版实现已同步**
- **Step 2 — Claude Code + DeepSeek Adapter：首版实现已同步**
- **Step 3 — Roundtable Router：首版实现已同步**
- **Step 4 — Review / Reverse Review / Cross Review：首版实现已同步**
- 两个 Adapter 统一使用 `AgentInput / AgentEvent / AgentRequest` 核心协议。
- Router 支持共享 workspace、lazy Invite、active Agent、`@Codex / @DeepSeek / @Both`、Parallel 合流和审批请求回路。
- Review 编排通过显式 `<peer_message author="...">` 传递对方原始回答，并要求 Reviewer 将其视为不可信引用数据、独立检查真实 workspace。
- `RoutedAgentEvent` 现在带 `stage: original | review` 和可选 `peerAgent`，后续 UI 可以直接还原四段 Cross Review 关系。
- 所有自动讨论模式只允许 `DISCUSS`；`@Both + EXECUTE` 和 Review 工作流中的 `EXECUTE` 都被 Router 拒绝，确保不会自动双写共享 workspace。
- Step 4 已用隔离 Fake Adapter 完成 TypeScript 编译和关键行为验证；真实 Codex / Claude Code + DeepSeek 端到端 smoke 仍需在对应本机 Harness 环境执行。
- 下一阶段：**Web UI / API 接入与消息时间线展示**，之后再补 session 恢复、trace 和长上下文策略。

## 当前代码结构

```text
src/
├─ index.ts
├─ core/
│  ├─ agent-types.ts
│  └─ async-queue.ts
├─ adapters/
│  ├─ codex/
│  │  ├─ index.ts
│  │  ├─ types.ts
│  │  ├─ json-rpc-client.ts
│  │  └─ codex-adapter.ts
│  └─ claude-code/
│     ├─ index.ts
│     ├─ types.ts
│     └─ claude-code-adapter.ts
└─ router/
   ├─ index.ts
   ├─ types.ts
   ├─ peer-message.ts
   └─ roundtable-router.ts

scripts/
├─ codex-smoke.ts
└─ claude-code-smoke.ts

tests/
├─ async-queue.test.ts
└─ roundtable-router.test.ts
```

安装依赖后可运行：

```bash
npm run typecheck
npm test
npm run smoke:codex -- /path/to/workspace
npm run smoke:claude -- /path/to/workspace
```

Claude Code smoke 会输出 `system/init` 中的实际 model，可用来确认 Roundtable 是否继承了预期的 DeepSeek 配置。

## 文档

- [V0.1 总体设计](docs/DESIGN_V0.1.md)
- [Step 1 — Codex Adapter 设计与代码要求](docs/STEP1_CODEX_ADAPTER.md)
- [Step 2 — Claude Code + DeepSeek Adapter](docs/STEP2_CLAUDE_CODE_ADAPTER.md)
- [Step 3 — Roundtable Router](docs/STEP3_ROUNDTABLE_ROUTER.md)
- [Step 4 — Review / Cross Review 编排](docs/STEP4_REVIEW_ORCHESTRATION.md)
