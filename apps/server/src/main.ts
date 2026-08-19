import { createPersistentPokerServer } from "./persistence/create-server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const server = await createPersistentPokerServer({
  databaseUrl: process.env.DATABASE_URL ?? "file:./dev.db",
  allowedOrigins,
  secureCookies: process.env.NODE_ENV === "production",
});
const listening = await server.listen({ port, host: process.env.HOST ?? "0.0.0.0" });

console.log(`friend-poker server listening on ${listening.url}`);

async function shutdown(): Promise<void> {
  await server.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
