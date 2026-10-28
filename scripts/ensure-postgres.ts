// `npm test` precondition: a reachable Postgres. Uses PG* env (defaults = compose.yaml);
// when nothing answers, starts the compose `postgres` service and waits for it.
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { applyTestPgDefaults } from "../test/helpers/pg-env.ts";

applyTestPgDefaults();

async function reachable(): Promise<boolean> {
  const sql = postgres({ max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

if (!(await reachable())) {
  console.log(`postgres not reachable at ${process.env.PGHOST}:${process.env.PGPORT}, starting compose service…`);
  execFileSync("docker", ["compose", "up", "-d", "--wait", "postgres"], { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname });
  for (let i = 0; i < 30 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await reachable())) {
    console.error("postgres still not reachable");
    process.exit(1);
  }
}
