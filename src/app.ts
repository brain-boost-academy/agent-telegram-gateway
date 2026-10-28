import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Bot, Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { CloseCode } from "@brain-boost-academy/agent-protocol";
import { AsrClient } from "./asr/client.ts";
import type { Config } from "./config.ts";
import { Repo } from "./db/repo.ts";
import type { Sql } from "./db/sql.ts";
import { Gateway, type Timings } from "./gateway.ts";
import { log } from "./log.ts";
import { createBot, proxyAgent } from "./telegram/bot.ts";
import { installHandlers } from "./telegram/handlers.ts";
import { Media } from "./telegram/media.ts";
import { COMMANDS } from "./telegram/texts.ts";
import { WsServer } from "./ws/server.ts";

export const VERSION = "0.1.0";
export const ADMIN_CHANNEL = "gateway_admin";

/** Sent by the admin CLI through Postgres NOTIFY so the running gateway reacts immediately. */
export type AdminEvent =
  | { action: "revoke" | "rotate"; connector_id: string }
  | { action: "unpair"; connector_id: string; tg_chat_id?: number };

export type AppOpts = {
  config: Config;
  sql: Sql;
  /** Tests: fixed bot identity (no getMe) and a Bot API interceptor. */
  botInfo?: UserFromGetMe;
  transformer?: Transformer;
  throttle?: boolean;
  timings?: Partial<Timings>;
  pingIntervalMs?: number;
  /** Tests: how long a stored blob waits to be referenced before the receiver expires it. */
  blobDoneTtlMs?: number;
};

export class App {
  readonly config: Config;
  readonly sql: Sql;
  readonly repo: Repo;
  readonly bot: Bot;
  readonly ws: WsServer;
  readonly media: Media;
  gw!: Gateway;
  health?: Server;
  #opts: AppOpts;
  #cleanup?: NodeJS.Timeout;
  #unlisten?: () => Promise<void>;
  #readyCache = { at: 0, ok: false };

  constructor(o: AppOpts) {
    this.#opts = o;
    this.config = o.config;
    this.sql = o.sql;
    this.repo = new Repo(o.sql);
    const agent = proxyAgent(o.config.tgProxy);
    this.bot = createBot({
      token: o.config.telegramToken,
      apiRoot: o.config.telegramApiRoot,
      agent,
      botInfo: o.botInfo,
      throttle: o.throttle,
      transformer: o.transformer,
    });
    this.gw = new Gateway({
      repo: this.repo,
      api: this.bot.api,
      botUsername: o.botInfo?.username ?? "",
      token: o.config.telegramToken,
      apiRoot: o.config.telegramApiRoot ?? "https://api.telegram.org",
      agent,
      asr: o.config.asrBaseUrl ? new AsrClient(o.config.asrBaseUrl, o.config.asrApiKey) : undefined,
      displayTz: o.config.displayTz,
      timings: o.timings,
    });
    this.media = new Media(this.gw);
    installHandlers(this.bot, this.gw, this.media);
    this.ws = new WsServer({
      port: o.config.wsPort,
      repo: this.repo,
      registry: this.gw.registry,
      handler: this.gw.events,
      label: o.config.label,
      version: VERSION,
      pingIntervalMs: o.pingIntervalMs,
      blobDoneTtlMs: o.blobDoneTtlMs,
    });
  }

  /** Start everything except Telegram long polling (see `poll`). Returns the WS port. */
  async start(): Promise<number> {
    await this.bot.init();
    this.gw.botUsername = this.bot.botInfo.username;
    const port = await this.ws.listen();
    // onlisten runs on every (re)subscribe: NOTIFYs sent while LISTEN was down are lost, so cached pairings are not trusted.
    const sub = await this.sql.listen(
      ADMIN_CHANNEL,
      (payload) => void this.onAdmin(JSON.parse(payload) as AdminEvent),
      () => this.gw.invalidateAllPairings(),
    );
    this.#unlisten = () => sub.unlisten();
    this.#cleanup = setInterval(() => void this.cleanup(), 3600_000);
    this.#cleanup.unref();
    log.info("gateway started", { ws_port: port, bot: this.bot.botInfo.username, version: VERSION });
    return port;
  }

  /** Long polling (production). setMyCommands once. */
  async poll(): Promise<void> {
    await this.bot.api.setMyCommands(COMMANDS).catch((err) => log.warn("setMyCommands failed", { err }));
    void this.bot.start({ drop_pending_updates: false, onStart: () => log.info("telegram polling started") });
  }

  async onAdmin(ev: AdminEvent): Promise<void> {
    try {
      if (ev.action === "revoke" || ev.action === "rotate") {
        const link = this.gw.registry.get(ev.connector_id);
        if (link) {
          log.info("closing connector after admin action", { connector: link.name, action: ev.action });
          link.close(CloseCode.unauthorized, ev.action === "revoke" ? "revoked" : "token rotated");
        }
      } else if (ev.action === "unpair") {
        this.gw.invalidatePairing(ev.connector_id);
        await this.gw.pairing.adminUnpaired(ev.connector_id, ev.tg_chat_id);
      }
    } catch (err) {
      log.error("admin event failed", { err });
    }
  }

  async cleanup(): Promise<void> {
    try {
      log.info("cleanup", await this.repo.cleanup());
    } catch (err) {
      log.error("cleanup failed", { err });
    }
  }

  /** /readyz: database + Telegram getMe (cached for 30 s to spare the Bot API). */
  async ready(force = false): Promise<boolean> {
    if (!force && Date.now() - this.#readyCache.at < 30_000) return this.#readyCache.ok;
    let ok = false;
    try {
      await this.sql`select 1`;
      await this.bot.api.getMe();
      ok = true;
    } catch (err) {
      log.warn("readiness check failed", { err });
    }
    this.#readyCache = { at: Date.now(), ok };
    return ok;
  }

  async listenHealth(port = this.config.healthPort): Promise<number> {
    this.health = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      if (path === "/readyz") {
        void this.ready().then((ok) => res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" }).end(ok ? "ready" : "not ready"));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.health!.listen(port, resolve));
    return (this.health.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    clearInterval(this.#cleanup);
    if (this.bot.isRunning()) await this.bot.stop();
    this.media.stop();
    this.gw.stop();
    await this.#unlisten?.().catch(() => {});
    await this.ws.close();
    await new Promise<void>((resolve) => (this.health ? this.health.close(() => resolve()) : resolve()));
    await this.gw.chats.drain();
  }
}
