export type AgentId = "codex" | "claude-deepseek";
export type AgentMode = "DISCUSS" | "EXECUTE";
export type DiscussionMode =
  | "manual"
  | "parallel"
  | "review"
  | "reverse-review"
  | "cross-review";
export type RouteTarget = AgentId | "both";
export type RoundtableStage = "original" | "review";

export interface RoomState {
  workspace: string;
  activeAgent: AgentId;
  invitedAgents: AgentId[];
  sessions: Partial<Record<AgentId, string>>;
}

export interface AgentRequest {
  requestId: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export type StreamAgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "item"; method: string; data: Record<string, unknown> }
  | { type: "tool"; method: string; data: Record<string, unknown> }
  | { type: "approval-request"; request: AgentRequest }
  | { type: "input-request"; request: AgentRequest }
  | { type: "usage"; data: Record<string, unknown> }
  | { type: "warning"; message: string; data?: Record<string, unknown> }
  | { type: "completed"; data: Record<string, unknown> }
  | { type: "error"; error: { name?: string; message: string } };

export interface RoutedStreamEvent {
  agent: AgentId;
  stage: RoundtableStage;
  peerAgent?: AgentId;
  event: StreamAgentEvent;
}

export interface SendInput {
  content: string;
  mode: AgentMode;
  target?: RouteTarget;
  discussionMode?: DiscussionMode;
}

export async function openRoom(
  workspace: string,
  activeAgent: AgentId = "codex",
): Promise<RoomState> {
  const data = await postJson<{ room: RoomState }>("/api/room/open", {
    workspace,
    activeAgent,
  });
  return data.room;
}

export async function closeRoom(): Promise<void> {
  await postJson("/api/room/close", {});
}

export async function invite(agent: AgentId): Promise<RoomState> {
  const data = await postJson<{ room: RoomState }>("/api/room/invite", { agent });
  return data.room;
}

export async function setActiveAgent(agent: AgentId): Promise<RoomState> {
  const data = await postJson<{ room: RoomState }>("/api/room/active", { agent });
  return data.room;
}

export async function respondToRequest(
  agent: AgentId,
  requestId: string | number,
  result: Record<string, unknown>,
): Promise<void> {
  await postJson("/api/request/respond", { agent, requestId, result });
}

export async function streamSend(
  input: SendInput,
  onEvent: (event: RoutedStreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
  if (!response.body) {
    throw new Error("浏览器没有收到 SSE response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleSseBlock(block, onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function handleSseBlock(
  block: string,
  onEvent: (event: RoutedStreamEvent) => void,
): void {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return;
  const data = JSON.parse(dataLines.join("\n")) as unknown;

  if (eventName === "routed-event") {
    onEvent(data as RoutedStreamEvent);
    return;
  }

  if (eventName === "stream-error") {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : "Roundtable stream error";
    throw new Error(message);
  }
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as T;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}
