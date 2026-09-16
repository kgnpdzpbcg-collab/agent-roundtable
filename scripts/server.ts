import { createRoundtableServer } from "../src/server/index.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const server = createRoundtableServer();
server.listen(port, host, () => {
  console.log(`Agent Roundtable server: http://${host}:${port}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
