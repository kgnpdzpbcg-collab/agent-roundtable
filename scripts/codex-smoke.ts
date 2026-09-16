import { resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex/index.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const adapter = new CodexAdapter();

try {
  await adapter.initialize();
  const threadId = await adapter.createSession(workspace);
  console.log(`[smoke] thread=${threadId}`);

  let text = "";
  for await (const event of adapter.send({
    mode: "DISCUSS",
    content: "Reply with exactly: pong",
  })) {
    if (event.type === "text-delta") {
      text += event.delta;
      process.stdout.write(event.delta);
    } else if (event.type === "warning") {
      console.warn(`\n[warning] ${event.message}`);
    } else if (event.type === "error") {
      throw event.error;
    } else if (event.type === "completed") {
      console.log("\n[smoke] turn completed");
    }
  }

  if (!text.trim()) {
    throw new Error("没有收到 Codex assistant 文本输出");
  }
} finally {
  await adapter.dispose();
}
