import type { Bot, Context } from "grammy";
import type { User } from "grammy/types";
import type { Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import { onMenuClick, runCommand } from "./commands.ts";
import { routeIncoming } from "./elicitation.ts";
import { ownerLink, sendPrompt } from "./inbound.ts";
import type { Click } from "./interactions.ts";
import { audioOf, fileOf, type Media } from "./media.ts";
import { COMMANDS, T } from "./texts.ts";
import { sendHtml } from "./tg.ts";

export function userDisplay(u: User): string {
  return u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.id);
}

/** `/cmd@bot args` → ["cmd", "args"]. */
export function parseCommand(text: string, botUsername: string): [string, string] | null {
  const m = /^\/([a-zA-Z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return [m[1]!.toLowerCase(), m[3] ?? ""];
}

const KNOWN_COMMANDS = new Set(COMMANDS.map((c) => c.command));

/** One of our bot commands (as opposed to text that merely starts with "/", like a path). */
export function isBotCommand(text: string, botUsername: string): boolean {
  const cmd = parseCommand(text, botUsername);
  return cmd !== null && KNOWN_COMMANDS.has(cmd[0]);
}

/**
 * Telegram updates → connector. Private chats only. Each chat is processed in order on its own
 * queue so a slow ASR/upload in one chat does not block others.
 */
export function installHandlers(bot: Bot, gw: Gateway, media: Media): void {
  bot.use((ctx, next) => {
    const chat = ctx.chat;
    if (!chat || chat.type !== "private" || !ctx.from) return;
    void gw.chats.run(chat.id, next);
  });

  bot.on("callback_query:data", (ctx) => onCallback(gw, ctx));

  bot.on("message", async (ctx, next) => {
    const text = ctx.message.text;
    const cmd = text ? parseCommand(text, gw.botUsername) : null;
    if (cmd?.[0] === "start") {
      await gw.interactions.disarmChat(ctx.chat.id);
      const code = cmd[1].trim();
      if (code) return gw.pairing.start({ id: ctx.from.id, chatId: ctx.chat.id, display: userDisplay(ctx.from) }, code);
      const p = await gw.pairingOfUser(ctx.from.id);
      if (!p) return void (await sendHtml(gw.api, ctx.chat.id, T.pairingHint));
      const c = await gw.repo.connectorById(p.connector_id);
      return void (await sendHtml(gw.api, ctx.chat.id, `${T.alreadyPaired(c?.name ?? "?")}\n\n${T.help}`));
    }
    // Only the paired owner talks to a connector (Security).
    if (!(await gw.pairingOfUser(ctx.from.id))) return void (await sendHtml(gw.api, ctx.chat.id, T.pairingHint));
    await next();
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const route = routeIncoming(gw.arming.get(chatId), text, (t) => isBotCommand(t, gw.botUsername));
    if (route === "command") {
      await gw.interactions.disarmChat(chatId);
      const cmd = parseCommand(text, gw.botUsername);
      if (cmd) await runCommand(gw, chatId, ctx.from.id, cmd[0], cmd[1]);
      return;
    }
    if (route === "answer") return gw.interactions.answerArmed(chatId, text);
    const o = await ownerLink(gw, chatId, ctx.from.id);
    if (o) await sendPrompt(gw, o, chatId, text, "text", { replyTo: ctx.message.reply_to_message?.message_id });
  });

  bot.on("message", async (ctx) => {
    const m = ctx.message;
    if (audioOf(m)) return media.voice(ctx.chat.id, ctx.from.id, m);
    if (fileOf(m)) return media.file(ctx.chat.id, ctx.from.id, m);
  });

  bot.catch((err) => log.error("telegram handler error", { err: err.error }));
}

async function onCallback(gw: Gateway, ctx: Context): Promise<void> {
  const cq = ctx.callbackQuery!;
  const chatId = ctx.chat!.id;
  const q: Click = {
    chatId,
    fromId: cq.from.id,
    messageId: cq.message?.message_id ?? 0,
    answer: async (text?: string) => {
      await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
    },
  };
  const row = await gw.repo.callback(cq.data ?? "");
  if (!row) {
    await q.answer(T.stale);
    return;
  }
  if (row.kind === "pairing") return gw.pairing.onClick(q, row);
  const p = await gw.pairingOfUser(cq.from.id);
  if (!p || p.connector_id !== row.connector_id) return q.answer(T.noAccess);
  switch (row.kind) {
    case "perm":
      return gw.interactions.onPermissionClick(q, row);
    case "elic":
      return gw.interactions.onElicitationClick(q, row);
    case "disarm":
      return gw.interactions.onDisarmClick(q, row);
    case "attach":
    case "mode":
    case "agent":
      return onMenuClick(gw, q, row);
    default:
      return q.answer(T.stale);
  }
}
