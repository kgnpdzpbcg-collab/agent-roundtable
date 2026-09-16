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
Browser / React UI
        ↓ HTTP + SSE
Roundtable Server
        ↓
Roundtable Router
   ├─ Codex Adapter ─────── Codex app-server ─────── GPT
   └─ Claude Code Adapter ─ Claude Code Harness ─── DeepSeek
```

Codex 继续使用本机 ChatGPT / Codex 登录态与订阅额度，不要求 OpenAI API Key；DeepSeek 运行在 Claude Code Harness 内，由 Claude Code 继续管理 session、context、tools、MCP 和 agent loop。

## 当前进度

- **V0.1 总体方案：已冻结**
- **Step 1 — Codex Adapter：首版实现已同步**
- **Step 2 — Claude Code + DeepSeek Adapter：首版实现已同步**
- **Step 3 — Roundtable Router：首版实现已同步**
- **Step 4 — Review / Reverse Review / Cross Review：首版实现已同步**
- **Step 5 — Web UI + HTTP/SSE API：首版实现已同步**
- 两个 Adapter 统一使用 `AgentInput / AgentEvent / AgentRequest` 核心协议。
- Router 支持共享 workspace、lazy Invite、active Agent、`@Codex / @DeepSeek / @Both`、Parallel 合流和审批请求回路。
- Review 编排通过显式 `<peer_message author="...">` 传递对方原始回答，并要求 Reviewer 将其视为不可信引用数据、独立检查真实 workspace。
- Web UI 使用 React + Vite + assistant-ui ExternalStoreRuntime，直接显示 `agent / stage / peerAgent`，不在浏览器重新实现 Review 工作流。
- 本地 Node Server 使用 HTTP + SSE 暴露 Router；默认仅监听 `127.0.0.1`，不开放通配 CORS。
- UI 已支持 workspace、Active/Invite、DISCUSS/EXECUTE、Manual/Parallel/Review/Reverse Review/Cross Review、流式时间线以及 Approval/Input Request 原始响应。
- 真实 Codex / Claude Code + DeepSeek 端到端联调仍需在用户本机 Harness 环境执行。

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
├─ router/
│  ├─ index.ts
│  ├─ types.ts
│  ├─ peer-message.ts
│  └─ roundtable-router.ts
└─ server/
   ├─ index.ts
   ├─ types.ts
   └─ roundtable-server.ts

web/
├─ index.html
└─ src/
   ├─ api.ts
   ├─ app.tsx
   ├─ main.tsx
   └─ styles.css

scripts/
├─ server.ts
├─ codex-smoke.ts
└─ claude-code-smoke.ts

tests/
├─ async-queue.test.ts
├─ roundtable-router.test.ts
└─ server.test.ts
```

## 本地运行

安装依赖：

```bash
npm install
```

终端 1：启动本地 Roundtable Server。

```bash
npm run dev:server
```

终端 2：启动 Web UI。

```bash
npm run dev:web
```

浏览器打开：

```text
http://localhost:5173
```

然后输入真实 workspace 的绝对路径，点击 `Open workspace`。

## 检查

```bash
npm run typecheck
npm test
npm run build
```

真实 Harness smoke：

```bash
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
- [Step 5 — Web UI + HTTP/SSE API](docs/STEP5_WEB_UI.md)
