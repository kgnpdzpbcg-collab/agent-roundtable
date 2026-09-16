import { randomUUID } from "node:crypto";
import {
  query,
  type Options,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../core/async-queue.js";
import type {
  AgentEvent,
  AgentInput,
  AgentRequest,
  AgentRequestId,
  JsonObject,
  JsonValue,
} from "../../core/agent-types.js";
import type { ClaudeCodeAdapterOptions } from "./types.js";

type PendingInteraction = {
  resolve: (result: PermissionResult) => void;
};

type StreamState = {
  partialTextSeen: boolean;
  textEmitted: boolean;
};

/**
 * Claude Code Adapter 不直接调用 DeepSeek API。
 * 它通过官方 Claude Agent SDK 启动 Claude Code Harness，并让 SDK 继续读取
 * 用户已有的 ~/.claude、项目 .claude 与环境变量配置，因此自定义 provider
 * （例如 DeepSeek）仍由 Claude Code 自己负责。
 */
export class ClaudeCodeAdapter {
  private readonly options: ClaudeCodeAdapterOptions;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();

  private initialized = false;
  private workspace?: string;
  private sessionId?: string;
  private sessionExists = false;
  private activeAbortController?: AbortController;
  private activeTurn = false;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.options = options;
  }

  /**
   * Agent SDK 会在 query() 时按需启动 Claude Code runtime。
   * 这里保留 initialize()，让两个 Adapter 对上层保持一致的生命周期。
   */
  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async createSession(workspace: string): Promise<string> {
    this.ensureInitialized();
    this.workspace = workspace;
    this.sessionId = randomUUID();
    this.sessionExists = false;
    return this.sessionId;
  }

  async resumeSession(sessionId: string, workspace: string): Promise<void> {
    this.ensureInitialized();
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.sessionExists = true;
  }

  /**
   * 每次 send() 对应一次 Claude Code query。
   * 首轮使用预分配 sessionId 创建真实 session；后续轮次通过 resume 恢复同一上下文。
   */
  async *send(message: AgentInput): AsyncIterable<AgentEvent> {
    this.ensureInitialized();
    if (this.activeTurn) {
      throw new Error("ClaudeCodeAdapter 同一 session 暂不允许并发 send()；请等待当前 turn 完成");
    }

    const workspace = this.expectString(this.workspace, "Claude Code workspace");
    const sessionId = this.expectString(this.sessionId, "Claude Code session id");
    const events = new AsyncQueue<AgentEvent>();
    const abortController = new AbortController();
    let finished = false;

    this.activeTurn = true;
    this.activeAbortController = abortController;

    void this.consumeQuery(message, workspace, sessionId, abortController, events)
      .catch((error) => {
        events.push({ type: "error", error: this.toError(error) });
      })
      .finally(() => {
        finished = true;
        events.close();
        this.activeTurn = false;
        if (this.activeAbortController === abortController) {
          this.activeAbortController = undefined;
        }
      });

    try {
      for await (const event of events) {
        yield event;
      }
    } finally {
      // 调用方提前停止消费时，也应停止底层 Claude Code query，避免留下孤儿进程。
      if (!finished) {
        abortController.abort();
      }
    }
  }

  /**
   * 回答 canUseTool 暂停点。
   * result 使用 Claude Agent SDK 的 PermissionResult 结构：
   * - allow: { behavior: "allow", updatedInput?: {...} }
   * - deny:  { behavior: "deny", message: "...", interrupt?: true }
   */
  respondToRequest(requestId: AgentRequestId, result: JsonObject): void {
    const key = String(requestId);
    const pending = this.pendingInteractions.get(key);
    if (!pending) {
      throw new Error(`找不到待处理的 Claude Code 请求：${key}`);
    }

    this.pendingInteractions.delete(key);
    pending.resolve(this.parsePermissionResult(result));
  }

  async dispose(): Promise<void> {
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;

    // Adapter 被关闭时明确拒绝所有仍在等待的审批，防止 query 永久挂起。
    for (const pending of this.pendingInteractions.values()) {
      pending.resolve({
        behavior: "deny",
        message: "Agent Roundtable 已关闭当前 Claude Code 会话",
        interrupt: true,
      });
    }
    this.pendingInteractions.clear();

    this.activeTurn = false;
    this.initialized = false;
  }

  private async consumeQuery(
    message: AgentInput,
    workspace: string,
    sessionId: string,
    abortController: AbortController,
    events: AsyncQueue<AgentEvent>,
  ): Promise<void> {
    const state: StreamState = {
      partialTextSeen: false,
      textEmitted: false,
    };

    const options = this.buildQueryOptions(
      message,
      workspace,
      sessionId,
      abortController,
      events,
    );

    const operation = query({ prompt: message.content, options });

    for await (const sdkMessage of operation) {
      const shouldStop = this.mapSdkMessage(sdkMessage, events, state);
      if (shouldStop) break;
    }
  }

  private buildQueryOptions(
    message: AgentInput,
    workspace: string,
    sessionId: string,
    abortController: AbortController,
    events: AsyncQueue<AgentEvent>,
  ): Options {
    const executable = this.options.pathToClaudeCodeExecutable ?? process.env.CLAUDE_CODE_BIN;

    return {
      cwd: workspace,
      abortController,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: this.options.settingSources ?? ["user", "project", "local"],
      env: {
        ...process.env,
        ...this.options.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "agent-roundtable",
      },
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(this.sessionExists ? { resume: sessionId } : { sessionId }),

      // DISCUSS 强制只读；EXECUTE 则由 canUseTool 将未预批准操作交给 Roundtable。
      permissionMode: message.mode === "DISCUSS" ? "plan" : "default",
      allowedTools: ["Read", "Glob", "Grep"],
      canUseTool: async (toolName, input) => {
        return this.requestInteraction(toolName, input, events);
      },
    };
  }

  private requestInteraction(
    toolName: string,
    input: Record<string, unknown>,
    events: AsyncQueue<AgentEvent>,
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    const request: AgentRequest = {
      requestId,
      method: toolName,
      params: this.toJsonObject(input),
    };

    events.push({
      type: toolName === "AskUserQuestion" ? "input-request" : "approval-request",
      request,
    });

    return new Promise<PermissionResult>((resolve) => {
      this.pendingInteractions.set(requestId, { resolve });
    });
  }

  /**
   * SDK 的消息种类很多；Adapter 只提取 Roundtable 当前真正需要的稳定语义。
   * 对具体 SDK 消息使用运行时判别，避免把上层 UI 绑死到 SDK 的完整联合类型。
   */
  private mapSdkMessage(
    value: unknown,
    events: AsyncQueue<AgentEvent>,
    state: StreamState,
  ): boolean {
    if (!this.isRecord(value) || typeof value.type !== "string") {
      return false;
    }

    if (value.type === "stream_event") {
      const event = this.asRecord(value.event);
      const delta = this.asRecord(event?.delta);
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        state.partialTextSeen = true;
        state.textEmitted = true;
        events.push({ type: "text-delta", delta: delta.text });
      }
      return false;
    }

    if (value.type === "assistant") {
      const message = this.asRecord(value.message);
      const content = Array.isArray(message?.content) ? message.content : [];

      for (const blockValue of content) {
        const block = this.asRecord(blockValue);
        if (!block || typeof block.type !== "string") continue;

        if (
          block.type === "text" &&
          !state.partialTextSeen &&
          typeof block.text === "string"
        ) {
          state.textEmitted = true;
          events.push({ type: "text-delta", delta: block.text });
          continue;
        }

        if (block.type === "tool_use" && typeof block.name === "string") {
          events.push({
            type: "tool",
            method: block.name,
            data: this.toJsonObject({
              id: block.id,
              input: block.input,
              parentToolUseId: value.parent_tool_use_id,
            }),
          });
        }
      }
      return false;
    }

    if (value.type === "system" && value.subtype === "init") {
      if (typeof value.session_id === "string") {
        this.sessionId = value.session_id;
        this.sessionExists = true;
      }

      events.push({
        type: "item",
        method: "system/init",
        data: this.toJsonObject({
          sessionId: value.session_id,
          cwd: value.cwd,
          model: value.model,
          claudeCodeVersion: value.claude_code_version,
          permissionMode: value.permissionMode,
          mcpServers: value.mcp_servers,
        }),
      });
      return false;
    }

    if (value.type === "tool_progress") {
      events.push({
        type: "tool",
        method: typeof value.tool_name === "string" ? value.tool_name : "tool_progress",
        data: this.toJsonObject(value),
      });
      return false;
    }

    if (value.type === "rate_limit_event" || value.type === "permission_denied") {
      events.push({
        type: "warning",
        message:
          value.type === "rate_limit_event"
            ? "Claude Code rate limit event"
            : "Claude Code tool permission denied",
        data: this.toJsonObject(value),
      });
      return false;
    }

    if (value.type === "result") {
      if (typeof value.session_id === "string") {
        this.sessionId = value.session_id;
        this.sessionExists = true;
      }

      events.push({
        type: "usage",
        data: this.toJsonObject({
          usage: value.usage,
          modelUsage: value.modelUsage,
          totalCostUsd: value.total_cost_usd,
          numTurns: value.num_turns,
          durationMs: value.duration_ms,
        }),
      });

      if (value.subtype === "success") {
        if (!state.textEmitted && typeof value.result === "string" && value.result) {
          state.textEmitted = true;
          events.push({ type: "text-delta", delta: value.result });
        }

        events.push({
          type: "completed",
          data: this.toJsonObject({
            sessionId: value.session_id,
            subtype: value.subtype,
            stopReason: value.stop_reason,
            terminalReason: value.terminal_reason,
            permissionDenials: value.permission_denials,
          }),
        });
      } else {
        const errors = Array.isArray(value.errors)
          ? value.errors.filter((item): item is string => typeof item === "string")
          : [];
        events.push({
          type: "error",
          error: new Error(
            errors.length > 0
              ? errors.join("; ")
              : `Claude Code query 失败：${String(value.subtype ?? "unknown")}`,
          ),
        });
      }
      return true;
    }

    return false;
  }

  private parsePermissionResult(value: JsonObject): PermissionResult {
    if (value.behavior === "allow") {
      const updatedInput = this.isRecord(value.updatedInput)
        ? (value.updatedInput as Record<string, unknown>)
        : undefined;
      const toolUseID = typeof value.toolUseID === "string" ? value.toolUseID : undefined;

      return {
        behavior: "allow",
        ...(updatedInput ? { updatedInput } : {}),
        ...(toolUseID ? { toolUseID } : {}),
      };
    }

    if (value.behavior === "deny") {
      return {
        behavior: "deny",
        message:
          typeof value.message === "string" && value.message
            ? value.message
            : "User denied this Claude Code tool request",
        ...(typeof value.interrupt === "boolean" ? { interrupt: value.interrupt } : {}),
        ...(typeof value.toolUseID === "string" ? { toolUseID: value.toolUseID } : {}),
      };
    }

    throw new Error('Claude Code 请求响应必须包含 behavior: "allow" 或 "deny"');
  }

  private toJsonObject(value: unknown): JsonObject {
    try {
      const serialized = JSON.stringify(value ?? {});
      const parsed: unknown = JSON.parse(serialized);
      if (this.isRecord(parsed)) return parsed as JsonObject;
      return { value: parsed as JsonValue };
    } catch {
      return { value: String(value) };
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return this.isRecord(value) ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private expectString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${label} 缺少有效字符串`);
    }
    return value;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("ClaudeCodeAdapter 尚未 initialize()");
    }
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
