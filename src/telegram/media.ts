import { sendBufferBlob } from "@brain-boost-academy/agent-protocol";
import type { Message } from "grammy/types";
import type { Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import { download, TG_DOWNLOAD_LIMIT, TooLargeError } from "./files.ts";
import { errorText, ownerLink, sendPrompt } from "./inbound.ts";
import { escapeHtml } from "./markdown.ts";
import { T } from "./texts.ts";
import { sendHtml } from "./tg.ts";

type FileItem = { fileId: string; size?: number; name: string; mime: string };
/** Messages of one chat waiting for the collection window to close (texts include file captions, in arrival order). */
type Collection = {
  userId: number;
  texts: string[];
  /** UTF-8 size of `texts` joined. */
  bytes: number;
  files: FileItem[];
  parts: number;
  replyTo?: number;
  firstAt: number;
  timer?: NodeJS.Timeout;
};
type Part = { text?: string; file?: FileItem; replyTo?: number };

function stamp(d: number): string {
  return new Date(d * 1000).toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/** The file of a photo/document/video message, or undefined for other messages. */
export function fileOf(m: Message): FileItem | undefined {
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1]!;
    return { fileId: p.file_id, size: p.file_size, name: `photo_${stamp(m.date)}_${p.file_unique_id}.jpg`, mime: "image/jpeg" };
  }
  if (m.document) {
    const d = m.document;
    return { fileId: d.file_id, size: d.file_size, name: d.file_name || `file_${d.file_unique_id}`, mime: d.mime_type || "application/octet-stream" };
  }
  if (m.video) {
    const v = m.video;
    return { fileId: v.file_id, size: v.file_size, name: v.file_name || `video_${stamp(m.date)}.mp4`, mime: v.mime_type || "video/mp4" };
  }
  return undefined;
}

/** The audio of a voice/audio/video_note message (Flow 3). */
export function audioOf(m: Message): FileItem | undefined {
  if (m.voice) return { fileId: m.voice.file_id, size: m.voice.file_size, name: "voice.oga", mime: m.voice.mime_type || "audio/ogg" };
  if (m.audio) return { fileId: m.audio.file_id, size: m.audio.file_size, name: m.audio.file_name || "audio", mime: m.audio.mime_type || "audio/mpeg" };
  if (m.video_note) return { fileId: m.video_note.file_id, size: m.video_note.file_size, name: "video_note.mp4", mime: "video/mp4" };
  return undefined;
}

/** A collection is sent before it would pass these: far below the 1 MiB protocol frame, and a bounded upload. */
export const COLLECTION_MAX_TEXT_BYTES = 256 * 1024;
export const COLLECTION_MAX_FILES = 10;

export class Media {
  #gw: Gateway;
  #pending = new Map<number, Collection>();
  /** Taken by `flush` and not sent yet (shutdown reporting). */
  #sending = new Set<Collection>();
  #stopped = false;

  constructor(gw: Gateway) {
    this.#gw = gw;
  }

  stop(): void {
    this.#stopped = true;
    for (const c of this.#pending.values()) clearTimeout(c.timer);
    this.#pending.clear();
  }

  /** Collections not sent yet (collected or in flight) and the Telegram messages in them. */
  unsent(): { chats: number; parts: number } {
    const all = [...this.#pending.values(), ...this.#sending];
    return { chats: all.length, parts: all.reduce((n, c) => n + c.parts, 0) };
  }

  async #fetch(f: FileItem): Promise<Buffer> {
    if (f.size !== undefined && f.size > TG_DOWNLOAD_LIMIT) throw new TooLargeError("too large");
    const file = await this.#gw.api.getFile(f.fileId);
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    return download(this.#gw.fileUrl(file.file_path), this.#gw.agent);
  }

  /** Voice → ASR → «🎤 text» → prompt (or the armed answer). ASR failure → no prompt. */
  async voice(chatId: number, userId: number, m: Message): Promise<void> {
    const f = audioOf(m)!;
    const say = (html: string, replyTo?: number) =>
      this.#gw.renderer.below(chatId, () =>
        sendHtml(this.#gw.api, chatId, html, replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      );
    const o = await ownerLink(this.#gw, chatId, userId);
    if (!o) return;
    if (!this.#gw.asr) return void (await say(T.asrOff));
    let text: string;
    try {
      const data = await this.#fetch(f);
      text = await this.#gw.asr.transcribe(data, f.name, f.mime);
    } catch (err) {
      log.warn("voice transcription failed", { err });
      await say(err instanceof TooLargeError ? T.tooBigDownload : T.asrFailed, m.message_id);
      return;
    }
    if (!text) return void (await say(T.asrFailed, m.message_id));
    await say(`🎤 ${escapeHtml(text)}`, m.message_id);
    if (this.#gw.arming.get(chatId)) return this.#gw.interactions.answerArmed(chatId, text);
    await sendPrompt(this.#gw, o, chatId, text, "voice", { replyTo: m.reply_to_message?.message_id });
  }

  /** A text prompt: collected like a file (see `#add`). Call inside the chat queue. */
  text(chatId: number, userId: number, text: string, replyTo?: number): Promise<void> {
    return this.#add(chatId, userId, { text, replyTo });
  }

  /** Photo/document/video, album item or not: collected (see `#add`). Call inside the chat queue. */
  file(chatId: number, userId: number, m: Message): Promise<void> {
    return this.#add(chatId, userId, { text: m.caption, file: fileOf(m)!, replyTo: m.reply_to_message?.message_id });
  }

  /**
   * Texts and files of one chat that arrive within `burstMs` of each other become one prompt (a share with a comment
   * comes as two messages; an album as one message per item). The window restarts on every message but closes at most
   * `burstMaxMs` after the first one. Two different replies are never merged: they target different sessions. A collection
   * that would pass COLLECTION_MAX_TEXT_BYTES / COLLECTION_MAX_FILES is sent first.
   */
  async #add(chatId: number, userId: number, part: Part): Promise<void> {
    if (this.#stopped) return; // after the shutdown budget: counted in the warning's `queues`
    let c = this.#pending.get(chatId);
    const bytes = part.text ? Buffer.byteLength(part.text) + 2 : 0; // + the "\n\n" separator
    const differentReply = part.replyTo !== undefined && c?.replyTo !== undefined && c.replyTo !== part.replyTo;
    const full = c && (c.bytes + bytes > COLLECTION_MAX_TEXT_BYTES || (part.file && c.files.length >= COLLECTION_MAX_FILES));
    if (c && (differentReply || full)) {
      await this.flushSafe(chatId);
      c = undefined;
    }
    if (!c) {
      c = { userId, texts: [], bytes: 0, files: [], parts: 0, firstAt: Date.now() };
      this.#pending.set(chatId, c);
    }
    c.parts++;
    c.bytes += bytes;
    if (part.text) c.texts.push(part.text);
    if (part.file) c.files.push(part.file);
    c.replyTo ??= part.replyTo;
    clearTimeout(c.timer);
    const { burstMs, burstMaxMs } = this.#gw.timings;
    const col = c;
    c.timer = setTimeout(
      () => void this.#gw.chats.run(chatId, () => (this.#pending.get(chatId) === col ? this.flush(chatId) : Promise.resolve())),
      Math.max(0, Math.min(burstMs, c.firstAt + burstMaxMs - Date.now())),
    );
  }

  /** Send what the chat has collected. Call inside the chat queue (the timer and `flushAll` do). */
  async flush(chatId: number): Promise<void> {
    const c = this.#pending.get(chatId);
    if (!c) return;
    this.#pending.delete(chatId);
    clearTimeout(c.timer);
    this.#sending.add(c);
    try {
      const text = c.texts.join("\n\n");
      if (c.files.length) return await this.#upload(chatId, c.userId, c.files, text, c.replyTo);
      const o = await ownerLink(this.#gw, chatId, c.userId);
      if (o) await sendPrompt(this.#gw, o, chatId, text, "text", { replyTo: c.replyTo });
    } finally {
      this.#sending.delete(c);
    }
  }

  /** `flush` that logs instead of throwing, so the update that triggered it still runs. */
  async flushSafe(chatId: number): Promise<void> {
    await this.flush(chatId).catch((err) => log.error("sending collected messages failed", { chat: chatId, err }));
  }

  /** Send every chat's collection now, in each chat's queue (shutdown, tests). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.#pending.keys()].map((chatId) => this.#gw.chats.run(chatId, () => this.flush(chatId))));
  }

  /** Upload every file as a blob, then one prompt with all of them. Any failure → error message, no prompt. */
  async #upload(chatId: number, userId: number, items: FileItem[], text: string, replyTo: number | undefined): Promise<void> {
    const o = await ownerLink(this.#gw, chatId, userId);
    if (!o) return;
    const blobIds: string[] = [];
    for (const f of items) {
      try {
        const data = await this.#fetch(f);
        const stored = await sendBufferBlob(o.link.peer, data, { name: f.name, mime: f.mime });
        blobIds.push(stored.blob_id);
      } catch (err) {
        log.warn("file upload to connector failed", { name: f.name, err });
        await sendHtml(this.#gw.api, chatId, err instanceof TooLargeError ? T.tooBigDownload : `${T.uploadFailed} ${errorText(err)}`);
        return;
      }
    }
    await sendPrompt(this.#gw, o, chatId, text, "text", { replyTo, attachments: blobIds });
  }
}
