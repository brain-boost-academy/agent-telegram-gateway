import type { Agent } from "node:http";
import type { Api } from "grammy";
import type { MessageType, PayloadOf } from "@brain-boost-academy/agent-protocol";
import type { AsrClient } from "./asr/client.ts";
import type { PairingRow, Repo, SessionRef } from "./db/repo.ts";
import { log } from "./log.ts";
import { Buttons } from "./telegram/buttons.ts";
import { ChatQueue } from "./telegram/chat-queue.ts";
import { Arming } from "./telegram/elicitation.ts";
import { Interactions } from "./telegram/interactions.ts";
import { PairingService } from "./telegram/pairing.ts";
import { Renderer } from "./telegram/render.ts";
import { ConnectorEvents } from "./ws/events.ts";
import { Registry } from "./ws/registry.ts";
import { ReplaceAlert } from "./ws/replace-alert.ts";

export type Timings = {
  /** Min interval between edits of one streaming turn. */
  flushMs: number;
  /** media_group_id debounce. */
  albumMs: number;
  /** Owner approval / re-pair confirmation timeout (R3b). */
  approvalMs: number;
  /** Pairing code TTL. */
  codeTtlMs: number;
  /** Pairing cache lifetime: bounds how long a lost admin NOTIFY can route to an old chat. */
  pairingTtlMs: number;
};

export const DEFAULT_TIMINGS: Timings = { flushMs: 1000, albumMs: 1000, approvalMs: 10 * 60_000, codeTtlMs: 10 * 60_000, pairingTtlMs: 60_000 };

type Cached = { row: PairingRow | null; at: number };

export type GatewayOpts = {
  repo: Repo;
  api: Api;
  botUsername: string;
  token: string;
  apiRoot: string;
  agent?: Agent;
  asr?: AsrClient;
  displayTz: string;
  timings?: Partial<Timings>;
};

type Pending =
  | { kind: "permission"; payload: PayloadOf<"permission.request"> }
  | { kind: "elicitation"; payload: PayloadOf<"elicitation.request"> };

/** Per-connector state that outlives a single WebSocket (R14): kept until the gateway process restarts. */
export type ConnectorState = {
  agents: PayloadOf<"hello">["agents"];
  conv?: PayloadOf<"session.state">;
  /** Requests the connector still waits on (live requests + last `sync`). */
  pending: Map<string, Pending>;
};

/** Composition root shared by the WS and Telegram sides. */
export class Gateway {
  readonly repo: Repo;
  readonly api: Api;
  botUsername: string;
  readonly token: string;
  readonly apiRoot: string;
  readonly agent?: Agent;
  readonly asr?: AsrClient;
  readonly displayTz: string;
  readonly timings: Timings;
  readonly registry = new Registry();
  readonly chats = new ChatQueue();
  readonly arming = new Arming();
  readonly replaceAlert = new ReplaceAlert();
  readonly buttons: Buttons;
  readonly renderer: Renderer;
  readonly interactions: Interactions;
  readonly pairing: PairingService;
  readonly events: ConnectorEvents;
  #state = new Map<string, ConnectorState>();
  #pairings = new Map<string, Cached>();
  #userPairings = new Map<number, Cached>();
  /** Bumped on every invalidation so a lookup that started before it does not store a stale row. */
  #pairingGen = 0;
  #verbose = new Map<number, boolean>();

  constructor(o: GatewayOpts) {
    this.repo = o.repo;
    this.api = o.api;
    this.botUsername = o.botUsername;
    this.token = o.token;
    this.apiRoot = o.apiRoot;
    this.agent = o.agent;
    this.asr = o.asr;
    this.displayTz = o.displayTz;
    this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    this.buttons = new Buttons(o.repo);
    this.renderer = new Renderer({
      api: o.api,
      flushMs: this.timings.flushMs,
      recordSession: (c, m, id, s) => this.recordSession(c, m, id, s),
    });
    this.interactions = new Interactions(this);
    this.pairing = new PairingService(this);
    this.events = new ConnectorEvents(this);
  }

  stop(): void {
    this.renderer.stop();
    this.pairing.stop();
  }

  state(connectorId: string): ConnectorState {
    let s = this.#state.get(connectorId);
    if (!s) {
      s = { agents: [], pending: new Map() };
      this.#state.set(connectorId, s);
    }
    return s;
  }

  async #cached<K>(cache: Map<K, Cached>, key: K, load: () => Promise<PairingRow | undefined>): Promise<PairingRow | undefined> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < this.timings.pairingTtlMs) return hit.row ?? undefined;
    const gen = this.#pairingGen;
    const row = (await load()) ?? null;
    if (gen === this.#pairingGen) cache.set(key, { row, at: Date.now() });
    return row ?? undefined;
  }

  /** The owner of a connector (cached for `pairingTtlMs`, dropped on every pairing change). */
  pairingOf(connectorId: string): Promise<PairingRow | undefined> {
    return this.#cached(this.#pairings, connectorId, () => this.repo.pairingByConnector(connectorId));
  }

  /** The connector a Telegram user owns (same cache rules as `pairingOf`). */
  pairingOfUser(tgUserId: number): Promise<PairingRow | undefined> {
    return this.#cached(this.#userPairings, tgUserId, () => this.repo.pairingByUser(tgUserId));
  }

  /** Admin NOTIFYs may have been missed (LISTEN reconnected): forget every cached pairing. */
  invalidateAllPairings(): void {
    this.#pairingGen++;
    this.#pairings.clear();
    this.#userPairings.clear();
  }

  invalidatePairing(connectorId: string): void {
    this.#pairingGen++;
    this.#pairings.delete(connectorId);
    // A change of one connector's owner can affect any user (old owner, new owner): pairing changes are rare, drop them all.
    this.#userPairings.clear();
  }

  async verbose(chatId: number): Promise<boolean> {
    if (!this.#verbose.has(chatId)) this.#verbose.set(chatId, await this.repo.verbose(chatId));
    return this.#verbose.get(chatId)!;
  }

  async setVerbose(chatId: number, on: boolean): Promise<void> {
    await this.repo.setVerbose(chatId, on);
    this.#verbose.set(chatId, on);
  }

  async recordSession(chatId: number, messageId: number, connectorId: string, s: SessionRef): Promise<void> {
    await this.repo.recordMessageSession(chatId, messageId, connectorId, { agent_id: s.agent_id, session_id: s.session_id, cwd: s.cwd });
  }

  /** Push a gateway→connector message to the live link, if any. */
  push<T extends MessageType>(connectorId: string, type: T, payload: PayloadOf<T>): boolean {
    const link = this.registry.get(connectorId);
    if (!link) {
      log.debug("connector offline, not pushing", { type, connector: connectorId });
      return false;
    }
    link.peer.send(type, payload);
    return true;
  }

  async pushPairingChanged(connectorId: string, reason: PayloadOf<"pairing.changed">["reason"]): Promise<void> {
    this.invalidatePairing(connectorId);
    const p = await this.pairingOf(connectorId);
    this.push(connectorId, "pairing.changed", p ? { paired: true, user_display: p.user_display, conversation_id: String(p.tg_chat_id), reason } : { paired: false, reason });
  }

  fileUrl(filePath: string): string {
    return `${this.apiRoot}/file/bot${this.token}/${filePath}`;
  }
}
