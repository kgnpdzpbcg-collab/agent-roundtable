import { AsyncQueue } from "../core/async-queue.js";
import type {
  AgentEvent,
  AgentInput,
  AgentRequestId,
  JsonObject,
} from "../core/agent-types.js";
import { CodexAdapter } from "../adapters/codex/codex-adapter.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code/claude-code-adapter.js";
import type {
  AgentId,
  RouteTarget,
  RoutedAgentEvent,
  RoundtableAgentAdapter,
  RoundtableRoomState,
  RoundtableRouterOptions,
  RoundtableSendInput,
} from "./types.js";

const ALL_AGENTS: AgentId[] = ["codex", "claude-deepseek"];

/**
 * Codex 早期 Adapter 的审批响应方法叫 respondToServerRequest。
 * Router 内部统一成 respondToRequest，避免上层知道两个 Harness 的协议差异。
 */
class CodexRouterAdapter extends CodexAdapter implements RoundtableAgentAdapter {
  respondToRequest(requestId: AgentRequestId, result: JsonObject): void {
    this.respondToServerRequest(requestId, result);
  }
}

/**
 * RoundtableRouter 只负责会话和路由，不处理模型推理，也不重新实现任何工具调用。
 * 两个 Harness 始终各自维护自己的原生 session/context。
 */
export class RoundtableRouter {
  private readonly adapters: Record<AgentId, RoundtableAgentAdapter>;
  private readonly initializedAgents = new Set<AgentId>();
  private readonly sessions: Partial<Record<AgentId, string>> = {};

  private workspace?: string;
  private activeAgent: AgentId;

  constructor(options: RoundtableRouterOptions = {}) {
    this.activeAgent = options.activeAgent ?? "codex";
    this.adapters = {
      codex: options.adapters?.codex ?? new CodexRouterAdapter(),
      "claude-deepseek":
        options.adapters?.["claude-deepseek"] ?? new ClaudeCodeAdapter(),
    };
  }

  /**
   * 打开一个 Roundtable room。这里不急着启动两个 Harness；
   * 某个 Agent 第一次被 Invite 或收到消息时才真正初始化并创建原生 session。
   */
  openRoom(workspace: string, activeAgent: AgentId = this.activeAgent): void {
    if (!workspace.trim()) {
      throw new Error("Roundtable workspace 不能为空");
    }
    if (this.workspace) {
      throw new Error("RoundtableRouter 已经打开 room；请先 dispose() 再创建新 room");
    }

    this.workspace = workspace;
    this.activeAgent = activeAgent;
  }

  async invite(agent: AgentId): Promise<string> {
    const workspace = this.expectWorkspace();
    const existing = this.sessions[agent];
    if (existing) return existing;

    await this.ensureInitialized(agent);
    const sessionId = await this.adapters[agent].createSession(workspace);
    this.sessions[agent] = sessionId;
    return sessionId;
  }

  async resumeAgent(agent: AgentId, sessionId: string): Promise<void> {
    const workspace = this.expectWorkspace();
    await this.ensureInitialized(agent);
    await this.adapters[agent].resumeSession(sessionId, workspace);
    this.sessions[agent] = sessionId;
  }

  async setActiveAgent(agent: AgentId): Promise<void> {
    await this.invite(agent);
    this.activeAgent = agent;
  }

  getState(): RoundtableRoomState {
    const workspace = this.expectWorkspace();
    return {
      workspace,
      activeAgent: this.activeAgent,
      invitedAgents: ALL_AGENTS.filter((agent) => Boolean(this.sessions[agent])),
      sessions: { ...this.sessions },
    };
  }

  /**
   * 路由规则：
   * 1. 显式 target 优先；
   * 2. 否则识别消息开头的 @Codex / @DeepSeek / @Both；
   * 3. 没有 @ 时发给当前 activeAgent。
   *
   * @Both 在 DISCUSS 模式下并行独立发送，双方首轮看不到彼此答案。
   */
  async *send(input: RoundtableSendInput): AsyncIterable<RoutedAgentEvent> {
    this.expectWorkspace();
    const resolved = this.resolveTarget(input);

    if (!resolved.content.trim()) {
      throw new Error("发送给 Agent 的消息内容不能为空");
    }

    if (resolved.target === "both") {
      if (input.mode === "EXECUTE") {
        throw new Error("EXECUTE 模式不允许 @Both：同一时刻只能有一个 Agent 写入 workspace");
      }

      await Promise.all(ALL_AGENTS.map((agent) => this.invite(agent)));
      yield* this.mergeAgentStreams(
        ALL_AGENTS.map((agent) => ({
          agent,
          stream: this.adapters[agent].send({
            content: resolved.content,
            mode: input.mode,
          }),
        })),
      );
      return;
    }

    await this.invite(resolved.target);
    this.activeAgent = resolved.target;

    for await (const event of this.adapters[resolved.target].send({
      content: resolved.content,
      mode: input.mode,
    })) {
      yield { agent: resolved.target, event };
    }
  }

  respondToRequest(
    agent: AgentId,
    requestId: AgentRequestId,
    result: JsonObject,
  ): void {
    if (!this.sessions[agent]) {
      throw new Error(`Agent 尚未加入当前 room：${agent}`);
    }
    this.adapters[agent].respondToRequest(requestId, result);
  }

  async dispose(): Promise<void> {
    const initialized = [...this.initializedAgents];
    this.initializedAgents.clear();

    await Promise.allSettled(
      initialized.map((agent) => this.adapters[agent].dispose()),
    );

    for (const agent of ALL_AGENTS) {
      delete this.sessions[agent];
    }
    this.workspace = undefined;
  }

  private async ensureInitialized(agent: AgentId): Promise<void> {
    if (this.initializedAgents.has(agent)) return;
    await this.adapters[agent].initialize();
    this.initializedAgents.add(agent);
  }

  private resolveTarget(input: RoundtableSendInput): {
    target: RouteTarget;
    content: string;
  } {
    if (input.target) {
      return { target: input.target, content: input.content };
    }

    const match = input.content.match(
      /^\s*@(Codex|DeepSeek|Both)(?=\s|$|[:：,，])[\s:：,，]*/i,
    );
    if (!match) {
      return { target: this.activeAgent, content: input.content };
    }

    const token = match[1].toLowerCase();
    const target: RouteTarget =
      token === "codex"
        ? "codex"
        : token === "deepseek"
          ? "claude-deepseek"
          : "both";

    return {
      target,
      content: input.content.slice(match[0].length),
    };
  }

  private async *mergeAgentStreams(
    sources: Array<{ agent: AgentId; stream: AsyncIterable<AgentEvent> }>,
  ): AsyncIterable<RoutedAgentEvent> {
    const queue = new AsyncQueue<RoutedAgentEvent>();
    let remaining = sources.length;

    const pump = async (
      agent: AgentId,
      stream: AsyncIterable<AgentEvent>,
    ): Promise<void> => {
      try {
        for await (const event of stream) {
          queue.push({ agent, event });
        }
      } catch (error) {
        queue.push({
          agent,
          event: {
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          },
        });
      } finally {
        remaining -= 1;
        if (remaining === 0) queue.close();
      }
    };

    for (const source of sources) {
      void pump(source.agent, source.stream);
    }

    for await (const event of queue) {
      yield event;
    }
  }

  private expectWorkspace(): string {
    if (!this.workspace) {
      throw new Error("Roundtable room 尚未 openRoom(workspace)");
    }
    return this.workspace;
  }
}
