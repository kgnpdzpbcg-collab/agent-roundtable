import type { AgentMode, AgentRequestId, JsonObject } from "../core/agent-types.js";
import type {
  AgentId,
  DiscussionMode,
  RouteTarget,
  RoundtableRoomState,
} from "../router/types.js";

export interface OpenRoomRequest {
  workspace: string;
  activeAgent?: AgentId;
}

export interface InviteRequest {
  agent: AgentId;
}

export interface SetActiveAgentRequest {
  agent: AgentId;
}

export interface SendRequest {
  content: string;
  mode: AgentMode;
  target?: RouteTarget;
  discussionMode?: DiscussionMode;
}

export interface RespondRequest {
  agent: AgentId;
  requestId: AgentRequestId;
  result: JsonObject;
}

export interface RoomStateResponse {
  room: RoundtableRoomState | null;
}
