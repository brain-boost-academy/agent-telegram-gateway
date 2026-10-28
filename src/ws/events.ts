import { rm } from "node:fs/promises";
import { GrammyError, InputFile } from "grammy";
import { durableKey, ProtocolError, type AnyEnvelope, type DurableType, type PayloadOf } from "@brain-boost-academy/agent-protocol";
import type { Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import { markdownToHtml, splitHtml } from "../telegram/markdown.ts";
import { T } from "../telegram/texts.ts";
import { sendHtml } from "../telegram/tg.ts";
import type { ConnectorLink } from "./link.ts";
import type { LinkHandler } from "./server.ts";

/**
 * Why a durable message could not be shown (protocol 1.2.0): `internal` = transient, the connector retries
 * (Telegram 429/5xx, network, database); `not_paired` / `invalid_message` = terminal, the connector drops it.
 */
export function deliveryError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof GrammyError) {
    const what = `telegram ${err.error_code}: ${err.description}`;
    if (err.error_code === 429 || err.error_code >= 500) return new ProtocolError("internal", what);
    // the owner blocked the bot / deleted the account / the chat is gone: nobody to show it to
    if (err.error_code === 403 || /chat not found|user is deactivated|bot was blocked|PEER_ID_INVALID/i.test(err.description)) {
      return new ProtocolError("not_paired", what);
    }
    return new ProtocolError("invalid_message", what);
  }
  // A bug in our rendering does not go away on retry (undici's network "fetch failed" is a TypeError, but transient).
  if ((err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) && err.message !== "fetch failed") {
    return new ProtocolError("invalid_message", `gateway cannot render this message: ${err.message}`);
  }
  return new ProtocolError("internal", err instanceof Error ? err.message : String(err));
}

type TakenBlob = { id: string; blob: ReturnType<ConnectorLink["blobs"]["take"]> };

const notPaired = () => new ProtocolError("not_paired", "no Telegram user is paired with this connector");

/** Messages from connectors → Telegram. */
export class ConnectorEvents implements LinkHandler {
  #gw: Gateway;
  #inflight = new Map<string, Promise<true | ProtocolError>>();
  /**
   * `<connector>|notify:<id>` → text parts (by count: the text never changes) and files (by name + size: a resend may omit
   * files that vanished) Telegram already accepted, so a retry resumes instead of duplicating. Kept until `delivered` is recorded.
   */
  #notifyProgress = new Map<string, { parts: number; files: Map<string, number> }>();
  #unknownKinds = new Set<string>();

  constructor(gw: Gateway) {
    this.#gw = gw;
  }

  pairingInfo(connectorId: string): Promise<PayloadOf<"welcome">["pairing"]> {
    return this.#gw.pairing.info(connectorId);
  }

  onConnected(link: ConnectorLink, replaced: ConnectorLink | undefined): void {
    this.#gw.state(link.connectorId).agents = link.hello?.agents ?? [];
    if (!replaced) return;
    const ips = this.#gw.replaceAlert.record(link.connectorId, replaced.ip, link.ip);
    if (!ips) return;
    log.error("connector token used from several places", { connector: link.name, ips });
    void (async () => {
      const owner = await this.#gw.pairingOf(link.connectorId);
      if (owner) await sendHtml(this.#gw.api, owner.tg_chat_id, T.replaceAlert(link.name, ips));
    })().catch((err) => log.warn("replace alert not sent", { err }));
  }

  /**
   * The owner chat for a message addressed to `conversationIds` (TG conversation_id = String(chat.id)).
   * Connectors may only reach their own paired owner.
   */
  async #chat(connectorId: string, conversationIds?: string[]): Promise<number | "unpaired" | "other"> {
    const p = await this.#gw.pairingOf(connectorId);
    if (!p) return "unpaired";
    if (conversationIds && !conversationIds.includes(String(p.tg_chat_id))) return "other";
    return p.tg_chat_id;
  }

  /** Owner chat of a durable message; a chat that is not (or no longer) the owner's is terminal `not_paired`. */
  async #ownerChat(connectorId: string, conversationIds?: string[]): Promise<number> {
    const chat = await this.#chat(connectorId, conversationIds);
    if (chat === "unpaired") throw notPaired();
    if (chat === "other") throw new ProtocolError("not_paired", "conversation is not paired with this connector");
    return chat;
  }

  async onMessage(link: ConnectorLink, env: AnyEnvelope): Promise<void> {
    const cid = link.connectorId;
    switch (env.type) {
      case "sync":
        return this.#sync(link, env.payload);
      case "session.state": {
        const chat = await this.#chat(cid, [env.payload.conversation_id]);
        if (typeof chat === "number") this.#gw.state(cid).conv = env.payload;
        return;
      }
      case "turn.started": {
        const chat = await this.#chat(cid, env.payload.conversation_ids);
        if (typeof chat === "number") await this.#gw.renderer.start(cid, chat, env.payload, await this.#gw.verbose(chat));
        return;
      }
      case "session.update": {
        const chat = await this.#chat(cid, env.payload.conversation_ids);
        if (typeof chat !== "number") return;
        const u = env.payload.update as { sessionUpdate: string; currentModeId?: unknown };
        const conv = this.#gw.state(cid).conv;
        if (u.sessionUpdate === "current_mode_update" && conv?.modes && typeof u.currentModeId === "string") conv.modes.current = u.currentModeId;
        const known = this.#gw.renderer.update(cid, chat, env.payload, await this.#gw.verbose(chat));
        if (!known && !this.#unknownKinds.has(u.sessionUpdate)) {
          this.#unknownKinds.add(u.sessionUpdate);
          log.info("ignoring unknown session.update kind", { kind: u.sessionUpdate });
        }
        return;
      }
      case "turn.ended":
        return this.#durable(link, env, "turn.ended", env.payload, async () => {
          const chat = await this.#ownerChat(cid, env.payload.conversation_ids);
          await this.#gw.renderer.end(cid, chat, env.payload, await this.#gw.verbose(chat));
        });
      case "turn.error":
        return this.#durable(link, env, "turn.error", env.payload, async () => {
          const chat = await this.#ownerChat(cid, env.payload.conversation_ids);
          await this.#gw.renderer.error(cid, chat, env.payload, await this.#gw.verbose(chat));
        });
      case "permission.request":
        this.#gw.state(cid).pending.set(env.payload.request_id, { kind: "permission", payload: env.payload });
        return this.#durable(link, env, "permission.request", env.payload, () => this.#showRequest(cid, { kind: "permission", ...env.payload }));
      case "elicitation.request":
        this.#gw.state(cid).pending.set(env.payload.request_id, { kind: "elicitation", payload: env.payload });
        return this.#durable(link, env, "elicitation.request", env.payload, () => this.#showRequest(cid, { kind: "elicitation", ...env.payload }));
      case "permission.resolved":
        return this.#gw.interactions.permissionResolved(cid, env.payload);
      case "elicitation.resolved":
        return this.#gw.interactions.elicitationResolved(cid, env.payload);
      case "notify": {
        // Taken here, not in show(): a resend that is skipped (already delivered) or joins a delivery in flight must
        // still consume its blobs, or they pile up in the receiver (maxOpen) and on disk.
        const blobs: TakenBlob[] = (env.payload.files ?? []).map((id) => ({ id, blob: link.blobs.take(id) }));
        const removeBlobs = async () => {
          for (const { blob } of blobs) if (blob) await rm(blob.path, { force: true }).catch((err) => log.warn("blob file not removed", { err }));
        };
        const progressKey = `${cid}|notify:${env.payload.notify_id}`;
        return this.#durable(link, env, "notify", env.payload, () => this.#notify(link, env.payload, blobs), {
          cleanup: removeBlobs,
          delivered: () => void this.#notifyProgress.delete(progressKey),
        });
      }
      case "pairing.request":
        link.peer.reply(env, "pairing.code", await this.#gw.pairing.createCode(cid));
        return;
      case "pairing.status":
        link.peer.reply(env, "pairing.status.result", await this.#gw.pairing.info(cid));
        return;
      case "pairing.revoke":
        await this.#gw.pairing.unpair(cid, "unpaired", T.agentUnpaired);
        link.peer.reply(env, "pairing.revoke.result", { ok: true });
        return;
      // A failed begin/chunk is answered once and remembered: the sender waits for the reply to blob.end, which must
      // carry the original error (too_large vs invalid_message), not «unknown blob».
      case "blob.begin":
        return link.blobs.begin(env.payload).catch((err) => this.#blobFailed(link, env, env.payload.blob_id, err));
      case "blob.chunk":
        if (link.failedBlobs.has(env.payload.blob_id)) return;
        return link.blobs.chunk(env.payload).catch((err) => this.#blobFailed(link, env, env.payload.blob_id, err));
      case "blob.end": {
        const failed = link.failedBlobs.get(env.payload.blob_id);
        if (failed) {
          link.failedBlobs.delete(env.payload.blob_id);
          link.peer.replyError(env, failed);
          return;
        }
        return link.blobs.end(env.payload).then(
          () => link.peer.reply(env, "blob.stored", { blob_id: env.payload.blob_id }),
          (err) => link.peer.replyError(env, err),
        );
      }
      case "error":
        log.warn("connector reported error", { connector: link.name, code: env.payload.code, message: env.payload.message });
        return;
      default:
        // responses without a pending request (timed out) end up here
        log.debug("unhandled connector message", { type: env.type });
    }
  }

  #blobFailed(link: ConnectorLink, env: { id: string }, blobId: string, err: unknown): void {
    const pe = err instanceof ProtocolError ? err : new ProtocolError("internal", err instanceof Error ? err.message : String(err));
    link.failedBlobs.set(blobId, pe);
    link.peer.replyError(env, pe);
  }

  /**
   * R2/R9: skip + ack when already delivered; otherwise show, and only after Telegram accepted it record the key and ack.
   * Not shown → `error` with `re` (protocol 1.2.0): `internal` makes the connector retry, a terminal code makes it drop the message.
   * `env` is undefined for requests rebuilt from `sync` (nothing to answer; the connector resends them on its own).
   * `cleanup` runs before the answer whether or not `show` ran (skipped as delivered, or joined a delivery in flight);
   * `delivered` runs once the key is recorded (or found) in `delivered`.
   */
  async #durable(
    link: ConnectorLink,
    env: { id: string } | undefined,
    type: DurableType,
    payload: PayloadOf<DurableType>,
    show: () => Promise<void>,
    hooks: { cleanup?: () => Promise<void>; delivered?: () => void } = {},
  ): Promise<void> {
    const cid = link.connectorId;
    const key = durableKey(type, payload);
    const k = `${cid}|${key}`;
    let run = this.#inflight.get(k);
    if (!run) {
      run = (async (): Promise<true | ProtocolError> => {
        if (await this.#gw.repo.isDelivered(cid, key)) {
          hooks.delivered?.();
          return true;
        }
        try {
          await show();
        } catch (err) {
          const pe = deliveryError(err);
          log.warn("durable message not delivered", { connector: link.name, key, code: pe.code, err });
          return pe;
        }
        await this.#gw.repo.markDelivered(cid, key);
        hooks.delivered?.();
        return true;
      })()
        .catch((err: unknown) => {
          log.error("durable bookkeeping failed", { connector: link.name, key, err });
          return new ProtocolError("internal", "gateway database error");
        })
        .finally(() => this.#inflight.delete(k));
      this.#inflight.set(k, run);
    }
    let r: true | ProtocolError;
    try {
      r = await run;
    } finally {
      await hooks.cleanup?.();
    }
    if (r === true) link.peer.send("delivered", { id: key });
    else if (env) link.peer.replyError(env, r);
  }

  async #showRequest(
    cid: string,
    req: ({ kind: "permission" } & PayloadOf<"permission.request">) | ({ kind: "elicitation" } & PayloadOf<"elicitation.request">),
  ): Promise<void> {
    const chat = await this.#ownerChat(cid, req.conversation_ids);
    if (req.kind === "permission") await this.#gw.interactions.showPermission(cid, chat, req);
    else await this.#gw.interactions.showElicitation(cid, chat, req);
  }

  /**
   * Show a notify: text parts, then files. Resumable: what Telegram already accepted for this notify is skipped on a
   * retry (a resend carries the same text and fresh blobs, possibly fewer of them).
   */
  async #notify(link: ConnectorLink, p: PayloadOf<"notify">, blobs: TakenBlob[]): Promise<void> {
    const cid = link.connectorId;
    const k = `${cid}|notify:${p.notify_id}`;
    const done = this.#notifyProgress.get(k) ?? { parts: 0, files: new Map<string, number>() };
    try {
      const chat = await this.#ownerChat(cid, p.conversation_id ? [p.conversation_id] : undefined);
      const missing = blobs.filter((b) => !b.blob).map((b) => b.id);
      // Blobs the receiver expired (stored, but the notify came too late) are re-sent by the connector: retry, do not drop.
      const expired = missing.filter((id) => link.blobs.wasExpired(id));
      if (expired.length) throw new ProtocolError("internal", `notify blobs expired before the notify arrived: ${expired.join(", ")}`);
      if (missing.length) throw new ProtocolError("invalid_message", `notify references unknown blobs: ${missing.join(", ")}`);
      const record = (messageId: number) =>
        p.session ? this.#gw.recordSession(chat, messageId, cid, p.session).catch((err) => log.warn("message_sessions insert failed", { err })) : undefined;
      if (p.text) {
        let html = markdownToHtml(p.text);
        if (p.switched) html += "\n\n<i>↪️ чат переключён на эту сессию — ответы пойдут в неё</i>";
        for (const part of splitHtml(html).slice(done.parts)) {
          const m = await sendHtml(this.#gw.api, chat, part);
          done.parts++;
          await record(m.message_id);
        }
      }
      const skip = new Map(done.files); // identities already shown, consumed one by one (two equal files stay two)
      for (const { blob } of blobs) {
        const id = `${blob!.name}|${blob!.size}`;
        const left = skip.get(id) ?? 0;
        if (left > 0) {
          skip.set(id, left - 1);
          continue;
        }
        const m = await this.#gw.api.sendDocument(chat, new InputFile(blob!.path, blob!.name));
        done.files.set(id, (done.files.get(id) ?? 0) + 1);
        await record(m.message_id);
      }
      // everything is shown; kept («all sent») until `delivered` is recorded, so a database failure does not re-send it
      this.#remember(k, done);
    } catch (err) {
      // only a transient failure is retried; keep what was sent for that retry
      if ((done.parts || done.files.size) && deliveryError(err).code === "internal") {
        this.#remember(k, done);
      } else {
        this.#notifyProgress.delete(k);
      }
      throw err;
    }
  }

  #remember(k: string, done: { parts: number; files: Map<string, number> }): void {
    this.#notifyProgress.set(k, done);
    if (this.#notifyProgress.size > 1000) this.#notifyProgress.delete(this.#notifyProgress.keys().next().value!);
  }

  /**
   * R2 + R14: reconcile running turns, rebuild pending requests; show those never delivered.
   * Protocol 1.2.0: turns we still render but the connector no longer runs are closed as interrupted; answers the
   * connector never got (link dropped right after a click) are sent again; forms of requests it no longer waits on are dropped.
   */
  async #sync(link: ConnectorLink, p: PayloadOf<"sync">): Promise<void> {
    const cid = link.connectorId;
    const st = this.#gw.state(cid);
    const owner = await this.#gw.pairingOf(cid);
    const conv = owner ? p.conversations.find((c) => c.conversation_id === String(owner.tg_chat_id)) : undefined;
    if (conv) st.conv = conv;
    st.pending = new Map();
    for (const r of p.pending) {
      if (r.kind === "permission") st.pending.set(r.request_id, { kind: "permission", payload: r });
      else st.pending.set(r.request_id, { kind: "elicitation", payload: r });
    }
    await this.#gw.interactions.syncPending(link, new Set(st.pending.keys()));
    await this.#gw.renderer
      .interruptMissing(cid, new Set(p.running_turns.map((t) => t.turn_id)))
      .catch((err) => log.warn("closing interrupted turns failed", { connector: link.name, err }));
    if (owner) {
      const verbose = await this.#gw.verbose(owner.tg_chat_id);
      for (const t of p.running_turns) {
        if (t.conversation_ids.includes(String(owner.tg_chat_id))) await this.#gw.renderer.reconcile(cid, owner.tg_chat_id, t, verbose);
      }
    }
    for (const r of p.pending) {
      if (r.kind === "permission") await this.#durable(link, undefined, "permission.request", r, () => this.#showRequest(cid, r));
      else await this.#durable(link, undefined, "elicitation.request", r, () => this.#showRequest(cid, r));
    }
  }
}
