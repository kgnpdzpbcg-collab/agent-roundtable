import { AsyncQueue } from "../core/async-queue.js";
import type {
  AgentEvent,
  AgentInput,
  AgentRequestId,
  JsonObject,
} from "../core/agent-types.js";
import { CodexAdapter } from "../adapters/codex/codex-adapter.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code/claude-code-adapter.js";
import { buildPeerReviewPrompt } from "./peer-message.js";
import type {
  AgentId,
  DiscussionMode,
  RouteTarget,
  RoutedAgentEvent,
  RoundtableAgentAdapter,
  RoundtableRoomState,
  RoundtableRouterOptions,
  RoundtableSendInput,
  RoundtableStage,
} from "./types.js";

const ALL_AGENTS: AgentId[] = ["codex", "claude-deepseek"];
const ROUTE_PREFIX = /^\s*@(Codex|DeepSeek|Both)(?=\s|$|[:：,，])[\s:：,，]*/i;

type CollectedResponse = {
  text: string;
  failed: boolean;
  completed: boolean;
};

type StreamSource = {
  agent: AgentId;
  stream: AsyncIterable<AgentEvent>;
  stage: RoundtableStage;
  peerAgent?: AgentId;
  onEvent?: (event: AgentEvent) => void;
};

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
 * Router 只做 session / routing / discussion orchestration。
 * 原始回答、Review 和 Cross Review 都仍由两个真实 Harness 自己完成。
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

  openRoom(workspace: string, activeAgent: AgentId = this.activeAgent): void {
    if (!workspace.trim()) throw new Error("Roundtable workspace 不能为空");
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
   * discussionMode 决定 V0.1 的讨论编排：
   * - manual：按 target / @ / activeAgent 路由；
   * - parallel：两边独立回答；
   * - review：Codex 原答 -> DeepSeek Review；
   * - reverse-review：DeepSeek 原答 -> Codex Review；
   * - cross-review：两边独立原答 -> 互相 Review。
   */
  async *send(input: RoundtableSendInput): AsyncIterable<RoutedAgentEvent> {
    this.expectWorkspace();
    const discussionMode = input.discussionMode ?? "manual";

    if (discussionMode !== "manual") {
      this.ensureDiscussionOnly(input.mode, discussionMode);
    }

    const workflowContent = this.stripRoutePrefix(input.content);
    if (!workflowContent.trim()) throw new Error("发送给 Agent 的消息内容不能为空");

    if (discussionMode === "parallel") {
      yield* this.runParallel(workflowContent);
      return;
    }
    if (discussionMode === "review") {
      yield* this.runReview(workflowContent, "codex", "claude-deepseek");
      return;
    }
    if (discussionMode === "reverse-review") {
      yield* this.runReview(workflowContent, "claude-deepseek", "codex");
      return;
    }
    if (discussionMode === "cross-review") {
      yield* this.runCrossReview(workflowContent);
      return;
    }

    const resolved = this.resolveTarget(input);
    if (!resolved.content.trim()) throw new Error("发送给 Agent 的消息内容不能为空");

    if (resolved.target === "both") {
      if (input.mode === "EXECUTE") {
        throw new Error("EXECUTE 模式不允许 @Both：同一时刻只能有一个 Agent 写入 workspace");
      }
      yield* this.runParallel(resolved.content);
      return;
    }

    await this.invite(resolved.target);
    this.activeAgent = resolved.target;
    for await (const event of this.adapters[resolved.target].send({
      content: resolved.content,
      mode: input.mode,
    })) {
      yield { agent: resolved.target, stage: "original", event };
    }
  }

  respondToRequest(
    agent: AgentId,
    requestId: AgentRequestId,
    result: JsonObject,
  ): void {
    if (!this.sessions[agent]) throw new Error(`Agent 尚未加入当前 room：${agent}`);
    this.adapters[agent].respondToRequest(requestId, result);
  }

  async dispose(): Promise<void> {
    const initialized = [...this.initializedAgents];
    this.initializedAgents.clear();
    await Promise.allSettled(
      initialized.map((agent) => this.adapters[agent].dispose()),
    );
    for (const agent of ALL_AGENTS) delete this.sessions[agent];
    this.workspace = undefined;
  }

  private async *runParallel(content: string): AsyncIterable<RoutedAgentEvent> {
    await Promise.all(ALL_AGENTS.map((agent) => this.invite(agent)));
    yield* this.mergeAgentStreams(
      ALL_AGENTS.map((agent) => ({
        agent,
        stage: "original" as const,
        stream: this.adapters[agent].send({ content, mode: "DISCUSS" }),
      })),
    );
  }

  private async *runReview(
    content: string,
    originalAgent: AgentId,
    reviewer: AgentId,
  ): AsyncIterable<RoutedAgentEvent> {
    await Promise.all([this.invite(originalAgent), this.invite(reviewer)]);

    const original = this.createCollectedResponse();
    for await (const event of this.adapters[originalAgent].send({
      content,
      mode: "DISCUSS",
    })) {
      this.collectResponseEvent(original, event);
      yield { agent: originalAgent, stage: "original", event };
    }

    if (!this.isReviewable(original)) {
      yield this.reviewSkippedEvent(reviewer, originalAgent);
      return;
    }

    const prompt = buildPeerReviewPrompt({
      userRequest: content,
      peerAgent: originalAgent,
      peerText: original.text,
    });

    for await (const event of this.adapters[reviewer].send({
      content: prompt,
      mode: "DISCUSS",
    })) {
      yield { agent: reviewer, stage: "review", peerAgent: originalAgent, event };
    }
  }

  private async *runCrossReview(content: string): AsyncIterable<RoutedAgentEvent> {
    await Promise.all(ALL_AGENTS.map((agent) => this.invite(agent)));

    const responses: Record<AgentId, CollectedResponse> = {
      codex: this.createCollectedResponse(),
      "claude-deepseek": this.createCollectedResponse(),
    };

    yield* this.mergeAgentStreams(
      ALL_AGENTS.map((agent) => ({
        agent,
        stage: "original" as const,
        stream: this.adapters[agent].send({ content, mode: "DISCUSS" }),
        onEvent: (event: AgentEvent) =>
          this.collectResponseEvent(responses[agent], event),
      })),
    );

    const reviewSources: StreamSource[] = [];
    for (const reviewer of ALL_AGENTS) {
      const peerAgent = this.otherAgent(reviewer);
      const peerResponse = responses[peerAgent];

      if (!this.isReviewable(peerResponse)) {
        yield this.reviewSkippedEvent(reviewer, peerAgent);
        continue;
      }

      reviewSources.push({
        agent: reviewer,
        stage: "review",
        peerAgent,
        stream: this.adapters[reviewer].send({
          content: buildPeerReviewPrompt({
            userRequest: content,
            peerAgent,
            peerText: peerResponse.text,
          }),
          mode: "DISCUSS",
        }),
      });
    }

    if (reviewSources.length > 0) {
      yield* this.mergeAgentStreams(reviewSources);
    }
  }

  private async *mergeAgentStreams(
    sources: StreamSource[],
  ): AsyncIterable<RoutedAgentEvent> {
    const queue = new AsyncQueue<RoutedAgentEvent>();
    let remaining = sources.length;
    if (remaining === 0) return;

    const pump = async (source: StreamSource): Promise<void> => {
      try {
        for await (const event of source.stream) {
          source.onEvent?.(event);
          queue.push({
            agent: source.agent,
            stage: source.stage,
            ...(source.peerAgent ? { peerAgent: source.peerAgent } : {}),
            event,
          });
        }
      } catch (error) {
        const event: AgentEvent = {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        source.onEvent?.(event);
        queue.push({
          agent: source.agent,
          stage: source.stage,
          ...(source.peerAgent ? { peerAgent: source.peerAgent } : {}),
          event,
        });
      } finally {
        remaining -= 1;
        if (remaining === 0) queue.close();
      }
    };

    for (const source of sources) void pump(source);
    for await (const event of queue) yield event;
  }

  private resolveTarget(input: RoundtableSendInput): {
    target: RouteTarget;
    content: string;
  } {
    if (input.target) return { target: input.target, content: input.content };

    const match = input.content.match(ROUTE_PREFIX);
    if (!match) return { target: this.activeAgent, content: input.content };

    const token = match[1].toLowerCase();
    const target: RouteTarget =
      token === "codex"
        ? "codex"
        : token === "deepseek"
          ? "claude-deepseek"
          : "both";
    return { target, content: input.content.slice(match[0].length) };
  }

  private stripRoutePrefix(content: string): string {
    const match = content.match(ROUTE_PREFIX);
    return match ? content.slice(match[0].length) : content;
  }

  private createCollectedResponse(): CollectedResponse {
    return { text: "", failed: false, completed: false };
  }

  private collectResponseEvent(state: CollectedResponse, event: AgentEvent): void {
    if (event.type === "text-delta") state.text += event.delta;
    if (event.type === "error") state.failed = true;
    if (event.type === "completed") state.completed = true;
  }

  private isReviewable(state: CollectedResponse): boolean {
    return state.completed && !state.failed && Boolean(state.text.trim());
  }

  private reviewSkippedEvent(
    reviewer: AgentId,
    peerAgent: AgentId,
  ): RoutedAgentEvent {
    return {
      agent: reviewer,
      stage: "review",
      peerAgent,
      event: {
        type: "warning",
        message: `跳过 Review：${peerAgent} 没有产生可审阅的完整文本回答`,
        data: { peerAgent },
      },
    };
  }

  private otherAgent(agent: AgentId): AgentId {
    return agent === "codex" ? "claude-deepseek" : "codex";
  }

  private ensureDiscussionOnly(
    mode: AgentInput["mode"],
    discussionMode: DiscussionMode,
  ): void {
    if (mode !== "DISCUSS") {
      throw new Error(
        `${discussionMode} 只允许 DISCUSS：Review 编排阶段不得自动修改 workspace`,
      );
    }
  }

  private async ensureInitialized(agent: AgentId): Promise<void> {
    if (this.initializedAgents.has(agent)) return;
    await this.adapters[agent].initialize();
    this.initializedAgents.add(agent);
  }

  private expectWorkspace(): string {
    if (!this.workspace) throw new Error("Roundtable room 尚未 openRoom(workspace)");
    return this.workspace;
  }
}
