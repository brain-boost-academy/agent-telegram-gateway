export type Config = {
  telegramToken: string;
  tgProxy?: string;
  telegramApiRoot?: string;
  asrBaseUrl?: string;
  asrApiKey?: string;
  wsPort: number;
  healthPort: number;
  logLevel: string;
  label: string;
  /** IANA zone for times shown in chat (session list). */
  displayTz: string;
};

function int(name: string, def: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got ${raw}`);
  return n;
}

function opt(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/** Gateway env. PG* variables are read by the postgres client directly. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telegramToken = opt(env.TELEGRAM_BOT_TOKEN);
  if (!telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  return {
    telegramToken,
    tgProxy: opt(env.TG_PROXY),
    telegramApiRoot: opt(env.TELEGRAM_API_ROOT),
    asrBaseUrl: opt(env.ASR_BASE_URL),
    asrApiKey: opt(env.ASR_API_KEY),
    wsPort: int("WS_PORT", 8080, env),
    healthPort: int("HTTP_HEALTH_PORT", 8081, env),
    logLevel: opt(env.LOG_LEVEL) ?? "info",
    label: opt(env.GATEWAY_LABEL) ?? "Telegram",
    displayTz: opt(env.DISPLAY_TZ) ?? "Europe/Moscow",
  };
}
