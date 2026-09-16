# Step 5 — Web UI + HTTP/SSE API

> 状态：**首版实现已完成**  
> 范围：把 Step 1–4 已完成的 Adapter / Router 暴露为本地 Web 应用。  
> 本步骤不做数据库、云部署、多 room 持久化、复杂认证或新的 Agent 编排逻辑。

## 1. Step 5 目标

Step 5 解决的是“如何真正使用当前 Roundtable”。

完成后链路为：

```text
Browser / React UI
        ↓ HTTP + SSE
Node Roundtable Server
        ↓
RoundtableRouter
   ├─ Codex Adapter ─────── Codex Harness ─────── GPT
   └─ Claude Code Adapter ─ Claude Code Harness ─ DeepSeek
```

前端不重新实现路由或 Review 状态机，只消费 Router 已经输出的：

- `agent`
- `stage: original | review`
- `peerAgent`
- `AgentEvent`

因此 Step 4 的编排仍然只有一份真实逻辑。

---

## 2. 前端技术选择

- React
- TypeScript
- Vite
- `@assistant-ui/react`
- assistant-ui `ExternalStoreRuntime`
- 原生 CSS

这里没有直接套单助手聊天模板，因为 Roundtable 一次用户输入可能产生：

- Codex original
- DeepSeek original
- Codex review
- DeepSeek review

因此 UI 自己保存带 Agent 来源信息的 timeline，assistant-ui 负责 runtime/composer/viewport 等交互基础设施。

---

## 3. 后端技术选择

后端继续使用 Node.js，但没有引入 Express。

`src/server/roundtable-server.ts` 使用 Node 原生 `http`：

- 普通控制操作：JSON HTTP API；
- Agent 流式输出：SSE；
- 当前只维护一个本地 room。

这样可以保持代码短小，并且不引入目前不需要的 Web 框架抽象。

---

## 4. HTTP API

### `GET /api/health`

检查本地 server 是否工作。

### `GET /api/room/state`

获取当前 room；未打开时返回：

```json
{ "room": null }
```

### `POST /api/room/open`

```json
{
  "workspace": "/absolute/path/to/repo",
  "activeAgent": "codex"
}
```

打开新的本地 room。

如果已有 room，会先 dispose 原 Router，再创建新的 Router。

### `POST /api/room/close`

关闭当前 room，并释放两个 Harness。

### `POST /api/room/invite`

```json
{
  "agent": "claude-deepseek"
}
```

显式 Invite 某个 Agent。

### `POST /api/room/active`

```json
{
  "agent": "codex"
}
```

切换 active Agent；若尚未 Invite，会由 Router 自动 Invite。

### `POST /api/send`

```json
{
  "content": "检查当前代码",
  "mode": "DISCUSS",
  "discussionMode": "cross-review"
}
```

返回 `text/event-stream`。

主要 SSE event：

```text
event: routed-event
```

其中 data 保留 Router 的完整：

```ts
{
  agent,
  stage,
  peerAgent?,
  event
}
```

流结束后发送：

```text
event: done
```

若 Router / Harness 运行中发生异常：

```text
event: stream-error
```

### `POST /api/request/respond`

把 Approval / Input Request 的 response 送回正确 Harness：

```json
{
  "agent": "codex",
  "requestId": 12,
  "result": {
    "decision": "accept"
  }
}
```

Roundtable Server 不解释每个 Harness 的原生 response payload，只负责把明确的 response 送回 Router。

---

## 5. UI 功能

当前 UI 支持：

1. 输入真实 workspace 绝对路径并打开 room；
2. 切换 Codex / Claude Code + DeepSeek 为 active Agent；
3. 显式 Invite 任一 Agent；
4. 选择 `DISCUSS / EXECUTE`；
5. 选择：
   - Manual
   - Parallel
   - Review
   - Reverse Review
   - Cross Review
6. Manual 下选择：
   - Active Agent
   - Codex
   - DeepSeek
   - Both
7. 也可以继续直接输入：
   - `@Codex`
   - `@DeepSeek`
   - `@Both`
8. 流式显示每个 Agent 的文本；
9. 明确显示：
   - `Original`
   - `Review · <peer>`
10. 折叠显示 tool / item / warning 等内部事件；
11. 显示 Approval / Input Request，并允许发送原始 JSON response。

---

## 6. Timeline 数据原则

浏览器中的一条 Agent 消息至少保留：

```ts
{
  agent: "codex" | "claude-deepseek",
  stage: "original" | "review",
  peerAgent?: AgentId,
  text: string,
  status: "streaming" | "complete" | "warning" | "error"
}
```

这样 UI 不需要通过消息出现顺序猜测“谁在 Review 谁”。

Cross Review 可以稳定还原为四类消息：

```text
Codex original
DeepSeek original
Codex review DeepSeek
DeepSeek review Codex
```

---

## 7. 本地安全边界

Roundtable 能触发本机 Coding Agent，因此 Step 5 不把 API 当普通公共 Web API 处理。

当前规则：

- Server 默认只监听 `127.0.0.1`；
- 不设置 `Access-Control-Allow-Origin: *`；
- Vite 使用 `/api` proxy 访问 8787；
- 不提供公网部署配置；
- Review / Cross Review 仍然只能使用 `DISCUSS`；
- `@Both + EXECUTE` 仍由 Router 拒绝。

如果未来真的需要局域网或远程访问，必须先补认证和权限模型，而不是直接把 `HOST` 改成 `0.0.0.0` 后公开使用。

---

## 8. 文件结构

新增：

```text
src/server/
├─ index.ts
├─ types.ts
└─ roundtable-server.ts

scripts/
└─ server.ts

web/
├─ index.html
└─ src/
   ├─ api.ts
   ├─ app.tsx
   ├─ main.tsx
   └─ styles.css

vite.config.ts
tsconfig.web.json

tests/
└─ server.test.ts
```

---

## 9. 本地运行

安装依赖：

```bash
npm install
```

终端 1：

```bash
npm run dev:server
```

默认地址：

```text
http://127.0.0.1:8787
```

终端 2：

```bash
npm run dev:web
```

默认打开：

```text
http://localhost:5173
```

Vite 会把 `/api/*` 代理到本地 Roundtable Server。

---

## 10. 验证

```bash
npm run typecheck
npm test
npm run build
```

其中 `tests/server.test.ts` 不依赖真实 Codex / Claude Code 登录态，只验证：

```text
health
  ↓
open room
  ↓
get state
  ↓
close room
```

真实 Agent 仍分别通过：

```bash
npm run smoke:codex -- /path/to/workspace
npm run smoke:claude -- /path/to/workspace
```

最终还需要在用户本机完成一次 UI → Server → Router → 两个 Harness 的端到端验证。

---

## 11. Step 5 不做

本步骤暂不实现：

- room / timeline 数据库持久化；
- 多 workspace room 同时运行；
- 用户账号；
- 公网访问；
- 文件上传；
- 自动恢复上次 room；
- 无限 Debate；
- 自动选择“哪个 Agent 更正确”；
- 第三个 Judge；
- 新的 Agent 工作流 DSL。

这些都不应污染当前第一版可用 UI。
