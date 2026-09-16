export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentMode = "DISCUSS" | "EXECUTE";

export interface AgentInput {
  content: string;
  mode: AgentMode;
}

export type AgentRequestId = string | number;

export interface AgentRequest {
  requestId: AgentRequestId;
  method: string;
  params?: JsonObject;
}

export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "item"; method: string; data: JsonObject }
  | { type: "tool"; method: string; data: JsonObject }
  | { type: "approval-request"; request: AgentRequest }
  | { type: "input-request"; request: AgentRequest }
  | { type: "usage"; data: JsonObject }
  | { type: "warning"; message: string; data?: JsonObject }
  | { type: "completed"; data: JsonObject }
  | { type: "error"; error: Error };
