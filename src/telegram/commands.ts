import type { CallbackRow, SessionRef } from "../db/repo.ts";
import type { ConnectorState, Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import { TTL, type ButtonSpec } from "./buttons.ts";
import type { Click } from "./interactions.ts";
import { errorText, ownerLink, SLOW_REQUEST_MS } from "./inbound.ts";
import { escapeHtml, markdownToHtml, splitHtml, truncate } from "./markdown.ts";
import { T } from "./texts.ts";
import { sendHtml } from "./tg.ts";

const BUSY_BADGE: Record<string, string> = { running: "⚙️ ", foreign: "🖥 ", idle: "" };

export function sessionTime(iso: string | null | undefined, tz: string, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => x.toLocaleDateString("ru-RU", { timeZone: tz });
  const hm = d.toLocaleTimeString("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(now)) return hm;
  return `${d.toLocaleDateString("ru-RU", { timeZone: tz, day: "2-digit", month: "2-digit" })} ${hm}`;
}

function agentTitle(gw: Gateway, connectorId: string, agentId: string | undefined): string {
  const a = gw.state(connectorId).agents.find((x) => x.agent_id === agentId);
  return a?.title ?? agentId ?? "?";
}

type Modes = NonNullable<NonNullable<ConnectorState["conv"]>["modes"]>;

const tick = (on: boolean, label: string) => `${on ? "✓ " : ""}${label}`;

function agentRows(st: ConnectorState, current: string | undefined): ButtonSpec[][] {
  return st.agents.map((a) => [{ label: tick(a.agent_id === current, a.title), kind: "agent", payload: { a: a.agent_id } }]);
}

function modeRows(modes: Modes): ButtonSpec[][] {
  return modes.available.map((m) => [{ label: tick(m.id === modes.current, m.name), kind: "mode", payload: { m: m.id, n: m.name } }]);
}

/**
 * After a successful pick: move the ✓ in the clicked menu itself. When that is not possible (no `rows`: the picked item
 * is not in the current list; or the message is gone, Telegram refused) the user gets a text confirmation instead; a
 * failure of that text is only logged — the pick did happen, so no error is shown.
 */
async function retick(gw: Gateway, q: Click, connectorId: string, rows: ButtonSpec[][] | undefined, fallbackHtml: string): Promise<void> {
  if (rows) {
    try {
      const reply_markup = await gw.buttons.keyboard(connectorId, rows, TTL.menu);
      await gw.api.editMessageReplyMarkup(q.chatId, q.messageId, { reply_markup });
      return;
    } catch (err) {
      log.debug("menu edit failed, sending text", { err });
    }
  }
  await sendHtml(gw.api, q.chatId, fallbackHtml).catch((err) => log.warn("menu pick confirmation failed", { err }));
}

/** Slash commands of a paired user. `/start` is handled before the owner gate. */
export async function runCommand(gw: Gateway, chatId: number, userId: number, cmd: string, args: string): Promise<void> {
  const say = (html: string, extra = {}) => sendHtml(gw.api, chatId, html, extra);
  switch (cmd) {
    case "help":
      await say(T.help);
      return;
    case "verbose": {
      const arg = args.trim().toLowerCase();
      const on = arg === "on" ? true : arg === "off" ? false : !(await gw.verbose(chatId));
      await gw.setVerbose(chatId, on);
      await say(`Подробный вывод: <b>${on ? "вкл" : "выкл"}</b>`);
      return;
    }
    case "status":
      return status(gw, chatId, userId);
    case "unpair": {
      const p = await gw.pairingOfUser(userId);
      if (!p) return void (await say(T.pairingHint));
      await gw.pairing.unpair(p.connector_id, "unpaired");
      const c = await gw.repo.connectorById(p.connector_id);
      await say(T.unpaired(c?.name ?? "?"));
      return;
    }
  }

  const o = await ownerLink(gw, chatId, userId);
  if (!o) return;
  const cid = o.pairing.connector_id;
  const conversation_id = o.conversationId;
  try {
    switch (cmd) {
      case "new": {
        const r = await o.link.peer.request("session.new", { conversation_id }, { timeoutMs: SLOW_REQUEST_MS });
        await say(`🆕 Новая сессия · ${escapeHtml(agentTitle(gw, cid, r.session.agent_id))}`);
        return;
      }
      case "stop": {
        const r = await o.link.peer.request("session.cancel", { conversation_id });
        await say(r.cancelled ? "⏹ Останавливаю…" : "Сейчас ничего не выполняется.");
        return;
      }
      case "sessions": {
        const r = await o.link.peer.request("sessions.list", { conversation_id, limit: 10 });
        if (!r.items.length) return void (await say("Сессий пока нет."));
        const current = gw.state(cid).conv?.session?.session_id;
        const rows: ButtonSpec[][] = r.items.slice(0, 10).map((it) => {
          const mark = it.session.session_id === current ? "▶️ " : "";
          const label = [
            `${mark}${BUSY_BADGE[it.busy] ?? ""}${truncate(it.title || "(без названия)", 40)}`,
            sessionTime(it.updated_at, gw.displayTz),
            agentTitle(gw, cid, it.session.agent_id),
          ]
            .filter(Boolean)
            .join(" · ");
          return [{ label, kind: "attach", payload: { s: it.session, t: it.title ?? "" } }];
        });
        await say("Последние сессии:", { reply_markup: await gw.buttons.keyboard(cid, rows, TTL.menu) });
        return;
      }
      case "mode": {
        const modes = gw.state(cid).conv?.modes;
        if (!modes?.available.length) return void (await say("Режимы недоступны: нет активной сессии."));
        await say("Режим разрешений:", { reply_markup: await gw.buttons.keyboard(cid, modeRows(modes), TTL.menu) });
        return;
      }
      case "agent": {
        const st = gw.state(cid);
        const current = st.conv?.agent_id ?? st.agents.find((a) => a.default)?.agent_id;
        if (!st.agents.length) return void (await say("Агент не сообщил список агентов."));
        await say("Выберите агента:", { reply_markup: await gw.buttons.keyboard(cid, agentRows(st, current), TTL.menu) });
        return;
      }
      default:
        await say(T.help);
    }
  } catch (err) {
    await say(errorText(err));
  }
}

async function status(gw: Gateway, chatId: number, userId: number): Promise<void> {
  const p = await gw.pairingOfUser(userId);
  if (!p) return void (await sendHtml(gw.api, chatId, T.pairingHint));
  const c = await gw.repo.connectorById(p.connector_id);
  const link = gw.registry.get(p.connector_id);
  const st = gw.state(p.connector_id);
  const lines = [`Агент: <b>${escapeHtml(c?.name ?? "?")}</b> — ${link ? "в сети" : "🔌 не в сети"}`];
  if (st.conv) {
    lines.push(`ACP-агент: ${escapeHtml(agentTitle(gw, p.connector_id, st.conv.agent_id))}`);
    lines.push(`Сессия: ${escapeHtml(st.conv.title || (st.conv.session ? st.conv.session.session_id : "нет"))}`);
    lines.push(`Состояние: ${st.conv.busy ? (st.conv.busy_reason === "foreign" ? "работает в фоне" : "работает") : "свободен"}${st.conv.queue_length ? `, в очереди ${st.conv.queue_length}` : ""}`);
    const mode = st.conv.modes?.available.find((m) => m.id === st.conv?.modes?.current);
    if (mode) lines.push(`Режим: ${escapeHtml(mode.name)}`);
  }
  lines.push(`Подробный вывод: ${(await gw.verbose(chatId)) ? "вкл" : "выкл"}`);
  await sendHtml(gw.api, chatId, lines.join("\n"));
}

/** Buttons of /sessions, /mode, /agent. */
export async function onMenuClick(gw: Gateway, q: Click, row: CallbackRow): Promise<void> {
  const link = gw.registry.get(row.connector_id);
  if (!link) return q.answer(T.offline);
  const conversation_id = String(q.chatId);
  const say = (html: string) => sendHtml(gw.api, q.chatId, html);
  // attach is slow: stop the button spinner at once. mode/agent answer after the request with a toast.
  const answered = row.kind === "attach";
  if (answered) await q.answer();
  try {
    if (row.kind === "attach") {
      const { s } = row.payload as { s: SessionRef };
      const r = await link.peer.request("session.attach", { conversation_id, session: s }, { timeoutMs: SLOW_REQUEST_MS });
      const head = `📂 <b>${escapeHtml(r.title || "(без названия)")}</b>`;
      const warn = r.warning === "active_elsewhere" ? "\n⚠️ Сессия сейчас открыта в другом месте (открыта в cloudcli?)" : "";
      const preview = r.last_assistant_text ? `\n\n${markdownToHtml(truncate(r.last_assistant_text, 3000))}` : "";
      const parts = splitHtml(`${head}${warn}${preview}`);
      for (const part of parts) {
        const m = await say(part);
        await gw.recordSession(q.chatId, m.message_id, row.connector_id, r.session).catch(() => {});
      }
      return;
    }
    if (row.kind === "mode") {
      const { m, n } = row.payload as { m: string; n: string };
      const r = await link.peer.request("session.set_mode", { conversation_id, mode_id: m });
      // The connector does not send session.state after set_mode, so keep our copy current.
      const conv = gw.state(row.connector_id).conv;
      if (conv?.modes) conv.modes.current = r.mode_id;
      await q.answer(`Режим: ${n}`);
      const shown = conv?.modes?.available.some((x) => x.id === r.mode_id) ? modeRows(conv.modes) : undefined;
      await retick(gw, q, row.connector_id, shown, `Режим: <b>${escapeHtml(n)}</b>`);
      return;
    }
    if (row.kind === "agent") {
      const { a } = row.payload as { a: string };
      const r = await link.peer.request("agent.select", { conversation_id, agent_id: a });
      // conv.agent_id is not written here: the connector follows agent.select with its own session.state.
      const title = agentTitle(gw, row.connector_id, r.agent_id);
      await q.answer(`Агент: ${title}`);
      const st = gw.state(row.connector_id);
      const shown = st.agents.some((x) => x.agent_id === r.agent_id) ? agentRows(st, r.agent_id) : undefined;
      await retick(gw, q, row.connector_id, shown, `Агент: <b>${escapeHtml(title)}</b>`);
    }
  } catch (err) {
    if (!answered) await q.answer();
    await say(errorText(err));
  }
}
