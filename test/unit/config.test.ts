// protects=env parsing (defaults from the spec), TG_PROXY formats used by the other bots (http URL) plus socks, ASR URL convention, command parsing;
// fails_when=WS_PORT/HTTP_HEALTH_PORT defaults change, a missing bot token is accepted, an http proxy URL is rejected,
//   ASR base with or without /v1 builds a wrong URL, /cmd@otherbot is treated as ours;
// no_claim=actual connectivity through a proxy
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AsrClient } from "../../src/asr/client.ts";
import { loadConfig } from "../../src/config.ts";
import { proxyAgent } from "../../src/telegram/bot.ts";
import { parseCommand } from "../../src/telegram/handlers.ts";
import { bearer } from "../../src/ws/tokens.ts";

test("config defaults", () => {
  const c = loadConfig({ TELEGRAM_BOT_TOKEN: "t" });
  assert.deepEqual(
    { ws: c.wsPort, health: c.healthPort, label: c.label, log: c.logLevel, proxy: c.tgProxy, asr: c.asrBaseUrl },
    { ws: 8080, health: 8081, label: "Telegram", log: "info", proxy: undefined, asr: undefined },
  );
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", WS_PORT: "x" }), /WS_PORT/);
});

test("TG_PROXY: http URL (flux proxy-config) and socks", () => {
  assert.ok(proxyAgent("http://xray-http.xray.svc.cluster.local:1081") instanceof HttpsProxyAgent);
  assert.ok(proxyAgent("socks5://127.0.0.1:1080") instanceof SocksProxyAgent);
  assert.equal(proxyAgent(undefined), undefined);
  assert.throws(() => proxyAgent("ftp://x:1"), /unsupported/);
});

test("ASR URL: OpenAI-style base with /v1, or bare host", () => {
  assert.equal(new AsrClient("http://giga:8000/v1").url, "http://giga:8000/v1/audio/transcriptions");
  assert.equal(new AsrClient("http://giga:8000/").url, "http://giga:8000/v1/audio/transcriptions");
});

test("command and bearer parsing", () => {
  assert.deepEqual(parseCommand("/start abc", "bot"), ["start", "abc"]);
  assert.deepEqual(parseCommand("/Verbose@Bot on", "bot"), ["verbose", "on"]);
  assert.equal(parseCommand("/x@other", "bot"), null);
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("Basic abc"), undefined);
});
