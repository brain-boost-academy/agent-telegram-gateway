/** Defaults matching compose.yaml, used when PG* are not set (CI sets them explicitly). */
export function applyTestPgDefaults(): void {
  process.env.PGHOST ??= "localhost";
  process.env.PGPORT ??= process.env.PG_HOST_PORT ?? "5432";
  process.env.PGUSER ??= "gateway";
  process.env.PGPASSWORD ??= "gateway";
  process.env.PGDATABASE ??= "gateway";
}
