export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentMode = "DISCUSS" | "EXECUTE";

export interface AgentInput {
  content: string;
  mode: AgentMode;
}

export type RpcId = string | number;

export interface ServerRequestEvent {
  requestId: RpcId;
  method: string;
  params?: JsonObject;
}

export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "item"; method: string; data: JsonObject }
  | { type: "tool"; method: string; data: JsonObject }
  | { type: "approval-request"; request: ServerRequestEvent }
  | { type: "input-request"; request: ServerRequestEvent }
  | { type: "usage"; data: JsonObject }
  | { type: "warning"; message: string; data?: JsonObject }
  | { type: "completed"; data: JsonObject }
  | { type: "error"; error: Error };

export interface CodexAdapterOptions {
  codexCommand?: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
    [key: string]: JsonValue;
  };
  [key: string]: JsonValue;
}

export interface TurnStartResponse {
  turn: {
    id: string;
    [key: string]: JsonValue;
  };
  [key: string]: JsonValue;
}

export interface RpcNotification {
  method: string;
  params?: JsonObject;
}
