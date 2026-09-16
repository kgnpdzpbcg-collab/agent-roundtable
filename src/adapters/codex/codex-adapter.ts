import { spawn } from "node:child_process";
import { AsyncQueue } from "../../core/async-queue.js";
import { JsonRpcClient } from "./json-rpc-client.js";
import type {
  AgentEvent,
  AgentInput,
  CodexAdapterOptions,
  JsonObject,
  JsonValue,
  RpcNotification,
  ServerRequestEvent,
  ThreadStartResponse,
  TurnStartResponse,
} from "./types.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

const INPUT_METHODS = new Set([
  "item/tool/requestUserInput",
  "tool/requestUserInput",
]);

export class CodexAdapter {
  private readonly rpc: JsonRpcClient;
  private readonly options: Required<Omit<CodexAdapterOptions, "codexCommand">> & {
    codexCommand: string;
  };
  private initialized = false;
  private threadId?: string;
  private workspace?: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      codexCommand: options.codexCommand ?? process.env.CODEX_BIN ?? "codex",
      clientName: options.clientName ?? "agent_roundtable",
      clientTitle: options.clientTitle ?? "Agent Roundtable",
      clientVersion: options.clientVersion ?? "0.1.0",
    };
    this.rpc = new JsonRpcClient(this.options.codexCommand);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.assertCodexAvailable();
    await this.rpc.start();

    try {
      await this.rpc.request("initialize", {
        clientInfo: {
          name: this.options.clientName,
          title: this.options.clientTitle,
          version: this.options.clientVersion,
        },
        capabilities: { experimentalApi: true },
      });
      this.rpc.notify("initialized");
      this.initialized = true;
    } catch (error) {
      await this.rpc.dispose();
      throw new Error(`Codex app-server initialize 失败：${this.errorMessage(error)}`);
    }
  }

  async createSession(workspace: string): Promise<string> {
    this.ensureInitialized();

    const result = this.expectObject(
      await this.rpc.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
      "thread/start",
    ) as ThreadStartResponse;

    const threadId = this.expectString(result.thread?.id, "thread/start.thread.id");
    this.threadId = threadId;
    this.workspace = workspace;
    return threadId;
  }

  async resumeSession(sessionId: string, workspace?: string): Promise<void> {
    this.ensureInitialized();

    const params: JsonObject = {
      threadId: sessionId,
      ...(workspace ? { cwd: workspace } : {}),
    };

    const result = this.expectObject(
      await this.rpc.request("thread/resume", params),
      "thread/resume",
    ) as ThreadStartResponse;

    this.threadId = this.expectString(result.thread?.id, "thread/resume.thread.id");
    if (workspace) this.workspace = workspace;
  }

  /**
   * 将一个真实 Codex turn 暴露为 AsyncIterable。
   * 监听器会在 turn/start 之前注册，避免首批通知比 response 更快到达时被漏掉。
   */
  async *send(message: AgentInput): AsyncIterable<AgentEvent> {
    this.ensureInitialized();
    const threadId = this.expectString(this.threadId, "当前 Codex thread");
    const queue = new AsyncQueue<RpcNotification | ServerRequestEvent>();

    const offNotification = this.rpc.onNotification((event) => queue.push(event));
    const offServerRequest = this.rpc.onServerRequest((event) => queue.push(event));
    const offClose = this.rpc.onClose((error) => queue.fail(error));

    try {
      const startParams: JsonObject = {
        threadId,
        input: [{ type: "text", text: message.content }],
        approvalPolicy: message.mode === "DISCUSS" ? "never" : "on-request",
        sandboxPolicy:
          message.mode === "DISCUSS"
            ? { type: "readOnly", networkAccess: false }
            : {
                type: "workspaceWrite",
                writableRoots: this.workspace ? [this.workspace] : [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
      };

      const started = this.expectObject(
        await this.rpc.request("turn/start", startParams),
        "turn/start",
      ) as TurnStartResponse;
      const turnId = this.expectString(started.turn?.id, "turn/start.turn.id");

      for await (const rawEvent of queue) {
        if (this.isServerRequest(rawEvent)) {
          if (!this.belongsToTurn(rawEvent.params, threadId, turnId)) continue;
          yield this.mapServerRequest(rawEvent);
          continue;
        }

        if (!this.belongsToTurn(rawEvent.params, threadId, turnId)) continue;
        const mapped = this.mapNotification(rawEvent);
        if (!mapped) continue;

        yield mapped;
        if (mapped.type === "completed") {
          queue.close();
          break;
        }
      }
    } catch (error) {
      yield { type: "error", error: this.toError(error) };
    } finally {
      offNotification();
      offServerRequest();
      offClose();
      queue.close();
    }
  }

  /**
   * 给未来 UI / orchestrator 回答 app-server 主动发来的审批或输入请求。
   */
  respondToServerRequest(requestId: string | number, result: JsonObject): void {
    this.rpc.respond(requestId, result);
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.threadId = undefined;
    await this.rpc.dispose();
  }

  private mapNotification(notification: RpcNotification): AgentEvent | undefined {
    const data = notification.params ?? {};

    if (notification.method === "item/agentMessage/delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      return delta ? { type: "text-delta", delta } : undefined;
    }

    if (notification.method === "turn/completed") {
      return { type: "completed", data };
    }

    if (notification.method === "thread/tokenUsage/updated") {
      return { type: "usage", data };
    }

    if (notification.method === "warning") {
      const message = typeof data.message === "string" ? data.message : "Codex warning";
      return { type: "warning", message, data };
    }

    if (notification.method === "error") {
      const message = this.readNestedString(data, ["error", "message"]) ?? "Codex turn error";
      return { type: "error", error: new Error(message) };
    }

    if (notification.method.startsWith("item/")) {
      if (
        notification.method.includes("commandExecution") ||
        notification.method.includes("fileChange") ||
        notification.method.includes("mcpToolCall")
      ) {
        return { type: "tool", method: notification.method, data };
      }
      return { type: "item", method: notification.method, data };
    }

    return undefined;
  }

  private mapServerRequest(request: ServerRequestEvent): AgentEvent {
    if (APPROVAL_METHODS.has(request.method)) {
      return { type: "approval-request", request };
    }
    if (INPUT_METHODS.has(request.method)) {
      return { type: "input-request", request };
    }
    return { type: "tool", method: request.method, data: request.params ?? {} };
  }

  private belongsToTurn(params: JsonObject | undefined, threadId: string, turnId: string): boolean {
    if (!params) return true;

    const eventThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (eventThreadId && eventThreadId !== threadId) return false;

    const eventTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (eventTurnId && eventTurnId !== turnId) return false;

    const nestedTurnId = this.readNestedString(params, ["turn", "id"]);
    if (nestedTurnId && nestedTurnId !== turnId) return false;

    return true;
  }

  private async assertCodexAvailable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.codexCommand, ["--version"], { stdio: "ignore" });
      child.once("error", (error) => reject(new Error(`找不到可用的 codex 命令：${error.message}`)));
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`codex --version 失败，退出码：${String(code)}`));
      });
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("CodexAdapter 尚未 initialize()");
    }
  }

  private expectObject(value: JsonValue, label: string): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} 返回值不是 JSON object`);
    }
    return value;
  }

  private expectString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${label} 缺少有效字符串`);
    }
    return value;
  }

  private isServerRequest(value: RpcNotification | ServerRequestEvent): value is ServerRequestEvent {
    return "requestId" in value;
  }

  private readNestedString(value: JsonObject, path: string[]): string | undefined {
    let current: JsonValue = value;
    for (const key of path) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
      current = current[key];
    }
    return typeof current === "string" ? current : undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
