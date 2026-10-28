import { ProtocolError } from "@brain-boost-academy/agent-protocol";
import type { PairingRow, SessionRef } from "../db/repo.ts";
import type { Gateway } from "../gateway.ts";
import type { ConnectorLink } from "../ws/link.ts";
import { T } from "./texts.ts";
import { sendHtml } from "./tg.ts";

/** conversation.prompt, session.new, session.attach may start an agent or load a long session (PROTOCOL.md: 120 s). */
export const SLOW_REQUEST_MS = 120_000;

export type Owner = { pairing: PairingRow; link: ConnectorLink; conversationId: string };

/**
 * Resolve the connector the user talks to. Unpaired users get only the pairing hint;
 * an offline connector gets «🔌 агент не в сети» (nothing is buffered).
 */
export async function ownerLink(gw: Gateway, chatId: number, userId: number): Promise<Owner | null> {
  const pairing = await gw.pairingOfUser(userId);
  if (!pairing) {
    await sendHtml(gw.api, chatId, T.pairingHint);
    return null;
  }
  const link = gw.registry.get(pairing.connector_id);
  if (!link) {
    await sendHtml(gw.api, chatId, T.offline);
    return null;
  }
  return { pairing, link, conversationId: String(chatId) };
}

export function errorText(err: unknown): string {
  if (err instanceof ProtocolError) {
    switch (err.code) {
      case "not_paired":
        return T.pairingHint;
      case "agent_unavailable":
        return "⚠️ Агент недоступен.";
      case "unknown_session":
        return "⚠️ Сессия не найдена.";
      case "session_busy":
        return "⚠️ Сессия занята.";
      case "too_large":
        return T.tooBigForAgent;
      case "timeout":
        return "⚠️ Агент не ответил вовремя.";
      default:
        return T.error(err.message);
    }
  }
  return T.error(err instanceof Error ? err.message : String(err));
}

/** Session of the agent message the user replied to (reply → that session, D7). */
export async function replySession(gw: Gateway, chatId: number, connectorId: string, replyTo?: number): Promise<SessionRef | undefined> {
  if (replyTo === undefined) return undefined;
  const ms = await gw.repo.messageSession(chatId, replyTo);
  if (!ms || ms.connector_id !== connectorId) return undefined;
  return { agent_id: ms.agent_id, session_id: ms.session_id, cwd: ms.cwd };
}

export async function sendPrompt(
  gw: Gateway,
  o: Owner,
  chatId: number,
  text: string,
  origin: "text" | "voice",
  opts: { replyTo?: number; attachments?: string[] } = {},
): Promise<void> {
  const session = await replySession(gw, chatId, o.pairing.connector_id, opts.replyTo);
  try {
    const acc = await o.link.peer.request(
      "conversation.prompt",
      {
        conversation_id: o.conversationId,
        text,
        origin,
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
        ...(session ? { session } : {}),
      },
      { timeoutMs: SLOW_REQUEST_MS },
    );
    if (acc.waiting_foreign) await sendHtml(gw.api, chatId, T.waitingForeign);
    else if (acc.queued_position > 0) await sendHtml(gw.api, chatId, T.queued(acc.queued_position));
  } catch (err) {
    await sendHtml(gw.api, chatId, errorText(err));
  }
}
