import { useCallback, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  closeRoom,
  invite,
  openRoom,
  respondToRequest,
  setActiveAgent,
  streamSend,
  type AgentId,
  type AgentMode,
  type AgentRequest,
  type DiscussionMode,
  type RoomState,
  type RouteTarget,
  type RoutedStreamEvent,
} from "./api.js";

type TimelineRole = "user" | "agent" | "system";
type TimelineStatus = "streaming" | "complete" | "warning" | "error";

type TimelineMessage = {
  id: string;
  role: TimelineRole;
  text: string;
  agent?: AgentId;
  stage?: "original" | "review";
  peerAgent?: AgentId;
  status: TimelineStatus;
  details?: string[];
};

type PendingRequest = {
  key: string;
  agent: AgentId;
  kind: "approval-request" | "input-request";
  request: AgentRequest;
};

const AGENT_LABELS: Record<AgentId, string> = {
  codex: "Codex · GPT",
  "claude-deepseek": "Claude Code · DeepSeek",
};

export function App() {
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [mode, setMode] = useState<AgentMode>("DISCUSS");
  const [discussionMode, setDiscussionMode] =
    useState<DiscussionMode>("manual");
  const [target, setTarget] = useState<"active" | RouteTarget>("active");
  const [timeline, setTimeline] = useState<TimelineMessage[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const appendSystem = useCallback((text: string, status: TimelineStatus = "warning") => {
    setTimeline((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "system",
        text,
        status,
      },
    ]);
  }, []);

  const handleRoutedEvent = useCallback(
    (runId: string, routed: RoutedStreamEvent) => {
      const messageId = [
        runId,
        routed.stage,
        routed.agent,
        routed.peerAgent ?? "none",
      ].join(":");

      const upsert = (update: (current: TimelineMessage) => TimelineMessage) => {
        setTimeline((items) => {
          const index = items.findIndex((item) => item.id === messageId);
          if (index < 0) {
            const created = update({
              id: messageId,
              role: "agent",
              text: "",
              agent: routed.agent,
              stage: routed.stage,
              peerAgent: routed.peerAgent,
              status: "streaming",
              details: [],
            });
            return [...items, created];
          }

          const next = [...items];
          next[index] = update(next[index]);
          return next;
        });
      };

      const event = routed.event;
      if (event.type === "text-delta") {
        upsert((current) => ({ ...current, text: current.text + event.delta }));
        return;
      }

      if (event.type === "completed") {
        upsert((current) => ({ ...current, status: "complete" }));
        return;
      }

      if (event.type === "warning") {
        upsert((current) => ({
          ...current,
          status: "warning",
          details: [...(current.details ?? []), event.message],
        }));
        return;
      }

      if (event.type === "error") {
        upsert((current) => ({
          ...current,
          status: "error",
          details: [...(current.details ?? []), event.error.message],
        }));
        return;
      }

      if (event.type === "tool" || event.type === "item") {
        upsert((current) => ({
          ...current,
          details: [...(current.details ?? []), `${event.type}: ${event.method}`],
        }));
        return;
      }

      if (event.type === "approval-request" || event.type === "input-request") {
        setPendingRequests((items) => [
          ...items,
          {
            key: `${routed.agent}:${String(event.request.requestId)}`,
            agent: routed.agent,
            kind: event.type,
            request: event.request,
          },
        ]);
      }
    },
    [],
  );

  const sendText = useCallback(
    async (text: string) => {
      if (!room) {
        appendSystem("请先打开一个 workspace", "error");
        return;
      }

      const content = text.trim();
      if (!content || isRunning) return;

      const runId = crypto.randomUUID();
      setTimeline((items) => [
        ...items,
        {
          id: `${runId}:user`,
          role: "user",
          text: content,
          status: "complete",
        },
      ]);
      setIsRunning(true);

      try {
        await streamSend(
          {
            content,
            mode,
            discussionMode,
            ...(target === "active" ? {} : { target }),
          },
          (event) => handleRoutedEvent(runId, event),
        );
      } catch (error) {
        appendSystem(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      } finally {
        setIsRunning(false);
      }
    },
    [appendSystem, discussionMode, handleRoutedEvent, isRunning, mode, room, target],
  );

  const runtimeMessages = useMemo(
    () => timeline.filter((item) => item.role !== "system"),
    [timeline],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      await sendText(text);
    },
    [sendText],
  );

  const runtime = useExternalStoreRuntime({
    messages: runtimeMessages,
    isRunning,
    isSendDisabled: !room,
    onNew,
    convertMessage: (message: TimelineMessage): ThreadMessageLike => ({
      id: message.id,
      role: message.role === "user" ? "user" : "assistant",
      content: [{ type: "text", text: message.text || " " }],
    }),
  });

  async function handleOpenRoom(): Promise<void> {
    if (!workspaceInput.trim()) return;
    setBusy(true);
    try {
      const state = await openRoom(workspaceInput.trim());
      setRoom(state);
      setTimeline([]);
      setPendingRequests([]);
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseRoom(): Promise<void> {
    setBusy(true);
    try {
      await closeRoom();
      setRoom(null);
      setPendingRequests([]);
    } finally {
      setBusy(false);
    }
  }

  async function handleActiveAgent(agent: AgentId): Promise<void> {
    setBusy(true);
    try {
      setRoom(await setActiveAgent(agent));
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(agent: AgentId): Promise<void> {
    setBusy(true);
    try {
      setRoom(await invite(agent));
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  function handleDiscussionMode(value: DiscussionMode): void {
    setDiscussionMode(value);
    if (value !== "manual") setMode("DISCUSS");
  }

  async function handleRequestResponse(
    pending: PendingRequest,
    result: Record<string, unknown>,
  ): Promise<void> {
    try {
      await respondToRequest(
        pending.agent,
        pending.request.requestId,
        result,
      );
      setPendingRequests((items) =>
        items.filter((item) => item.key !== pending.key),
      );
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), "error");
    }
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="app-shell">
        <header className="topbar">
          <div>
            <h1>Agent Roundtable</h1>
            <p>Codex · GPT × Claude Code · DeepSeek</p>
          </div>
          <div className={`room-indicator ${room ? "online" : "offline"}`}>
            {room ? "ROOM OPEN" : "NO ROOM"}
          </div>
        </header>

        <section className="workspace-panel">
          <input
            value={workspaceInput}
            onChange={(event) => setWorkspaceInput(event.target.value)}
            placeholder="真实 workspace 绝对路径，例如 D:\\repo 或 /home/user/repo"
            disabled={Boolean(room) || busy}
          />
          {!room ? (
            <button onClick={() => void handleOpenRoom()} disabled={busy || !workspaceInput.trim()}>
              Open workspace
            </button>
          ) : (
            <button className="secondary" onClick={() => void handleCloseRoom()} disabled={busy || isRunning}>
              Close
            </button>
          )}
        </section>

        {room && (
          <section className="control-panel">
            <div className="control-group">
              <span className="control-label">Active</span>
              {(["codex", "claude-deepseek"] as AgentId[]).map((agent) => (
                <button
                  key={agent}
                  className={room.activeAgent === agent ? "selected" : "secondary"}
                  onClick={() => void handleActiveAgent(agent)}
                  disabled={busy || isRunning}
                >
                  {AGENT_LABELS[agent]}
                </button>
              ))}
            </div>

            <div className="control-group">
              <span className="control-label">Invited</span>
              {(["codex", "claude-deepseek"] as AgentId[]).map((agent) => (
                <button
                  key={agent}
                  className={room.invitedAgents.includes(agent) ? "invited" : "secondary"}
                  onClick={() => void handleInvite(agent)}
                  disabled={busy || isRunning || room.invitedAgents.includes(agent)}
                >
                  {room.invitedAgents.includes(agent) ? "✓ " : "+ "}
                  {AGENT_LABELS[agent]}
                </button>
              ))}
            </div>

            <div className="select-row">
              <label>
                Mode
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as AgentMode)}
                  disabled={discussionMode !== "manual" || isRunning}
                >
                  <option value="DISCUSS">DISCUSS</option>
                  <option value="EXECUTE">EXECUTE</option>
                </select>
              </label>
              <label>
                Discussion
                <select
                  value={discussionMode}
                  onChange={(event) => handleDiscussionMode(event.target.value as DiscussionMode)}
                  disabled={isRunning}
                >
                  <option value="manual">Manual</option>
                  <option value="parallel">Parallel</option>
                  <option value="review">Review</option>
                  <option value="reverse-review">Reverse Review</option>
                  <option value="cross-review">Cross Review</option>
                </select>
              </label>
              <label>
                Target
                <select
                  value={target}
                  onChange={(event) => setTarget(event.target.value as "active" | RouteTarget)}
                  disabled={discussionMode !== "manual" || isRunning}
                >
                  <option value="active">Active agent</option>
                  <option value="codex">Codex</option>
                  <option value="claude-deepseek">DeepSeek</option>
                  <option value="both">Both</option>
                </select>
              </label>
            </div>
          </section>
        )}

        <ThreadPrimitive.Root className="thread-root">
          <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
            <div className="timeline">
              {timeline.length === 0 && (
                <div className="empty-state">
                  <strong>Roundtable ready.</strong>
                  <span>打开 workspace 后，可单独讨论、并行回答或互相 Review。</span>
                </div>
              )}
              {timeline.map((message) => (
                <TimelineCard key={message.id} message={message} />
              ))}

              {pendingRequests.map((pending) => (
                <PendingRequestCard
                  key={pending.key}
                  pending={pending}
                  onRespond={handleRequestResponse}
                />
              ))}
            </div>

            <ThreadPrimitive.ViewportFooter className="composer-footer">
              <ComposerPrimitive.Root className="composer">
                <ComposerPrimitive.Input
                  className="composer-input"
                  placeholder={room ? "输入问题；也可以直接使用 @Codex / @DeepSeek / @Both" : "先打开 workspace"}
                  submitMode="enter"
                />
                <ComposerPrimitive.Send className="send-button">
                  {isRunning ? "Running…" : "Send"}
                </ComposerPrimitive.Send>
              </ComposerPrimitive.Root>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </main>
    </AssistantRuntimeProvider>
  );
}

function TimelineCard({ message }: { message: TimelineMessage }) {
  if (message.role === "system") {
    return <div className={`system-card ${message.status}`}>{message.text}</div>;
  }

  if (message.role === "user") {
    return (
      <article className="message-card user-card">
        <div className="message-header">You</div>
        <div className="message-text">{message.text}</div>
      </article>
    );
  }

  const agent = message.agent!;
  const peer = message.peerAgent;
  return (
    <article className={`message-card agent-card ${agent === "codex" ? "codex" : "deepseek"}`}>
      <div className="message-header">
        <span>{AGENT_LABELS[agent]}</span>
        <span className="stage-badge">
          {message.stage === "review"
            ? `Review · ${peer ? AGENT_LABELS[peer] : "peer"}`
            : "Original"}
        </span>
      </div>
      {message.text && <div className="message-text">{message.text}</div>}
      {message.details && message.details.length > 0 && (
        <details className="event-details">
          <summary>{message.details.length} event(s)</summary>
          {message.details.map((detail, index) => (
            <div key={`${message.id}:detail:${index}`}>{detail}</div>
          ))}
        </details>
      )}
      <div className={`status-line ${message.status}`}>{message.status}</div>
    </article>
  );
}

function PendingRequestCard({
  pending,
  onRespond,
}: {
  pending: PendingRequest;
  onRespond: (pending: PendingRequest, result: Record<string, unknown>) => Promise<void>;
}) {
  const [raw, setRaw] = useState(() =>
    JSON.stringify(defaultRequestResult(pending), null, 2),
  );
  const [error, setError] = useState<string>();

  async function submit(): Promise<void> {
    try {
      const result = JSON.parse(raw) as Record<string, unknown>;
      await onRespond(pending, result);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  return (
    <article className="request-card">
      <div className="message-header">
        <span>{AGENT_LABELS[pending.agent]}</span>
        <span className="stage-badge">{pending.kind}</span>
      </div>
      <strong>{pending.request.method}</strong>
      <pre>{JSON.stringify(pending.request.params ?? {}, null, 2)}</pre>
      <label>
        Response JSON
        <textarea value={raw} onChange={(event) => setRaw(event.target.value)} />
      </label>
      {error && <div className="request-error">{error}</div>}
      <button onClick={() => void submit()}>Send response</button>
    </article>
  );
}

function defaultRequestResult(pending: PendingRequest): Record<string, unknown> {
  if (pending.kind === "approval-request") {
    return pending.agent === "codex"
      ? { decision: "accept" }
      : { behavior: "allow" };
  }
  return {};
}
