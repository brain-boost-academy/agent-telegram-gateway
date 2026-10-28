import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { migrate } from "../../src/db/migrate.ts";
import { Repo } from "../../src/db/repo.ts";
import { createSql, type Sql } from "../../src/db/sql.ts";
import { setLogLevel } from "../../src/log.ts";
import { applyTestPgDefaults } from "./pg-env.ts";

setLogLevel(process.env.LOG_LEVEL ?? "silent");

export type TestDb = { name: string; sql: Sql; repo: Repo; drop: () => Promise<void> };

/** A fresh, migrated database per test file; dropped afterwards. */
export async function freshDb(): Promise<TestDb> {
  applyTestPgDefaults();
  const admin = postgres({ max: 1, onnotice: () => {} });
  const name = `gw_test_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);
  const sql = createSql({ database: name });
  await migrate(sql);
  return {
    name,
    sql,
    repo: new Repo(sql),
    drop: async () => {
      await sql.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 2 });
    },
  };
}
