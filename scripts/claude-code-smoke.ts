import { resolve } from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const adapter = new ClaudeCodeAdapter();

try {
  await adapter.initialize();
  const sessionId = await adapter.createSession(workspace);
  console.log(`[smoke] session=${sessionId}`);

  let text = "";

  for await (const event of adapter.send({
    mode: "DISCUSS",
    content: "Reply with exactly: pong. Do not modify any files.",
  })) {
    if (event.type === "item" && event.method === "system/init") {
      console.log(
        `[smoke] model=${String(event.data.model ?? "unknown")} claudeCode=${String(
          event.data.claudeCodeVersion ?? "unknown",
        )}`,
      );
    } else if (event.type === "text-delta") {
      text += event.delta;
      process.stdout.write(event.delta);
    } else if (event.type === "approval-request" || event.type === "input-request") {
      adapter.respondToRequest(event.request.requestId, {
        behavior: "deny",
        message: "Smoke test does not provide interactive approval/input",
      });
    } else if (event.type === "warning") {
      console.warn(`\n[warning] ${event.message}`);
    } else if (event.type === "error") {
      throw event.error;
    } else if (event.type === "completed") {
      console.log("\n[smoke] turn completed");
    }
  }

  if (!text.trim()) {
    throw new Error("没有收到 Claude Code assistant 文本输出");
  }
} finally {
  await adapter.dispose();
}
