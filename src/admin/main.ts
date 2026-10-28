import { migrate } from "../db/migrate.ts";
import { Repo } from "../db/repo.ts";
import { createSql } from "../db/sql.ts";
import { setLogLevel } from "../log.ts";
import { runAdmin, UsageError } from "./commands.ts";

setLogLevel(process.env.LOG_LEVEL ?? "warn");
const sql = createSql({ max: 1 });
let code = 0;
try {
  await migrate(sql);
  for (const line of await runAdmin(process.argv.slice(2), new Repo(sql))) console.log(line);
} catch (err) {
  console.error(err instanceof UsageError ? err.message : err);
  code = err instanceof UsageError ? 2 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(code);
