import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Sql } from "./sql.ts";
import { log } from "../log.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
// Arbitrary constant: serializes concurrent migrators (two gateway pods, CLI + gateway).
const LOCK_KEY = 7_340_211;

/** Applies `migrations/NNN_*.sql` in name order, each in its own transaction. Returns applied names. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const applied: string[] = [];
  for (const file of files) {
    const body = await readFile(`${dir}/${file}`, "utf8");
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
      const done = await tx`select 1 from schema_migrations where version = ${file}`;
      if (done.length) return;
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version) values (${file})`;
      applied.push(file);
    });
  }
  if (applied.length) log.info("migrations applied", { applied });
  return applied;
}
