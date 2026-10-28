import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  BOTH_DIRECTIONS,
  CloseCode,
  CONNECTOR_TO_GATEWAY,
  decode,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  type AnyEnvelope,
  type PayloadOf,
} from "@brain-boost-academy/agent-protocol";
import type { Repo } from "../db/repo.ts";
import { log } from "../log.ts";
import { ConnectorLink } from "./link.ts";
import type { Registry } from "./registry.ts";
import { bearer, hashToken } from "./tokens.ts";

export const LIMITS = { max_inbound_file_bytes: 20 * 1024 * 1024, max_outbound_file_bytes: 50 * 1024 * 1024 };

/** What the WS layer needs from the rest of the gateway. */
export interface LinkHandler {
  pairingInfo(connectorId: string): Promise<PayloadOf<"welcome">["pairing"]>;
  onConnected(link: ConnectorLink, replaced: ConnectorLink | undefined): void;
  onMessage(link: ConnectorLink, env: AnyEnvelope): Promise<void>;
}

export type WsServerOpts = {
  port: number;
  host?: string;
  repo: Repo;
  registry: Registry;
  handler: LinkHandler;
  label: string;
  version: string;
  pingIntervalMs?: number;
  blobDoneTtlMs?: number;
  helloTimeoutMs?: number;
};

/** WebSocket 1013 "try again later": our database failed, the token may be fine (4401 would make the connector wait 5 min). */
export const TRY_AGAIN_LATER = 1013;

const ALLOWED = new Set<string>(CONNECTOR_TO_GATEWAY);
const BOTH = new Set<string>(BOTH_DIRECTIONS);

/** Client IP: the right-most X-Forwarded-For entry (added by our ingress), else the socket peer. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last ?? req.socket.remoteAddress ?? "?";
}

export class WsServer {
  readonly http: Server;
  readonly wss: WebSocketServer;
  #o: WsServerOpts;
  #timers = new Set<NodeJS.Timeout>();

  constructor(o: WsServerOpts) {
    this.#o = o;
    // Frames up to 2 MiB reach decode() so they get `error too_large` instead of a hard close.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MAX_FRAME_BYTES });
    this.http = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.http.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/v1/connect") {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => void this.#onSocket(ws, req));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(this.#o.port, this.#o.host, () => resolve((this.http.address() as AddressInfo).port));
    });
  }

  async close(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  async #onSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const ip = clientIp(req);
    // Buffer frames that arrive while the token lookup is in flight.
    const early: RawData[] = [];
    const buffer = (d: RawData) => early.push(d);
    ws.on("message", buffer);
    ws.on("error", (err) => log.debug("ws error", { ip, err }));

    let link: ConnectorLink | undefined;
    let helloTimer: NodeJS.Timeout | undefined;
    // Registered before any await: a socket that dies during the token lookup must never become a link.
    ws.on("close", (code) => {
      clearTimeout(helloTimer);
      if (!link) return;
      const wasLive = this.#o.registry.detach(link);
      link.dispose();
      log.info("connector disconnected", { connector: link.name, ip, code, live: wasLive });
    });

    const token = bearer(req.headers.authorization);
    const tokenHash = token ? hashToken(token) : undefined;
    let connector: Awaited<ReturnType<Repo["connectorByTokenHash"]>>;
    try {
      connector = tokenHash ? await this.#o.repo.connectorByTokenHash(tokenHash) : undefined;
    } catch (err) {
      log.error("connector token lookup failed", { ip, err });
      ws.close(TRY_AGAIN_LATER, "try again later");
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    if (!connector || connector.revoked_at || !tokenHash) {
      log.warn("connector auth failed", { ip, reason: connector ? "revoked" : "unknown token" });
      ws.close(CloseCode.unauthorized, "unauthorized");
      return;
    }

    let authed: ConnectorLink;
    try {
      authed = await ConnectorLink.open(ws, connector, tokenHash, ip, LIMITS.max_outbound_file_bytes, { doneTtlMs: this.#o.blobDoneTtlMs });
    } catch (err) {
      // e.g. the blob temp dir cannot be created; #onSocket runs under `void`, so nothing may escape
      log.error("connector link setup failed", { connector: connector.name, ip, err });
      ws.close(TRY_AGAIN_LATER, "try again later");
      return;
    }
    if (ws.readyState !== ws.OPEN) {
      authed.dispose();
      return;
    }
    link = authed;
    helloTimer = setTimeout(() => {
      if (!authed.hello) {
        log.warn("no hello from connector", { connector: authed.name, ip });
        authed.close(1008, "hello timeout");
      }
    }, this.#o.helloTimeoutMs ?? 10_000);
    helloTimer.unref();

    const onFrame = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        authed.peer.replyError(undefined, new ProtocolError("invalid_message", "binary frames are not supported"));
        return;
      }
      const r = decode(data as Buffer);
      if (!r.ok) {
        authed.peer.replyError(r.id ? { id: r.id } : undefined, new ProtocolError(r.code, r.message));
        return;
      }
      const env = r.env;
      if (authed.peer.handleResponse(env)) return;
      if (!authed.hello) {
        if (env.type !== "hello") {
          authed.peer.replyError(env, new ProtocolError("invalid_message", "expected hello"));
          return;
        }
        clearTimeout(helloTimer);
        if (!this.#acceptHello(authed, env.payload)) return;
        // Later frames (sync, …) are queued behind the welcome on the same chain.
        void authed.enqueue(() => this.#welcome(authed));
        return;
      }
      if (env.type === "hello" || (!ALLOWED.has(env.type) && !BOTH.has(env.type))) {
        authed.peer.replyError(env, new ProtocolError("invalid_message", `unexpected ${env.type}`));
        return;
      }
      void authed.enqueue(() => this.#o.handler.onMessage(authed, env));
    };

    ws.off("message", buffer);
    ws.on("message", (d, bin) => onFrame(d, bin));
    for (const d of early) onFrame(d, false);
  }

  #acceptHello(link: ConnectorLink, hello: PayloadOf<"hello">): boolean {
    if (hello.protocol.min > PROTOCOL_VERSION || hello.protocol.max < PROTOCOL_VERSION) {
      link.peer.replyError(undefined, new ProtocolError("unsupported_version", `gateway speaks protocol ${PROTOCOL_VERSION}`));
      setTimeout(() => link.close(CloseCode.unsupportedVersion, "unsupported version"), 50).unref();
      log.warn("connector protocol mismatch", { connector: link.name, offered: hello.protocol });
      return false;
    }
    link.hello = hello;
    return true;
  }

  /** Token still valid and not rotated? false → closed with 4401; database failure → closed with 1013. */
  async #stillAuthorized(link: ConnectorLink): Promise<boolean> {
    let ok: boolean;
    try {
      ok = await this.#o.repo.touchLastSeen(link.connectorId, link.tokenHash);
    } catch (err) {
      log.error("connector re-check failed", { connector: link.name, err });
      link.close(TRY_AGAIN_LATER, "try again later");
      return false;
    }
    if (!ok) {
      log.warn("connector token revoked or rotated, closing", { connector: link.name, ip: link.ip });
      link.close(CloseCode.unauthorized, "unauthorized");
    }
    return ok;
  }

  async #welcome(link: ConnectorLink): Promise<void> {
    const hello = link.hello!;
    // Revocation may have happened after the token lookup (and its NOTIFY may be lost); a dead socket must not replace the live one.
    if (link.closed || !(await this.#stillAuthorized(link)) || link.closed || link.ws.readyState !== link.ws.OPEN) return;
    const replaced = this.#o.registry.attach(link);
    const pairing = await this.#o.handler.pairingInfo(link.connectorId);
    link.peer.send("welcome", {
      protocol: PROTOCOL_VERSION,
      gateway: { kind: "telegram", label: this.#o.label, version: this.#o.version },
      connector_id: link.connectorId,
      limits: LIMITS,
      pairing,
    });
    log.info("connector connected", { connector: link.name, ip: link.ip, version: hello.connector_version, agents: hello.agents.map((a) => a.agent_id) });
    this.#startPing(link);
    this.#o.handler.onConnected(link, replaced);
  }

  #startPing(link: ConnectorLink): void {
    let alive = true;
    let missed = 0;
    link.ws.on("pong", () => {
      alive = true;
      missed = 0;
    });
    const timer = setInterval(() => {
      if (link.closed) {
        clearInterval(timer);
        this.#timers.delete(timer);
        return;
      }
      if (!alive && ++missed >= 2) {
        log.warn("connector missed 2 pongs, dropping", { connector: link.name });
        link.ws.terminate();
        return;
      }
      if (alive) {
        // Heartbeat doubles as the revocation re-check; a database hiccup here does not drop a healthy link.
        void this.#o.repo.touchLastSeen(link.connectorId, link.tokenHash).then(
          (ok) => {
            if (ok || link.closed) return;
            log.warn("connector token revoked or rotated, closing", { connector: link.name, ip: link.ip });
            link.close(CloseCode.unauthorized, "unauthorized");
          },
          (err) => log.warn("last_seen update failed", { connector: link.name, err }),
        );
      }
      alive = false;
      link.ws.ping();
    }, this.#o.pingIntervalMs ?? 30_000);
    timer.unref();
    this.#timers.add(timer);
  }
}
