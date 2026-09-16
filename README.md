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
- Agent 间信息使用显式 peer message 传递，并要求 Reviewer 基于真实 workspace 自行验证。

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
- 两个 Adapter 已统一使用 `AgentInput / AgentEvent / AgentRequest` 核心协议。
- Router 已支持共享 workspace、lazy Invite、active Agent、`@Codex / @DeepSeek / @Both`、Parallel 事件合流和审批请求回路。
- `@Both + EXECUTE` 在 Router 层被禁止，确保同一时刻只有一个 Agent 可以修改 workspace。
- Step 3 Router 已通过独立 TypeScript 编译检查，并使用 Fake Adapter 验证关键路由行为。
- Codex 与 Claude Code 的真实 smoke 仍需要在对应的本机登录 / provider 环境执行。
- 下一阶段：**Step 4 — Review / Reverse Review / Cross Review 与 peer message 编排**，之后再进入 Web UI。

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
