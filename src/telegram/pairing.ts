import { randomBytes } from "node:crypto";
import type { PayloadOf } from "@brain-boost-academy/agent-protocol";
import type { CallbackRow, CodeCheck, ConnectorRow, PairingRow } from "../db/repo.ts";
import type { Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import type { Click } from "./interactions.ts";
import { T } from "./texts.ts";
import { editHtml, sendHtml } from "./tg.ts";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding (URL- and /start-safe). */
export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 128-bit one-time pairing code. */
export function newPairingCode(): string {
  return base32(randomBytes(16));
}

export type TgUser = { id: number; chatId: number; display: string };

export type StartDecision =
  | { do: "reply"; text: string }
  | { do: "already" }
  | { do: "confirm_rebind"; oldConnectorId: string }
  | { do: "ask_owner"; owner: PairingRow }
  | { do: "apply" };

/**
 * Pure /start <code> rules (Flow 1, R3b, D11):
 * bad code → message; same owner → nothing; user owns another connector → ask «Перепривязать?»
 * (unless already confirmed); connector has another owner → owner approval; else pair.
 */
export function decideStart(i: {
  check: CodeCheck;
  connector?: Pick<ConnectorRow, "revoked_at">;
  owner?: PairingRow;
  userPairing?: PairingRow;
  userId: number;
  rebindConfirmed?: boolean;
}): StartDecision {
  if (i.check.status === "unknown") return { do: "reply", text: T.codeUnknown };
  if (i.check.status === "used") return { do: "reply", text: T.codeUsed };
  if (i.check.status === "expired") return { do: "reply", text: T.codeExpired };
  if (!i.connector || i.connector.revoked_at) return { do: "reply", text: T.connectorRevoked };
  if (i.owner?.tg_user_id === i.userId) return { do: "already" };
  if (i.userPairing && i.userPairing.connector_id !== i.check.connectorId && !i.rebindConfirmed) {
    return { do: "confirm_rebind", oldConnectorId: i.userPairing.connector_id };
  }
  if (i.owner) return { do: "ask_owner", owner: i.owner };
  return { do: "apply" };
}

type PendingFlow = {
  id: string;
  kind: "confirm" | "approve";
  connectorId: string;
  connectorName: string;
  user: TgUser;
  /** Who may press the buttons. */
  deciderId: number;
  deciderChatId: number;
  messageId?: number;
  timer: NodeJS.Timeout;
};

export class PairingService {
  #gw: Gateway;
  #flows = new Map<string, PendingFlow>();

  constructor(gw: Gateway) {
    this.#gw = gw;
  }

  stop(): void {
    for (const f of this.#flows.values()) clearTimeout(f.timer);
    this.#flows.clear();
  }

  async createCode(connectorId: string): Promise<PayloadOf<"pairing.code">> {
    const code = newPairingCode();
    const expires = new Date(Date.now() + this.#gw.timings.codeTtlMs);
    await this.#gw.repo.insertCode(code, connectorId, expires);
    return { code, url: `https://t.me/${this.#gw.botUsername}?start=${code}`, expires_at: expires.toISOString() };
  }

  async info(connectorId: string): Promise<PayloadOf<"pairing.status.result">> {
    const p = await this.#gw.pairingOf(connectorId);
    return p ? { paired: true, user_display: p.user_display, conversation_id: String(p.tg_chat_id) } : { paired: false };
  }

  /** `/start <code>` from any Telegram user. */
  async start(user: TgUser, code: string): Promise<void> {
    const repo = this.#gw.repo;
    const check = await repo.consumeCode(code);
    const connector = check.status === "ok" ? await repo.connectorById(check.connectorId) : undefined;
    const [owner, userPairing] = connector ? await Promise.all([repo.pairingByConnector(connector.id), repo.pairingByUser(user.id)]) : [];
    await this.#continue(user, decideStart({ check, connector, owner, userPairing, userId: user.id }), connector);
  }

  async #continue(user: TgUser, d: StartDecision, connector: ConnectorRow | undefined): Promise<void> {
    const say = (html: string) => sendHtml(this.#gw.api, user.chatId, html);
    switch (d.do) {
      case "reply":
        await say(d.text);
        return;
      case "already":
        await say(T.alreadyPaired(connector!.name));
        return;
      case "confirm_rebind": {
        const old = await this.#gw.repo.connectorById(d.oldConnectorId);
        await this.#ask("confirm", connector!, user, user.id, user.chatId, T.askRebind(old?.name ?? "?", connector!.name), ["Да", "Нет"]);
        return;
      }
      case "ask_owner":
        await this.#ask("approve", connector!, user, d.owner.tg_user_id, d.owner.tg_chat_id, T.ownerAsk(user.display, connector!.name), ["Разрешить", "Отклонить"]);
        await say(T.waitOwner);
        return;
      case "apply":
        await this.#apply(connector!, user);
        return;
    }
  }

  async #ask(kind: PendingFlow["kind"], connector: ConnectorRow, user: TgUser, deciderId: number, deciderChatId: number, html: string, labels: [string, string]): Promise<void> {
    const id = randomBytes(9).toString("base64url");
    const flow: PendingFlow = {
      id,
      kind,
      connectorId: connector.id,
      connectorName: connector.name,
      user,
      deciderId,
      deciderChatId,
      timer: setTimeout(() => void this.#timeout(id), this.#gw.timings.approvalMs),
    };
    flow.timer.unref();
    this.#flows.set(id, flow);
    const markup = await this.#gw.buttons.keyboard(
      connector.id,
      [[{ label: labels[0], kind: "pairing", payload: { p: id, y: true } }, { label: labels[1], kind: "pairing", payload: { p: id, y: false } }]],
      this.#gw.timings.approvalMs + 60_000,
    );
    const m = await sendHtml(this.#gw.api, deciderChatId, html, { reply_markup: markup });
    flow.messageId = m.message_id;
  }

  async #timeout(id: string): Promise<void> {
    const f = this.#flows.get(id);
    if (!f) return;
    this.#flows.delete(id);
    try {
      if (f.kind === "approve") {
        if (f.messageId) await editHtml(this.#gw.api, f.deciderChatId, f.messageId, T.ownerTimeout(f.user.display));
        await sendHtml(this.#gw.api, f.user.chatId, T.newTimeout);
      } else if (f.messageId) {
        await editHtml(this.#gw.api, f.deciderChatId, f.messageId, T.stale);
      }
    } catch (err) {
      log.warn("pairing timeout notice failed", { err });
    }
  }

  /** The flow can no longer be decided (pairing changed meanwhile): its buttons die, the requester is told. */
  async #stale(f: PendingFlow): Promise<void> {
    try {
      if (f.messageId) await editHtml(this.#gw.api, f.deciderChatId, f.messageId, T.stale);
      if (f.kind === "approve") await sendHtml(this.#gw.api, f.user.chatId, T.newStale);
    } catch (err) {
      log.warn("stale pairing notice failed", { err });
    }
  }

  /** Every pending confirmation/approval of these connectors goes stale (their pairing just changed). */
  async #cancelFlows(connectorIds: string[]): Promise<void> {
    for (const f of [...this.#flows.values()]) {
      if (!connectorIds.includes(f.connectorId)) continue;
      this.#flows.delete(f.id);
      clearTimeout(f.timer);
      await this.#stale(f);
    }
  }

  async onClick(q: Click, row: CallbackRow): Promise<void> {
    const { p, y } = row.payload as { p: string; y: boolean };
    const f = this.#flows.get(p);
    if (!f) {
      await q.answer(T.stale);
      await this.#gw.api.editMessageReplyMarkup(q.chatId, q.messageId).catch(() => {});
      return;
    }
    if (q.fromId !== f.deciderId) return q.answer(T.noAccess);
    this.#flows.delete(p);
    clearTimeout(f.timer);
    await q.answer();
    const connector = await this.#gw.repo.connectorById(f.connectorId);
    if (f.kind === "confirm") {
      if (!y) {
        await editHtml(this.#gw.api, q.chatId, q.messageId, T.rebindDeclined);
        return;
      }
      await this.#gw.api.editMessageReplyMarkup(q.chatId, q.messageId).catch(() => {});
      const owner = await this.#gw.repo.pairingByConnector(f.connectorId);
      const d = decideStart({
        check: { status: "ok", connectorId: f.connectorId },
        connector,
        owner,
        userId: f.user.id,
        rebindConfirmed: true,
      });
      await this.#continue(f.user, d, connector);
      return;
    }
    // owner approval (R3b): only the current owner decides; ownership may have moved since the question was asked
    const owner = await this.#gw.repo.pairingByConnector(f.connectorId);
    if (owner?.tg_user_id !== f.deciderId) {
      await this.#stale(f);
      return;
    }
    if (!y) {
      await editHtml(this.#gw.api, q.chatId, q.messageId, T.ownerRejected(f.user.display));
      await sendHtml(this.#gw.api, f.user.chatId, T.newRejected);
      return;
    }
    if (!connector || connector.revoked_at) {
      await editHtml(this.#gw.api, q.chatId, q.messageId, T.connectorRevoked);
      return;
    }
    await editHtml(this.#gw.api, q.chatId, q.messageId, T.ownerApproved(f.user.display));
    await this.#apply(connector, f.user, f.deciderId);
  }

  /**
   * Write the pairing (strict 1:1) and tell everyone affected (R16). `toldUserId`: the removed owner who already saw
   * a message about this change (the approving owner), so they do not get a second one.
   */
  async #apply(connector: ConnectorRow, user: TgUser, toldUserId?: number): Promise<void> {
    let removed: PairingRow[];
    try {
      removed = await this.#gw.repo.setPairing({
        connector_id: connector.id,
        tg_user_id: user.id,
        tg_chat_id: user.chatId,
        user_display: user.display,
      });
    } catch (err) {
      // unique violation: a concurrent /start won the race for this connector (or this user)
      if ((err as { code?: unknown }).code !== "23505") throw err;
      log.info("pairing lost a race", { connector: connector.name, tg_user: user.id });
      await sendHtml(this.#gw.api, user.chatId, T.justClaimed(connector.name));
      return;
    }
    this.#gw.invalidatePairing(connector.id);
    await this.#cancelFlows([connector.id, ...removed.map((r) => r.connector_id)]);
    let reason: "paired" | "replaced" = "paired";
    for (const r of removed) {
      this.#gw.invalidatePairing(r.connector_id);
      if (r.connector_id === connector.id && r.tg_user_id !== user.id) {
        reason = "replaced";
        await this.#gw.interactions.disarmChat(r.tg_chat_id).catch(() => {});
        if (r.tg_user_id !== toldUserId) await sendHtml(this.#gw.api, r.tg_chat_id, T.lostToOther(connector.name)).catch(() => {});
      } else if (r.connector_id !== connector.id) {
        // the user moved away from another connector
        await this.#gw.pushPairingChanged(r.connector_id, "replaced");
      }
    }
    await this.#gw.pushPairingChanged(connector.id, reason);
    await sendHtml(this.#gw.api, user.chatId, T.paired(connector.name));
    log.info("paired", { connector: connector.name, tg_user: user.id, reason });
  }

  /** Owner `/unpair` or connector `pairing.revoke`. */
  async unpair(connectorId: string, reason: "unpaired" | "admin_unpair", notice?: (name: string) => string): Promise<boolean> {
    const removed = await this.#gw.repo.deletePairing(connectorId);
    if (reason === "admin_unpair") await this.#gw.repo.killCodes(connectorId);
    await this.#gw.pushPairingChanged(connectorId, reason);
    await this.#cancelFlows([connectorId]);
    if (removed) {
      await this.#gw.interactions.disarmChat(removed.tg_chat_id).catch(() => {});
      if (notice) {
        const c = await this.#gw.repo.connectorById(connectorId);
        await sendHtml(this.#gw.api, removed.tg_chat_id, notice(c?.name ?? "?")).catch(() => {});
      }
    }
    return Boolean(removed);
  }

  /** The admin CLI already deleted the row; tell the connector and the former owner. */
  async adminUnpaired(connectorId: string, chatId: number | undefined): Promise<void> {
    await this.#gw.pushPairingChanged(connectorId, "admin_unpair");
    await this.#cancelFlows([connectorId]);
    if (chatId !== undefined) {
      const c = await this.#gw.repo.connectorById(connectorId);
      await this.#gw.interactions.disarmChat(chatId).catch(() => {});
      await sendHtml(this.#gw.api, chatId, T.adminUnpaired(c?.name ?? "?")).catch(() => {});
    }
  }
}
