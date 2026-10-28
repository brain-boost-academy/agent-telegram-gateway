import { GrammyError, type Api } from "grammy";
import type { InlineKeyboardMarkup, Message } from "grammy/types";

type Extra = { reply_markup?: InlineKeyboardMarkup; reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean } };

function desc(err: unknown): string {
  return err instanceof GrammyError ? err.description : "";
}

export const isNotModified = (e: unknown) => /message is not modified/i.test(desc(e));
export const isGone = (e: unknown) => /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(desc(e));
export const isParseError = (e: unknown) => /can't parse entities|unsupported start tag|can't find end tag/i.test(desc(e));

/** Last-resort plain text when Telegram rejects our HTML. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

export async function sendHtml(api: Api, chatId: number, html: string, extra: Extra = {}): Promise<Message.TextMessage> {
  const base = { link_preview_options: { is_disabled: true }, ...extra };
  try {
    return await api.sendMessage(chatId, html, { parse_mode: "HTML", ...base });
  } catch (e) {
    if (isParseError(e)) return api.sendMessage(chatId, htmlToPlain(html), base);
    throw e;
  }
}

/** Edit a message; "gone" when it no longer exists (deleted by the user). "Not modified" counts as success. */
export async function editHtml(api: Api, chatId: number, messageId: number, html: string, extra: Extra = {}): Promise<"ok" | "gone"> {
  const base = { link_preview_options: { is_disabled: true }, ...extra };
  try {
    await api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", ...base });
    return "ok";
  } catch (e) {
    if (isNotModified(e)) return "ok";
    if (isGone(e)) return "gone";
    if (isParseError(e)) {
      await api.editMessageText(chatId, messageId, htmlToPlain(html), base).catch((e2) => {
        if (!isNotModified(e2)) throw e2;
      });
      return "ok";
    }
    throw e;
  }
}
