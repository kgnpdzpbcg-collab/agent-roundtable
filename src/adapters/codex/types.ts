import type {
  AgentRequest,
  AgentRequestId,
  JsonObject,
  JsonValue,
} from "../../core/agent-types.js";

export type {
  AgentEvent,
  AgentInput,
  AgentMode,
  AgentRequest,
  AgentRequestId,
  JsonObject,
  JsonPrimitive,
  JsonValue,
} from "../../core/agent-types.js";

export type RpcId = AgentRequestId;
export type ServerRequestEvent = AgentRequest;

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
