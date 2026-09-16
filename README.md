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

Codex 继续使用本机 ChatGPT / Codex 登录态与订阅额度，不要求 OpenAI API Key；DeepSeek 则运行在 Claude Code Harness 内，由 Claude Code 继续管理 session、context、tools、MCP 和 agent loop。

## 当前进度

- **V0.1 总体方案：已冻结**
- **Step 1 — Codex Adapter：设计、代码要求和首版实现已同步**
- 已实现：TypeScript 最小工程、`codex app-server` stdio JSON-RPC、initialize、thread start/resume、turn 流式事件、server request、DISCUSS/EXECUTE 权限、真实 Codex smoke 脚本和 `AsyncQueue` 基础测试。
- 当前代码已通过 TypeScript 类型检查和 `AsyncQueue` 单元测试；真实 Codex smoke 需要在已安装并登录 Codex 的本机执行。
- Claude Code + DeepSeek Adapter、Web UI、双 Agent Roundtable 编排尚未进入实现阶段。

## Step 1 代码结构

```text
src/
├─ index.ts
├─ core/
│  └─ async-queue.ts
└─ adapters/
   └─ codex/
      ├─ index.ts
      ├─ types.ts
      ├─ json-rpc-client.ts
      └─ codex-adapter.ts
scripts/
└─ codex-smoke.ts
tests/
└─ async-queue.test.ts
```

安装依赖后可运行：

```bash
npm run typecheck
npm test
npm run smoke:codex -- /path/to/workspace
```

## 文档

- [V0.1 总体设计](docs/DESIGN_V0.1.md)
- [Step 1 — Codex Adapter 设计与代码要求](docs/STEP1_CODEX_ADAPTER.md)
