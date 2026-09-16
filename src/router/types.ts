import type {
  AgentEvent,
  AgentInput,
  AgentRequestId,
  JsonObject,
} from "../core/agent-types.js";

export type AgentId = "codex" | "claude-deepseek";
export type RouteTarget = AgentId | "both";

export interface RoundtableAgentAdapter {
  initialize(): Promise<void>;
  createSession(workspace: string): Promise<string>;
  resumeSession(sessionId: string, workspace: string): Promise<void>;
  send(message: AgentInput): AsyncIterable<AgentEvent>;
  respondToRequest(requestId: AgentRequestId, result: JsonObject): void;
  dispose(): Promise<void>;
}

export interface RoundtableSendInput extends AgentInput {
  target?: RouteTarget;
}

export interface RoutedAgentEvent {
  agent: AgentId;
  event: AgentEvent;
}

export interface RoundtableRoomState {
  workspace: string;
  activeAgent: AgentId;
  invitedAgents: AgentId[];
  sessions: Partial<Record<AgentId, string>>;
}

export interface RoundtableRouterOptions {
  adapters?: Partial<Record<AgentId, RoundtableAgentAdapter>>;
  activeAgent?: AgentId;
}
