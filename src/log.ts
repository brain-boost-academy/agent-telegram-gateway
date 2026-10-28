const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof LEVELS, "silent">;

let threshold: number = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level as keyof typeof LEVELS] ?? LEVELS.info;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) line[k] = v instanceof Error ? v.message : v;
  }
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};
