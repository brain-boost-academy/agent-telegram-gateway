import postgres from "postgres";

export type Sql = postgres.Sql<{ bigint: number }>;

/** Postgres client configured from PG* env (porsager/postgres reads them itself). */
export function createSql(opts: { database?: string; max?: number } = {}): Sql {
  return postgres({
    database: opts.database,
    max: opts.max ?? 10,
    onnotice: () => {},
    // int8 → JS number: Telegram ids fit in 2^53.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
}
