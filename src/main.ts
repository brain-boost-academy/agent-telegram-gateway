import { App } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createSql } from "./db/sql.ts";
import { log, setLogLevel } from "./log.ts";

const config = loadConfig();
setLogLevel(config.logLevel);
const sql = createSql();
await migrate(sql);
const app = new App({ config, sql });
await app.listenHealth();
await app.start();
await app.poll();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.stop().catch((err) => log.error("shutdown error", { err }));
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
