import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { WebSocket } from "ws";
import {
  BlobReceiver,
  decode,
  Peer,
  ProtocolError,
  ResponseOf,
  type AnyEnvelope,
  type MessageType,
  type PayloadOf,
  type RequestType,
  type ResponseTypeOf,
} from "@brain-boost-academy/agent-protocol";
import { App } from "../../src/app.ts";
import type { Timings } from "../../src/gateway.ts";
import type { TestDb } from "./db.ts";

export const TOKEN = "123456:TEST-TOKEN";
export const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "Gateway",
  username: "test_gw_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---------------- fake Bot API ----------------

export type TgCall = { method: string; payload: Record<string, unknown>; messageId?: number; failed?: boolean };

/** Records every Bot API call and fakes responses; nothing reaches the network. */
export class FakeTelegram {
  calls: TgCall[] = [];
  files = new Map<string, Buffer>();
  #nextId = 1000;
  #fail: Array<{ method: string; times: number; code: number; description: string; skip: number }> = [];

  transformer: Transformer = async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const call: TgCall = { method, payload: p };
    this.calls.push(call);
    const f = this.#fail.find((x) => x.method === method && x.times > 0);
    if (f && f.skip > 0) f.skip--;
    else if (f) {
      f.times--;
      call.failed = true;
      return { ok: false, error_code: f.code, description: f.description } as never;
    }
    const ok = (result: unknown) => ({ ok: true, result }) as never;
    switch (method) {
      case "sendMessage":
      case "sendDocument":
        call.messageId = this.#nextId++;
        return ok({ message_id: call.messageId, date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id, type: "private" }, text: p.text });
      case "getFile":
        return ok({ file_id: p.file_id, file_unique_id: `u${p.file_id}`, file_path: `files/${p.file_id}` });
      case "getMe":
        return ok(BOT_INFO);
      default:
        return ok(true);
    }
  };

  /** Fail the next `times` calls of `method`, after letting `skip` calls through. */
  failNext(method: string, times = 1, code = 400, description = "Bad Request: chat not found", skip = 0): void {
    this.#fail.push({ method, times, code, description, skip });
  }

  of(method: string, chatId?: number): TgCall[] {
    return this.calls.filter((c) => c.method === method && (chatId === undefined || c.payload.chat_id === chatId));
  }

  texts(chatId?: number): string[] {
    return this.of("sendMessage", chatId).map((c) => String(c.payload.text));
  }

  /** All sendMessage/editMessageText texts, in order. */
  allTexts(chatId?: number): string[] {
    return this.calls
      .filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && (chatId === undefined || c.payload.chat_id === chatId))
      .map((c) => String(c.payload.text));
  }

  /** callback_data of the buttons of the last message whose text matches. */
  buttons(match: RegExp): Array<{ text: string; data: string }> {
    const call = [...this.calls].reverse().find((c) => (c.method === "sendMessage" || c.method === "editMessageText") && match.test(String(c.payload.text)) && c.payload.reply_markup);
    if (!call) throw new Error(`no message with buttons matching ${match}`);
    const kb = (call.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    return kb.flat().map((b) => ({ text: b.text, data: b.callback_data }));
  }

  /** message_id of the last successful sendMessage whose text matches. */
  messageId(match: RegExp): number {
    const c = [...this.calls].reverse().find((x) => x.method === "sendMessage" && x.messageId !== undefined && match.test(String(x.payload.text)));
    if (!c) throw new Error(`no sent message matching ${match}`);
    return c.messageId!;
  }
}

// ---------------- file + ASR servers ----------------

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Serves `/file/bot<token>/files/<file_id>` like api.telegram.org. */
export async function fileServer(tg: FakeTelegram): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const m = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(req.url ?? "");
    const data = m && m[1] === TOKEN ? tg.files.get(decodeURIComponent(m[2]!)) : undefined;
    if (!data) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": data.length }).end(data);
  });
  return { url: await listen(server), server };
}

export type FakeAsr = { url: string; server: Server; requests: Array<{ auth?: string; bytes: number; filename?: string }>; reply: { status: number; text: string } };

export async function fakeAsr(): Promise<FakeAsr> {
  const asr: FakeAsr = { url: "", server: undefined as never, requests: [], reply: { status: 200, text: "привет агент" } };
  asr.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const filename = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1];
      asr.requests.push({ auth: req.headers.authorization, bytes: body.length, filename });
      if (req.url !== "/v1/audio/transcriptions") return void res.writeHead(404).end();
      if (asr.reply.status !== 200) return void res.writeHead(asr.reply.status).end(JSON.stringify({ error: { message: "busy" } }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: asr.reply.text }));
    });
  });
  asr.url = `${await listen(asr.server)}/v1`;
  return asr;
}

// ---------------- gateway under test ----------------

export type Harness = {
  app: App;
  tg: FakeTelegram;
  asr: FakeAsr;
  wsUrl: string;
  feed: (u: Update) => Promise<void>;
  stop: () => Promise<void>;
};

export async function startGateway(
  db: TestDb,
  o: { timings?: Partial<Timings>; tg?: FakeTelegram; asr?: FakeAsr; pingIntervalMs?: number; blobDoneTtlMs?: number } = {},
): Promise<Harness> {
  const tg = o.tg ?? new FakeTelegram();
  const files = await fileServer(tg);
  const asr = o.asr ?? (await fakeAsr());
  const app = new App({
    config: {
      telegramToken: TOKEN,
      telegramApiRoot: files.url,
      asrBaseUrl: asr.url,
      asrApiKey: "asr-key",
      wsPort: 0,
      healthPort: 0,
      logLevel: "silent",
      label: "Telegram",
      displayTz: "UTC",
    },
    sql: db.sql,
    botInfo: BOT_INFO,
    transformer: tg.transformer,
    throttle: false,
    // pairingTtlMs 0: fixtures write pairings straight into Postgres (makeConnector), bypassing the gateway's invalidation.
    timings: { flushMs: 20, albumMs: 50, pairingTtlMs: 0, ...o.timings },
    pingIntervalMs: o.pingIntervalMs,
    blobDoneTtlMs: o.blobDoneTtlMs,
  });
  const port = await app.start();
  return {
    app,
    tg,
    asr,
    wsUrl: `ws://127.0.0.1:${port}/v1/connect`,
    feed: async (u) => {
      await app.bot.handleUpdate(u);
      await app.gw.chats.drain();
    },
    stop: async () => {
      await app.stop();
      await new Promise<void>((r) => files.server.close(() => r()));
      if (!o.asr) await new Promise<void>((r) => asr.server.close(() => r()));
    },
  };
}

// ---------------- Telegram updates ----------------

let updateId = 1;
let messageId = 1;

export type TgUser = { id: number; username?: string; first_name?: string };

function msgBase(u: TgUser) {
  return {
    message_id: messageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: u.id, type: "private" as const, first_name: u.first_name ?? "U" },
    from: { id: u.id, is_bot: false, first_name: u.first_name ?? "U", ...(u.username ? { username: u.username } : {}) },
  };
}

export function textUpdate(u: TgUser, text: string, replyTo?: number): Update {
  const m = { ...msgBase(u), text, ...(replyTo ? { reply_to_message: { ...msgBase({ id: BOT_INFO.id }), message_id: replyTo, text: "x" } } : {}) };
  return { update_id: updateId++, message: m } as unknown as Update;
}

export function callbackUpdate(u: TgUser, data: string, onMessageId = 1): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: u.id, is_bot: false, first_name: u.first_name ?? "U" },
      chat_instance: "ci",
      data,
      message: { message_id: onMessageId, date: 0, chat: { id: u.id, type: "private", first_name: "U" }, text: "x" },
    },
  } as unknown as Update;
}

export function voiceUpdate(u: TgUser, fileId: string, size = 1000): Update {
  return { update_id: updateId++, message: { ...msgBase(u), voice: { file_id: fileId, file_unique_id: `u${fileId}`, duration: 3, mime_type: "audio/ogg", file_size: size } } } as unknown as Update;
}

export function photoUpdate(u: TgUser, fileId: string, o: { caption?: string; group?: string } = {}): Update {
  return {
    update_id: updateId++,
    message: {
      ...msgBase(u),
      photo: [
        { file_id: `${fileId}_small`, file_unique_id: `s${fileId}`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: `u${fileId}`, width: 800, height: 600, file_size: 10 },
      ],
      ...(o.caption ? { caption: o.caption } : {}),
      ...(o.group ? { media_group_id: o.group } : {}),
    },
  } as unknown as Update;
}

// ---------------- fake connector ----------------

type Handler<T extends RequestType> = (p: PayloadOf<T>) => PayloadOf<ResponseTypeOf<T>> | ProtocolError | Promise<PayloadOf<ResponseTypeOf<T>> | ProtocolError>;

export const SESSION = { agent_id: "claude", session_id: "sess-1", cwd: "/home/u/work" };

export const HELLO: PayloadOf<"hello"> = {
  protocol: { min: 1, max: 1 },
  acp_protocol: 1,
  connector_version: "test",
  agents: [
    { agent_id: "claude", title: "Claude Code", default: true, caps: { load_session: true, list_sessions: true, images: true } },
    { agent_id: "opencode", title: "opencode", default: false, caps: { load_session: true, list_sessions: true, images: false } },
  ],
};

/** A connector built on the protocol package: Peer for sending, auto-replies to gateway requests. */
export class FakeConnector {
  ws: WebSocket;
  peer: Peer;
  inbox: AnyEnvelope[] = [];
  closeCode?: number;
  welcome?: PayloadOf<"welcome">;
  blobs = new BlobReceiver(mkdtempSync(join(tmpdir(), "fake-conn-")), 20 * 1024 * 1024);
  handlers: { [T in RequestType]?: Handler<T> } = {
    "conversation.prompt": () => ({ session: SESSION, queued_position: 0 }),
    "session.new": () => ({ session: { ...SESSION, session_id: "sess-new" } }),
    "session.cancel": () => ({ cancelled: true }),
  };
  #closed: Promise<number>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.peer = new Peer({ send: (d, cb) => (ws.readyState === ws.OPEN ? ws.send(d, cb) : cb(new Error("closed"))) });
    this.#closed = new Promise((resolve) =>
      ws.on("close", (code) => {
        this.closeCode = code;
        this.peer.close();
        resolve(code);
      }),
    );
    ws.on("message", (data) => {
      const r = decode(data as Buffer);
      if (!r.ok) throw new Error(`gateway sent invalid frame: ${r.message}`);
      const env = r.env;
      this.inbox.push(env);
      if (this.peer.handleResponse(env)) return;
      void this.#onRequest(env);
    });
  }

  static open(url: string, token: string | undefined, headers: Record<string, string> = {}): Promise<FakeConnector> {
    const ws = new WebSocket(url, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    const c = new FakeConnector(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }

  /** open + hello + wait welcome + sync. */
  static async connect(
    url: string,
    token: string,
    o: { sync?: PayloadOf<"sync">; hello?: PayloadOf<"hello">; headers?: Record<string, string> } = {},
  ): Promise<FakeConnector> {
    const c = await FakeConnector.open(url, token, o.headers);
    c.peer.send("hello", o.hello ?? HELLO);
    const w = await c.waitFor("welcome");
    c.welcome = w.payload as PayloadOf<"welcome">;
    c.peer.send("sync", o.sync ?? { conversations: [], running_turns: [], pending: [] });
    return c;
  }

  async #onRequest(env: AnyEnvelope): Promise<void> {
    if (env.type === "blob.begin") return void this.blobs.begin(env.payload).catch((e) => this.peer.replyError(env, e));
    if (env.type === "blob.chunk") return void this.blobs.chunk(env.payload).catch((e) => this.peer.replyError(env, e));
    if (env.type === "blob.end") {
      try {
        const b = await this.blobs.end(env.payload);
        this.peer.reply(env, "blob.stored", { blob_id: b.blob_id, path: `/uploads/${b.name}` });
      } catch (e) {
        this.peer.replyError(env, e);
      }
      return;
    }
    const h = this.handlers[env.type as RequestType] as Handler<RequestType> | undefined;
    if (!h) return;
    const out = await h(env.payload as never);
    if (out instanceof ProtocolError) this.peer.replyError(env, out);
    else this.peer.reply(env, ResponseOf[env.type as RequestType], out as never);
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>): AnyEnvelope {
    return this.peer.send(type, payload) as AnyEnvelope;
  }

  request<T extends RequestType>(type: T, payload: PayloadOf<T>) {
    return this.peer.request(type, payload);
  }

  received(type: MessageType, pred: (p: never) => boolean = () => true): AnyEnvelope[] {
    return this.inbox.filter((e) => e.type === type && pred(e.payload as never));
  }

  async waitFor(type: MessageType, pred: (p: never) => boolean = () => true, timeoutMs = 3000): Promise<AnyEnvelope> {
    return until(() => this.inbox.find((e) => e.type === type && pred(e.payload as never)), type, timeoutMs);
  }

  closed(): Promise<number> {
    return this.#closed;
  }

  close(): Promise<number> {
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000);
    return this.#closed;
  }
}

// ---------------- fixtures ----------------

import { generateToken, hashToken } from "../../src/ws/tokens.ts";
import type { Repo } from "../../src/db/repo.ts";

export const OWNER: TgUser = { id: 5001, username: "owner", first_name: "Olga" };
export const STRANGER: TgUser = { id: 5002, username: "stranger", first_name: "Sam" };

/** Connector with a known token, optionally already paired to `owner`. */
export async function makeConnector(repo: Repo, name: string, owner?: TgUser): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const c = await repo.createConnector(name, hashToken(token));
  if (owner) await repo.setPairing({ connector_id: c.id, tg_user_id: owner.id, tg_chat_id: owner.id, user_display: `@${owner.username}` });
  return { id: c.id, token };
}
