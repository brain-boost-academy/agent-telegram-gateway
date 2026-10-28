import type { Agent } from "node:http";
import { Bot, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

/**
 * TG_PROXY is a proxy URL, same as the other bots (flux `proxy-config` HTTP_PROXY, e.g.
 * `http://xray-http.xray.svc.cluster.local:1081`). http(s):// → CONNECT tunnel, socks*:// → SOCKS.
 */
export function proxyAgent(url: string | undefined): Agent | undefined {
  if (!url) return undefined;
  const scheme = new URL(url).protocol.replace(":", "");
  if (scheme === "http" || scheme === "https") return new HttpsProxyAgent(url, { keepAlive: true });
  if (scheme.startsWith("socks")) return new SocksProxyAgent(url, { keepAlive: true });
  throw new Error(`TG_PROXY: unsupported scheme ${scheme}`);
}

export type BotOpts = {
  token: string;
  apiRoot?: string;
  agent?: Agent;
  /** Skip getMe at startup (tests). */
  botInfo?: UserFromGetMe;
  /** Rate limiting per Bot API guidance; off in tests. */
  throttle?: boolean;
  /** Installed last, i.e. sees every call first (tests intercept the Bot API here). */
  transformer?: Transformer;
};

export function createBot(o: BotOpts): Bot {
  const bot = new Bot(o.token, {
    botInfo: o.botInfo,
    client: {
      apiRoot: o.apiRoot,
      ...(o.agent ? { baseFetchConfig: { agent: o.agent, compress: true } } : {}),
    },
  });
  if (o.throttle ?? true) bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  if (o.transformer) bot.api.config.use(o.transformer);
  return bot;
}
