import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createRoundtableServer } from "../src/server/roundtable-server.js";

test("HTTP server 支持 health、open room、state 和 close", async () => {
  const server = createRoundtableServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const opened = await fetch(`${base}/api/room/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp/roundtable-test" }),
    });
    assert.equal(opened.status, 200);
    const openedBody = (await opened.json()) as {
      room: { workspace: string; activeAgent: string; invitedAgents: string[] };
    };
    assert.equal(openedBody.room.workspace, "/tmp/roundtable-test");
    assert.equal(openedBody.room.activeAgent, "codex");
    assert.deepEqual(openedBody.room.invitedAgents, []);

    const state = await fetch(`${base}/api/room/state`);
    const stateBody = (await state.json()) as {
      room: { workspace: string } | null;
    };
    assert.equal(stateBody.room?.workspace, "/tmp/roundtable-test");

    const closed = await fetch(`${base}/api/room/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json(), { room: null });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
