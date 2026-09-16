import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonObject, JsonValue, RpcId, RpcNotification, ServerRequestEvent } from "./types.js";

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

type NotificationListener = (notification: RpcNotification) => void;
type ServerRequestListener = (request: ServerRequestEvent) => void;
type CloseListener = (error: Error) => void;

/**
 * 只负责 codex app-server 的 stdio JSON-RPC 通信。
 * Roundtable 的 session、事件语义和业务逻辑全部放在上层 Adapter。
 */
export class JsonRpcClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly stderrLines: string[] = [];
  private closed = false;

  constructor(private readonly command = process.env.CODEX_BIN ?? "codex") {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.closed = false;
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > 100) this.stderrLines.shift();
      }
    });

    child.once("error", (error) => {
      this.shutdown(new Error(`启动 codex app-server 失败：${error.message}`));
    });

    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const suffix = this.stderrTail();
      this.shutdown(
        new Error(
          `codex app-server 已退出（code=${String(code)}, signal=${String(signal)}）${suffix}`,
        ),
      );
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
  }

  request(method: string, params?: JsonObject): Promise<JsonValue> {
    const id = this.nextRequestId++;
    const message: JsonObject = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        reject(this.toError(error));
      }
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
  }

  /**
   * app-server 也会主动向 client 发 JSON-RPC request，例如审批和 request_user_input。
   * requestId 必须原样返回，才能让 Codex 继续当前 turn。
   */
  respond(requestId: RpcId, result: JsonObject): void {
    this.write({ jsonrpc: "2.0", id: requestId, result });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const child = this.process;
    this.process = undefined;
    this.rejectPending(new Error("codex app-server 已关闭"));

    if (!child || child.exitCode !== null) {
      return;
    }

    child.stdin.end();
    child.kill("SIGTERM");

    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);

    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.shutdown(new Error(`收到非法 JSON-RPC 行：${line.slice(0, 500)}`));
      return;
    }

    if (!this.isRecord(raw)) {
      this.shutdown(new Error("收到非法 JSON-RPC payload：顶层不是对象"));
      return;
    }

    const method = typeof raw.method === "string" ? raw.method : undefined;
    const id = this.readRpcId(raw.id);

    // server -> client request：同时存在 method 和 id。
    if (method && id !== undefined) {
      const params = this.asJsonObject(raw.params);
      const request: ServerRequestEvent = {
        requestId: id,
        method,
        ...(params ? { params } : {}),
      };
      for (const listener of this.serverRequestListeners) listener(request);
      return;
    }

    // server notification：有 method，但没有 id。
    if (method) {
      const params = this.asJsonObject(raw.params);
      const notification: RpcNotification = { method, ...(params ? { params } : {}) };
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }

    // 普通 response：用 id 找回原 request 的 Promise。
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);

      if (this.isRecord(raw.error)) {
        const message = typeof raw.error.message === "string" ? raw.error.message : "未知 JSON-RPC 错误";
        pending.reject(new Error(`JSON-RPC request 失败：${message}`));
        return;
      }

      pending.resolve(this.asJsonValue(raw.result));
    }
  }

  private write(message: JsonObject): void {
    const child = this.process;
    if (!child || this.closed || !child.stdin.writable) {
      throw new Error("codex app-server 尚未启动或已关闭");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    const child = this.process;
    this.process = undefined;
    this.rejectPending(error);
    for (const listener of this.closeListeners) listener(error);

    // 协议已经不可继续时主动终止子进程，避免留下失联的 app-server。
    if (child && child.exitCode === null) {
      child.stdin.destroy();
      child.kill("SIGTERM");
    }
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private stderrTail(): string {
    const tail = this.stderrLines.slice(-20).join("\n").trim();
    return tail ? `\nstderr:\n${tail}` : "";
  }

  private readRpcId(value: unknown): RpcId | undefined {
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  }

  private asJsonObject(value: unknown): JsonObject | undefined {
    return this.isRecord(value) ? (value as JsonObject) : undefined;
  }

  private asJsonValue(value: unknown): JsonValue {
    return value as JsonValue;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
