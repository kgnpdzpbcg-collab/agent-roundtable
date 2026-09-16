import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RoundtableRouter } from "../router/roundtable-router.js";
import type { RoutedAgentEvent } from "../router/types.js";
import type {
  InviteRequest,
  OpenRoomRequest,
  RespondRequest,
  RoomStateResponse,
  SendRequest,
  SetActiveAgentRequest,
} from "./types.js";

/**
 * Step 5 只维护一个本地 Roundtable room。
 * 先把真实 Router 暴露为 HTTP/SSE，避免在 UI 阶段引入数据库和复杂多房间状态管理。
 */
export function createRoundtableServer() {
  let router: RoundtableRouter | undefined;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "OPTIONS") {
        applyCors(res);
        res.writeHead(204).end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/room/state") {
        const body: RoomStateResponse = {
          room: router ? router.getState() : null,
        };
        sendJson(res, 200, body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/room/open") {
        const body = await readJson<OpenRoomRequest>(req);
        if (!body.workspace?.trim()) {
          sendJson(res, 400, { error: "workspace 不能为空" });
          return;
        }

        if (router) await router.dispose();
        router = new RoundtableRouter();
        router.openRoom(body.workspace, body.activeAgent);
        sendJson(res, 200, { room: router.getState() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/room/close") {
        if (router) await router.dispose();
        router = undefined;
        sendJson(res, 200, { room: null });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/room/invite") {
        const current = requireRouter(router);
        const body = await readJson<InviteRequest>(req);
        await current.invite(body.agent);
        sendJson(res, 200, { room: current.getState() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/room/active") {
        const current = requireRouter(router);
        const body = await readJson<SetActiveAgentRequest>(req);
        await current.setActiveAgent(body.agent);
        sendJson(res, 200, { room: current.getState() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/request/respond") {
        const current = requireRouter(router);
        const body = await readJson<RespondRequest>(req);
        current.respondToRequest(body.agent, body.requestId, body.result);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/send") {
        const current = requireRouter(router);
        const body = await readJson<SendRequest>(req);
        startSse(res);

        try {
          for await (const event of current.send(body)) {
            writeSse(res, "routed-event", serializeRoutedEvent(event));
          }
          writeSse(res, "done", { ok: true });
        } catch (error) {
          writeSse(res, "stream-error", {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          res.end();
        }
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) {
        writeSse(res, "stream-error", { message });
        res.end();
      } else {
        sendJson(res, 500, { error: message });
      }
    }
  });

  // HTTP server 被关闭时一并释放两个 Harness，避免残留本地子进程。
  server.once("close", () => {
    const current = router;
    router = undefined;
    if (current) void current.dispose();
  });

  return server;
}

function requireRouter(router: RoundtableRouter | undefined): RoundtableRouter {
  if (!router) throw new Error("Roundtable room 尚未打开");
  return router;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("请求体过大");
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  return (text ? JSON.parse(text) : {}) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  applyCors(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function startSse(res: ServerResponse): void {
  applyCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.flushHeaders();
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function serializeRoutedEvent(value: RoutedAgentEvent): unknown {
  if (value.event.type !== "error") return value;

  return {
    ...value,
    event: {
      type: "error",
      error: {
        name: value.event.error.name,
        message: value.event.error.message,
      },
    },
  };
}

function applyCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}
