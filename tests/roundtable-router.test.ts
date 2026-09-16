import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentEvent,
  AgentInput,
  AgentRequestId,
  JsonObject,
} from "../src/core/agent-types.js";
import { RoundtableRouter } from "../src/router/roundtable-router.js";
import type {
  AgentId,
  RoundtableAgentAdapter,
  RoutedAgentEvent,
} from "../src/router/types.js";

class FakeAdapter implements RoundtableAgentAdapter {
  readonly sent: AgentInput[] = [];
  readonly createdWorkspaces: string[] = [];
  readonly responses: Array<{ requestId: AgentRequestId; result: JsonObject }> = [];

  constructor(private readonly name: string) {}

  async initialize(): Promise<void> {}

  async createSession(workspace: string): Promise<string> {
    this.createdWorkspaces.push(workspace);
    return `${this.name}-session`;
  }

  async resumeSession(_sessionId: string, _workspace: string): Promise<void> {}

  async *send(message: AgentInput): AsyncIterable<AgentEvent> {
    this.sent.push(message);
    yield { type: "text-delta", delta: `${this.name}:${message.content}` };
    yield { type: "completed", data: {} };
  }

  respondToRequest(requestId: AgentRequestId, result: JsonObject): void {
    this.responses.push({ requestId, result });
  }

  async dispose(): Promise<void> {}
}

async function collect(
  stream: AsyncIterable<RoutedAgentEvent>,
): Promise<RoutedAgentEvent[]> {
  const items: RoutedAgentEvent[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function createRouter(): {
  router: RoundtableRouter;
  codex: FakeAdapter;
  deepseek: FakeAdapter;
} {
  const codex = new FakeAdapter("codex");
  const deepseek = new FakeAdapter("deepseek");
  const adapters: Record<AgentId, RoundtableAgentAdapter> = {
    codex,
    "claude-deepseek": deepseek,
  };

  return {
    router: new RoundtableRouter({ adapters }),
    codex,
    deepseek,
  };
}

test("默认消息发送给 activeAgent，@DeepSeek 会切换目标并去掉前缀", async () => {
  const { router, codex, deepseek } = createRouter();
  router.openRoom("/workspace");

  await collect(router.send({ content: "hello", mode: "DISCUSS" }));
  await collect(router.send({ content: "@DeepSeek review this", mode: "DISCUSS" }));

  assert.equal(codex.sent[0]?.content, "hello");
  assert.equal(deepseek.sent[0]?.content, "review this");
  assert.equal(router.getState().activeAgent, "claude-deepseek");
});

test("@Both 会把同一条 DISCUSS 消息并行发送给两个独立 Agent", async () => {
  const { router, codex, deepseek } = createRouter();
  router.openRoom("/workspace");

  const events = await collect(
    router.send({ content: "@Both inspect", mode: "DISCUSS" }),
  );

  assert.equal(codex.sent[0]?.content, "inspect");
  assert.equal(deepseek.sent[0]?.content, "inspect");
  assert.deepEqual(
    new Set(events.map((event) => event.agent)),
    new Set<AgentId>(["codex", "claude-deepseek"]),
  );
});

test("@Both + EXECUTE 被拒绝，防止两个 Agent 并发修改 workspace", async () => {
  const { router } = createRouter();
  router.openRoom("/workspace");

  await assert.rejects(
    () => collect(router.send({ content: "@Both edit", mode: "EXECUTE" })),
    /同一时刻只能有一个 Agent 写入 workspace/,
  );
});

test("Invite 是幂等的，并且两个 Agent 使用同一个 workspace", async () => {
  const { router, codex, deepseek } = createRouter();
  router.openRoom("/workspace");

  const first = await router.invite("codex");
  const second = await router.invite("codex");
  await router.invite("claude-deepseek");

  assert.equal(first, second);
  assert.deepEqual(codex.createdWorkspaces, ["/workspace"]);
  assert.deepEqual(deepseek.createdWorkspaces, ["/workspace"]);
});
